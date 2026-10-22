import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { Annotation, Change, Region } from '../../bridge/types';
import { normalizeError } from '../../bridge/client';
import type { ActiveProject } from '../project/useProjectLifecycle';
import { shortcutAction } from '../project/shortcuts';
import { AnnotationDrafts } from './drafts';
export type Tool = 'select' | 'annotate' | 'mask';
export function useAnnotations(active: ActiveProject | null) {
  const [tool, setTool] = useState<Tool>('select'), [selectedId, select] = useState<string | null>(null), [cancelVersion, setCancel] = useState(0);
  const drafts = useMemo(() => active ? new AnnotationDrafts(active) : null, [active]);
  useEffect(() => { select(null); return () => drafts?.dispose(); }, [drafts]);
  const run = (action: () => Promise<unknown>) => {
    if (!active || active.store.editingDisabled) return;
    const owner = active;
    void owner.lifecycle.enqueueEdit(async () => { owner.store.assertEditable(); await owner.lifecycle.submitDrafts(); return action(); }).catch(cause => { owner.store.setError(normalizeError(cause)); });
  };
  const command = (change: Change) => run(() => active!.queue.enqueue(change, { owner: 'annotations' }));
  const mutate = (id: string, patch: Partial<Pick<Annotation, 'region' | 'categoryId'>>) => run(async () => {
    const annotation = active!.store.snapshot.document.annotations.find(a => a.id === id);
    if (annotation) await active!.queue.enqueue({ type: 'updateAnnotation', annotation: { ...annotation, ...patch, updatedAt: new Date().toISOString() } }, { owner: 'annotations' });
  });
  const history = (kind: 'undo' | 'redo') => run(async () => { if (active!.store.snapshot[kind === 'undo' ? 'canUndo' : 'canRedo']) await active!.queue[kind]({ owner: 'annotations' }); });
  const remove = () => { if (selectedId) run(async () => { if (active!.store.snapshot.document.annotations.some(a => a.id === selectedId)) await active!.queue.enqueue({ type: 'removeAnnotation', id: selectedId }, { owner: 'annotations' }); }); };
  const cancel = () => { setCancel(v => v + 1); select(null); };
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if (!active || active.store.editingDisabled || e.defaultPrevented) return;
      const action = shortcutAction(e); if (!action) return;
      if (action === 'delete' && !selectedId) return;
      e.preventDefault();
      if (action === 'undo' || action === 'redo') history(action);
      else if (action === 'delete') remove();
      else if (action === 'cancel') cancel();
      else setTool(action);
    };
    window.addEventListener('keydown', listener); return () => window.removeEventListener('keydown', listener);
  // Keep other selection listeners installed if React commits during this event.
  }, [active, selectedId]);
  return { active, drafts, tool, setTool, selectedId, select, cancelVersion, cancel, command, mutate, history, remove,
    create: (region: Region) => {
      const id = crypto.randomUUID(), now = new Date().toISOString();
      run(async () => { await active!.queue.enqueue({ type: 'addAnnotation', annotation: { id, region, categoryId: null, note: '', createdAt: now, updatedAt: now } }, { owner: 'annotations' }); select(id); });
    },
  };
}
export type AnnotationUI = ReturnType<typeof useAnnotations>;
export const AnnotationContext = createContext<AnnotationUI | null>(null);
export const useAnnotationContext = () => useContext(AnnotationContext);
