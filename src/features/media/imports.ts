import type { CommandQueue } from '../../app/commands';
import type { ProjectStore } from '../../app/store';
import { normalizeError } from '../../bridge/client';
import type { MediaCommands, MediaEvent } from '../../bridge/media';
import type { AppError } from '../../bridge/types';

export interface ImportItem { path: string; state: 'waiting' | 'hashing' | 'decoding' | 'publishing' | 'success' | 'failed' | 'cancelled'; completed: number; error?: AppError }
/** One controller belongs to one ActiveProject object, never merely its projectId. */
export class MediaImportController {
  items: ImportItem[] = [];
  busy = false;
  cancelling = false;
  error: AppError | null = null;
  private disposed = false;
  private taskId: string | null = null;
  private startPending = false;
  private finished = false;
  private tail: Promise<void> = Promise.resolve();
  private version = 0;
  private listeners = new Set<() => void>();
  private unsubscribe: () => void;
  constructor(private store: ProjectStore, private queue: CommandQueue, private api: MediaCommands) {
    this.unsubscribe = store.subscribe(() => { if (store.editingDisabled && this.busy) this.cancel(); });
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getVersion = () => this.version;
  private notify() { this.version++; this.listeners.forEach(fn => fn()); }
  async start(paths: string[], relinkId?: string) {
    this.store.assertEditable();
    if (this.disposed || this.busy || paths.length === 0) return;
    this.busy = true; this.cancelling = false; this.error = null; this.taskId = null;
    this.startPending = true; this.finished = false;
    this.items = paths.map(path => ({ path, state: 'waiting', completed: 0 })); this.notify();
    try {
      const taskId = await this.api.start(this.store.snapshot.document.projectId, paths, event => this.receive(event, relinkId), relinkId);
      this.taskId = taskId;
      if (this.cancelling || this.disposed || this.store.editingDisabled) await this.api.cancel(taskId);
      this.startPending = false; this.busy = !this.finished; this.notify();
    } catch (e) {
      this.error = normalizeError(e); this.busy = false; this.startPending = false;
      this.items = this.items.map(item => ({ ...item, state: 'failed', error: this.error! })); this.notify();
    }
  }
  private receive(event: MediaEvent, relinkId?: string) {
    this.taskId ??= event.taskId;
    if (event.taskId !== this.taskId) return;
    if (event.type === 'progress') {
      const item = this.items[event.index];
      if (item && !this.cancelling && !this.disposed) { item.state = event.phase === 'hashing' ? 'hashing' : 'decoding'; item.completed = event.completed; this.notify(); }
      return;
    }
    this.tail = this.tail.then(async () => {
      if (event.type === 'finished') {
        for (const item of this.items) if (['waiting', 'hashing', 'decoding'].includes(item.state)) item.state = event.cancelled || this.cancelling ? 'cancelled' : 'failed';
        this.finished = true; this.busy = this.startPending; this.notify(); return;
      }
      const item = this.items[event.index]; if (!item) return;
      if (event.type === 'failed') { item.error = event.error; item.state = event.error.code === 'Cancelled' ? 'cancelled' : 'failed'; this.notify(); return; }
      if (this.disposed || this.cancelling || this.store.editingDisabled) {
        item.state = 'cancelled';
        await this.api.release(event.taskId, event.media.id); this.notify(); return;
      }
      item.state = 'publishing'; this.notify();
      try {
        // Admission occurs here. Lifecycle drains any accepted queue command before replacing authority.
        await this.queue.enqueue({ type: relinkId ? 'relinkMedia' : 'importMedia', media: event.media });
        item.state = 'success';
      } catch (e) { item.state = 'failed'; item.error = normalizeError(e); }
      this.notify();
    }).catch(e => { this.error = normalizeError(e); this.notify(); });
  }
  cancel() {
    if (!this.busy || this.cancelling) return;
    this.cancelling = true; this.notify();
    if (this.taskId) void this.api.cancel(this.taskId).catch(e => { this.error = normalizeError(e); this.notify(); });
  }
  settled() { return this.tail; }
  dispose() { this.cancel(); this.disposed = true; this.unsubscribe(); this.listeners.clear(); }
}
