import { useEffect, useRef, useState, useSyncExternalStore, type PointerEvent } from 'react';
import type { OrganizationController, VerifiedOrganization } from './organization';
import type { RecycleController, VerifiedRecycle } from './recycle';
import type { ProjectLifecycle } from '../project/lifecycle';
import { folderAtPoint, type FolderHit } from './dropTarget';

interface Options {
    organization?: OrganizationController | null;
    recycle?: RecycleController | null;
    lifecycle?: ProjectLifecycle | null;
    enabled: boolean;
    retryAllowed?: boolean;
    retryUnavailableReason?: string;
    authorized: boolean;
    selected: ReadonlySet<string>;
    onGestureStart?: () => void;
    onStart?: () => void;
    onDispatch?: () => void;
    onReviewAction?: () => void;
    onComplete: (target: string | null, count: number) => void;
}
interface Gesture {
    owner: OrganizationController; recycle: RecycleController; lifecycle: ProjectLifecycle | null | undefined; pointerId: number; element: HTMLElement;
    x: number; y: number; ids: string[]; revision: number;
    started: boolean;
}
interface Review {
    owner: OrganizationController; recycle: RecycleController; lifecycle: ProjectLifecycle | null | undefined; ids: string[]; target: string | null;
    kind: 'conflict' | 'definite' | 'unknown' | 'committed'; changed?: boolean; cause: string; status: 'refreshing' | 'ready' | 'blocked'; message: string;
    organizationRead?: VerifiedOrganization; recycleRead?: VerifiedRecycle;
}
interface ReviewReads {
    owner: OrganizationController; recycle: RecycleController;
    organizationRead: Promise<VerifiedOrganization>; recycleRead: Promise<VerifiedRecycle>;
}
const noSubscribe = () => () => {};

export function useTreeMove(options: Options) {
    const current = useRef(options); current.current = options;
    // Subscribe to the boolean boundary only: lifecycle status updates should not
    // otherwise rerender a large media tree.
    const admissionClosed = useSyncExternalStore(options.lifecycle?.subscribe ?? noSubscribe, () => !!options.lifecycle?.admissionClosed, () => !!options.lifecycle?.admissionClosed);
    const gesture = useRef<Gesture | null>(null), suppress = useRef(false), request = useRef(0);
    const pendingReads = useRef(new Set<ReviewReads>());
    const feedbackValue = useRef<{ target: FolderHit | null; count: number } | null>(null);
    const [feedback, setFeedback] = useState<{ target: FolderHit | null; count: number } | null>(null);
    const [review, setReview] = useState<Review | null>(null), [notice, setNotice] = useState('');
    const sameSession = (owner: OrganizationController, recycle: RecycleController, lifecycle: ProjectLifecycle | null | undefined) => current.current.organization === owner && current.current.recycle === recycle && current.current.lifecycle === lifecycle && owner.projectId === recycle.projectId && owner.runtimeNonce === recycle.runtimeNonce;
    const active = (owner: OrganizationController, recycle: RecycleController, lifecycle: ProjectLifecycle | null | undefined) => current.current.authorized && !lifecycle?.admissionClosed && sameSession(owner, recycle, lifecycle);
    const retirePair = (pending: ReviewReads, observeNewer = false) => {
        pending.owner.retireVerified(pending.organizationRead, observeNewer);
        pending.recycle.retireVerified(pending.recycleRead, observeNewer);
    };
    const retireReads = () => {
        for (const pending of pendingReads.current) retirePair(pending);
        pendingReads.current.clear();
    };
    const release = () => {
        const old = gesture.current; gesture.current = null;
        if (feedbackValue.current) { feedbackValue.current = null; setFeedback(null); }
        if (old?.started) suppress.current = true;
        if (old) { try { if (old.element.hasPointerCapture?.(old.pointerId)) old.element.releasePointerCapture(old.pointerId); } catch { /* element may have been removed */ } }
    };
    const finish = (owner: OrganizationController, recycle: RecycleController, lifecycle: ProjectLifecycle | null | undefined, target: string | null, count: number) => {
        if (!active(owner, recycle, lifecycle)) return;
        retireReads(); owner.clearMutationFeedback(); setReview(null); setNotice(`已移动 ${count} 个音频`); current.current.onComplete(target, count);
    };
    const check = (head: VerifiedOrganization, trash: VerifiedRecycle, ids: string[], target: string | null) => {
        if (target !== null && !head.snapshot.folders.some(folder => folder.id === target)) return '目标文件夹已不存在，请重新选择目标。';
        const members = new Map(head.snapshot.media.map(item => [item.mediaId, item.folderId]));
        if (ids.some(id => !members.has(id))) return '部分音频已不存在，请重新选择要移动的音频。';
        const trashed = new Set(trash.snapshot.trashed.map(item => item.mediaId));
        if (ids.some(id => trashed.has(id))) return '部分音频已进入回收站，请重新选择要移动的音频。';
        return '';
    };
    const refreshReview = async (item: Review) => {
        const sequence = ++request.current;
        if (!sameSession(item.owner, item.recycle, item.lifecycle)) return;
        if (!active(item.owner, item.recycle, item.lifecycle)) { retireReads(); setReview({ ...item, status: 'blocked', message: '项目暂不可编辑，请恢复后重新刷新。', organizationRead: undefined, recycleRead: undefined }); return; }
        setReview({ ...item, status: 'refreshing', message: '正在核对目录和回收站…', organizationRead: undefined, recycleRead: undefined });
        const pending: ReviewReads = { owner: item.owner, recycle: item.recycle, organizationRead: item.owner.readVerified(), recycleRead: item.recycle.readVerified() };
        pendingReads.current.add(pending);
        let remaining = 2;
        const settled = () => { if (--remaining === 0) pendingReads.current.delete(pending); };
        void pending.organizationRead.then(settled, settled); void pending.recycleRead.then(settled, settled);
        try {
            const [organizationRead, recycleRead] = await Promise.all([pending.organizationRead, pending.recycleRead]);
            if (sequence !== request.current || !sameSession(item.owner, item.recycle, item.lifecycle)) return;
            if (!active(item.owner, item.recycle, item.lifecycle)) { retirePair(pending); setReview({ ...item, status: 'blocked', message: '项目暂不可编辑，请恢复后重新刷新。' }); return; }
            if (!item.owner.isVerifiedCurrent(organizationRead) || !item.recycle.isVerifiedCurrent(recycleRead)) throw new Error('读取已被更新');
            const invalid = check(organizationRead, recycleRead, item.ids, item.target);
            if (invalid) { setReview({ ...item, status: 'blocked', message: invalid }); return; }
            const members = new Map(organizationRead.snapshot.media.map(member => [member.mediaId, member.folderId]));
            if ((item.kind === 'unknown' || item.kind === 'committed') && item.ids.every(id => members.get(id) === item.target)) {
                if (item.kind === 'committed' && !item.changed) { retireReads(); item.owner.clearMutationFeedback(); setReview(null); setNotice('音频已在目标文件夹，未作更改'); }
                else finish(item.owner, item.recycle, item.lifecycle, item.target, item.ids.length);
                return;
            }
            setReview({ ...item, status: 'ready', message: '目录已刷新，请核对目标和音频后显式重试。', organizationRead, recycleRead });
        } catch {
            const same = sameSession(item.owner, item.recycle, item.lifecycle), authorized = active(item.owner, item.recycle, item.lifecycle);
            // Keep observing a safe newer head from a failed pair while freeing polls;
            // dismissal or owner/interruption cleanup turns that observation off.
            retirePair(pending, sequence === request.current && same && authorized);
            if (sequence === request.current && same) setReview({ ...item, status: 'blocked', message: authorized ? '无法确认最新目录和回收站状态，请刷新后重试。' : '项目暂不可编辑，请恢复后重新刷新。' });
        }
    };
    const submit = async (owner: OrganizationController, recycle: RecycleController, lifecycle: ProjectLifecycle | null | undefined, ids: string[], target: string | null, revision: number) => {
        if (!active(owner, recycle, lifecycle) || !(current.current.retryAllowed ?? current.current.enabled) || owner.pending || recycle.pending || recycle.purge.pending) return;
        const sequence = ++request.current;
        current.current.onDispatch?.();
        retireReads(); setNotice(''); setReview(null);
        const result = await owner.submitBatch({ expectedRevision: revision, operation: { type: 'moveMediaBatch', mediaIds: [...ids], folderId: target } });
        if (sequence !== request.current || !sameSession(owner, recycle, lifecycle)) return;
        if (result.ok) {
            if (!active(owner, recycle, lifecycle)) {
                setReview({ owner, recycle, lifecycle, ids: [...ids], target, kind: 'committed', changed: result.changed, cause: result.changed ? '移动已完成' : '移动已确认无需更改', status: 'blocked', message: '项目暂不可编辑，请恢复后重新刷新并核对。' });
            } else if (result.changed) finish(owner, recycle, lifecycle, target, ids.length);
            else { owner.clearMutationFeedback(); setReview(null); }
            return;
        }
        const item: Review = { owner, recycle, lifecycle, ids: [...ids], target, kind: result.error?.code === 'RevisionConflict' && result.kind === 'definite' ? 'conflict' : result.kind, cause: result.error?.message ?? '未能确认移动结果', status: 'refreshing', message: '' };
        await refreshReview(item);
    };
    const retry = () => {
        if (!review || review.status !== 'ready' || !review.organizationRead || !review.recycleRead || !active(review.owner, review.recycle, review.lifecycle) || !(current.current.retryAllowed ?? current.current.enabled) || review.owner.pending || review.recycle.pending || review.recycle.purge.pending) return;
        current.current.onReviewAction?.();
        if (!review.owner.isVerifiedCurrent(review.organizationRead) || !review.recycle.isVerifiedCurrent(review.recycleRead) || check(review.organizationRead, review.recycleRead, review.ids, review.target)) { void refreshReview(review); return; }
        void submit(review.owner, review.recycle, review.lifecycle, review.ids, review.target, review.organizationRead.snapshot.revision);
    };
    useEffect(() => {
        release(); request.current++; retireReads(); setReview(null); setNotice('');
    }, [options.organization, options.recycle, options.lifecycle]);
    useEffect(() => { release(); return options.lifecycle?.registerBackgroundGuard(() => !gesture.current); }, [options.lifecycle]);
    useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 4000); return () => clearTimeout(timer); }, [notice]);
    useEffect(() => {
        if (!options.enabled || !options.authorized || admissionClosed) release();
        if ((!options.authorized || admissionClosed) && review?.status === 'refreshing' && sameSession(review.owner, review.recycle, review.lifecycle)) {
            request.current++; retireReads();
            setReview(previous => previous === review ? { ...review, status: 'blocked', message: '项目暂不可编辑，请恢复后重新刷新。', organizationRead: undefined, recycleRead: undefined } : previous);
        }
    }, [options.enabled, options.authorized, admissionClosed, review]);
    useEffect(() => {
        const cancel = () => { release(); suppress.current = false; };
        const keys = (event: KeyboardEvent) => { if (event.key === 'Escape' && gesture.current) { event.preventDefault(); event.stopPropagation(); release(); } else if (!gesture.current && event.key !== 'Escape') suppress.current = false; };
        const pointerUp = (event: globalThis.PointerEvent) => { const g = gesture.current; if (g && g.pointerId === event.pointerId && !g.element.isConnected) release(); if (suppress.current) setTimeout(() => { suppress.current = false; }, 0); };
        const lost = (event: globalThis.PointerEvent) => { const g = gesture.current; if (g && event.pointerId === g.pointerId && (event.target === document || event.target === g.element || !g.element.isConnected)) release(); };
        window.addEventListener('blur', cancel); window.addEventListener('keydown', keys, true); window.addEventListener('pointerup', pointerUp, true); document.addEventListener('lostpointercapture', lost, true);
        return () => { request.current++; retireReads(); cancel(); window.removeEventListener('blur', cancel); window.removeEventListener('keydown', keys, true); window.removeEventListener('pointerup', pointerUp, true); document.removeEventListener('lostpointercapture', lost, true); };
    }, []);
    const down = (event: PointerEvent<HTMLButtonElement>, id: string) => {
        if (!gesture.current) suppress.current = false;
        const { organization: owner, recycle, enabled, selected } = current.current;
        if (!enabled || !owner?.snapshot || !recycle?.snapshot || !active(owner, recycle, current.current.lifecycle) || owner.pending || review || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        const ids = selected.has(id) ? [...selected] : [id], membership = new Set(owner.snapshot.media.map(m => m.mediaId));
        if (!ids.length || ids.some(mediaId => !membership.has(mediaId))) return;
        current.current.onGestureStart?.();
        release(); setNotice(''); gesture.current = { owner, recycle, lifecycle: current.current.lifecycle, pointerId: event.pointerId, element: event.currentTarget, x: event.clientX, y: event.clientY, ids, revision: owner.snapshot.revision, started: false };
        try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* pointer capture may be unavailable in tests */ }
    };
    const move = (event: PointerEvent<HTMLButtonElement>) => {
        const g = gesture.current; if (!g || event.pointerId !== g.pointerId) return;
        if (!active(g.owner, g.recycle, g.lifecycle) || !current.current.enabled || g.owner.pending) { release(); return; }
        if (!g.started && Math.hypot(event.clientX - g.x, event.clientY - g.y) < 6) return;
        g.started = true; const target = folderAtPoint(event.clientX, event.clientY);
        const next = { target: target && (target.folderId === null || g.owner.snapshot?.folders.some(f => f.id === target.folderId)) ? target : null, count: g.ids.length }, old = feedbackValue.current;
        if (!old || old.count !== next.count || (old.target === null) !== (next.target === null) || old.target?.folderId !== next.target?.folderId) { feedbackValue.current = next; setFeedback(next); }
    };
    const up = (event: PointerEvent<HTMLButtonElement>) => {
        const g = gesture.current; if (!g || event.pointerId !== g.pointerId) return;
        const target = g.started ? folderAtPoint(event.clientX, event.clientY) : null;
        release();
        if (!g.started) return;
        suppress.current = true; setTimeout(() => { suppress.current = false; }, 0);
        event.preventDefault();
        if (!target || !active(g.owner, g.recycle, g.lifecycle) || !current.current.enabled || g.owner.pending) return;
        current.current.onStart?.();
        if (target.folderId !== null && !g.owner.snapshot?.folders.some(folder => folder.id === target.folderId)) {
            setReview({ owner: g.owner, recycle: g.recycle, lifecycle: g.lifecycle, ids: [...g.ids], target: target.folderId, kind: 'definite', cause: '目标文件夹已变化', status: 'blocked', message: '目标文件夹已不存在，请重新选择目标。' }); return;
        }
        void submit(g.owner, g.recycle, g.lifecycle, g.ids, target.folderId, g.revision);
    };
    const canRetry = (options.retryAllowed ?? options.enabled) && options.authorized && !admissionClosed && !options.organization?.pending && !options.recycle?.pending && !options.recycle?.purge.pending;
    const retryReason = !options.authorized || admissionClosed ? '项目暂不可编辑，请恢复后重试。' : !canRetry ? options.retryUnavailableReason ?? '请等待当前音频或回收站操作完成后重试。' : '';
    return {
        feedback, notice, review, canRetry, retryReason, admissionClosed, down, move, up, cancel: (event: PointerEvent<HTMLButtonElement>) => { if (gesture.current?.pointerId === event.pointerId) release(); },
        consumeClick: () => { if (!suppress.current) return false; suppress.current = false; return true; },
        refreshReview: () => { if (review) { current.current.onReviewAction?.(); void refreshReview(review); } }, retry,
        dismissReview: () => { request.current++; retireReads(); setReview(null); },
    };
}
