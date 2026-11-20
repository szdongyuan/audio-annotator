import { useEffect, useRef, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { captureDropSession, preflightDrop, type DropSession, type DropTarget } from '../../bridge/dragDrop';
import type { ProjectLifecycleUI, ActiveProject } from '../project/useProjectLifecycle';
import type { MediaUI } from './useMedia';
import { physicalFolderAtPoint, type FolderHit } from './dropTarget';
import { isNativeModal } from '../../components/modal';

type NativeDrop = Parameters<Parameters<ReturnType<typeof getCurrentWebview>['onDragDropEvent']>[0]>[0]['payload'];
type Gesture = { owner: ActiveProject; session: Promise<DropSession>; cancelled: boolean; epoch: number };
type Flight = { owner: ActiveProject; epoch: number };
const messageOf = (error: unknown) => typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string' ? error.message : '无法检查拖入来源，请重新拖入。';
const modalOpen = () => [...document.querySelectorAll<HTMLDialogElement>('dialog[open]')].some(isNativeModal) || !!document.querySelector('[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"], .dialog-backdrop');

export function useNativeDrop(project: ProjectLifecycleUI, media: MediaUI) {
    const latest = useRef({ project, media }); latest.current = { project, media };
    const gesture = useRef<Gesture | null>(null), inFlight = useRef<Flight | null>(null), epoch = useRef(0);
    const scope = useRef({ owner: project.active, busy: project.busy, close: project.closePending, recovery: project.recovery });
    if (scope.current.owner !== project.active || scope.current.busy !== project.busy || scope.current.close !== project.closePending || scope.current.recovery !== project.recovery) {
        epoch.current++; scope.current = { owner: project.active, busy: project.busy, close: project.closePending, recovery: project.recovery };
    }
    const [target, setTarget] = useState<FolderHit | null>(null), [message, setMessage] = useState('');
    const targetValue = useRef<FolderHit | null>(null), messageValue = useRef('');
    const folderIndex = useRef<{ snapshot: unknown; folders: unknown; ids: Set<string> } | null>(null);
    const updateTarget = (next: FolderHit | null) => {
        const current = targetValue.current;
        if (current === next || (current !== null && next !== null && current.folderId === next.folderId)) return;
        targetValue.current = next; setTarget(next);
    };
    const updateMessage = (next: string) => { if (messageValue.current !== next) { messageValue.current = next; setMessage(next); } };
    const invalidateGesture = () => { if (gesture.current) gesture.current.cancelled = true; gesture.current = null; updateTarget(null); };
    const reason = (ownFlight?: Flight) => {
        const { project: p, media: m } = latest.current, owner = p.active, flight = inFlight.current;
        if (p.busy || p.closePending || p.recovery || owner?.lifecycle.admissionClosed) return '项目正在切换或恢复，请完成当前操作后重新拖入。';
        if (!owner) return '请先打开或新建项目，再拖入音频。';
        if (owner.store.editingDisabled || owner.collaboration?.canImportMedia === false) return '当前项目只读，无法导入音频。';
        if (modalOpen()) return '请先关闭当前窗口，再拖入音频。';
        if (!m.controller || m.controller.occupied || (flight && flight !== ownFlight && flight.owner === owner && flight.epoch === epoch.current)) return '已有导入任务，请完成后再拖入。';
        if (owner.collaboration && (!m.organization || !m.organization.snapshot)) return '目录尚未就绪，请刷新后重新拖入。';
        return '';
    };
    const valid = (g: Gesture, flight?: Flight) => !g.cancelled && g.epoch === epoch.current && latest.current.project.active === g.owner && (!flight || inFlight.current === flight) && !reason(flight);
    const hit = (x: number, y: number): FolderHit | null => {
        const org = latest.current.media.organization, found = physicalFolderAtPoint(x, y);
        const snapshot = org?.snapshot ?? null;
        if (!folderIndex.current || folderIndex.current.snapshot !== snapshot || folderIndex.current.folders !== snapshot?.folders)
            folderIndex.current = { snapshot, folders: snapshot?.folders, ids: new Set(snapshot?.folders.map(folder => folder.id) ?? []) };
        const folders = folderIndex.current.ids;
        if (found) return found.folderId === null || folders.has(found.folderId) ? found : null;
        const selected = org?.selectedFolderId ?? null;
        return { folderId: selected && folders.has(selected) ? selected : null };
    };
    const updateHit = (x: number, y: number) => {
        const found = hit(x, y); updateTarget(found);
        updateMessage(found ? '' : '目标文件夹已变化，请核对目标后重新拖入。');
        return found;
    };
    const handler = useRef<(event: NativeDrop) => void>(() => {});
    handler.current = event => {
        if (event.type === 'enter') {
            invalidateGesture();
            const why = reason(), owner = latest.current.project.active;
            if (why || !owner) { updateMessage(why); return; }
            const g: Gesture = { owner, cancelled: false, epoch: epoch.current, session: captureDropSession(owner.store.snapshot.document.projectId) };
            void g.session.catch(() => {});
            gesture.current = g; updateHit(event.position.x, event.position.y); return;
        }
        if (event.type === 'leave') { if (gesture.current) invalidateGesture(); return; }
        const g = gesture.current;
        if (!g || !valid(g)) { if (g) { updateMessage(reason() || '项目会话已变化，请重新拖入。'); invalidateGesture(); } return; }
        if (event.type === 'over') { updateHit(event.position.x, event.position.y); return; }
        const owner = g.owner, org = latest.current.media.organization, hitTarget = hit(event.position.x, event.position.y);
        gesture.current = null; updateTarget(null);
        if (!hitTarget) { updateMessage('目标文件夹已变化，请核对目标后重新拖入。'); return; }
        const targetSnapshot: DropTarget | null = owner.collaboration && org?.snapshot ? { folderId: hitTarget.folderId, layoutRevision: org.snapshot.layoutRevision } : null;
        const paths = [...event.paths], flight: Flight = { owner, epoch: g.epoch };
        inFlight.current = flight; updateMessage('正在检查拖入来源…');
        void (async () => {
            try {
                const session = await g.session;
                if (!valid(g, flight) || session.projectId !== owner.store.snapshot.document.projectId || session.shared !== !!owner.collaboration || (session.shared && (!org || latest.current.media.organization !== org || org.runtimeNonce !== session.runtimeNonce || !targetSnapshot))) throw new Error('项目会话已变化，请重新拖入。');
                const result = await preflightDrop(session, paths, targetSnapshot);
                if (!valid(g, flight) || latest.current.media.organization !== org) throw new Error('项目会话或导入状态已变化，请重新拖入。');
                const m = latest.current.media;
                if (result.kind === 'audio') {
                    if (!m.controller || !await m.controller.startDropped(result)) throw new Error('已有导入任务，请完成后再拖入。');
                } else if (!m.source || !m.source.beginDropped(result, document.activeElement instanceof HTMLElement ? document.activeElement : null)) throw new Error('已有导入任务，请完成后再拖入。');
                if (inFlight.current === flight && latest.current.project.active === owner) updateMessage('');
            } catch (error) { if (inFlight.current === flight && latest.current.project.active === owner) updateMessage(messageOf(error)); }
            finally { if (inFlight.current === flight) inFlight.current = null; }
        })();
    };
    useEffect(() => {
        let retired = false;
        if (gesture.current && gesture.current.epoch !== epoch.current) { invalidateGesture(); retired = true; }
        if (inFlight.current && inFlight.current.epoch !== epoch.current) { inFlight.current = null; retired = true; }
        if (retired) updateMessage('项目会话或操作状态已变化，请重新拖入。');
    }, [project.active, project.busy, project.closePending, project.recovery]);
    useEffect(() => {
        if (!message || message === '正在检查拖入来源…') return;
        const timer = setTimeout(() => updateMessage(''), 6000); return () => clearTimeout(timer);
    }, [message]);
    useEffect(() => {
        if (!isTauri()) return;
        let disposed = false, unlisten: (() => void) | undefined;
        void getCurrentWebview().onDragDropEvent(event => handler.current(event.payload)).then(stop => { if (disposed) stop(); else unlisten = stop; }).catch(() => { if (!disposed) updateMessage('无法启用文件拖入，请使用导入按钮。'); });
        return () => { disposed = true; epoch.current++; if (gesture.current) gesture.current.cancelled = true; gesture.current = null; inFlight.current = null; unlisten?.(); };
    }, []);
    return { target, message };
}
