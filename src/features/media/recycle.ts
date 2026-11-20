import { normalizeError } from '../../bridge/client';
import type { AppError } from '../../bridge/types';
import type { Recycle, RecycleCommands, RecycleOperation, RecycleSnapshot } from '../../bridge/recycle';
import type { ActiveProject } from '../project/useProjectLifecycle';
import { admitted, suspendRefresh } from '../collaboration/admission';
import { PurgeController } from './purge';
export interface RecycleDraft {
    expectedRevision: number;
    operation: RecycleOperation;
}
export interface VerifiedRecycle { readonly snapshot: Recycle; readonly mutationEpoch: number; readonly purgeVersion: number; readonly readEpoch: number }
/** Shared recycle metadata; writes coordinate with the owner lifecycle without editing personal content. */
export class RecycleController {
    readonly purge: PurgeController;
    snapshot: Recycle | null = null;
    error: AppError | null = null;
    private mutationError: AppError | null = null;
    pending = false;
    private disposed = false;
    private generation = 0;
    private mutationEpoch = 0;
    private readEpoch = 0;
    private reading: Promise<void> | null = null;
    private verifying: Promise<VerifiedRecycle> | null = null;
    private verificationStates = new WeakMap<Promise<VerifiedRecycle>, { retired: boolean; observeNewer: boolean }>();
    private verifyingRefresh: Promise<void> | null = null;
    private releaseVerificationWait: (() => void) | null = null;
    private version = 0;
    private listeners = new Set<() => void>();
    constructor(readonly projectId: string, readonly runtimeNonce: string, readonly writable: boolean, private api: RecycleCommands, private owner?: ActiveProject) { this.purge = new PurgeController(projectId, runtimeNonce, writable, undefined, owner); }
    subscribe = (f: () => void) => { this.listeners.add(f); return () => { this.listeners.delete(f); }; };
    getVersion = () => this.version;
    private notify() { this.version++; this.listeners.forEach(f => f()); }
    private install(value: RecycleSnapshot) { if (value.projectId !== this.projectId || value.runtimeNonce !== this.runtimeNonce || value.recycle.projectId !== this.projectId)
        return; if (this.snapshot && value.recycle.revision < this.snapshot.revision)
        return; if (!this.snapshot || JSON.stringify(this.snapshot) !== JSON.stringify(value.recycle)) this.snapshot = value.recycle; this.error = this.mutationError; }
    refresh(force = false, allowPending = false): Promise<void> {
        if (this.disposed) return Promise.resolve();
        if (this.verifyingRefresh && !force) return this.verifyingRefresh;
        if (this.reading && !force) return this.reading;
        // Forced reads follow a known change and invalidate prior review evidence immediately.
        if (force) this.readEpoch++;
        const generation = ++this.generation, mutationEpoch = this.mutationEpoch, purgeVersion = this.purge.getVersion();
        const currentOwner = () => !this.owner || (this.owner.collaboration?.runtimeNonce === this.runtimeNonce && this.owner.store.snapshot.document.projectId === this.projectId);
        const beforeSnapshot = this.snapshot, beforeError = JSON.stringify(this.error);
        const reading = (async () => {
            let installedNewer = false;
            try {
                const value = await this.api.get(this.projectId);
                const sameOwner = currentOwner(), sameMutation = mutationEpoch === this.mutationEpoch && purgeVersion === this.purge.getVersion();
                if (!this.disposed && (!this.pending || allowPending) && !this.purge.pending && sameOwner && sameMutation && generation === this.generation) {
                    if (value.projectId === this.projectId && value.runtimeNonce === this.runtimeNonce && value.recycle.projectId === this.projectId && (!this.snapshot || value.recycle.revision >= this.snapshot.revision)) this.install(value);
                    else this.readEpoch++;
                } else if (!this.disposed && !this.pending && !this.purge.pending && sameOwner && sameMutation && (!this.owner || !this.owner.lifecycle.admissionClosed) && generation !== this.generation && value.projectId === this.projectId && value.runtimeNonce === this.runtimeNonce && value.recycle.projectId === this.projectId && (!this.snapshot || value.recycle.revision > this.snapshot.revision)) {
                    const currentError = this.error; this.install(value); this.error = currentError; installedNewer = true;
                }
            } catch (error) {
                if (!this.disposed && currentOwner() && mutationEpoch === this.mutationEpoch && purgeVersion === this.purge.getVersion() && generation === this.generation) { this.readEpoch++; this.error = this.mutationError ?? normalizeError(error); }
            } finally {
                if (!this.disposed && (generation === this.generation || installedNewer) && (this.snapshot !== beforeSnapshot || JSON.stringify(this.error) !== beforeError)) this.notify();
            }
        })();
        this.reading = reading;
        void reading.finally(() => { if (this.reading === reading) this.reading = null; });
        return reading;
    }
    readVerified(): Promise<VerifiedRecycle> {
        this.releaseVerificationWait?.();
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
    retireVerified(reading: Promise<VerifiedRecycle>, observeNewer = false) {
        const state = this.verificationStates.get(reading);
        if (!state) return;
        if (state.retired) { if (!observeNewer) state.observeNewer = false; return; }
        state.retired = true; state.observeNewer = observeNewer;
        if (this.verifying === reading) {
            this.releaseVerificationWait?.();
            this.verifying = null; this.verifyingRefresh = null; this.releaseVerificationWait = null;
        }
    }
    private async performVerifiedRead(state: { retired: boolean; observeNewer: boolean }): Promise<VerifiedRecycle> {
        if (this.disposed) throw new Error('项目会话已结束，请重新打开项目');
        const generation = ++this.generation, mutationEpoch = this.mutationEpoch, purgeVersion = this.purge.getVersion(), before = this.snapshot, beforeError = JSON.stringify(this.error);
        let installedNewer = false;
        try {
            const value = await this.api.get(this.projectId);
            const bound = value.projectId === this.projectId && value.runtimeNonce === this.runtimeNonce && value.recycle.projectId === this.projectId;
            const authorized = !this.disposed && !this.pending && !this.purge.pending && purgeVersion === this.purge.getVersion() && mutationEpoch === this.mutationEpoch && (!this.owner || (!this.owner.lifecycle.admissionClosed && !this.owner.store.editingDisabled && this.owner.collaboration?.runtimeNonce === this.runtimeNonce && this.owner.store.snapshot.document.projectId === this.projectId));
            if (authorized && bound && (state.retired ? state.observeNewer : generation !== this.generation) && (!this.snapshot || value.recycle.revision > this.snapshot.revision)) {
                const currentError = this.error; this.install(value); this.error = currentError; installedNewer = true;
            }
            if (state.retired || !authorized || !bound || generation !== this.generation || (this.snapshot && value.recycle.revision < this.snapshot.revision)) throw new Error('回收站读取已失效，请重新刷新');
            this.install(value);
            return { snapshot: this.snapshot!, mutationEpoch, purgeVersion, readEpoch: this.readEpoch };
        } catch (error) {
            if (!state.retired && !this.disposed && generation === this.generation) { this.readEpoch++; this.error = this.mutationError ?? normalizeError(error); }
            throw error;
        } finally { if (!this.disposed && ((!state.retired && generation === this.generation) || installedNewer) && (this.snapshot !== before || JSON.stringify(this.error) !== beforeError)) this.notify(); }
    }
    isVerifiedCurrent(read: VerifiedRecycle): boolean {
        return !this.disposed && !this.pending && !this.purge.pending && this.purge.getVersion() === read.purgeVersion && this.mutationEpoch === read.mutationEpoch && this.readEpoch === read.readEpoch && this.snapshot === read.snapshot && (!this.owner || (!this.owner.lifecycle.admissionClosed && !this.owner.store.editingDisabled && this.owner.collaboration?.runtimeNonce === this.runtimeNonce && this.owner.store.snapshot.document.projectId === this.projectId));
    }
    beginEdit(operation: RecycleOperation): RecycleDraft { this.mutationError = null; this.error = null; return { expectedRevision: this.snapshot?.revision ?? 0, operation }; }
    private async apply(draft: RecycleDraft): Promise<RecycleSnapshot> {
        // Capture before waiting: retry the same reviewed operation, never a later draft.
        const expectedRevision = draft.expectedRevision, operation = structuredClone(draft.operation);
        const action = () => this.api.apply(this.projectId, expectedRevision, operation);
        const owner = this.owner;
        if (!owner) return action();
        return await owner.lifecycle.enqueueEdit(async () => {
            // Pause periodic refresh before draining it, so another poll cannot starve the edit.
            // The registered suspension excludes manual sync (which may itself await this edit).
            const resume = await suspendRefresh(owner.lifecycle);
            try {
                return await admitted(owner, action, () => !this.disposed && !owner.lifecycle.admissionClosed
                    && owner.collaboration?.runtimeNonce === this.runtimeNonce
                    && owner.store.snapshot.document.projectId === this.projectId);
            } finally { resume?.(); }
        }) as RecycleSnapshot;
    }
    async submit(draft: RecycleDraft) { if (this.disposed || !this.writable || !this.snapshot || this.pending)
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
    dispose() { this.purge.dispose(); this.disposed = true; this.generation++; this.releaseVerificationWait?.(); this.verifying = null; this.verifyingRefresh = null; this.releaseVerificationWait = null; this.listeners.clear(); }
}
