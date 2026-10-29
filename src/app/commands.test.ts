import { expect, it, vi } from 'vitest';
import fixture from '../../tests/fixtures/document-v3.json';
import { ProjectStore } from './store';
import { CommandQueue, type ProjectCommands } from './commands';
import { parseProjectDocument, type Change, type ProjectSnapshot } from '../bridge/types';

function snapshot(revision = 0): ProjectSnapshot {
  return { document: { ...parseProjectDocument(structuredClone(fixture)), revision }, canUndo: false, canRedo: false };
}
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; }
function setup(overrides: Partial<ProjectCommands> = {}) {
  const store = new ProjectStore(snapshot());
  const api: ProjectCommands = {
    applyChange: vi.fn(async (_id, revision) => snapshot(revision + 1)),
    getSnapshot: vi.fn(async () => snapshot(10)),
    undo: vi.fn(async (_id, revision) => snapshot(revision + 1)),
    redo: vi.fn(async (_id, revision) => snapshot(revision + 1)),
    ...overrides,
  };
  return { store, api, queue: new CommandQueue(store, api) };
}
const note = (text: string): Change => ({ type: 'updateMediaNote', mediaId: fixture.media[0].id, note: text, mergeKey: null });

it('retirement while a conflict snapshot is in flight does not cancel queued survivor work',async()=>{
 const refresh=deferred<ProjectSnapshot>(),s=setup({applyChange:vi.fn().mockRejectedValueOnce({code:'RevisionConflict',message:'retired',retryable:true}).mockResolvedValueOnce(snapshot(3)),getSnapshot:vi.fn(()=>refresh.promise)}),accepted=vi.fn();
 const a=s.queue.enqueue(note('A'));await vi.waitFor(()=>expect(s.api.getSnapshot).toHaveBeenCalled());
 const global=s.queue.enqueue({type:'addCategory',category:{id:'22222222-2222-4222-8222-222222222222',name:'surviving global',color:'#aabbcc'}},{onAccepted:accepted});s.store.retire([fixture.media[0].id],{...snapshot(2),document:{...snapshot(2).document,media:[],annotations:[],edits:[],analysis:{},playbackMix:{},viewState:{...snapshot(2).document.viewState,media:{},activeMediaId:null,compareMediaId:null}}});refresh.resolve(snapshot(1));await a;await global;expect(accepted).toHaveBeenCalledOnce();expect(s.queue.unresolvedFailures).toHaveLength(0);
});

it('retirement clears only a retired command conflict block and keeps unrelated failures',async()=>{
 const s=setup({applyChange:vi.fn().mockRejectedValueOnce({code:'RevisionConflict',message:'A stale',retryable:true}).mockResolvedValueOnce(snapshot(3)),getSnapshot:vi.fn().mockRejectedValue({code:'SaveFailed',message:'offline',retryable:true})});await expect(s.queue.enqueue(note('A'))).rejects.toBeDefined();expect(s.queue.needsRefresh).toBe(true);
 s.store.retire([fixture.media[0].id],snapshot(2));expect(s.queue.needsRefresh).toBe(false);await s.queue.enqueue({type:'addCategory',category:{id:'22222222-2222-4222-8222-222222222222',name:'global',color:'#aabbcc'}});expect(s.queue.unresolvedFailures).toHaveLength(0);
});

it('transition admission blocks new mutations while accepted commands and refresh finish', async () => {
  const write = deferred<ProjectSnapshot>();
  const read = deferred<ProjectSnapshot>();
  const { queue, api, store } = setup({ applyChange: vi.fn(() => write.promise), getSnapshot: vi.fn(() => read.promise) });
  const accepted = queue.enqueue(note('accepted before transition'));
  const refresh = queue.refresh();
  const release = store.beginTransition();
  expect(() => queue.enqueue(note('too late'))).toThrow();
  expect(() => queue.undo()).toThrow();
  expect(() => queue.redo()).toThrow();
  expect(() => queue.refresh()).toThrow();
  expect(() => store.setDraft('late', 'too late')).toThrow();
  let drained = false;
  const flushing = queue.flush().then(() => { drained = true; });
  write.resolve(snapshot(1));
  await accepted;
  expect(drained).toBe(false);
  // The refresh runs after the accepted write; it cannot finish after adoption.
  await Promise.resolve();
  expect(api.getSnapshot).toHaveBeenCalledTimes(1);
  read.resolve(snapshot(1));
  await refresh; await flushing;
  expect(store.snapshot.document.revision).toBe(1);
  release();
  store.setDraft('late', 'allowed after cancellation');
  expect(store.drafts.get('late')).toBe('allowed after cancellation');
});

it('serializes rapid changes using the latest successful revision', async () => {
  const { queue, api, store } = setup();
  await Promise.all([queue.enqueue(note('a')), queue.enqueue(note('ab'))]);
  expect(vi.mocked(api.applyChange).mock.calls.map((c) => c[1])).toEqual([0, 1]);
  expect(store.snapshot.document.revision).toBe(2);
});
it('keeps newer drafts and rejects queued destructive operations after conflict', async () => {
  const gate = deferred<ProjectSnapshot>();
  const { queue, api, store } = setup({ applyChange: vi.fn(() => gate.promise), getSnapshot: vi.fn(async () => snapshot(7)) });
  store.setDraft('mediaNote', 'first');
  const first = queue.enqueue(note('first'), { draftKey: 'mediaNote' });
  store.setDraft('mediaNote', 'new draft');
  const remove = queue.enqueue({ type: 'removeMedia', mediaId: fixture.media[0].id });
  const outcomes = Promise.allSettled([first, remove]);
  // Reject through the transport boundary, after both edits have been queued.
  gate.reject({ code: 'RevisionConflict', message: 'Changed', retryable: false });
  expect((await outcomes).every((r) => r.status === 'rejected')).toBe(true);
  expect(api.applyChange).toHaveBeenCalledTimes(1);
  expect(api.getSnapshot).toHaveBeenCalledTimes(1);
  expect(store.snapshot.document.revision).toBe(7);
  expect(store.drafts.get('mediaNote')).toBe('new draft');
  expect(store.error?.code).toBe('RevisionConflict');
});
it('does not mark a newer revision saved when an older save completes', async () => {
  const { store, queue } = setup();
  await queue.enqueue(note('a'));
  const savedRevision = store.dirtyRevision;
  await queue.enqueue(note('b'));
  store.markPersisted(fixture.projectId, savedRevision);
  expect(store.persistedRevision).toBe(1);
  expect(store.isDirty).toBe(true);
  store.markPersisted(fixture.projectId, 2);
  store.markPersisted(fixture.projectId, 0);
  expect(store.isDirty).toBe(false);
});
it('does not clear text typed while an earlier draft is in flight', async () => {
  const gate = deferred<ProjectSnapshot>();
  const { store, queue } = setup({ applyChange: () => gate.promise });
  store.setDraft('note', 'a');
  const pending = queue.enqueue(note('a'), { draftKey: 'note' });
  store.setDraft('note', 'ab');
  gate.resolve(snapshot(1)); await pending;
  expect(store.drafts.get('note')).toBe('ab');
});

it('blocks writes after failed conflict refresh until an explicit refresh succeeds', async () => {
  const conflict = { code: 'RevisionConflict', message: 'Changed', retryable: false };
  const { api, queue, store } = setup({ applyChange: vi.fn().mockRejectedValueOnce(conflict).mockResolvedValue(snapshot(8)), getSnapshot: vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(snapshot(7)) });
  await expect(queue.enqueue(note('first'))).rejects.toEqual(conflict);
  await expect(queue.enqueue(note('second'))).rejects.toEqual(conflict);
  expect(api.applyChange).toHaveBeenCalledTimes(1);
  await queue.refresh();
  const [first, second] = queue.unresolvedFailures;
  await queue.retry(first.id, note('reviewed'));
  expect(store.error).toEqual(conflict);
  queue.discardFailure(second.id);
  expect(store.snapshot.document.revision).toBe(8);
  expect(store.error).toBeNull();
});

it('serializes undo and redo with edits and captures change values at enqueue time', async () => {
  const { queue, api } = setup();
  const change = note('first');
  const first = queue.enqueue(change);
  if (change.type === 'updateMediaNote') change.note = 'mutated';
  await Promise.all([first, queue.undo(), queue.redo()]);
  expect(api.applyChange).toHaveBeenCalledWith(fixture.projectId, 0, note('first'));
  expect(api.undo).toHaveBeenCalledWith(fixture.projectId, 1);
  expect(api.redo).toHaveBeenCalledWith(fixture.projectId, 2);
});

it('reports a failed queued edit when callers flush before saving or closing', async () => {
  const failure = { code: 'InvalidInput', message: 'Invalid bounds', retryable: false };
  const { queue } = setup({ applyChange: vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(snapshot(1)) });
  await expect(queue.enqueue(note('bad'))).rejects.toEqual(failure);
  await expect(queue.flush()).rejects.toEqual(failure);
  await queue.retry(queue.unresolvedFailures[0].id, note('corrected'));
  await expect(queue.flush()).resolves.toBeUndefined();
});

it('keeps an earlier failed draft visible to flush after an unrelated queued edit succeeds', async () => {
  const failure = { code: 'InvalidInput', message: 'Invalid note A', retryable: false };
  const { queue, store } = setup({ applyChange: vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(snapshot(1)) });
  store.setDraft('noteA', 'unsaved A');
  const first = queue.enqueue(note('unsaved A'), { draftKey: 'noteA' });
  const second = queue.enqueue({ type: 'updateChannelNote', mediaId: fixture.media[0].id, channelIndex: 0, note: 'B', mergeKey: null });
  const outcomes = await Promise.allSettled([first, second]);
  expect(outcomes.map((result) => result.status)).toEqual(['rejected', 'fulfilled']);
  expect(store.drafts.get('noteA')).toBe('unsaved A');
  await expect(queue.flush()).rejects.toEqual(failure);
  expect(store.error).toEqual(failure);
});

it('resolves only the explicitly retried failure after successful correction', async () => {
  const failureA = { code: 'InvalidInput', message: 'A failed', retryable: false };
  const failureB = { code: 'InvalidInput', message: 'B failed', retryable: false };
  const { queue, store } = setup({ applyChange: vi.fn().mockRejectedValueOnce(failureA).mockRejectedValueOnce(failureB).mockRejectedValueOnce(failureA).mockResolvedValue(snapshot(1)) });
  store.setDraft('A', 'a'); store.setDraft('B', 'b');
  await expect(queue.enqueue(note('a'), { draftKey: 'A' })).rejects.toEqual(failureA);
  await expect(queue.enqueue({ type: 'updateChannelNote', mediaId: fixture.media[0].id, channelIndex: 0, note: 'b', mergeKey: null }, { draftKey: 'B' })).rejects.toEqual(failureB);
  const [first, second] = queue.unresolvedFailures;
  await expect(queue.retry(first.id, note('still bad'))).rejects.toEqual(failureA);
  expect(queue.unresolvedFailures.map((f) => f.id)).toEqual([first.id, second.id]);
  store.setDraft('A', 'corrected');
  await queue.retry(first.id, note('corrected'));
  expect(store.drafts.has('A')).toBe(false);
  expect(store.drafts.get('B')).toBe('b');
  await expect(queue.flush()).rejects.toEqual(failureB);
  expect(store.error).toEqual(failureB);
  queue.discardFailure(second.id);
  expect(store.drafts.has('B')).toBe(false);
  await expect(queue.flush()).resolves.toBeUndefined();
  expect(store.error).toBeNull();
});

it('preserves newer text when an older failed command is retried or discarded', async () => {
  const failure = { code: 'InvalidInput', message: 'Failed', retryable: false };
  const { queue, store } = setup({ applyChange: vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce(snapshot(1)).mockRejectedValueOnce(failure) });
  store.setDraft('A', 'old');
  await expect(queue.enqueue(note('old'), { draftKey: 'A' })).rejects.toEqual(failure);
  store.setDraft('A', 'newer');
  await queue.retry(queue.unresolvedFailures[0].id);
  expect(store.drafts.get('A')).toBe('newer');
  await expect(queue.enqueue(note('newer'), { draftKey: 'A' })).rejects.toEqual(failure);
  store.setDraft('A', 'newest');
  queue.discardFailure(queue.unresolvedFailures[0].id);
  expect(store.drafts.get('A')).toBe('newest');
});

it('does not allow a retry to retarget the failed operation', async () => {
  const failure = { code: 'InvalidInput', message: 'Failed', retryable: false };
  const { queue, api } = setup({ applyChange: vi.fn().mockRejectedValueOnce(failure) });
  await expect(queue.enqueue(note('bad'))).rejects.toEqual(failure);
  expect(queue.unresolvedFailures).toHaveLength(1);
  expect(() => queue.retry(queue.unresolvedFailures[0].id, { type: 'removeMedia', mediaId: fixture.media[0].id })).toThrow('same failed operation and target');
  expect(api.applyChange).toHaveBeenCalledTimes(1);
  await expect(queue.flush()).rejects.toEqual(failure);
});

it('keeps a retry unresolved while in flight and rejects duplicate retry or discard', async () => {
  const failure = { code: 'InvalidInput', message: 'Failed', retryable: false };
  const gate = deferred<ProjectSnapshot>();
  const { queue } = setup({ applyChange: vi.fn().mockRejectedValueOnce(failure).mockImplementationOnce(() => gate.promise) });
  await expect(queue.enqueue(note('bad'))).rejects.toEqual(failure);
  const id = queue.unresolvedFailures[0].id;
  const retry = queue.retry(id, note('corrected'));
  expect(queue.unresolvedFailures).toHaveLength(1);
  expect(() => queue.retry(id)).toThrow('already being retried');
  expect(() => queue.discardFailure(id)).toThrow('already being retried');
  gate.resolve(snapshot(1));
  await retry;
  await expect(queue.flush()).resolves.toBeUndefined();
});
it('an acknowledgement callback failure cannot turn an accepted native mutation into a replayable command failure',async()=>{
 const s=setup(),onAccepted=vi.fn(()=>{throw new Error('UI observer failed');});await expect(s.queue.enqueue(note('accepted'),{onAccepted})).rejects.toThrow('UI observer failed');expect(s.store.snapshot.document.revision).toBe(1);expect(s.queue.unresolvedFailures).toHaveLength(0);expect(s.api.applyChange).toHaveBeenCalledOnce();
});
