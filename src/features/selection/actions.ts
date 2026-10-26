import { toggleLabel } from '../annotations/labels';
import { annotationDisabled } from '../collaboration/capabilities';
import type { Annotation, Region } from '../../bridge/types';
import { normalizeError } from '../../bridge/client';
import type { ActiveProject } from '../project/useProjectLifecycle';
import { resolveSelection, sameRegion, validRegion, type Selection, SelectionState } from './state';
/** Resolve saved identities against current authority; temporary regions remain physical snapshots. */
export function resolveRegion(owner: ActiveProject, target: Selection): Region | null {
  return resolveSelection(owner.store.snapshot.document, target)?.region ?? null;
}
/** All durable actions enroll synchronously in the owner's save/close barrier. */
export function selectionActions(owner: ActiveProject, state: SelectionState) {
  const createdAnnotations = new WeakMap<Selection, string>();
  const run = (action: () => Promise<unknown>) => {
    if (owner.store.editingDisabled) return Promise.resolve();
    return owner.lifecycle.enqueueEdit(async () => { await owner.lifecycle.submitDrafts(); return action(); }).catch(cause => { owner.store.setError(normalizeError(cause)); });
  };
  const resolve = (target: Selection) => resolveRegion(owner, target);
  const annotate = (target: Selection, categoryId: string | null | undefined, focus?: (id: string) => void) => run(async () => {
    const region = resolve(target); if (!region) return;
    if(annotationDisabled(owner))return;
    const doc = owner.store.snapshot.document;
    if (categoryId && !doc.categories.some(c => c.id === categoryId)) return;
    const id = target.object?.kind === 'annotation' ? target.object.id : createdAnnotations.get(target);
    const existing = doc.annotations.find(a => a.id === id);
    let annotation: Annotation;
    if (existing) {
      annotation = existing;
      if (categoryId !== undefined && (categoryId !== null || existing.categoryIds.length > 0)) {
        annotation = { ...existing, categoryIds: toggleLabel(existing.categoryIds, categoryId), updatedAt: new Date().toISOString() };
        await owner.queue.enqueue({ type: 'updateAnnotation', annotation }, { owner: 'annotations' });
      }
    } else {
      // An earlier creation that was subsequently removed must not resurrect itself.
      if (id) return;
      const now = new Date().toISOString();
      annotation = { id: crypto.randomUUID(), region: { ...region }, categoryIds: categoryId ? [categoryId] : [], note: '', createdAt: now, updatedAt: now };
      await owner.queue.enqueue({ type: 'addAnnotation', annotation }, { owner: 'annotations' });
      createdAnnotations.set(target, annotation.id);
    }
    const current = state.getActiveSelection();
    const bound = state.bind(target, { kind: 'annotation', id: annotation.id });
    if (focus && (bound || current?.object?.kind === 'annotation' && current.object.id === annotation.id)) focus(annotation.id);
  });
  return {
    classify: (target: Selection, categoryId: string | null) => annotate(target, categoryId),
    note: (target: Selection, focus: (id: string) => void) => annotate(target, undefined, focus),
    gain: (target: Selection, gainDb: number) => run(async () => {
      const region = resolve(target); if (!region || !Number.isFinite(gainDb) || gainDb < -60 || gainDb > 24) return false;
      if (gainDb === 0) return true;
      await owner.queue.enqueue({ type: 'addEdit', edit: { id: crypto.randomUUID(), region: { ...region }, enabled: true, processingVersion: 2, operation: { type: 'gain', gainDb } } }, { owner: 'masks', onAccepted: () => state.clear(target) });
      state.clear(target); return true;
    }),
    mask: (target: Selection) => run(async () => {
      const region = resolve(target); if (!region) return;
      const existing = owner.store.snapshot.document.edits.find(e => e.operation.type==='mask' && sameRegion(e.region, region));
      const edit = existing ? { ...existing, enabled: true } : { id: crypto.randomUUID(), region: { ...region }, enabled: true, processingVersion: 2 as const, operation: {type: 'mask' as const} };
      if (!existing || !existing.enabled) await owner.queue.enqueue(existing ? { type: 'updateEdit', edit } : { type: 'addEdit', edit }, { owner: 'masks', onAccepted: () => state.clear(target) });
      state.clear(target);
    }),
    remove: (target: Selection) => run(async () => {
      if (!target.object || !resolve(target)) return;
      const { kind, id } = target.object;
      if(kind==='annotation'&&annotationDisabled(owner))return;
      await owner.queue.enqueue(kind === 'annotation' ? { type: 'removeAnnotation', id } : { type: 'removeEdit', id }, { owner: kind === 'annotation' ? 'annotations' : 'masks' });
      state.reconcile(owner.store.snapshot.document);
    }),
    toggleMask: (target: Selection) => run(async () => {
      if (target.object?.kind !== 'mask') return;
      const edit = owner.store.snapshot.document.edits.find(e => e.id === target.object!.id);
      if (edit) await owner.queue.enqueue({ type: 'updateEdit', edit: { ...edit, enabled: !edit.enabled } }, { owner: 'masks' });
    }),
    move: (target: Selection, region: Region) => run(async () => {
      const latest = resolve(target);
      // A gesture proposal is relative to its captured geometry. History or
      // accepted edits that changed it win over this now-obsolete proposal.
      if (!latest || !sameRegion(latest, target.region) || !validRegion(owner.store.snapshot.document, region) || !target.object) return;
      const { kind, id } = target.object, doc = owner.store.snapshot.document;
      if (kind === 'annotation') {
        if(annotationDisabled(owner))return;
        const annotation = doc.annotations.find(a => a.id === id)!;
        await owner.queue.enqueue({ type: 'updateAnnotation', annotation: { ...annotation, region, updatedAt: new Date().toISOString() } }, { owner: 'annotations' });
      } else {
        const edit = doc.edits.find(e => e.id === id)!;
        await owner.queue.enqueue({ type: 'updateEdit', edit: { ...edit, region } }, { owner: 'masks' });
      }
    }),
  };
}
