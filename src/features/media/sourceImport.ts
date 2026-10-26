import { normalizeError } from '../../bridge/client';
import { parseSourceRules, sameSourceToken, type SourceCommands, type SourceConfig, type SourceCounts, type SourceEvent, type SourcePage, type SourceRules, type SourceToken } from '../../bridge/sourceImport';
import type { AppError } from '../../bridge/types';
import type { ActiveProject } from '../project/useProjectLifecycle';
import { MediaImportController, type ImportItem } from './imports';
import { ImportRuleStore } from './importRules';
export type SourceState = 'idle' | 'choosing' | 'scanning' | 'preview' | 'importing' | 'paused' | 'finished' | 'cancelled' | 'failed';
const emptyCounts = (): SourceCounts => ({ checked: 0, candidates: 0, skipped: 0, issues: 0, selectedBytes: 0 });
/** One preview owns the media reservation until its native capability is released. */
export class SourceImportController {
  state: SourceState = 'idle';
  open = false;
  config: SourceConfig;
  counts = emptyCounts();
  page: SourcePage | null = null;
  pageOffset = 0;
  items: (ImportItem & {
    index: number;
  })[] = [];
  error: AppError | null = null;
  picking = false;
  loadingPage = false;
  readonly rules = new ImportRuleStore();
  private token: SourceToken | null = null;
  private acknowledged = false;
  private generation = 0;
  private pageGeneration = 0;
  private disposed = false;
  private releasing: Promise<boolean> | null = null;
  private releaseFailed = false;
  private retiredTokens = new Map<string, SourceToken>();
  private reserved = false;
  private running = false;
  private offset = 0;
  private ownedBatch: ImportItem[] | null = null;
  private batchCompletion = Promise.resolve();
  private version = 0;
  private listeners = new Set<() => void>();
  private unsubscribers: (() => void)[];
  constructor(private owner: ActiveProject, private imports: MediaImportController, private api: SourceCommands) {
    this.config = { kind: 'folder', paths: [], rules: structuredClone(this.rules.last) };
    this.unsubscribers = [imports.subscribe(() => {
        this.unreserve();
        this.notify();
      }), owner.store.subscribe(() => {
        if (owner.store.editingDisabled)
          void this.cancel();
      })];
    if (owner.lifecycle)
      this.unsubscribers.push(owner.lifecycle.subscribe(() => {
        if (owner.lifecycle.admissionClosed)
          void this.cancel();
      }));
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getVersion = () => this.version;
  private notify() {
    this.version++;
    this.listeners.forEach(f => f());
  }
  get busy() {
    return ['choosing', 'scanning', 'preview', 'importing', 'paused'].includes(this.state) || this.releasePending;
  }
  get releasePending() {
    return this.releaseFailed || !!this.releasing || this.retiredTokens.size > 0;
  }
  get ownsCurrentBatch() {
    return !!this.ownedBatch && this.imports.items === this.ownedBatch;
  }
  get failures() {
    return this.imports.failures(this.items);
  }
  get pendingAcknowledgements() {
    return this.imports.pendingAcknowledgements;
  }
  get successCount() {
    this.imports.failures(this.items);
    return this.items.filter(i => ['success', 'accepted'].includes(i.state)).length;
  }
  get canImport() {
    return this.state === 'preview' && this.acknowledged && !this.loadingPage && this.counts.candidates > 0 && !this.releasePending;
  }
  private valid(g: number) {
    return !this.disposed && g === this.generation && !this.owner.store.editingDisabled && !this.owner.lifecycle?.admissionClosed;
  }
  private reserve() {
    if (this.reserved)
      return true;
    this.reserved = this.imports.reserve(this);
    return this.reserved;
  }
  private unreserve() {
    // Shared recovery controls can finish this workflow's publication/release
    // outside retry(). Reconcile ownership on those notifications, but retain it
    // throughout active configuration and until the native batch has settled.
    if (this.reserved && !this.busy && !this.imports.busy && !this.token && !this.failures.length && !this.pendingAcknowledgements.length) {
      this.reserved = false;
      this.imports.unreserve(this);
    }
  }
  begin(kind: SourceConfig['kind']) {
    if (this.disposed || this.busy || this.failures.length || this.pendingAcknowledgements.length || this.owner.collaboration?.canImportMedia === false || !this.reserve())
      return false;
    this.generation++;
    this.config = { kind, paths: [], rules: structuredClone(this.rules.last) };
    this.state = 'choosing';
    this.open = true;
    this.counts = emptyCounts();
    this.page = null;
    this.items = [];
    this.offset = 0;
    this.error = null;
    this.notify();
    return true;
  }
  async choose(picker: () => Promise<string | string[] | null>) {
    if (!['choosing', 'preview', 'failed'].includes(this.state) || this.picking)
      return;
    const g = this.generation;
    this.picking = true;
    this.notify();
    try {
      const paths = await picker();
      if (!this.valid(g) || !paths)
        return;
      await this.invalidate();
      this.config = { ...this.config, paths: Array.isArray(paths) ? paths : [paths] };
    }
    catch (e) {
      this.error = normalizeError(e);
    }
    finally {
      this.picking = false;
      this.notify();
    }
  }
  async configure(rules: SourceRules) {
    if (['importing', 'paused'].includes(this.state))
      return;
    this.config = { ...this.config, rules: structuredClone(rules) };
    await this.invalidate();
  }
  private async invalidate() {
    this.generation++;
    this.pageGeneration++;
    this.acknowledged = false;
    this.state = 'choosing';
    this.page = null;
    this.counts = emptyCounts();
    this.error = null;
    this.notify();
    await this.release();
    this.notify();
  }
  private async release(): Promise<boolean> {
    if (this.releasing)
      return this.releasing;
    const token = this.token;
    this.releasing = (async () => {
      if (token) {
        try {
          await this.api.release(token);
          if (this.token && sameSourceToken(this.token, token))
            this.token = null;
          this.releaseFailed = false;
        }
        catch (e) {
          this.releaseFailed = true;
          this.error = normalizeError(e);
          return false;
        }
      }
      return this.retryRetired();
    })().finally(() => {
      this.releasing = null;
      this.notify();
    });
    return this.releasing;
  }
  async retryRelease() {
    const ok = await (this.releaseFailed || this.releasing ? this.release() : this.retryRetired());
    if (ok) {
      this.error = null;
      this.unreserve();
    }
    this.notify();
  }
  async scan() {
    if (this.disposed || this.picking || this.failures.length || this.pendingAcknowledgements.length || ['importing', 'paused', 'scanning'].includes(this.state))
      return;
    let g = this.generation;
    try {
      parseSourceRules(this.config.rules);
      if (!this.config.paths.length)
        throw new Error('请选择音频来源');
      if (!this.reserve())
        return;
      if (!await this.release())
        return;
      if (!this.valid(g))
        return;
      g = ++this.generation;
      this.acknowledged = false;
      this.error = null;
      this.page = null;
      this.offset = 0;
      this.items = [];
      this.counts = emptyCounts();
      this.state = 'scanning';
      this.rules.remember(this.config.rules);
      this.notify();
      const token = await this.api.start(this.owner.store.snapshot.document.projectId, structuredClone(this.config), e => this.receive(g, e));
      if (!this.valid(g) || !['scanning', 'preview'].includes(this.state)) {
        await this.releaseRetired(token);
        return;
      }
      if (this.token && !sameSourceToken(this.token, token))
        throw new Error('扫描令牌不匹配');
      this.token = token;
      this.acknowledged = true;
      this.notify();
    }
    catch (e) {
      if (this.valid(g)) {
        this.error = normalizeError(e);
        this.state = 'failed';
        await this.release();
        this.notify();
      }
    }
  }
  private async releaseRetired(token: SourceToken) {
    // A late start acknowledgement belongs to its own generation, never to
    // the currently displayed preview. Keep its exact token on failure.
    this.retiredTokens.set(token.taskId, token);
    try {
      await this.api.release(token);
      this.retiredTokens.delete(token.taskId);
      return true;
    }
    catch (e) {
      this.error = normalizeError(e);
      return false;
    }
    finally {
      if (!this.disposed)
        this.notify();
    }
  }
  private async retryRetired() {
    for (const token of [...this.retiredTokens.values()]) {
      if (!await this.releaseRetired(token))
        return false;
    }
    return true;
  }
  private receive(g: number, event: SourceEvent) {
    if (!this.valid(g) || !['scanning', 'preview'].includes(this.state) || event.token.projectId !== this.owner.store.snapshot.document.projectId || (this.owner.collaboration && event.token.runtimeNonce !== this.owner.collaboration.runtimeNonce))
      return;
    if (this.state === 'preview' && event.type === 'progress')
      return;
    if (this.token && !sameSourceToken(this.token, event.token))
      return;
    this.token ??= event.token;
    if (event.type === 'failed') {
      this.error = event.error;
      this.state = event.error.code === 'Cancelled' ? 'cancelled' : 'failed';
      void this.release().then(() => {
        this.unreserve();
      });
    }
    else {
      this.counts = event.counts;
      if (event.type === 'result') {
        this.state = 'preview';
        void this.loadPage(0);
      }
    }
    this.notify();
  }
  async loadPage(offset: number) {
    if (!this.token || this.state !== 'preview')
      return;
    const token = this.token, g = this.generation, p = ++this.pageGeneration;
    this.loadingPage = true;
    this.notify();
    try {
      const page = await this.api.page(token, offset, 50);
      if (this.valid(g) && p === this.pageGeneration) {
        this.page = page;
        this.pageOffset = offset;
      }
    }
    catch (e) {
      if (this.valid(g) && p === this.pageGeneration) {
        this.error = normalizeError(e);
        this.state = 'failed';
      }
    }
    finally {
      if (p === this.pageGeneration) {
        this.loadingPage = false;
        this.notify();
      }
    }
  }
  async importAll() {
    if (!this.canImport)
      return;
    this.state = 'importing';
    this.open = false;
    this.notify();
    await this.advance();
  }
  private async advance() {
    if (this.running || !this.token || this.state !== 'importing')
      return;
    this.running = true;
    const g = this.generation, token = this.token;
    try {
      while (this.offset < this.counts.candidates && this.valid(g) && this.state === 'importing') {
        if (this.owner.queue.unresolvedFailures.length || this.pendingAcknowledgements.length) {
          this.state = 'paused';
          break;
        }
        const page = await this.api.page(token, this.offset, 256);
        if (!this.valid(g) || this.state !== 'importing')
          return;
        // Other edits and release acknowledgements may settle while paging.
        if (this.owner.queue.unresolvedFailures.length || this.pendingAcknowledgements.length) {
          this.state = 'paused';
          break;
        }
        if (!page.candidates.length)
          throw new Error('扫描预览已失效，请重新扫描');
        const indices = page.candidates.map(c => c.index);
        const starting = this.imports.start(page.candidates.map(c => c.displayName), undefined, this, receive => this.api.batch(token, indices, receive));
        // start installs the run synchronously; preserve the exact ledger items
        // before an early native event or start acknowledgement can settle it.
        this.ownedBatch = this.imports.items;
        this.items.push(...this.imports.items.map((item, i) => Object.assign(item, { index: indices[i] })));
        this.offset += indices.length;
        this.batchCompletion = this.imports.completed();
        this.notify();
        void starting;
        await this.batchCompletion;
        if (!this.valid(g) || this.state !== 'importing')
          return;
        if (this.owner.queue.unresolvedFailures.length || this.pendingAcknowledgements.length) {
          this.state = 'paused';
          break;
        }
        if (this.imports.error)
          throw this.imports.error;
      }
      if (this.valid(g) && this.state === 'importing') {
        this.state = 'finished';
        await this.release();
        this.unreserve();
      }
    }
    catch (e) {
      if (this.valid(g)) {
        this.error = normalizeError(e);
        this.state = 'failed';
        await this.release();
        this.unreserve();
      }
    }
    finally {
      this.running = false;
      this.notify();
    }
  }
  async retry() {
    if (this.disposed || this.owner.store.editingDisabled)
      return;
    try {
      await this.imports.retry(this.items);
      this.error = null;
      if (this.state === 'paused' && !this.owner.queue.unresolvedFailures.length && !this.pendingAcknowledgements.length) {
        this.state = 'importing';
        void this.advance();
      }
      else
        this.unreserve();
    }
    catch (e) {
      this.error = normalizeError(e);
    }
    this.notify();
  }
  async cancel() {
    if (this.state === 'idle' || this.state === 'cancelled')
      return;
    this.generation++;
    this.pageGeneration++;
    this.loadingPage = false;
    this.state = 'cancelled';
    this.open = false;
    this.imports.cancel();
    this.notify();
    await this.release();
    this.unreserve();
    this.notify();
  }
  async end() {
    await this.cancel();
    try {
      await this.imports.discard(this.items, this.batchCompletion);
      this.error = null;
      await this.release();
      this.unreserve();
    }
    catch (e) {
      this.error = normalizeError(e);
    }
    this.notify();
  }
  dismiss() {
    if (!this.busy && !this.failures.length && !this.pendingAcknowledgements.length) {
      this.unreserve();
      if (this.reserved) return;
      this.state = 'idle';
      this.notify();
    }
  }
  show() {
    this.open = true;
    this.notify();
  }
  dispose() {
    void this.cancel();
    this.disposed = true;
    this.generation++;
    this.unsubscribers.forEach(f => f());
    this.listeners.clear();
  }
}
