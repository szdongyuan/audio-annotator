import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { mediaClient, mediaDialogs, type MediaStatus } from '../../bridge/media';
import { normalizeError } from '../../bridge/client';
import type { ActiveProject } from '../project/useProjectLifecycle';
import type { AppError, MediaDescriptor } from '../../bridge/types';
import { MediaImportController } from './imports';
import { FolderImportController } from './folderImport';
import { folderClient } from '../../bridge/folders';
import { sourceClient } from '../../bridge/sourceImport';
import { SourceImportController } from './sourceImport';
import { useOrganization } from './useOrganization';
const none = () => () => {};
const zero = () => 0;
export function useMedia(active: ActiveProject | null) {
  const organization=useOrganization(active);
  const current = useRef(active); current.current = active;
  const [binding, setBinding] = useState<{ owner: ActiveProject; controller: MediaImportController; folder: FolderImportController; source: SourceImportController } | null>(null);
  const controller = binding?.owner === active ? binding?.controller ?? null : null;
  const folder = binding?.owner === active ? binding?.folder ?? null : null;
  const source = binding?.owner === active ? binding?.source ?? null : null;
  useSyncExternalStore(controller?.subscribe ?? none, controller?.getVersion ?? zero);
  useSyncExternalStore(folder?.subscribe ?? none, folder?.getVersion ?? zero);
  useSyncExternalStore(source?.subscribe ?? none, source?.getVersion ?? zero);
  const [statuses, setStatuses] = useState<MediaStatus[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [relink, setRelink] = useState<MediaDescriptor | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  useEffect(() => {
    const next = active ? new MediaImportController(active.store, active.queue, active.commands?.media ?? mediaClient, active.lifecycle, active.collaboration?.projectFlavor === 'default') : null;
    const nextFolder = active && next ? new FolderImportController(active, next, active.commands?.folders ?? folderClient) : null;
    const nextSource = active && next ? new SourceImportController(active, next, active.commands?.sources ?? sourceClient) : null;
    setBinding(active && next && nextFolder && nextSource ? { owner: active, controller: next, folder: nextFolder, source: nextSource } : null);
    setStatuses([]); setSelectedId(active?.store.snapshot.document.viewState.activeMediaId ?? null); setRelink(null); setError(null);
    return () => { nextSource?.dispose(); nextFolder?.dispose(); next?.dispose(); };
  }, [active]);
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
  }, [active]);
  const choose = async (target?: MediaDescriptor) => {
    if (!active || !controller || active.store.editingDisabled || (!target && active.collaboration?.canImportMedia===false)) return;
    const reservation = {};
    if (!controller.reserve(reservation)) return;
    try {
      const paths = await mediaDialogs.choose(!target);
      if (!paths || current.current !== active || active.store.editingDisabled) return;
      setRelink(null); setError(null);
      const chosen=Array.isArray(paths)?paths:[paths];
      const placement=!target&&organization?.snapshot?{folderId:organization.selectedFolderId,layoutRevision:organization.snapshot.layoutRevision}:undefined;
      await controller.start(chosen,target?.id,reservation,placement?receive=>(active.commands?.media??mediaClient).start(active.store.snapshot.document.projectId,chosen,receive,undefined,placement):undefined);
    } catch (e) { if (current.current === active) setError(normalizeError(e)); }
    finally { controller.unreserve(reservation); }
  };
  const media = active?.store.snapshot.document.media ?? [];
  const selected = media.find(m => m.id === selectedId) ?? media.find(m => m.id === active?.store.snapshot.document.viewState.activeMediaId) ?? media[0] ?? null;
  return { controller, folder, source, organization, statuses, selected, selectedId: selected?.id ?? null, setSelectedId, relink, setRelink, error,
    disabled: !active || !controller || active.store.editingDisabled || controller.occupied,
    chooseFolder: () => { if (active?.collaboration?.canImportMedia!==false) folder?.begin(); },
    sourceDisabled: !active?.collaboration || active.collaboration.projectFlavor !== 'default' || !active.collaboration.canImportMedia,
    chooseSourceFolder: (returnFocus?:HTMLElement|null) => { source?.begin('folder',organization?.selectedFolderId??null,returnFocus); }, chooseSourceZip: (returnFocus?:HTMLElement|null) => { source?.begin('zip',organization?.selectedFolderId??null,returnFocus); },
    choose: () => void choose(), chooseRelink: () => void choose(relink ?? undefined),
    verify: () => { if (relink && controller && !controller.occupied && !active?.store.editingDisabled) { const target = relink; setRelink(null); void controller.start([target.sourceRef], target.id).catch(e => { if (current.current === active) setError(normalizeError(e)); }); } },
  };
}
export type MediaUI = ReturnType<typeof useMedia>;
