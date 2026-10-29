import { parseChange, type AppError, type Change, type ProjectDocument, type ProjectSnapshot } from '../bridge/types';

/** Target identity comes from the pre-retirement document, never note text or UI owner. */
export function changeMediaIds(change: Change, doc: ProjectDocument): string[] {
  if ('mediaId' in change) return [change.mediaId];
  if ('annotation' in change) return [change.annotation.region.mediaId];
  if ('edit' in change) return [change.edit.region.mediaId];
  if ('media' in change) return [change.media.id];
  if ('items' in change) return change.items.map(m => m.id);
  if ('id' in change && change.type !== 'removeCategory') {
    const target = (change.type === 'removeEdit' || change.type === 'setEditEnabled' ? doc.edits : doc.annotations).find(a => a.id === change.id);
    return target ? [target.region.mediaId] : [];
  }
  return [];
}

/** Runtime state is separate from the serializable authority document. */
export class ProjectStore {
  snapshot: ProjectSnapshot;
  persistedRevision: number;
  private readonly draftValues = new Map<string, string>();
  private readonly draftTargets = new Map<string, { value: string; target?: string; mediaIds: readonly string[] }>();
  private readonly retired = new Set<string>();
  private readonly retiredObjects = new Set<string>();
  private readonly retirementListeners = new Set<(ids: ReadonlySet<string>, before: ProjectDocument) => void>();
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
  isRetired(id: string) { return this.retired.has(id); }
  onRetirement(listener: (ids: ReadonlySet<string>, before: ProjectDocument) => void) { this.retirementListeners.add(listener); return () => { this.retirementListeners.delete(listener); }; }
  targetsRetired(change: Change) { return this.retired.size > 0 && (changeMediaIds(change, this.snapshot.document).some(id => this.retired.has(id)) || ('id' in change && change.type !== 'removeCategory' && this.retiredObjects.has(change.id))); }
  projectChange(change: Change): Change { return this.retired.size && change.type === 'updateViewState' ? { ...change, viewState: this.projectView(change.viewState) } : change; }
  private projectView(view: ProjectDocument['viewState']) {
    return { ...view, media: Object.fromEntries(Object.entries(view.media).filter(([id]) => !this.retired.has(id))), activeMediaId: view.activeMediaId && !this.retired.has(view.activeMediaId) ? view.activeMediaId : null, compareMediaId: view.compareMediaId && !this.retired.has(view.compareMediaId) ? view.compareMediaId : null };
  }
  private projectSnapshot(snapshot: ProjectSnapshot): ProjectSnapshot {
    const d = snapshot.document;
    return { ...snapshot, document: { ...d, media: d.media.filter(m => !this.retired.has(m.id)), annotations: d.annotations.filter(a => !this.retired.has(a.region.mediaId)), edits: d.edits.filter(e => !this.retired.has(e.region.mediaId)), analysis: Object.fromEntries(Object.entries(d.analysis).filter(([id]) => !this.retired.has(id))), playbackMix: Object.fromEntries(Object.entries(d.playbackMix).filter(([id]) => !this.retired.has(id))), viewState: this.projectView(d.viewState) } };
  }
  /** Only native trusted retirement is allowed to remove references without adopting a new catalog. */
  retire(ids: readonly string[], snapshot: ProjectSnapshot) {
    if (snapshot.document.projectId !== this.snapshot.document.projectId) throw new Error('Retirement belongs to another project');
    const added = new Set(ids.filter(id => !this.retired.has(id))); if (!added.size) return;
    const before = this.snapshot.document;
    for (const id of added) this.retired.add(id);
    for (const target of [...before.annotations, ...before.edits]) if (this.retired.has(target.region.mediaId)) this.retiredObjects.add(target.id);
    for (const [key, value] of this.draftValues) {
      const projected = this.projectDraft(key, value, before);
      if (projected === undefined) { this.draftValues.delete(key); this.draftTargets.delete(key); } else this.draftValues.set(key, projected);
    }
    this.snapshot = this.projectSnapshot(snapshot.document.revision >= before.revision ? snapshot : this.snapshot);
    this.retirementListeners.forEach(listener => listener(added, before)); this.notify();
  }
  private projectDraft(key: string, value: string, before = this.snapshot.document): string | undefined {
    const captured = this.draftTargets.get(key);
    if (captured?.value === value && captured.mediaIds.some(id => this.retired.has(id))) return undefined;
    let parsed: unknown;
    try { parsed = JSON.parse(value); } catch { return value; } // Opaque non-JSON drafts have no target identity.
    if (this.draftTargetsRetired(parsed, before)) return undefined;
    if (key === 'spectrogram-view') {
      const change = parseChange({ type: 'updateViewState', viewState: parsed });
      return JSON.stringify((this.projectChange(change) as Extract<Change, {type:'updateViewState'}>).viewState);
    }
    if (key === 'collaboration:playback-preferences') {
      const prefs = parsed as { mediaMonitorGainDb?: Record<string, unknown> };
      return prefs && typeof prefs === 'object' && prefs.mediaMonitorGainDb ? JSON.stringify({ ...prefs, mediaMonitorGainDb: Object.fromEntries(Object.entries(prefs.mediaMonitorGainDb).filter(([id]) => !this.retired.has(id))) }) : value;
    }
    let change: Change;
    try { change = parseChange(parsed); } catch { return value; } // Other draft owners retain their own validation contract.
    if (change.type === 'updateViewState') return JSON.stringify({ ...change, viewState: this.projectView(change.viewState) });
    if (changeMediaIds(change, before).some(id => this.retired.has(id)) || this.targetsRetired(change)) return undefined;
    return value;
  }
  /** Inputs can be temporarily invalid (for example an empty bounds field).
   * Read only supported operation identities here; submission still uses parseChange. */
  private draftTargetsRetired(value: unknown, before: ProjectDocument): boolean {
    const record = (v: unknown): Record<string, unknown> | null => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
    const id = (v: unknown): string | null => typeof v === 'string' && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(v) ? v : null;
    const retired = (v: unknown) => { const target = id(v); return target !== null && this.retired.has(target); };
    const change = record(value); if (!change) return false;
    switch (change.type) {
      case 'removeMedia': case 'setMediaCategories': case 'setChannelCategories': case 'updateMediaNote': case 'updateChannelNote': case 'resetMediaMasks': case 'updateAnalysis': case 'updatePlaybackMix': return retired(change.mediaId);
      case 'addAnnotation': case 'updateAnnotation': case 'addEdit': case 'updateEdit': {
        const target = record(change.type === 'addAnnotation' || change.type === 'updateAnnotation' ? change.annotation : change.edit);
        return !!target && (this.retiredObjects.has(id(target.id) ?? '') || retired(record(target.region)?.mediaId));
      }
      case 'updateAnnotationNote': case 'removeAnnotation': case 'removeEdit': case 'setEditEnabled': {
        const target = id(change.id);
        const objects = change.type === 'removeEdit' || change.type === 'setEditEnabled' ? before.edits : before.annotations;
        return target !== null && (this.retiredObjects.has(target) || objects.some(object => object.id === target && this.retired.has(object.region.mediaId)));
      }
      case 'importMedia': case 'relinkMedia': return retired(record(change.media)?.id);
      default: return false;
    }
  }
  accept(snapshot: ProjectSnapshot) {
    if (snapshot.document.projectId !== this.snapshot.document.projectId) throw new Error('Snapshot belongs to another project');
    if (snapshot.document.revision < this.dirtyRevision) { if (this.retired.size) return; throw new Error('Stale project snapshot'); }
    this.snapshot = this.retired.size ? this.projectSnapshot(snapshot) : snapshot;
    this.notify();
  }
  setError(error: AppError | null) { this.error = error; this.notify(); }
  setDraft(key: string, value: string) {
    this.assertEditable();
    // Bind only this value's target while annotation/edit identity is still known.
    // Temporarily invalid input retains the existing identity-only validation.
    let mediaIds: string[] = [];
    let identity: string | undefined;
    let change: unknown;
    try { change = JSON.parse(value); }
    catch { /* Opaque draft owners retain their own serialization contract. */ }
    if (change !== null && typeof change === 'object' && 'type' in change) {
      const target = change as Record<string, unknown>;
      if (target.type === 'updateAnnotationNote' || target.type === 'removeAnnotation' || target.type === 'removeEdit' || target.type === 'setEditEnabled') {
        const objects = target.type === 'removeEdit' || target.type === 'setEditEnabled' ? this.snapshot.document.edits : this.snapshot.document.annotations;
        const object = objects.find(o => o.id === target.id);
        if (typeof target.id === 'string') identity = `${target.type === 'removeEdit' || target.type === 'setEditEnabled' ? 'edit' : 'annotation'}:${target.id}`;
        if (object) mediaIds = [object.region.mediaId];
        else {
          const previous = this.draftTargets.get(key);
          if (identity !== undefined && previous?.target === identity && previous.value === this.draftValues.get(key)) mediaIds = [...previous.mediaIds];
        }
      }
    }
    // Replace metadata before projection: a reused key may now contain B typing.
    this.draftTargets.set(key, { value, target: identity, mediaIds });
    const projected = this.retired.size ? this.projectDraft(key, value) : value;
    if (projected !== undefined) { this.draftValues.set(key, projected); this.draftTargets.set(key, { value: projected, target: identity, mediaIds }); }
    else { this.draftValues.delete(key); this.draftTargets.delete(key); }
    this.notify();
  }
  /** First submission may follow an ordinary snapshot that no longer contains its object.
   * Borrow only the current, strictly valid draft's identical flat operation/value. */
  captureChangeMediaIds(change: Change, draftKey?: string, draftValue?: string): readonly string[] {
    const current = changeMediaIds(change, this.snapshot.document);
    if (current.length || draftKey === undefined || draftValue === undefined) return current;
    if (change.type !== 'updateAnnotationNote' && change.type !== 'removeAnnotation' && change.type !== 'removeEdit' && change.type !== 'setEditEnabled') return current;
    const binding = this.draftTargets.get(draftKey);
    const target = `${change.type === 'removeEdit' || change.type === 'setEditEnabled' ? 'edit' : 'annotation'}:${change.id}`;
    if (binding?.target !== target || binding.value !== draftValue || this.draftValues.get(draftKey) !== draftValue) return current;
    let draft: Change;
    try { draft = parseChange(JSON.parse(draftValue)); }
    catch { return current; } // Invalid in-progress input cannot authorize a different valid command.
    // These four supported operations contain only primitive fields. Comparing every
    // field preserves value/operation identity without depending on JSON key order.
    if (!Object.entries(change).every(([key, value]) => Object.is((draft as unknown as Record<string, unknown>)[key], value))) return current;
    return [...binding.mediaIds];
  }
  clearDraftIfUnchanged(key: string, value: string | undefined) {
    if (this.draftValues.get(key) === value) { this.draftValues.delete(key); this.draftTargets.delete(key); this.notify(); }
  }
  markPersisted(projectId: string, revision: number) {
    if (projectId !== this.snapshot.document.projectId) return;
    if (!Number.isSafeInteger(revision) || revision < 0 || revision > this.dirtyRevision) throw new Error('Invalid saved revision');
    this.persistedRevision = Math.max(this.persistedRevision, revision);
    this.notify();
  }
}
