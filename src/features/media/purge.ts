import { createPurgeClient, parsePurgeCleanupPage, parsePurgePreview, parsePurgeResult, type PurgeCleanupPage, type PurgeCommands, type PurgePreview, type PurgeResult, type PurgeSelection } from '../../bridge/purge';
import { collaborationClient, createCollaborationStatusParser, type CollaborationStatus } from '../../bridge/collaboration';
import { normalizeError } from '../../bridge/client';
import type { AppError } from '../../bridge/types';
import { admitted, suspendRefresh } from '../collaboration/admission';
import type { ActiveProject } from '../project/useProjectLifecycle';
/** Fixed native capability and original operation, scoped to a single owner/actor/runtime. */
export class PurgeController {
    preview: PurgePreview | null = null;
    result: PurgeResult | null = null;
    error: AppError | null = null;
    pending = false;
    previewOffset = 0;
    cleanupPage: PurgeCleanupPage | null = null;
    cleanupOffset = 0;
    cleanupLoading = false;
    cleanupError: AppError | null = null;
    operationId: string | null = null;
    maintenance: CollaborationStatus['purgeMaintenance'] = { total: 0, items: [] };
    private selection: PurgeSelection | null = null;
    private disposed = false;
    private generation = 0;
    private pageGeneration = 0;
    private version = 0;
    private listeners = new Set<() => void>();
    private readonly actorId: string | null;
    private readonly parseStatus=createCollaborationStatusParser();
    constructor(readonly projectId: string, readonly runtimeNonce: string, readonly writable: boolean, private api: PurgeCommands = createPurgeClient(runtimeNonce, projectId), private owner?: ActiveProject, private newId: () => string = () => crypto.randomUUID()) { this.actorId = owner?.collaboration?.actor?.authorId ?? null; }
    subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
    getVersion = () => this.version;
    private notify() { if (!this.disposed) {
        this.version++;
        this.listeners.forEach(f => f());
    } }
    private valid = () => !this.disposed && (!this.owner || !this.owner.lifecycle.admissionClosed && this.owner.collaboration?.runtimeNonce === this.runtimeNonce && (this.owner.collaboration.actor?.authorId ?? null) === this.actorId && this.owner.store.snapshot.document.projectId === this.projectId);
    private bound(value: {
        projectId: string;
        runtimeNonce: string;
        operationId: string;
    }, operationId: string) {
        if (value.projectId !== this.projectId || value.runtimeNonce !== this.runtimeNonce || value.operationId !== operationId)
            throw new Error('Purge response belongs to another operation');
    }
    private async mutate<T>(action: () => Promise<T>): Promise<T> {
        const owner = this.owner;
        if (!owner)
            return action();
        // Suspend before persistence/admission, including draining any background publication.
        const resume = await suspendRefresh(owner.lifecycle);
        try {
            if (!this.valid())
                throw { code: 'Cancelled', message: 'Purge owner changed', retryable: false } satisfies AppError;
            return await owner.lifecycle.enqueuePersistedEdit(() => admitted(owner, action, this.valid));
        }
        finally {
            resume?.();
        }
    }
    async begin(selection: PurgeSelection) {
        if (!this.valid() || !this.writable || this.pending)
            return false;
        this.cancel();
        this.committedUnknown = false;
        this.selection = structuredClone(selection);
        this.operationId = this.newId();
        this.previewOffset = 0;
        this.preview = null;
        this.result = null;
        this.error = null;
        return this.readPreview(0);
    }
    previewPage(offset: number) { return this.readPreview(offset); }
    private async readPreview(offset: number) {
        if (!this.valid() || !this.selection || !this.operationId || this.pending || !this.writable)
            return false;
        const generation = this.generation, operationId = this.operationId, selection = structuredClone(this.selection);
        this.pending = true;
        this.error = null;
        this.notify();
        try {
            const p = parsePurgePreview(await this.mutate(() => this.api.preview(operationId, selection, offset, 50)));
            this.bound(p, operationId);
            if (!this.valid() || generation !== this.generation)
                return false;
            if (this.preview && (p.previewId !== this.preview.previewId || p.requestedCount !== this.preview.requestedCount || p.eligibleCount !== this.preview.eligibleCount || p.retainedCount !== this.preview.retainedCount || p.otherAuthorRetainedCount !== this.preview.otherAuthorRetainedCount || p.audioBytes !== this.preview.audioBytes || p.requiresFormatUpgrade !== this.preview.requiresFormatUpgrade))
                throw new Error('Purge preview changed');
            this.preview = p;
            this.previewOffset = offset;
            return true;
        }
        catch (e) {
            if (this.valid() && generation === this.generation)
                this.error = normalizeError(e);
            return false;
        }
        finally {
            if (generation === this.generation) {
                this.pending = false;
                this.notify();
            }
        }
    }
    async commit() {
        if (!this.valid() || !this.writable || this.pending || !this.preview || this.result || this.committed)
            return false;
        const previewId = this.preview.previewId, operationId = this.preview.operationId;
        return this.writeResult(operationId, () => this.api.commit(previewId, operationId));
    }
    async retryCleanup() {
        if (!this.valid() || !this.writable || this.pending || !this.operationId || !this.committed)
            return false;
        const operationId = this.operationId;
        const ok = await this.writeResult(operationId, () => this.api.retryCleanup(operationId));
        if (ok && this.valid() && this.cleanupPage)
            await this.loadCleanupPage(this.cleanupOffset);
        return ok;
    }
    get committed() { return !!this.result && this.result.status !== 'no-eligible-items' || !!this.operationId && this.maintenance.items.some(i => i.operationId === this.operationId && i.committed) || this.committedUnknown; }
    private committedUnknown = false;
    private async writeResult(operationId: string, action: () => Promise<PurgeResult>) {
        const generation = this.generation;
        this.pending = true;
        this.error = null;
        this.notify();
        try {
            const r = parsePurgeResult(await this.mutate(action));
            this.bound(r, operationId);
            if (!this.valid() || generation !== this.generation)
                return false;
            this.result = r;
            this.committedUnknown = false;
            // Native status supplies the personal retirement snapshot, never foreign author layers.
            if (this.owner) {
                const status = await collaborationClient.status();
                if (this.valid() && generation === this.generation)
                    this.acceptStatus(status);
            }
            return this.valid() && generation === this.generation;
        }
        catch (e) {
            if (this.valid() && generation === this.generation) {
                this.error = normalizeError(e);
                const d = this.error.details as Record<string, unknown> | undefined;
                if (d?.purgeCommitted === true && d.operationId === operationId && d.projectId === this.projectId && d.runtimeNonce === this.runtimeNonce)
                    this.committedUnknown = true;
            }
            return false;
        }
        finally {
            if (generation === this.generation) {
                this.pending = false;
                this.notify();
            }
        }
    }
    acceptStatus(status: CollaborationStatus) {
        if (!this.valid() || status.runtimeNonce !== this.runtimeNonce || status.projectId !== this.projectId || this.owner && (status.actor?.authorId ?? null) !== this.actorId)
            return;
        this.parseStatus(status, this.owner?.store.snapshot.document);
        const changed=JSON.stringify(this.maintenance)!==JSON.stringify(status.purgeMaintenance);
        if(changed)this.maintenance = structuredClone(status.purgeMaintenance);
        if (status.retirement && this.owner)
            this.owner.store.retire(status.retirement.mediaIds, status.retirement.snapshot);
        if(changed)this.notify();
    }
    viewOperation(operationId: string) {
        if (!this.valid() || this.pending || !this.maintenance.items.some(i => i.operationId === operationId && i.committed))
            return false;
        this.cancel();
        this.operationId = operationId;
        this.result = null;
        this.committedUnknown = false;
        this.notify();
        return true;
    }
    async loadCleanupPage(offset = this.cleanupOffset): Promise<boolean> {
        if (!this.valid() || !this.operationId || !this.committed)
            return false;
        const generation = this.generation, pageGeneration = ++this.pageGeneration, operationId = this.operationId;
        this.cleanupLoading = true;
        this.cleanupError = null;
        this.notify();
        try {
            // Read-only query deliberately does not become a pending lifecycle edit.
            const p = parsePurgeCleanupPage(await this.api.cleanupPage(operationId, offset, 50));
            this.bound(p, operationId);
            if (!this.valid() || generation !== this.generation || pageGeneration !== this.pageGeneration)
                return false;
            if (offset > 0 && offset >= p.total)
                return await this.loadCleanupPage(p.total ? Math.floor((p.total - 1) / 50) * 50 : 0);
            this.cleanupPage = p;
            this.cleanupOffset = p.offset;
            return true;
        }
        catch (e) {
            if (this.valid() && generation === this.generation && pageGeneration === this.pageGeneration)
                this.cleanupError = normalizeError(e);
            return false;
        }
        finally {
            if (generation === this.generation && pageGeneration === this.pageGeneration) {
                this.cleanupLoading = false;
                this.notify();
            }
        }
    }
    cancel() {
        const operation = this.preview?.operationId ?? (this.selection ? this.operationId : null);
        const generation = ++this.generation;
        this.pageGeneration++;
        this.pending = false;
        this.cleanupLoading = false;
        this.cleanupPage = null;
        this.cleanupError = null;
        // Release the preview even after commit; durable cleanup uses the operation ID.
        if (operation)
            void this.api.cancel(operation).catch(e => { if (this.valid() && generation === this.generation) {
                this.error = normalizeError(e);
                this.notify();
            } });
        this.selection = null;
        this.preview = null;
        this.notify();
    }
    dispose() { this.cancel(); this.disposed = true; this.listeners.clear(); }
}
