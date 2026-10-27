import { exampleClient, type ExampleAPI, type ExampleEntry, type ExampleLibrary, type ExampleOwner, type ExampleScope } from '../../bridge/examples';
import { normalizeError } from '../../bridge/client';
import type { ActiveProject } from '../project/useProjectLifecycle';
import type { IdentityController } from '../identity/controller';
import { retryAdmission } from '../../bridge/admission';
export function exampleOwner(active: ActiveProject | null, identity?: IdentityController): ExampleOwner | null {
    if (!active)
        return null;
    const context = active.collaboration, runtimeNonce = context?.runtimeNonce ?? identity?.snapshot?.runtimeNonce;
    if (!runtimeNonce)
        return null;
    return { projectId: active.store.snapshot.document.projectId, runtimeNonce, actorId: context ? context.actor?.authorId ?? null : identity?.selected?.authorId ?? null };
}
export function friendlyName(path: string) { return Array.from(path.split(/[\\/]/).at(-1)?.replace(/\.[^.]*$/, '') || '示例').slice(0, 128).join(''); }
export function nameError(name: string) { return !name.trim() ? '请输入示例名称' : Array.from(name).length > 128 ? '名称最多 128 个字符' : /[\u0000-\u001f\u007f-\u009f]/.test(name) ? '名称不能包含控制字符' : null; }
export interface ImportRow {
    id: string;
    path: string;
    name: string;
    state: 'pending' | 'success' | 'error';
    error: string | null;
}
const empty = (): ExampleLibrary => ({ entries: [], revisions: {} });
export class ExampleController {
    scope: ExampleScope;
    importScope: ExampleScope;
    search = '';
    rows: ImportRow[] = [];
    importOpen = false;
    renameDraft: {
        entry: ExampleEntry;
        name: string;
    } | null = null;
    error: string | null = null;
    loading = false;
    busy = false;
    private libraries: Record<ExampleScope, ExampleLibrary> = { private: empty(), shared: empty() };
    private alive = true;
    private version = 0;
    private reads = { private: 0, shared: 0 };
    private inFlight:Record<ExampleScope,Set<number>>={private:new Set(),shared:new Set()};
    private lifetime = 0;
    private listeners = new Set<() => void>();
    constructor(readonly owner: ExampleOwner, private api: ExampleAPI = exampleClient) { this.scope = owner.actorId ? 'private' : 'shared'; this.importScope=this.scope; }
    start() { this.lifetime++; this.alive = true; this.loading = false; this.busy = false; this.reads.private++; this.reads.shared++; this.inFlight.private.clear();this.inFlight.shared.clear(); }
    private admitted<T>(attempt:()=>Promise<T>) {
        const lifetime=this.lifetime;
        return retryAdmission(attempt,{valid:()=>this.alive&&lifetime===this.lifetime});
    }
    subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
    getVersion = () => this.version;
    private notify() {
        if (!this.alive) return;
        this.version++;
        this.listeners.forEach(fn => fn());
    }
    get entries() { return this.libraries[this.scope].entries; }
    get refreshing() { return this.inFlight[this.scope].size>0; }
    get filtered() { const q = this.search.toLocaleLowerCase(); return this.entries.filter(e => e.name.toLocaleLowerCase().includes(q)); }
    get canMutate() { return !!this.owner.actorId && this.alive; }
    owns(e: ExampleEntry) { return this.canMutate && e.creatorId === this.owner.actorId; }
    setSearch(q: string) { this.search = q; this.notify(); }
    setScope(scope: ExampleScope) {
        if (this.busy || scope === 'private' && !this.owner.actorId) return;
        this.scope = scope;
        this.error = null;
        this.notify();
        void this.refresh();
    }
    async refresh(scope = this.scope, quiet = false) {
        if (!this.alive) return;
        const read = ++this.reads[scope];
        this.inFlight[scope].add(read);
        if (!quiet && scope===this.scope) {
            this.loading = true;
            this.notify();
        }
        try {
            const data = await this.api.list(this.owner, scope);
            if (this.alive && read === this.reads[scope]) {
                this.libraries[scope] = data;
                if (!quiet && scope===this.scope) this.error = null;
            }
        } catch (e) {
            if (this.alive && read === this.reads[scope] && scope===this.scope) this.error = normalizeError(e).message;
        } finally {
            this.inFlight[scope].delete(read);
            if (this.alive && read === this.reads[scope]) {
                if (scope===this.scope) this.loading = false;
                this.notify();
            }
        }
    }
    private async mutate(action: () => Promise<unknown>, scope = this.scope) {
        if (!this.canMutate || this.busy) return false;
        this.busy = true;
        this.error = null;
        this.notify();
        let ok = false;
        try {
            await action();
            ok = true;
        } catch (e) {
            if (this.alive) this.error = normalizeError(e).message;
        } finally {
            await this.refresh(scope, true);
            if (this.alive) {
                this.busy = false;
                this.notify();
            }
        }
        return ok && this.alive;
    }
    setImportOpen(open: boolean) { if (!this.alive || this.busy) return; this.importOpen = open; this.notify(); }
    setImportPaths(paths: string[]) { if(!this.alive)return;this.importScope=this.scope;this.rows = paths.slice(0, 32).map(path => ({ id: crypto.randomUUID(), path, name: friendlyName(path), state: 'pending', error: null })); this.importOpen=this.rows.length>0;this.error = paths.length > 32 ? '每批最多导入 32 个文件，其余文件请分批导入' : null; this.notify(); }
    setImportScope(scope:ExampleScope) {
        if(!this.canMutate||this.busy||this.rows.some(row=>row.state==='success'))return;
        this.importScope=scope;this.notify();
    }
    editRow(id: string, name: string) { if (this.busy)
        return; this.rows = this.rows.map(r => r.id === id && r.state !== 'success' ? { ...r, name, state: 'pending', error: null } : r); this.notify(); }
    async importRows() {
        if (!this.canMutate || this.busy)
            return;
        this.busy = true;
        this.notify();
        const scope = this.importScope;
        try {
            for (const row of this.rows) {
                if (!this.alive)
                    break;
                if (row.state === 'success')
                    continue;
                const invalid = nameError(row.name);
                if (invalid) {
                    row.state = 'error';
                    row.error = invalid;
                    this.notify();
                    continue;
                }
                await this.refresh(scope, true);
                if (!this.alive)
                    break;
                try {
                    await this.admitted(()=>this.api.import(this.owner, scope, row.path, row.name, this.libraries[scope].revisions[this.owner.actorId!] ?? 0));
                    if (this.alive) {
                        row.state = 'success';
                        row.error = null;
                    }
                }
                catch (e) {
                    if (this.alive) {
                        row.state = 'error';
                        row.error = normalizeError(e).message;
                    }
                }
                await this.refresh(scope, true);
                this.notify();
            }
        }
        finally {
            if (this.alive) {
                this.busy = false;
                this.notify();
            }
        }
    }
    async addCurrent(mediaId: string, name: string, scope = this.scope) {
        const invalid = nameError(name);
        if (invalid) {
            this.error = invalid;
            this.notify();
            return false;
        }
        return this.mutate(async () => {
            await this.refresh(scope, true);
            if (!this.alive) return;
            return this.admitted(()=>this.api.fromProject(this.owner, scope, mediaId, name, this.libraries[scope].revisions[this.owner.actorId!] ?? 0));
        }, scope);
    }
    beginRename(entry: ExampleEntry) { if (!this.owns(entry))
        return; this.renameDraft = { entry, name: entry.name }; this.error = null; this.notify(); }
    setRename(name: string) { if (this.renameDraft) {
        this.renameDraft = { ...this.renameDraft, name };
        this.notify();
    } }
    cancelRename() { this.renameDraft = null; this.error = null; this.notify(); }
    async saveRename() { const draft = this.renameDraft; if (!draft)
        return; const invalid = nameError(draft.name); if (invalid) {
        this.error = invalid;
        this.notify();
        return;
    } const entry = this.libraries[draft.entry.scope].entries.find(e => e.creatorId === draft.entry.creatorId && e.sampleId === draft.entry.sampleId) ?? draft.entry; if (await this.rename(entry, draft.name)) {
        this.renameDraft = null;
        this.notify();
    } }
    async rename(entry: ExampleEntry, name: string) { if (!this.owns(entry))
        return false; const invalid = nameError(name); if (invalid) {
        this.error = invalid;
        this.notify();
        return false;
    } return this.mutate(() => this.api.rename(this.owner, entry, name), entry.scope); }
    async remove(entry: ExampleEntry) { if (!this.owns(entry))
        return false; return this.mutate(() => this.api.remove(this.owner, entry), entry.scope); }
    async copy(entry: ExampleEntry) {
        const target = entry.scope === 'private' ? 'shared' : 'private';
        return this.mutate(async () => {
            await this.refresh(target, true);
            if (!this.alive) return;
            return this.admitted(()=>this.api.copy(this.owner, entry, target, this.libraries[target].revisions[this.owner.actorId!] ?? 0));
        }, target);
    }
    dispose() { this.importOpen = false; this.lifetime++; this.alive = false; this.reads.private++; this.reads.shared++; this.inFlight.private.clear();this.inFlight.shared.clear();this.listeners.clear(); }
}
