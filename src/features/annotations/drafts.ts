import type { Change } from '../../bridge/types';
import { normalizeError } from '../../bridge/client';
import type { ActiveProject } from '../project/useProjectLifecycle';
/** Owned by the project editor, not the mounted input. Hidden dirty objects keep a submitter. */
export class AnnotationDrafts {
  private registrations = new Map<string, () => void>();
  private pending = new Map<string, Promise<unknown>>();
  constructor(private active: ActiveProject) {}
  owns(key: string) { return this.registrations.has(key); }
  read(key: string): Change | undefined {
    const value = this.active.store.drafts.get(key); return value ? JSON.parse(value) as Change : undefined;
  }
  write(key: string, change: Change) {
    if (!this.registrations.has(key)) this.registrations.set(key, this.active.lifecycle.registerDraft(key, () => this.submit(key)));
    this.active.store.setDraft(key, JSON.stringify(change));
  }
  async submit(key: string): Promise<unknown> {
    if (this.pending.has(key)) return this.pending.get(key);
    let change = this.read(key); if (!change) return;
    const failure = this.active.queue.unresolvedFailures.find(f => f.draftKey === key);
    const work = (async () => {
      try {
        await this.active.queue.flush().catch(cause => { if (!failure) throw cause; });
        if (this.active.queue.needsRefresh) await this.active.queue.refresh();
        change = this.read(key); if (!change) return;
        // Bounds drafts own only geometry. Read after accepted notes/category writes finish.
        if (change.type === 'updateAnnotation') {
          const id = change.annotation.id;
          const latest = this.active.store.snapshot.document.annotations.find(a => a.id === id);
          if (latest) change = { ...change, annotation: { ...latest, region: change.annotation.region, updatedAt: new Date().toISOString() } };
        }
        return await (failure ? this.active.queue.retry(failure.id, change) : this.active.queue.enqueue(change, { draftKey: key, owner: 'annotations' }));
      } catch (cause) { this.active.store.setError(normalizeError(cause)); throw cause; }
      finally {
        this.pending.delete(key);
        if (!this.active.store.drafts.has(key)) { this.registrations.get(key)?.(); this.registrations.delete(key); }
      }
    })();
    this.pending.set(key, work); return work;
  }
  dispose() { this.registrations.forEach(unregister => unregister()); this.registrations.clear(); }
}
