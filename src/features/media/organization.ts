import type { ActiveProject } from '../project/useProjectLifecycle';
import { admitted, suspendRefresh } from '../collaboration/admission';
import { normalizeError } from '../../bridge/client';
import { parseAppError, type AppError } from '../../bridge/types';
import type { Organization, OrganizationCommands, OrganizationOperation, OrganizationSnapshot } from '../../bridge/organization';
export interface OrganizationDraft {
    expectedRevision: number;
    operation: OrganizationOperation;
}
export interface VerifiedOrganization { readonly snapshot: Organization; readonly mutationEpoch: number; readonly readEpoch: number }
/** Metadata only. No reference to personal document, queue, playback or catalog adoption. */
export class OrganizationController {
    snapshot: Organization | null = null;
    selectedFolderId: string | null = null;
    error: AppError | null = null;
    private mutationError: AppError | null = null;
    pending = false;
    private disposed = false;
    private generation = 0;
    private mutationEpoch = 0;
    private readEpoch = 0;
    private reading: Promise<void> | null = null;
    private verifying: Promise<VerifiedOrganization> | null = null;
    private verificationStates = new WeakMap<Promise<VerifiedOrganization>, { retired: boolean; observeNewer: boolean }>();
    private verifyingRefresh: Promise<void> | null = null;
    private releaseVerificationWait: (() => void) | null = null;
    private deferredRefresh: Promise<void> | null = null;
    private deferredAgain = false;
    private version = 0;
    private listeners = new Set<() => void>();
    constructor(readonly projectId: string, readonly runtimeNonce: string, readonly writable: boolean, private api: OrganizationCommands, private owner?: ActiveProject) { }
    subscribe = (f: () => void) => { this.listeners.add(f); return () => { this.listeners.delete(f); }; };
    getVersion = () => this.version;
    private notify() { this.version++; this.listeners.forEach(f => f()); }
    private install(value: OrganizationSnapshot) { if (value.projectId !== this.projectId || value.runtimeNonce !== this.runtimeNonce || value.organization.projectId !== this.projectId)
        return; if (this.snapshot && value.organization.revision < this.snapshot.revision)
        return; if (!this.snapshot || JSON.stringify(this.snapshot) !== JSON.stringify(value.organization)) this.snapshot = value.organization; if (this.selectedFolderId && !value.organization.folders.some(f => f.id === this.selectedFolderId))
        this.selectedFolderId = null; this.error = this.mutationError; }
    select(id: string | null) { if (id !== null && !this.snapshot?.folders.some(f => f.id === id))
        return; this.selectedFolderId = id; this.notify(); }
    refresh(force = false, allowPending = false): Promise<void> {
        if (this.disposed) return Promise.resolve();
        if (this.verifyingRefresh && !force) return this.verifyingRefresh;
        if (this.reading && !force) return this.reading;
        // A forced read follows a known change and invalidates earlier review evidence now,
        // not only when its potentially slow response arrives.
        if (force) this.readEpoch++;
        const generation = ++this.generation, mutationEpoch = this.mutationEpoch;
        const currentOwner = () => !this.owner || (this.owner.collaboration?.runtimeNonce === this.runtimeNonce && this.owner.store.snapshot.document.projectId === this.projectId);
        const beforeSnapshot = this.snapshot, beforeError = JSON.stringify(this.error);
        const reading = (async () => {
            let installedNewer = false;
            try {
                const value = await this.api.get(this.projectId);
                const sameOwner = currentOwner(), sameMutation = mutationEpoch === this.mutationEpoch;
                if (!this.disposed && (!this.pending || allowPending) && sameOwner && sameMutation && generation === this.generation) {
                    if (value.projectId === this.projectId && value.runtimeNonce === this.runtimeNonce && value.organization.projectId === this.projectId && (!this.snapshot || value.organization.revision >= this.snapshot.revision)) {
                        this.install(value);
                    } else this.readEpoch++;
                } else if (!this.disposed && !this.pending && sameOwner && sameMutation && (!this.owner || !this.owner.lifecycle.admissionClosed) && generation !== this.generation && value.projectId === this.projectId && value.runtimeNonce === this.runtimeNonce && value.organization.projectId === this.projectId && (!this.snapshot || value.organization.revision > this.snapshot.revision)) {
                    // A superseded request can still discover a genuinely newer revision.
                    const currentError = this.error; this.install(value); this.error = currentError; installedNewer = true;
                }
            } catch (error) {
                if (!this.disposed && currentOwner() && mutationEpoch === this.mutationEpoch && generation === this.generation) { this.readEpoch++; this.error = this.mutationError ?? normalizeError(error); }
            } finally {
                if (!this.disposed && (generation === this.generation || installedNewer) && (this.snapshot !== beforeSnapshot || JSON.stringify(this.error) !== beforeError)) this.notify();
            }
        })();
        this.reading = reading;
        void reading.finally(() => { if (this.reading === reading) this.reading = null; });
        return reading;
    }
    /** A media-count change needs a later read, but must not starve a review already in flight. */
    refreshAfterVerified(): Promise<void> {
        if (this.deferredRefresh) { this.deferredAgain = true; return this.deferredRefresh; }
        if (!this.verifyingRefresh) return this.refresh(true);
        const pending = (async () => {
            do {
                while (this.verifyingRefresh && !this.disposed) await this.verifyingRefresh;
                this.deferredAgain = false;
                if (!this.disposed) await this.refresh(true);
            } while (this.deferredAgain && !this.disposed);
        })();
        this.deferredRefresh = pending;
        void pending.finally(() => { if (this.deferredRefresh === pending) this.deferredRefresh = null; });
        return pending;
    }
    /** A review must be backed by this request's successful, current response. */
    readVerified(): Promise<VerifiedOrganization> {
        // Explicit attempts must never inherit a request issued for an earlier review.
        this.releaseVerificationWait?.();
        // A poll started before the review cannot be its evidence; retire its dedupe slot.
        this.reading = null;
        const state = { retired: false, observeNewer: false };
        const reading = this.performVerifiedRead(state);
        this.verificationStates.set(reading, state);
        this.verifying = reading;
        let release!: () => void;
        this.verifyingRefresh = new Promise<void>(resolve => { release = resolve; });
        this.releaseVerificationWait = release;
        const clear = () => { release(); if (this.verifying === reading) { this.verifying = null; this.verifyingRefresh = null; this.releaseVerificationWait = null; } };
        void reading.then(clear, clear);
        return reading;
    }
    /** Release only this review's gate; a failed pair may still observe a newer safe head. */
    retireVerified(reading: Promise<VerifiedOrganization>, observeNewer = false) {
        const state = this.verificationStates.get(reading);
        if (!state) return;
        if (state.retired) { if (!observeNewer) state.observeNewer = false; return; }
        state.retired = true; state.observeNewer = observeNewer;
        if (this.verifying === reading) {
            this.releaseVerificationWait?.();
            this.verifying = null; this.verifyingRefresh = null; this.releaseVerificationWait = null;
        }
    }
    private async performVerifiedRead(state: { retired: boolean; observeNewer: boolean }): Promise<VerifiedOrganization> {
        if (this.disposed) throw new Error('项目会话已结束，请重新打开项目');
        const generation = ++this.generation, mutationEpoch = this.mutationEpoch;
        const before = this.snapshot, beforeError = JSON.stringify(this.error);
        let installedNewer = false;
        try {
            const value = await this.api.get(this.projectId);
            const bound = value.projectId === this.projectId && value.runtimeNonce === this.runtimeNonce && value.organization.projectId === this.projectId;
            const authorized = !this.disposed && !this.pending && mutationEpoch === this.mutationEpoch && (!this.owner || (!this.owner.lifecycle.admissionClosed && !this.owner.store.editingDisabled && this.owner.collaboration?.runtimeNonce === this.runtimeNonce && this.owner.store.snapshot.document.projectId === this.projectId));
            if (authorized && bound && (state.retired ? state.observeNewer : generation !== this.generation) && (!this.snapshot || value.organization.revision > this.snapshot.revision)) {
                // Superseded or failed-pair reads cannot approve a review, but may reveal a newer head.
                const currentError = this.error; this.install(value); this.error = currentError; installedNewer = true;
            }
            if (state.retired || !authorized || !bound || generation !== this.generation || (this.snapshot && value.organization.revision < this.snapshot.revision))
                throw new Error('目录读取已失效，请重新刷新');
            this.install(value);
            return { snapshot: this.snapshot!, mutationEpoch, readEpoch: this.readEpoch };
        } catch (error) {
            if (!state.retired && !this.disposed && generation === this.generation) { this.readEpoch++; this.error = this.mutationError ?? normalizeError(error); }
            throw error;
        } finally {
            if (!this.disposed && ((!state.retired && generation === this.generation) || installedNewer) && (this.snapshot !== before || JSON.stringify(this.error) !== beforeError)) this.notify();
        }
    }
    isVerifiedCurrent(read: VerifiedOrganization): boolean {
        return !this.disposed && !this.pending && this.mutationEpoch === read.mutationEpoch && this.readEpoch === read.readEpoch && this.snapshot === read.snapshot && (!this.owner || (!this.owner.lifecycle.admissionClosed && !this.owner.store.editingDisabled && this.owner.collaboration?.runtimeNonce === this.runtimeNonce && this.owner.store.snapshot.document.projectId === this.projectId));
    }
    beginEdit(operation: OrganizationOperation): OrganizationDraft { this.mutationError = null; this.error = null; return { expectedRevision: this.snapshot?.revision ?? 0, operation }; }
    clearMutationFeedback() { this.mutationError = null; this.error = null; this.notify(); }
    private async apply(draft: OrganizationDraft): Promise<OrganizationSnapshot> {
        const expectedRevision=draft.expectedRevision, operation=structuredClone(draft.operation);
        const action=()=>this.api.apply(this.projectId,expectedRevision,operation), owner=this.owner;
        if(!owner)return action();
        return await owner.lifecycle.enqueueEdit(async()=>{
            const resume=await suspendRefresh(owner.lifecycle);
            try{return await admitted(owner,action,()=>!this.disposed&&!owner.lifecycle.admissionClosed
                && owner.collaboration?.runtimeNonce===this.runtimeNonce
                && owner.store.snapshot.document.projectId===this.projectId);}
            finally{resume?.();}
        }) as OrganizationSnapshot;
    }
    async submit(draft: OrganizationDraft) { if (this.disposed || !this.writable || !this.snapshot || this.pending)
        return false; this.pending = true; this.mutationEpoch++; this.mutationError = null; this.error = null; this.notify(); try {
        const value = await this.apply(draft);
        if (this.disposed)
            return false;
        this.generation++;
        this.install(value);
        return true;
    }
    catch (e) {
        if (this.disposed)
            return false;
        this.error = this.mutationError = normalizeError(e);
        if (this.error.code === 'RevisionConflict') {
            const conflict = this.error;
            await this.refresh(true, true);
            if (this.snapshot)
                draft.expectedRevision = this.snapshot.revision;
            this.error = conflict;
        }
        return false;
    }
    finally {
        this.pending = false;
        if (!this.disposed)
            this.notify();
    } }
    /** Unlike menu edits, a batch conflict must not silently advance its draft. */
    async submitBatch(draft: OrganizationDraft): Promise<{ ok: true; changed: boolean } | { ok: false; kind: 'definite' | 'unknown'; error: AppError | null }> {
        if (this.disposed || !this.writable || !this.snapshot || this.pending || draft.operation.type !== 'moveMediaBatch') return { ok: false, kind: 'definite', error: null };
        this.pending = true; this.mutationEpoch++; this.mutationError = null; this.error = null; this.notify();
        try {
            const value = await this.apply(draft);
            if (this.disposed || value.projectId !== this.projectId || value.runtimeNonce !== this.runtimeNonce || value.organization.projectId !== this.projectId) return { ok: false, kind: 'unknown', error: null };
            this.generation++; this.install(value);
            return { ok: true, changed: value.organization.revision !== draft.expectedRevision };
        } catch (error) {
            if (this.disposed) return { ok: false, kind: 'unknown', error: null };
            let nativeError: AppError | null = null;
            try { nativeError = parseAppError(error); } catch { /* transport/invalid response is uncertain */ }
            this.error = this.mutationError = nativeError ?? { code: 'InvalidInput', message: error instanceof Error ? error.message : '未能确认移动结果', retryable: true };
            return { ok: false, kind: nativeError ? 'definite' : 'unknown', error: this.error };
        } finally { this.pending = false; if (!this.disposed) this.notify(); }
    }
    dispose() { this.disposed = true; this.generation++; this.releaseVerificationWait?.(); this.verifying = null; this.verifyingRefresh = null; this.releaseVerificationWait = null; this.listeners.clear(); }
}
export function organizationIndex(head: Organization | null, known: ReadonlySet<string>) {
    const folders = new Map(head?.folders.map(f => [f.id, f]) ?? []), children = new Map<string | null, string[]>(), paths = new Map<string, string>(), counts = new Map<string | null, number>(), mediaFolder = new Map<string, string | null>();
    for (const f of folders.values()) {
        const siblings = children.get(f.parentId) ?? [];
        siblings.push(f.id);
        children.set(f.parentId, siblings);
    }
    const path = (id: string): string => { const cached = paths.get(id); if (cached !== undefined)
        return cached; const f = folders.get(id)!; const value = (f.parentId ? path(f.parentId) + '/' : '') + f.name; paths.set(id, value); return value; };
    for (const id of folders.keys())
        path(id);
    for (const m of head?.media ?? []) {
        if (known.has(m.mediaId))
            mediaFolder.set(m.mediaId, m.folderId);
        let id = m.folderId;
        counts.set(null, (counts.get(null) ?? 0) + 1);
        while (id !== null) {
            counts.set(id, (counts.get(id) ?? 0) + 1);
            id = folders.get(id)?.parentId ?? null;
        }
    }
    return { folders, children, paths, counts, mediaFolder };
}
/** Preview only; native rechecks organization and recycle state under its commit lock. */
export function folderRemoval(head: Organization | null, folderId: string, recycled: ReadonlySet<string> | null) {
    const index = organizationIndex(head, new Set()), folder = index.folders.get(folderId);
    const subtree = new Set<string>(), pending = folder ? [folderId] : [];
    while (pending.length) {
        const id = pending.pop()!;
        subtree.add(id);
        pending.push(...index.children.get(id) ?? []);
    }
    let associated = 0, trashed = 0;
    for (const membership of head?.media ?? []) {
        if (membership.folderId && subtree.has(membership.folderId)) {
            associated++;
            if (recycled?.has(membership.mediaId)) trashed++;
        }
    }
    const blocked = associated - trashed;
    const reason = associated && recycled === null ? '回收站状态不可用' : blocked ? '仍有关联音频' : '';
    return { allowed: !!folder && !reason, reason, folderCount: subtree.size, associated, trashed, blocked, parentPath: folder?.parentId ? index.paths.get(folder.parentId)! : '全部音频' };
}
