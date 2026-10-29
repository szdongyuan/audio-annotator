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
/** Shared recycle metadata; writes coordinate with the owner lifecycle without editing personal content. */
export class RecycleController {
    readonly purge: PurgeController;
    snapshot: Recycle | null = null;
    error: AppError | null = null;
    private mutationError: AppError | null = null;
    pending = false;
    private disposed = false;
    private generation = 0;
    private reading: Promise<void> | null = null;
    private version = 0;
    private listeners = new Set<() => void>();
    constructor(readonly projectId: string, readonly runtimeNonce: string, readonly writable: boolean, private api: RecycleCommands, private owner?: ActiveProject) { this.purge = new PurgeController(projectId, runtimeNonce, writable, undefined, owner); }
    subscribe = (f: () => void) => { this.listeners.add(f); return () => { this.listeners.delete(f); }; };
    getVersion = () => this.version;
    private notify() { this.version++; this.listeners.forEach(f => f()); }
    private install(value: RecycleSnapshot) { if (value.projectId !== this.projectId || value.runtimeNonce !== this.runtimeNonce || value.recycle.projectId !== this.projectId)
        return; if (this.snapshot && value.recycle.revision < this.snapshot.revision)
        return; this.snapshot = value.recycle; this.error = this.mutationError; }
    refresh(force = false): Promise<void> {
        if (this.disposed) return Promise.resolve();
        if (this.reading && !force) return this.reading;
        const generation = ++this.generation;
        const reading = (async () => {
            try {
                const value = await this.api.get(this.projectId);
                if (!this.disposed && generation === this.generation) this.install(value);
            } catch (error) {
                if (!this.disposed && generation === this.generation) this.error = this.mutationError ?? normalizeError(error);
            } finally {
                if (!this.disposed && generation === this.generation) this.notify();
            }
        })();
        this.reading = reading;
        void reading.finally(() => { if (this.reading === reading) this.reading = null; });
        return reading;
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
        return false; this.pending = true; this.mutationError = null; this.error = null; this.notify(); try {
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
            await this.refresh(true);
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
    dispose() { this.purge.dispose(); this.disposed = true; this.generation++; this.listeners.clear(); }
}
