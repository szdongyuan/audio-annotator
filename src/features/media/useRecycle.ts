import { useEffect, useState, useSyncExternalStore } from 'react';
import { createRecycleClient } from '../../bridge/recycle';
import type { ActiveProject } from '../project/useProjectLifecycle';
import { RecycleController } from './recycle';
import type { CollaborationStatus } from '../../bridge/collaboration';
const noop = () => () => { }, zero = () => 0;
export function useRecycle(owner: ActiveProject | null, status?: CollaborationStatus | null) {
    const actorId = owner?.collaboration?.actor?.authorId;
    const nonce = owner?.collaboration?.runtimeNonce;
    const [binding, setBinding] = useState<{
        owner: ActiveProject;
        actorId: string | undefined;
        controller: RecycleController;
    } | null>(null);
    const controller = binding?.owner === owner && binding.controller.runtimeNonce === nonce && binding.actorId === actorId ? binding.controller : null;
    useSyncExternalStore(controller?.subscribe ?? noop, controller?.getVersion ?? zero);
    useSyncExternalStore(controller?.purge.subscribe ?? noop, controller?.purge.getVersion ?? zero);
    useEffect(() => { if (status) controller?.purge.acceptStatus(status); }, [controller, status]);
    useEffect(() => { if (!owner || !nonce) {
        setBinding(null);
        return;
    } const next = new RecycleController(owner.store.snapshot.document.projectId, nonce, owner.collaboration?.canImportMedia === true, createRecycleClient(nonce), owner); setBinding({ owner, actorId, controller: next }); void next.refresh(); const refresh = () => void next.refresh(), timer = setInterval(refresh, 1500); window.addEventListener('focus', refresh); return () => { clearInterval(timer); window.removeEventListener('focus', refresh); next.dispose(); }; }, [owner, nonce, actorId]);
    return controller;
}
