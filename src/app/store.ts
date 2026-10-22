import type { AppError, ProjectSnapshot } from '../bridge/types';

/** Runtime state is separate from the serializable authority document. */
export class ProjectStore {
  snapshot: ProjectSnapshot;
  persistedRevision: number;
  private readonly draftValues = new Map<string, string>();
  private transitioning = false;
  private inactive = false;
  error: AppError | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(snapshot: ProjectSnapshot, persistedRevision = snapshot.document.revision) {
    this.snapshot = snapshot;
    this.persistedRevision = persistedRevision;
  }
  get dirtyRevision() { return this.snapshot.document.revision; }
  get isDirty() { return this.dirtyRevision > this.persistedRevision; }
  get drafts(): ReadonlyMap<string, string> { return this.draftValues; }
  get editingDisabled() { return this.transitioning || this.inactive; }
  assertEditable() {
    if (this.editingDisabled) throw { code: 'InvalidInput', message: '项目正在切换或已关闭，请稍后再编辑。', retryable: true } satisfies AppError;
  }
  /** Reject new renderer edits while accepted commands finish and native ownership changes. */
  beginTransition(): () => void {
    this.assertEditable();
    this.transitioning = true; this.notify();
    let released = false;
    return () => { if (!released) { released = true; this.transitioning = false; this.notify(); } };
  }
  deactivate() { this.inactive = true; this.notify(); }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private notify() { this.listeners.forEach((listener) => listener()); }
  accept(snapshot: ProjectSnapshot) {
    if (snapshot.document.projectId !== this.snapshot.document.projectId) throw new Error('Snapshot belongs to another project');
    if (snapshot.document.revision < this.dirtyRevision) throw new Error('Stale project snapshot');
    this.snapshot = snapshot;
    this.notify();
  }
  setError(error: AppError | null) { this.error = error; this.notify(); }
  setDraft(key: string, value: string) { this.assertEditable(); this.draftValues.set(key, value); this.notify(); }
  clearDraftIfUnchanged(key: string, value: string | undefined) {
    if (this.draftValues.get(key) === value) { this.draftValues.delete(key); this.notify(); }
  }
  markPersisted(projectId: string, revision: number) {
    if (projectId !== this.snapshot.document.projectId) return;
    if (!Number.isSafeInteger(revision) || revision < 0 || revision > this.dirtyRevision) throw new Error('Invalid saved revision');
    this.persistedRevision = Math.max(this.persistedRevision, revision);
    this.notify();
  }
}
