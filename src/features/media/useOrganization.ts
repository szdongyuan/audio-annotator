import { useEffect, useState, useSyncExternalStore } from 'react';
import { createOrganizationClient } from '../../bridge/organization';
import type { ActiveProject } from '../project/useProjectLifecycle';
import { OrganizationController } from './organization';
const noop = () => () => { }, zero = () => 0;
export function useOrganization(owner: ActiveProject | null) {
    const nonce = owner?.collaboration?.runtimeNonce;
    const [binding, setBinding] = useState<{
        owner: ActiveProject;
        controller: OrganizationController;
    } | null>(null);
    const controller = binding?.owner === owner && binding.controller.runtimeNonce === nonce ? binding.controller : null;
    useSyncExternalStore(controller?.subscribe ?? noop, controller?.getVersion ?? zero);
    useEffect(() => { if (!owner || !nonce) {
        setBinding(null);
        return;
    } const next = new OrganizationController(owner.store.snapshot.document.projectId, nonce, owner.collaboration?.canImportMedia === true, createOrganizationClient(nonce), owner); setBinding({ owner, controller: next }); void next.refresh(); const refresh = () => void next.refresh(), timer = setInterval(refresh, 1500);
    let mediaCount = owner.store.snapshot.document.media.length;
    const unsubscribe = owner.store.subscribe(() => {
        const count = owner.store.snapshot.document.media.length;
        if (count !== mediaCount) { mediaCount = count; void next.refresh(true); }
    });
    window.addEventListener('focus', refresh); return () => { unsubscribe(); clearInterval(timer); window.removeEventListener('focus', refresh); next.dispose(); }; }, [owner, nonce]);
    return controller;
}
