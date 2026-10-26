import { normalizeError } from '../../bridge/client';
import type { AppError } from '../../bridge/types';
import type { Organization, OrganizationCommands, OrganizationOperation, OrganizationSnapshot } from '../../bridge/organization';
export interface OrganizationDraft {
    expectedRevision: number;
    operation: OrganizationOperation;
}
/** Metadata only. No reference to personal document, queue, playback or catalog adoption. */
export class OrganizationController {
    snapshot: Organization | null = null;
    selectedFolderId: string | null = null;
    error: AppError | null = null;
    private mutationError: AppError | null = null;
    pending = false;
    private disposed = false;
    private generation = 0;
    private reading: Promise<void> | null = null;
    private version = 0;
    private listeners = new Set<() => void>();
    constructor(readonly projectId: string, readonly runtimeNonce: string, readonly writable: boolean, private api: OrganizationCommands) { }
    subscribe = (f: () => void) => { this.listeners.add(f); return () => { this.listeners.delete(f); }; };
    getVersion = () => this.version;
    private notify() { this.version++; this.listeners.forEach(f => f()); }
    private install(value: OrganizationSnapshot) { if (value.projectId !== this.projectId || value.runtimeNonce !== this.runtimeNonce || value.organization.projectId !== this.projectId)
        return; if (this.snapshot && value.organization.revision < this.snapshot.revision)
        return; this.snapshot = value.organization; if (this.selectedFolderId && !value.organization.folders.some(f => f.id === this.selectedFolderId))
        this.selectedFolderId = null; this.error = this.mutationError; }
    select(id: string | null) { if (id !== null && !this.snapshot?.folders.some(f => f.id === id))
        return; this.selectedFolderId = id; this.notify(); }
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
    beginEdit(operation: OrganizationOperation): OrganizationDraft { this.mutationError = null; this.error = null; return { expectedRevision: this.snapshot?.revision ?? 0, operation }; }
    async submit(draft: OrganizationDraft) { if (this.disposed || !this.writable || !this.snapshot || this.pending)
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
