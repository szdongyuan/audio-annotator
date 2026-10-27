import { useEffect, useState, useSyncExternalStore } from 'react';
import { createRecycleClient } from '../../bridge/recycle';
import type { ActiveProject } from '../project/useProjectLifecycle';
import { RecycleController } from './recycle';
const noop = () => () => { }, zero = () => 0;
export function useRecycle(owner: ActiveProject | null) {
    const nonce = owner?.collaboration?.runtimeNonce;
    const [binding, setBinding] = useState<{
        owner: ActiveProject;
        controller: RecycleController;
    } | null>(null);
    const controller = binding?.owner === owner && binding.controller.runtimeNonce === nonce ? binding.controller : null;
    useSyncExternalStore(controller?.subscribe ?? noop, controller?.getVersion ?? zero);
    useEffect(() => { if (!owner || !nonce) {
        setBinding(null);
        return;
    } const next = new RecycleController(owner.store.snapshot.document.projectId, nonce, owner.collaboration?.canImportMedia === true, createRecycleClient(nonce)); setBinding({ owner, controller: next }); void next.refresh(); const refresh = () => void next.refresh(), timer = setInterval(refresh, 1500); window.addEventListener('focus', refresh); return () => { clearInterval(timer); window.removeEventListener('focus', refresh); next.dispose(); }; }, [owner, nonce]);
    return controller;
}
