import { retryAdmission } from '../../bridge/admission';
import type { CommandQueue } from '../../app/commands';
import type { ProjectStore } from '../../app/store';
import { normalizeError } from '../../bridge/client';
import type { MediaCommands, MediaEvent } from '../../bridge/media';
import type { AppError } from '../../bridge/types';
import type { ProjectLifecycle } from '../project/lifecycle';

export interface ImportItem {
  path: string; state: 'waiting' | 'hashing' | 'decoding' | 'publishing' | 'accepted' | 'success' | 'failed' | 'cancelled'; completed: number;
  acknowledged?:boolean;ackError?:AppError; releasing?:Promise<void>; error?: AppError; failureId?: number; mediaId?: string; taskId?: string;
}
interface Run {
  items: ImportItem[]; taskId: string | null; ack: boolean; terminal: boolean; stopped: boolean;
  pending: number; done: Promise<void>; resolve: () => void;
}
/** One controller belongs to one ActiveProject object, never merely its projectId. */
export class MediaImportController {
  items: ImportItem[] = [];
  busy = false;
  cancelling = false;
  error: AppError | null = null;
  private disposed = false;
  private retained=new Set<ImportItem>();
  private run: Run | null = null;
  private reservation: object | null = null;
  private tail: Promise<void> = Promise.resolve();
  private version = 0;
  private listeners = new Set<() => void>();
  private unsubscribe: () => void;
  constructor(private store: ProjectStore, private queue: CommandQueue, private api: MediaCommands, private lifecycle?: ProjectLifecycle) {
    const storeSubscription = store.subscribe(() => { if (store.editingDisabled) this.cancel();else queueMicrotask(()=>{if(!this.disposed)this.failures([...this.retained]);}); });
    const lifecycleSubscription = lifecycle?.subscribe(() => { if (lifecycle.admissionClosed) this.cancel(); });
    this.unsubscribe = () => { storeSubscription(); lifecycleSubscription?.(); };
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getVersion = () => this.version;
  private notify() { this.version++; this.listeners.forEach(fn => fn()); }
  get pendingAcknowledgements(){return [...this.retained].filter(item=>item.state==='success'&&!item.acknowledged);}
  get errorIsAcknowledgement(){return this.pendingAcknowledgements.some(item=>item.ackError===this.error);}
  get occupied() { return this.busy || this.reservation !== null; }
  reserve(owner: object) {
    if (this.disposed || this.store.editingDisabled || this.lifecycle?.admissionClosed || this.occupied) return false;
    this.reservation = owner; this.notify(); return true;
  }
  unreserve(owner: object) { if (this.reservation === owner) { this.reservation = null; this.notify(); } }
  async start(paths: string[], relinkId?: string, reservation?: object) {
    this.store.assertEditable();
    if (this.disposed || this.busy || (this.reservation && reservation !== this.reservation) || paths.length === 0) return;
    let resolve!: () => void;
    const run: Run = { items: paths.map(path => ({ path, state: 'waiting', completed: 0 })), taskId: null, ack: false, terminal: false, stopped: false, pending: 0, done: new Promise<void>(r => { resolve = r; }), resolve: () => resolve() };
    this.run = run; this.items = run.items; this.busy = true; this.cancelling = false; this.error = null; this.notify();
    try {
      const taskId = await retryAdmission(()=>this.api.start(this.store.snapshot.document.projectId, paths, event => this.receive(run, event, relinkId), relinkId),{valid:()=>!this.disposed&&!run.stopped&&!this.store.editingDisabled});
      run.taskId ??= taskId; run.ack = true;
      if (run.stopped || this.disposed || this.store.editingDisabled) void this.api.cancel(taskId).catch(e => this.report(e));
    } catch (e) {
      this.error = normalizeError(e); run.ack = true; run.terminal = true;
      for (const item of run.items) if (item.state === 'waiting') { item.state = run.stopped ? 'cancelled' : 'failed'; item.error = this.error; }
    }
    this.check(run);
  }
  private report(e: unknown) { this.error = normalizeError(e); this.notify(); }
  private check(run: Run) {
    if (run.pending === 0 && (run.stopped || (run.ack && run.terminal))) run.resolve();
    if (run === this.run) { this.busy = !(run.ack && run.terminal && run.pending === 0); this.notify(); }
  }
  private track(run: Run, work: Promise<unknown>) {
    run.pending++;
    const settled = work.catch(e => this.report(e)).finally(() => { run.pending--; this.check(run); });
    this.tail = Promise.all([this.tail, settled]).then(() => {});
  }
  private receive(run: Run, event: MediaEvent, relinkId?: string) {
    run.taskId ??= event.taskId;
    if (event.taskId !== run.taskId) {
      if (event.type === 'ready') this.track(run, this.api.release(event.taskId, event.media.id));
      return;
    }
    if (event.type === 'finished') {
      run.terminal = true;
      for (const item of run.items) if (['waiting', 'hashing', 'decoding'].includes(item.state)) item.state = event.cancelled || run.stopped ? 'cancelled' : 'failed';
      this.check(run); return;
    }
    const item = run.items[event.index];
    if (event.type === 'ready' && (!item || run.stopped || run.terminal || this.disposed || this.store.editingDisabled)) {
      this.track(run, this.api.release(event.taskId, event.media.id)); return;
    }
    if (!item || run.stopped || run.terminal || this.disposed) return;
    if (event.type === 'progress') { item.state = event.phase === 'hashing' ? 'hashing' : 'decoding'; item.completed = event.completed; this.notify(); return; }
    if (event.type === 'failed') { item.error = event.error; item.state = event.error.code === 'Cancelled' ? 'cancelled' : 'failed'; this.notify(); return; }
    this.retained.add(item);item.state = 'publishing'; item.taskId = event.taskId; item.mediaId = event.media.id;
    const owner = `media:${crypto.randomUUID()}` as const;
    // Admission is synchronous at receipt, before any private promise bookkeeping.
    const publish = () => this.queue.enqueue({ type: relinkId ? 'relinkMedia' : 'importMedia', media: event.media }, { owner });
    const work = this.lifecycle ? this.lifecycle.enqueueEdit(publish) : publish();
    this.track(run, work.then(async () => { item.state = 'success'; await this.acknowledge(item); }, async e => {
      item.error = normalizeError(e);item.state=this.committed(item.error,item.mediaId)?'accepted':'failed';
      item.failureId = this.queue.unresolvedFailures.find(f => f.owner === owner)?.id;
      // Rejection before queue admission has no retryable prepared-media owner.
      if (item.failureId === undefined) await this.api.release(event.taskId, event.media.id);
    }));
    this.notify();
  }
  private committed(error:AppError|undefined,id?:string){const d=error?.details as {catalogCommitted?:boolean;catalogAdoptionRequired?:boolean;mediaId?:string}|undefined;return d?.catalogCommitted===true&&d.catalogAdoptionRequired===true&&d.mediaId===id;}
  private acknowledge(item:ImportItem):Promise<void>{
    if(item.acknowledged||!item.taskId||!item.mediaId)return Promise.resolve();
    if(item.releasing)return item.releasing;
    item.releasing=this.api.release(item.taskId,item.mediaId).then(()=>{item.acknowledged=true;this.retained.delete(item);if(this.error===item.ackError)this.error=null;item.ackError=undefined;this.notify();},e=>{item.ackError=normalizeError(e);this.report(item.ackError);}).finally(()=>{item.releasing=undefined;});
    return item.releasing;
  }
  failures(items: ImportItem[] = this.items) {
    const ids = new Set(this.queue.unresolvedFailures.map(f => f.id));
    for (const item of items) if (item.failureId !== undefined && !ids.has(item.failureId)) {
      if (this.store.snapshot.document.media.some(m => m.id === item.mediaId)) { item.state = 'success'; item.error = undefined; void this.acknowledge(item); }
      item.failureId = undefined;
    }
    return items.filter(i => i.failureId !== undefined);
  }
  private async acknowledgeRetained() {
    // Result panels and folder scopes can be replaced; native capabilities belong
    // to this controller until their original task/media pair is acknowledged.
    for (const item of this.pendingAcknowledgements) await this.acknowledge(item);
  }
  async retryAcknowledgements() {
    if (this.disposed) return;
    const retry = () => this.acknowledgeRetained();
    try { if (this.lifecycle) await this.lifecycle.enqueueEdit(retry); else await retry(); }
    finally { this.notify(); }
  }
  async retry(items: ImportItem[] = this.items) {
    const retry = async () => {
      await this.acknowledgeRetained();
      if (this.queue.needsRefresh) await this.queue.refresh();
      // Reconcile inside shared admission: a preceding End/global Retry may already have won.
      for (const item of this.failures(items)) {
        try { await this.queue.retry(item.failureId!); item.state = 'success'; item.error = undefined; item.failureId = undefined; await this.acknowledge(item); }
        catch (e) { item.error = normalizeError(e);if(this.committed(item.error,item.mediaId))item.state='accepted';throw e; }
      }
    };
    try { if (this.lifecycle) await this.lifecycle.enqueueEdit(retry); else await retry(); }
    finally { this.notify(); }
  }
  async discard(items: ImportItem[] = this.items, pending: Promise<void> = Promise.resolve()) {
    const discard = async () => {
      await pending;
      for (const item of this.failures(items)) {
        if(item.state==='accepted'){await this.queue.retry(item.failureId!);item.state='success';item.failureId=undefined;item.error=undefined;await this.acknowledge(item);continue;}
        // Keep the retryable ledger until its prepared PCM has actually been released.
        if (item.taskId && item.mediaId) await this.api.release(item.taskId, item.mediaId);
        this.queue.discardFailure(item.failureId!); item.failureId = undefined;this.retained.delete(item);
      }
      this.notify();
    };
    if (this.lifecycle) await this.lifecycle.enqueueEdit(discard); else await discard();
  }
  cancel() {
    const run = this.run;
    if (!run || run.stopped || (!this.busy && run.terminal)) return;
    run.stopped = true; this.cancelling = true;
    for (const item of run.items) if (['waiting', 'hashing', 'decoding'].includes(item.state)) item.state = 'cancelled';
    if (run.taskId) void this.api.cancel(run.taskId).catch(e => this.report(e));
    this.check(run);
  }
  /** Whole batch barrier: start acknowledgement, native terminal and every accepted publication.
   * Cancellation/reset resolves after accepted work without depending on another native event. */
  completed() { return this.run?.done ?? Promise.resolve(); }
  settled() { return this.tail; }
  dispose() { this.cancel(); this.disposed = true; this.unsubscribe(); this.listeners.clear(); }
}
