import { parseChange, type AppError, type Change, type ProjectSnapshot } from '../bridge/types';
import { normalizeError } from '../bridge/client';
import { ProjectStore } from './store';

export interface ProjectCommands {
  applyChange(projectId: string, expectedRevision: number, change: Change): Promise<ProjectSnapshot>;
  getSnapshot(projectId: string): Promise<ProjectSnapshot>;
  undo(projectId: string, expectedRevision: number): Promise<ProjectSnapshot>;
  redo(projectId: string, expectedRevision: number): Promise<ProjectSnapshot>;
}
type CommandOwner = 'annotations' | 'masks' | 'playback' | `media:${string}`;
type QueuedCommand = (
  | { kind: 'change'; change: Change; mediaIds: readonly string[]; draftKey?: string; draft?: string }
  | { kind: 'undo' | 'redo' }) & { owner?: CommandOwner; onAccepted?: () => void };
export interface CommandFailure { id: number; error: AppError; draftKey?: string; owner?: CommandOwner }
interface FailedCommand { command: QueuedCommand; error: AppError }

function changeTarget(change: Change): string {
  const target = 'mediaId' in change ? [change.mediaId, 'channelIndex' in change ? change.channelIndex : null]
    : 'id' in change ? change.id
    : 'items' in change ? change.items.map(m=>m.id)
    : 'media' in change ? change.media.id
    : 'category' in change ? change.category.id
    : 'annotation' in change ? change.annotation.id
    : 'edit' in change ? change.edit.id : null;
  return JSON.stringify([change.type, target]);
}

export class CommandQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private blocked: AppError | null = null;
  private blockedCommand: QueuedCommand | null = null;
  private readonly pendingCommands = new Set<{command: QueuedCommand; cancelledBy: QueuedCommand | null}>();
  private nextFailureId = 0;
  private readonly failures = new Map<number, FailedCommand>();
  private readonly retrying = new Set<number>();
  constructor(private readonly store: ProjectStore, private readonly api: ProjectCommands) {
    store.onRetirement(() => {
      for (const [id, failure] of this.failures) if (this.targetsRetired(failure.command)) this.failures.delete(id);
      if (this.blockedCommand && this.targetsRetired(this.blockedCommand)) { this.blocked = null; this.blockedCommand = null; }
      this.publishError();
    });
  }

  enqueue(change: Change, options: { draftKey?: string; owner?: CommandOwner; onAccepted?: () => void } = {}): Promise<ProjectSnapshot> {
    // Capture caller values now; text may continue changing while the queue runs.
    const captured = structuredClone(parseChange(change));
    const draft = options.draftKey === undefined ? undefined : this.store.drafts.get(options.draftKey);
    return this.run({ kind: 'change', change: captured, mediaIds: this.store.captureChangeMediaIds(captured, options.draftKey, draft), draftKey: options.draftKey, draft, owner: options.owner, onAccepted: options.onAccepted });
  }
  undo(options: { owner?: CommandOwner } = {}) { return this.run({ kind: 'undo', owner: options.owner }); }
  redo(options: { owner?: CommandOwner } = {}) { return this.run({ kind: 'redo', owner: options.owner }); }
  get needsRefresh() { return this.blocked !== null; }
  get unresolvedFailures(): readonly CommandFailure[] {
    return [...this.failures].map(([id, failure]) => ({
      id, error: structuredClone(failure.error),
      owner: failure.command.owner,
      draftKey: failure.command.kind === 'change' ? failure.command.draftKey : undefined,
    }));
  }
  async flush(): Promise<void> {
    let tail: Promise<unknown>;
    do { tail = this.tail; await tail; } while (tail !== this.tail);
    const failure = this.failures.values().next().value;
    if (failure) throw failure.error;
    if (this.blocked) throw this.blocked;
  }
  /** Explicitly retry a reviewed failure. Corrections must keep its operation and target. */
  retry(failureId: number, correction?: Change): Promise<ProjectSnapshot> {
    this.store.assertEditable();
    const failure = this.getFailure(failureId);
    let command = failure.command;
    if (correction !== undefined) {
      const captured = structuredClone(parseChange(correction));
      if (command.kind !== 'change' || changeTarget(command.change) !== changeTarget(captured)) {
        throw new Error('A correction must address the same failed operation and target');
      }
      command = { ...command, change: captured, draft: command.draftKey === undefined ? undefined : this.store.drafts.get(command.draftKey) };
    }
    this.retrying.add(failureId);
    return this.run(command, failureId).finally(() => { this.retrying.delete(failureId); });
  }
  /** User acknowledgement of discarding this failed edit, never an automatic success path. */
  discardFailure(failureId: number): void {
    this.store.assertEditable();
    const { command } = this.getFailure(failureId);
    this.failures.delete(failureId);
    if (command.kind === 'change' && command.draftKey !== undefined) {
      this.store.clearDraftIfUnchanged(command.draftKey, command.draft);
    }
    this.publishError();
  }
  private getFailure(failureId: number): FailedCommand {
    const failure = this.failures.get(failureId);
    if (!failure || this.retrying.has(failureId)) throw new Error('Failure is unknown or already being retried');
    return failure;
  }
  private publishError() {
    this.store.setError(this.failures.values().next().value?.error ?? this.blocked);
  }

  /** Explicit retry after a failed conflict refresh; never replays a mutation. */
  refresh(): Promise<void> {
    this.store.assertEditable();
    const next = this.tail.then(async () => {
      this.store.accept(await this.api.getSnapshot(this.store.snapshot.document.projectId));
      this.blocked = null;
      this.blockedCommand = null;
      this.publishError();
    });
    this.tail = next.catch(() => undefined);
    return next;
  }
  private targetsRetired(command: QueuedCommand): boolean {
    return command.kind === 'change' && (command.mediaIds.some(id => this.store.isRetired(id)) || this.store.targetsRetired(command.change));
  }
  private run(command: QueuedCommand, failureId?: number): Promise<ProjectSnapshot> {
    this.store.assertEditable();
    const admission = {command, cancelledBy: null as QueuedCommand | null};
    this.pendingCommands.add(admission);
    const next = this.tail.then(async () => {
      const { projectId, revision } = this.store.snapshot.document;
      if (this.targetsRetired(command)) return this.store.snapshot;
      let attempted = false;
      try {
        const cancelledBy = admission.cancelledBy;
        if (this.blocked || cancelledBy && !(this.targetsRetired(cancelledBy))) throw this.blocked ?? { code: 'RevisionConflict', message: 'Queued change cancelled after conflict; review refreshed content', retryable: false } satisfies AppError;
        attempted = true;
        const snapshot = command.kind === 'change'
          ? await this.api.applyChange(projectId, revision, this.store.projectChange(command.change))
          : await this.api[command.kind](projectId, revision);
        this.store.accept(snapshot);
        if (failureId !== undefined) this.failures.delete(failureId);
        if (command.kind === 'change' && command.draftKey !== undefined) {
          this.store.clearDraftIfUnchanged(command.draftKey, command.draft);
        }
        this.publishError();
        return this.store.snapshot;
      } catch (cause) {
        if (this.targetsRetired(command)) return this.store.snapshot;
        const error = normalizeError(cause);
        if (attempted && error.code === 'RevisionConflict') {
          this.blocked = error;
          this.blockedCommand = command;
          // Remember why each already queued command was stopped. Trusted retirement
          // can invalidate that exact cause without cancelling unrelated survivor work.
          for (const pending of this.pendingCommands) if (pending !== admission) pending.cancelledBy ??= command;
          try { this.store.accept(await this.api.getSnapshot(projectId)); this.blocked = null; }
          catch { /* Keep blocked until explicit refresh succeeds; retain all drafts. */ }
          if (this.targetsRetired(command)) { this.blocked = null; this.blockedCommand = null; this.publishError(); return this.store.snapshot; }
          if (!this.blocked) this.blockedCommand = null;
        }
        this.failures.set(failureId ?? ++this.nextFailureId, { command, error });
        this.publishError();
        throw error;
      }
    });
    // UI completion belongs after native acknowledgement. A local observer
    // error must never make an accepted edit available for replay.
    const accepted = next.then(snapshot => { if (!this.targetsRetired(command)) command.onAccepted?.(); return snapshot; });
    this.tail = accepted.catch(() => undefined);
    return accepted.finally(() => { this.pendingCommands.delete(admission); });
  }
}
