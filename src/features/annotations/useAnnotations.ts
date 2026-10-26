import { toggleLabel } from './labels';
import { annotationDisabled } from '../collaboration/capabilities';
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { classifyTarget, type ClassificationTarget } from './classification';
import type { Annotation, Change } from '../../bridge/types';
import { normalizeError } from '../../bridge/client';
import type { ActiveProject } from '../project/useProjectLifecycle';
import { shortcutAction } from '../project/shortcuts';
import { AnnotationDrafts } from './drafts';
import type { SelectionUI } from '../selection/useSelection';
export function useAnnotations(active: ActiveProject | null, selection?: SelectionUI) {
  const binding = useRef(active); binding.current = active;
  useEffect(() => { binding.current = active; return () => { binding.current = null; }; }, [active]);
  const [fallbackId, setFallbackId] = useState<string | null>(null);
  const selectedId = selection ? selection.selection?.object?.kind === 'annotation' ? selection.selection.object.id : null : fallbackId;
  const select = (id: string | null) => selection ? selection.selectObject('annotation', id) : setFallbackId(id);
  const drafts = useMemo(() => active ? new AnnotationDrafts(active) : null, [active]);
  useEffect(() => { setFallbackId(null); return () => drafts?.dispose(); }, [drafts]);
  const run = (action: () => Promise<unknown>,publicWrite=true) => {
    if (!active || active.store.editingDisabled || publicWrite&&annotationDisabled(active)) return;
    const owner = active;
    void owner.lifecycle.enqueueEdit(async () => { owner.store.assertEditable(); await owner.lifecycle.submitDrafts(); return action(); }).catch(cause => { owner.store.setError(normalizeError(cause)); });
  };
  const command = (change: Change) => run(() => active!.queue.enqueue(change, { owner: 'annotations' }));
  const mutate = (id: string, patch: Partial<Pick<Annotation, 'region' | 'categoryIds'>>) => run(async () => {
    const annotation = active!.store.snapshot.document.annotations.find(a => a.id === id);
    if (annotation) await active!.queue.enqueue({ type: 'updateAnnotation', annotation: { ...annotation, ...patch, updatedAt: new Date().toISOString() } }, { owner: 'annotations' });
  });
  const classifyAnnotation = (id: string, categoryId: string | null) => run(async () => {
    const doc = active!.store.snapshot.document, annotation = doc.annotations.find(a => a.id === id);
    if (annotation && (categoryId === null || doc.categories.some(c => c.id === categoryId))) await active!.queue.enqueue({ type: 'updateAnnotation', annotation: { ...annotation, categoryIds: toggleLabel(annotation.categoryIds, categoryId), updatedAt: new Date().toISOString() } }, { owner: 'annotations' });
  });
  const history = (kind: 'undo' | 'redo') => run(async () => { if (active!.store.snapshot[kind === 'undo' ? 'canUndo' : 'canRedo']) await active!.queue[kind]({ owner: 'annotations' }); },false);
  const remove = () => { if (selectedId) run(async () => { if (active!.store.snapshot.document.annotations.some(a => a.id === selectedId)) await active!.queue.enqueue({ type: 'removeAnnotation', id: selectedId }, { owner: 'annotations' }); }); };
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if (!active || active.store.editingDisabled || e.defaultPrevented) return;
      const action = shortcutAction(e);
      if (action === 'undo' || action === 'redo') { e.preventDefault(); history(action); }
    };
    window.addEventListener('keydown', listener); return () => window.removeEventListener('keydown', listener);
  }, [active]);
  const classify = (target: ClassificationTarget, categoryId: string | null) => active ? classifyTarget(active, target, categoryId, () => binding.current === active) : Promise.resolve();
  return { active, drafts, selectedId, select, command, mutate, classifyAnnotation, history, remove, classify };
}
export type AnnotationUI = ReturnType<typeof useAnnotations>;
export const AnnotationContext = createContext<AnnotationUI | null>(null);
export const useAnnotationContext = () => useContext(AnnotationContext);
