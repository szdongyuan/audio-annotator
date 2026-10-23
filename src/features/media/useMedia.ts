import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { mediaClient, mediaDialogs, type MediaStatus } from '../../bridge/media';
import { normalizeError } from '../../bridge/client';
import type { ActiveProject } from '../project/useProjectLifecycle';
import type { AppError, MediaDescriptor } from '../../bridge/types';
import { MediaImportController } from './imports';
import { FolderImportController } from './folderImport';
import { folderClient } from '../../bridge/folders';
const none = () => () => {};
const zero = () => 0;
export function useMedia(active: ActiveProject | null) {
  const current = useRef(active); current.current = active;
  const [binding, setBinding] = useState<{ owner: ActiveProject; controller: MediaImportController; folder: FolderImportController } | null>(null);
  const controller = binding?.owner === active ? binding?.controller ?? null : null;
  const folder = binding?.owner === active ? binding?.folder ?? null : null;
  useSyncExternalStore(controller?.subscribe ?? none, controller?.getVersion ?? zero);
  useSyncExternalStore(folder?.subscribe ?? none, folder?.getVersion ?? zero);
  const [statuses, setStatuses] = useState<MediaStatus[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [relink, setRelink] = useState<MediaDescriptor | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  useEffect(() => {
    const next = active ? new MediaImportController(active.store, active.queue, active.commands?.media ?? mediaClient, active.lifecycle) : null;
    const nextFolder = active && next ? new FolderImportController(active, next, active.commands?.folders ?? folderClient) : null;
    setBinding(active && next && nextFolder ? { owner: active, controller: next, folder: nextFolder } : null);
    setStatuses([]); setSelectedId(active?.store.snapshot.document.viewState.activeMediaId ?? null); setRelink(null); setError(null);
    return () => { nextFolder?.dispose(); next?.dispose(); };
  }, [active]);
  const sourceKey = active?.store.snapshot.document.media.map(m => `${m.id}:${m.sha256}:${m.sourceRef}`).join('|');
  useEffect(() => {
    if (!active) return;
    let disposed = false;
    let pending = false;
    const refresh = () => {
      if (pending || active.store.editingDisabled) return;
      pending = true;
      void (active.commands?.media ?? mediaClient).status(active.store.snapshot.document.projectId).then(value => { if (!disposed) setStatuses(old => JSON.stringify(old) === JSON.stringify(value) ? old : value); }).catch(e => { if (!disposed) setError(normalizeError(e)); }).finally(() => { pending = false; });
    };
    refresh(); const timer = setInterval(refresh, 1500);
    window.addEventListener('focus', refresh);
    return () => { disposed = true; clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, [active, sourceKey, controller?.busy]);
  const choose = async (target?: MediaDescriptor) => {
    if (!active || !controller || active.store.editingDisabled || (!target && active.collaboration)) return;
    const reservation = {};
    if (!controller.reserve(reservation)) return;
    try {
      const paths = await mediaDialogs.choose(!target);
      if (!paths || current.current !== active || active.store.editingDisabled) return;
      setRelink(null); setError(null);
      await controller.start(Array.isArray(paths) ? paths : [paths], target?.id, reservation);
    } catch (e) { if (current.current === active) setError(normalizeError(e)); }
    finally { controller.unreserve(reservation); }
  };
  const media = active?.store.snapshot.document.media ?? [];
  const selected = media.find(m => m.id === selectedId) ?? media.find(m => m.id === active?.store.snapshot.document.viewState.activeMediaId) ?? media[0] ?? null;
  return { controller, folder, statuses, selected, selectedId: selected?.id ?? null, setSelectedId, relink, setRelink, error,
    disabled: !active || !controller || active.store.editingDisabled || controller.occupied,
    chooseFolder: () => { if (!active?.collaboration) folder?.begin(); },
    choose: () => void choose(), chooseRelink: () => void choose(relink ?? undefined),
    verify: () => { if (relink && controller && !controller.occupied && !active?.store.editingDisabled) { const target = relink; setRelink(null); void controller.start([target.sourceRef], target.id).catch(e => { if (current.current === active) setError(normalizeError(e)); }); } },
  };
}
export type MediaUI = ReturnType<typeof useMedia>;
