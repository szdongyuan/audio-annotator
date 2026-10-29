import type { CommandQueue } from '../../app/commands';
import type { ProjectStore } from '../../app/store';
import { normalizeError } from '../../bridge/client';
import type { AppError } from '../../bridge/types';

export interface PersistenceCommands {
  save(projectId: string, revision: number): Promise<number>;
  close(projectId: string, revision: number, discard: boolean): Promise<void>;
}
export type SaveStatus = 'saved' | 'unsaved' | 'saving' | 'failed';
const draftError = (): AppError => ({ code: 'SaveFailed', message: '仍有未提交的编辑草稿，请完成编辑后重试。', retryable: true });

/** One lifecycle per project. Editors register a submitter for each durable draft key. */
export class ProjectLifecycle {
  status: SaveStatus = 'saved';
  savedAt: Date | null = null;
  private saveError: AppError | null = null;
  private readonly drafts = new Map<string, () => Promise<unknown>>();
  private readonly backgroundGuards = new Set<() => boolean>();
  private readonly pendingEdits = new Set<Promise<unknown>>();
  private editTail: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<() => void>();
  private version = 0;
  private debounce?: ReturnType<typeof setTimeout>;
  private maximum?: ReturnType<typeof setTimeout>;
  private saving: Promise<void> | null = null;
  private closing: Promise<void> | null = null;
  private transitioning = false;
  private disposed = false;
  private signature = '';
  private readonly unsubscribe: () => void;
  constructor(readonly store: ProjectStore, readonly queue: CommandQueue, private readonly api: PersistenceCommands) {
    this.unsubscribe = store.subscribe(() => this.changed());
    this.changed();
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getVersion = () => this.version;
  private notify() { this.version++; this.listeners.forEach(l => l()); }
  private get commandError() { return this.queue.unresolvedFailures[0]?.error ?? this.store.error; }
  get error(): AppError | null { return this.commandError ?? this.saveError; }
  get admissionClosed() { return this.transitioning || this.disposed; }
  /** Ref-based guards protect transient intent that a normal owner transition may reset. */
  get allowsBackgroundTransition() { return !this.disposed && [...this.backgroundGuards].every(allowed => allowed()); }
  registerBackgroundGuard(allowed: () => boolean) {
    this.backgroundGuards.add(allowed);
    return () => { this.backgroundGuards.delete(allowed); };
  }
  get hasPendingWork() { return this.store.isDirty || this.store.drafts.size > 0 || this.queue.unresolvedFailures.length > 0 || this.pendingEdits.size > 0; }
  /** Admit renderer actions synchronously, before they await drafts or native writes. */
  async enqueueEdit(action: () => Promise<unknown>): Promise<unknown> {
    if (this.transitioning || this.disposed) throw { code: 'InvalidInput', message: '项目正在切换或已关闭', retryable: true } satisfies AppError;
    this.store.assertEditable();
    const next = this.editTail.then(action);
    this.editTail = next.catch(() => {});
    this.pendingEdits.add(next); this.changed();
    try { return await next; }
    finally { this.pendingEdits.delete(next); this.changed(); }
  }
  private async flushEdits() {
    while (this.pendingEdits.size) await Promise.all([...this.pendingEdits]);
  }
  /** Persist within this admitted edit without waiting for the edit itself or resetting playback. */
  enqueuePersistedEdit<T>(action: () => Promise<T>): Promise<T> {
    return this.enqueueEdit(async () => {
      await this.submitDrafts();
      await this.persistSnapshot();
      return action();
    }) as Promise<T>;
  }
  registerDraft(key: string, submit: () => Promise<unknown>) {
    this.drafts.set(key, submit);
    return () => { if (this.drafts.get(key) === submit) this.drafts.delete(key); };
  }
  private changed() {
    const signature = JSON.stringify([this.store.dirtyRevision, this.store.persistedRevision, [...this.store.drafts], this.queue.unresolvedFailures, this.store.error, this.store.editingDisabled, this.pendingEdits.size]);
    if (signature === this.signature || this.disposed) return;
    this.signature = signature;
    if (this.commandError) {
      this.status = 'failed';
      this.clearTimers();
    } else if (!this.saving) {
      this.status = this.saveError ? 'failed' : this.hasPendingWork ? 'unsaved' : 'saved';
      if (this.hasPendingWork) this.schedule(this.saveError ? 5000 : 1000);
      else this.clearTimers();
    }
    this.notify();
  }
  private schedule(delay = 1000) {
    // Rejected commands require a user decision; autosave cannot resolve them.
    if (this.disposed || this.closing || this.transitioning || this.commandError) return;
    clearTimeout(this.debounce);
    const attempt = () => { this.clearTimers(); void this.save().catch(() => {}); };
    this.debounce = setTimeout(attempt, delay);
    this.maximum ??= setTimeout(attempt, 5000);
  }
  private clearTimers() { clearTimeout(this.debounce); clearTimeout(this.maximum); this.debounce = undefined; this.maximum = undefined; }
  async submitDrafts(): Promise<void> {
    // Failed operations require an explicit retry/discard decision first.
    await this.queue.flush();
    for (const key of [...this.store.drafts.keys()]) {
      const submit = this.drafts.get(key);
      if (!submit) throw draftError();
      await submit();
    }
    await this.queue.flush();
    // A newer draft typed while the command ran must never be acknowledged away.
    if (this.store.drafts.size) throw draftError();
  }
  save(): Promise<void> {
    if (this.transitioning || this.disposed) return Promise.reject({ code: 'InvalidInput', message: '项目正在切换或已关闭', retryable: true } satisfies AppError);
    if (this.saving) return this.saving;
    this.clearTimers();
    this.status = 'saving'; this.saveError = null; this.notify();
    this.saving = (async () => {
      try {
        if (this.pendingEdits.size) await this.flushEdits();
        await this.submitDrafts();
        await this.persistSnapshot();
      } catch (cause) {
        const error = normalizeError(cause);
        this.saveError = this.commandError ? null : error;
        this.status = 'failed'; throw error;
      } finally {
        this.saving = null;
        if (this.hasPendingWork) this.schedule(this.status === 'failed' ? 5000 : 1000);
        this.notify();
      }
    })();
    return this.saving;
  }
  private async persistSnapshot() {
    this.status = 'saving'; this.saveError = null; this.notify();
    const { projectId, revision } = this.store.snapshot.document;
    const persisted = await this.api.save(projectId, revision);
    if (persisted !== revision) throw { code: 'SaveFailed', message: '保存版本与请求不一致', retryable: true } satisfies AppError;
    this.store.markPersisted(projectId, persisted);
    this.savedAt = new Date();
    this.status = this.commandError ? 'failed' : this.hasPendingWork ? 'unsaved' : 'saved';
  }
  /** Submit drafts while enqueue is available, then freeze admission and drain accepted work. */
  transition<T>(action: () => Promise<T>, discard?: boolean): Promise<T>;
  transition<T>(action: () => Promise<T>, discard: boolean, eligible: () => boolean): Promise<T | undefined>;
  async transition<T>(action: () => Promise<T>, discard = false, eligible?: () => boolean): Promise<T | undefined> {
    if (this.transitioning || this.disposed) throw { code: 'InvalidInput', message: '项目正在切换或已关闭', retryable: true } satisfies AppError;
    if (eligible && !eligible()) return;
    this.transitioning = true; this.clearTimers(); this.notify();
    let release: (() => void) | undefined;
    try {
      // Save As/discard must remain possible after a disk save fails.
      await this.saving?.catch(() => {});
      // Actions admitted before this transition must finish before freezing their queue.
      // Explicit discard may ignore their errors, but must still wait for every action.
      if (discard) { while (this.pendingEdits.size) await Promise.allSettled([...this.pendingEdits]); }
      else if (this.pendingEdits.size) await this.flushEdits();
      // Discard is explicit, but native close still requires the current authority revision.
      if (discard && this.queue.needsRefresh) await this.queue.refresh();
      if (!discard) await this.submitDrafts();
      // Playback can start while accepted edits/drafts are being drained. Defer
      // before beginTransition publishes editingDisabled and resets that intent.
      if (eligible && !eligible()) return;
      release = this.store.beginTransition();
      // Includes operations admitted just before the barrier, and serialized refreshes.
      if (discard) await this.queue.flush().catch(() => {});
      else { await this.queue.flush(); if (this.store.drafts.size) throw draftError(); }
      return await action();
    } catch (cause) {
      const error = normalizeError(cause);
      this.saveError = this.commandError ? null : error;
      this.status = 'failed'; throw error;
    } finally {
      release?.(); this.transitioning = false;
      if (this.hasPendingWork) this.schedule(this.status === 'failed' ? 5000 : 1000);
      this.notify();
    }
  }
  /** Recovery shares edit admission with media abandonment, before either can touch prepared PCM. */
  retryFailure(failureId: number, submit?: () => Promise<unknown>): Promise<unknown> {
    return this.enqueueEdit(() => this.retryAcceptedFailure(failureId, submit));
  }
  private async retryAcceptedFailure(failureId: number, submit?: () => Promise<unknown>) {
    // A prior accepted retry/abandonment may have resolved this captured UI callback.
    if (!this.queue.unresolvedFailures.some(f => f.id === failureId)) return;
    if (this.queue.needsRefresh) await this.queue.refresh();
    return submit ? submit() : this.queue.retry(failureId);
  }
  async retryFailures() {
    // Capture the failures reviewed by this user action, then recheck inside shared admission.
    const ids = this.queue.unresolvedFailures.map(f => f.id);
    await this.enqueueEdit(async () => {
      if (this.queue.needsRefresh) await this.queue.refresh();
      for (const id of ids) await this.retryAcceptedFailure(id);
    });
    await this.save();
  }
  /** Persist inside the transition barrier, using the same acknowledgement as normal Save. */
  transitionAfterSave<T>(action: () => Promise<T>): Promise<T>;
  transitionAfterSave<T>(action: () => Promise<T>, eligible: () => boolean): Promise<T | undefined>;
  transitionAfterSave<T>(action: () => Promise<T>, eligible?: () => boolean): Promise<T | undefined> {
    const saved = async () => {
      // A guarded retry already persisted this revision before a native busy
      // deferral. Saving it again schedules another NAS refresh and can starve
      // admission forever. transition has drained all accepted edits/drafts here.
      if (!eligible || this.store.isDirty || this.saveError) await this.persistSnapshot();
      return action();
    };
    return eligible ? this.transition(saved, false, eligible) : this.transition(saved);
  }
  close(discard = false): Promise<void> {
    if (this.closing) return this.closing;
    this.clearTimers();
    this.closing = this.transition(async () => {
      if (!discard) await this.persistSnapshot();
      const { projectId, revision } = this.store.snapshot.document;
      await this.api.close(projectId, revision, discard);
      this.dispose();
    }, discard).finally(() => { this.closing = null; });
    return this.closing;
  }
  dispose() { this.disposed = true; this.backgroundGuards.clear(); this.clearTimers(); this.unsubscribe(); this.store.deactivate(); }
}
