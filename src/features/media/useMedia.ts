import { useEffect, useState, useSyncExternalStore } from 'react';
import { mediaClient, mediaDialogs, type MediaStatus } from '../../bridge/media';
import { normalizeError } from '../../bridge/client';
import type { ActiveProject } from '../project/useProjectLifecycle';
import type { AppError, MediaDescriptor } from '../../bridge/types';
import { MediaImportController } from './imports';
const none = () => () => {};
const zero = () => 0;
export function useMedia(active: ActiveProject | null) {
  const [binding, setBinding] = useState<{ owner: ActiveProject; controller: MediaImportController } | null>(null);
  const controller = binding?.owner === active ? binding?.controller ?? null : null;
  useSyncExternalStore(controller?.subscribe ?? none, controller?.getVersion ?? zero);
  const [statuses, setStatuses] = useState<MediaStatus[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [relink, setRelink] = useState<MediaDescriptor | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  useEffect(() => {
    const next = active ? new MediaImportController(active.store, active.queue, mediaClient) : null;
    setBinding(active && next ? { owner: active, controller: next } : null);
    setStatuses([]); setSelectedId(active?.store.snapshot.document.viewState.activeMediaId ?? null); setRelink(null); setError(null);
    return () => next?.dispose();
  }, [active]);
  const sourceKey = active?.store.snapshot.document.media.map(m => `${m.id}:${m.sha256}:${m.sourceRef}`).join('|');
  useEffect(() => {
    if (!active) return;
    let disposed = false;
    let pending = false;
    const refresh = () => {
      if (pending || active.store.editingDisabled) return;
      pending = true;
      void mediaClient.status(active.store.snapshot.document.projectId).then(value => { if (!disposed) setStatuses(old => JSON.stringify(old) === JSON.stringify(value) ? old : value); }).catch(e => { if (!disposed) setError(normalizeError(e)); }).finally(() => { pending = false; });
    };
    refresh(); const timer = setInterval(refresh, 1500);
    window.addEventListener('focus', refresh);
    return () => { disposed = true; clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, [active, sourceKey, controller?.busy]);
  const choose = async (target?: MediaDescriptor) => {
    if (!active || !controller || active.store.editingDisabled || controller.busy) return;
    try {
      const paths = await mediaDialogs.choose(!target);
      if (!paths || active.store.editingDisabled) return;
      setRelink(null); setError(null);
      await controller.start(Array.isArray(paths) ? paths : [paths], target?.id);
    } catch (e) { setError(normalizeError(e)); }
  };
  const media = active?.store.snapshot.document.media ?? [];
  const selected = media.find(m => m.id === selectedId) ?? media.find(m => m.id === active?.store.snapshot.document.viewState.activeMediaId) ?? media[0] ?? null;
  return { controller, statuses, selected, selectedId: selected?.id ?? null, setSelectedId, relink, setRelink, error,
    disabled: !active || !controller || active.store.editingDisabled || controller.busy,
    choose: () => void choose(), chooseRelink: () => void choose(relink ?? undefined),
    verify: () => { if (relink && controller && !active?.store.editingDisabled) { const target = relink; setRelink(null); void controller.start([target.sourceRef], target.id).catch(e => setError(normalizeError(e))); } },
  };
}
export type MediaUI = ReturnType<typeof useMedia>;
