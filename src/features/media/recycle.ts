import { normalizeError } from '../../bridge/client';
import type { AppError } from '../../bridge/types';
import type { Recycle, RecycleCommands, RecycleOperation, RecycleSnapshot } from '../../bridge/recycle';
export interface RecycleDraft {
    expectedRevision: number;
    operation: RecycleOperation;
}
/** Metadata only. No reference to personal document, queue, playback or catalog adoption. */
export class RecycleController {
    snapshot: Recycle | null = null;
    error: AppError | null = null;
    private mutationError: AppError | null = null;
    pending = false;
    private disposed = false;
    private generation = 0;
    private reading: Promise<void> | null = null;
    private version = 0;
    private listeners = new Set<() => void>();
    constructor(readonly projectId: string, readonly runtimeNonce: string, readonly writable: boolean, private api: RecycleCommands) { }
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
    async submit(draft: RecycleDraft) { if (this.disposed || !this.writable || !this.snapshot || this.pending)
        return false; this.pending = true; this.mutationError = null; this.error = null; this.notify(); try {
        const value = await this.api.apply(this.projectId, draft.expectedRevision, structuredClone(draft.operation));
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
    dispose() { this.disposed = true; this.generation++; this.listeners.clear(); }
}
