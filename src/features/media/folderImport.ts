import { normalizeError } from '../../bridge/client';
import { sameScanToken, type FolderCommands, type FolderCounts, type FolderEvent, type FolderIssue, type ScanToken } from '../../bridge/folders';
import type { AppError } from '../../bridge/types';
import type { ActiveProject } from '../project/useProjectLifecycle';
import { MediaImportController, type ImportItem } from './imports';

export type FolderState = 'idle' | 'choosing' | 'scanning' | 'importing' | 'paused' | 'finished' | 'cancelled' | 'failed';
export type FolderImportItem = ImportItem & { index: number };
const emptyCounts = (): FolderCounts => ({ checked: 0, candidates: 0, existing: 0, skipped: 0, failed: 0, issues: 0 });
/** Owns a scan and references to its batches; never borrows a later direct/relink job's results. */
export class FolderImportController {
  state: FolderState = 'idle';
  counts = emptyCounts();
  items: FolderImportItem[] = [];
  issues: FolderIssue[] = [];
  error: AppError | null = null;
  root = '';
  private token: ScanToken | null = null;
  private acknowledged = false;
  private result: Extract<FolderEvent, { type: 'result' }> | null = null;
  private offset = 0;
  private batchCompletion: Promise<void> = Promise.resolve();
  private running: number | null = null;
  private disposed = false;
  private generation = 0;
  private version = 0;
  private listeners = new Set<() => void>();
  private unsubscribers: (() => void)[];
  constructor(private owner: ActiveProject, private imports: MediaImportController, private api: FolderCommands) {
    this.unsubscribers = [owner.store.subscribe(() => { if (owner.store.editingDisabled && this.busy) this.cancel(); else if (this.state !== 'idle') this.notify(); }), imports.subscribe(() => { if (this.state !== 'idle') this.notify(); })];
    if (owner.lifecycle) this.unsubscribers.push(owner.lifecycle.subscribe(() => { if (owner.lifecycle.admissionClosed && this.busy) this.cancel(); }));
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getVersion = () => this.version;
  private notify() { this.version++; this.listeners.forEach(fn => fn()); }
  get busy() { return ['choosing', 'scanning', 'importing', 'paused'].includes(this.state); }
  get ownsCurrentBatch() { return !!this.imports.items.length && this.items.includes(this.imports.items[0] as FolderImportItem); }
  get failures() { return this.imports.failures(this.items); }
  get otherFailures() { return this.owner.queue.unresolvedFailures.length - this.failures.length; }
  get successCount() { this.imports.failures(this.items); return this.items.filter(i => i.state === 'success').length; }
  get failedCount() { return this.counts.failed + this.items.filter(i => i.state === 'failed').length; }
  private valid(generation: number) { return !this.disposed && generation === this.generation && !this.owner.store.editingDisabled && this.busy; }
  begin() {
    if (this.owner.collaboration || this.disposed || this.busy || this.failures.length || !this.imports.reserve(this)) return false;
    this.generation++; this.state = 'choosing'; this.counts = emptyCounts(); this.items = []; this.issues = []; this.error = null; this.root = ''; this.result = null; this.acknowledged = false; this.offset = 0; this.notify(); return true;
  }
  async choose(picker: () => Promise<string | string[] | null>, recursive = false) {
    if (this.state !== 'choosing' && !this.begin()) return;
    const generation = this.generation;
    try {
      const path = await picker();
      if (!this.valid(generation)) return;
      if (!path) { this.cancel(); return; }
      this.root = Array.isArray(path) ? path[0] : path; this.state = 'scanning'; this.notify();
      const token = await this.api.start(this.owner.store.snapshot.document.projectId, this.root, event => this.receive(generation, event), recursive);
      if (!this.valid(generation)) { await this.api.cancel(token).catch(() => {}); await this.api.release(token).catch(() => {}); return; }
      if (this.token && !sameScanToken(this.token, token)) throw new Error('Folder scan ownership changed');
      this.token = token; this.acknowledged = true; void this.advance(generation);
    } catch (e) { if (this.valid(generation)) this.fail(e); }
  }
  private receive(generation: number, event: FolderEvent) {
    if (!this.valid(generation)) return;
    this.token ??= event.token;
    if (!sameScanToken(this.token, event.token)) return;
    if (event.type === 'progress') this.counts = event.counts;
    if (event.type === 'result') { this.counts = event.counts; this.result = event; if (this.acknowledged) void this.advance(generation); }
    if (event.type === 'cancelled') this.cancel();
    if (event.type === 'failed') this.fail(event.error);
    this.notify();
  }
  private async advance(generation: number) {
    if (this.running === generation || !this.acknowledged || !this.result || !this.token || !this.valid(generation)) return;
    this.running = generation;
    const token = this.token;
    try {
      if (this.result.retainedIssues && !this.issues.length) {
        const page = await this.api.page(token, 'issues', 0, 256);
        if (!this.valid(generation)) return;
        this.issues = page.issues;
      }
      while (this.offset < this.counts.candidates && this.valid(generation)) {
        this.state = 'importing'; this.notify();
        const page = await this.api.page(token, 'candidates', this.offset, 256);
        if (!this.valid(generation)) return;
        if (this.offset > 0 && this.owner.queue.unresolvedFailures.length) { this.state = 'paused'; this.notify(); return; }
        if (!page.candidates.length) throw new Error('Folder scan returned an empty candidate page');
        const starting = this.imports.start(page.candidates.map(c => c.path), undefined, this);
        // start installs its run synchronously, so capture references before any callback/ack awaits.
        const batch = this.imports.items.map((item, index) => Object.assign(item, { index: this.offset + index }));
        this.items.push(...batch); this.offset += batch.length; this.notify();
        // completed() can unblock on reset even if the native start acknowledgement never arrives.
        void starting;
        this.batchCompletion = this.imports.completed();
        await this.batchCompletion;
        if (!this.valid(generation)) return;
        if (this.owner.queue.unresolvedFailures.length) { this.state = 'paused'; this.notify(); return; }
        if (this.imports.error) { this.fail(this.imports.error); return; }
      }
      if (this.valid(generation)) { this.state = 'finished'; this.release(); this.imports.unreserve(this); this.notify(); }
    } catch (e) { if (this.valid(generation)) this.fail(e); }
    finally { if (this.running === generation) this.running = null; }
  }
  private release() { const token = this.token; this.token = null; if (token) void this.api.release(token).catch(() => {}); }
  private fail(e: unknown) { this.error = normalizeError(e); this.state = 'failed'; this.release(); this.imports.unreserve(this); this.notify(); }
  cancel() {
    if (!this.busy) return;
    this.state = 'cancelled'; this.generation++;
    if (this.token) void this.api.cancel(this.token).catch(() => {});
    this.release(); this.imports.cancel(); this.imports.unreserve(this); this.notify();
  }
  async retry() {
    if (this.disposed || this.owner.store.editingDisabled) return;
    try {
      await this.imports.retry(this.items); this.error = null;
      if (this.state === 'paused' && !this.owner.queue.unresolvedFailures.length) { this.state = 'importing'; void this.advance(this.generation); }
    } catch (e) { this.error = normalizeError(e); }
    this.notify();
  }
  /** Explicit user decision to abandon these failed edits; cancellation itself never does this. */
  async end() { this.cancel(); try { await this.imports.discard(this.items, this.batchCompletion); this.error = null; } catch (e) { this.error = normalizeError(e); } this.notify(); }
  dismiss() { if (!this.busy && !this.failures.length) { this.state = 'idle'; this.notify(); } }
  dispose() { this.cancel(); this.disposed = true; this.generation++; this.unsubscribers.forEach(fn => fn()); this.listeners.clear(); }
}
