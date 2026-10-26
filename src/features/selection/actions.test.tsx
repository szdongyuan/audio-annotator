import { expect, it, vi } from 'vitest';
import fixture from '../../../tests/fixtures/document-v3.json';
import { parseProjectDocument, type Change } from '../../bridge/types';
import { ProjectStore } from '../../app/store';
import { CommandQueue } from '../../app/commands';
import { ProjectLifecycle } from '../project/lifecycle';
import { SelectionState } from './state';
import { selectionActions } from './actions';
function setup() {
  const store = new ProjectStore({ document: parseProjectDocument(structuredClone(fixture)), canUndo: false, canRedo: false });
  const applyChange = vi.fn(async (_id: string, revision: number, c: Change) => {
    const d = structuredClone(store.snapshot.document); d.revision = revision + 1;
    if (c.type === 'addAnnotation') d.annotations.push(c.annotation);
    if (c.type === 'updateAnnotation') d.annotations = d.annotations.map(a => a.id === c.annotation.id ? c.annotation : a);
    if (c.type === 'addEdit') d.edits.push(c.edit);
    if (c.type === 'updateEdit') d.edits = d.edits.map(e => e.id === c.edit.id ? c.edit : e);
    if (c.type === 'removeAnnotation') d.annotations = d.annotations.filter(a => a.id !== c.id);
    return { ...store.snapshot, document: d };
  });
  const queue = new CommandQueue(store, { applyChange, undo: async () => store.snapshot, redo: async () => store.snapshot, getSnapshot: async () => store.snapshot });
  const save = vi.fn(async (_id: string, rev: number) => rev);
  const lifecycle = new ProjectLifecycle(store, queue, { save, close: async () => {} });
  const state = new SelectionState(), active = { store, queue, lifecycle, path: '' };
  return { active, state, actions: selectionActions(active, state), applyChange, save };
}
it('enrolls before save, creates one annotation for repeated classification and binds without stealing selection', async () => {
  const s = setup(), doc = s.active.store.snapshot.document;
  s.state.select({ region: doc.annotations[0].region, object: null }); const target = s.state.getSnapshot()!;
  const one = s.actions.classify(target, null), two = s.actions.classify(target, doc.categories[0].id);
  const save = s.active.lifecycle.save();
  await Promise.all([one, two, save]);
  expect(s.applyChange.mock.calls.map(c => c[2].type)).toEqual(['addAnnotation', 'updateAnnotation']);
  expect(s.active.store.snapshot.document.annotations.at(-1)?.categoryIds).toEqual([doc.categories[0].id]);
  expect(s.state.getSnapshot()?.object?.id).toBe(s.active.store.snapshot.document.annotations.at(-1)?.id);
  expect(s.save).toHaveBeenCalledWith(doc.projectId, doc.revision + 2); s.active.lifecycle.dispose();
});
it('Delete reuses and enables an exact mask; explicit delete only removes the captured object', async () => {
  const s = setup(), doc = s.active.store.snapshot.document, edit = doc.edits[0]; edit.enabled = false;
  s.state.select({ region: { ...edit.region }, object: null });
  const captured=s.state.getSnapshot()!; await s.actions.mask(captured); await s.actions.mask(captured);
  expect(s.active.store.snapshot.document.edits).toHaveLength(doc.edits.length);
  expect(s.active.store.snapshot.document.edits[0].enabled).toBe(true);
  const a = doc.annotations[0], target = { region: a.region, object: { kind: 'annotation' as const, id: a.id } };
  await s.actions.remove(target); expect(s.active.store.snapshot.document.annotations).toHaveLength(0);
  expect(s.active.store.snapshot.document.edits).toHaveLength(doc.edits.length); s.active.lifecycle.dispose();
});
it('a queued old selection action cannot bind over a new selection and ignores removed targets', async () => {
  const s = setup(), a = s.active.store.snapshot.document.annotations[0];
  s.state.select({ region: a.region, object: null }); const target = s.state.getSnapshot()!;
  const pending = s.actions.classify(target, null);
  const next = { region: { ...a.region, lowHz: 1 }, object: null }; s.state.select(next);
  await pending; expect(s.state.getSnapshot()).toBe(next);
  await s.actions.remove({ region: a.region, object: { kind: 'annotation', id: 'absent' } });
  expect(s.applyChange).toHaveBeenCalledTimes(1); s.active.lifecycle.dispose();
});
it('classification drains a draft before reading its annotation, and a closing barrier retains accepted actions', async () => {
  const s = setup(), a = s.active.store.snapshot.document.annotations[0];
  let release!: () => void;
  s.active.store.setDraft('note', 'pending');
  const unregister = s.active.lifecycle.registerDraft('note', async () => {
    await new Promise<void>(resolve => { release = resolve; });
    await s.active.queue.enqueue({ type: 'updateAnnotation', annotation: { ...a, note: 'new note' } }, { owner: 'annotations', draftKey: 'note' });
  });
  const action = s.actions.classify({ region: a.region, object: { kind: 'annotation', id: a.id } }, null);
  await new Promise(resolve => setTimeout(resolve, 0));
  const closing = s.active.lifecycle.close(); release(); await action; await closing;
  expect(s.active.store.snapshot.document.annotations[0]).toMatchObject({ note: 'new note', categoryIds: [] });
  expect(s.save).toHaveBeenCalledWith(s.active.store.snapshot.document.projectId, s.active.store.snapshot.document.revision); unregister();
});
it('a failed mask command remains owned by masks and stops subsequent annotation work', async () => {
  const s = setup(), a = s.active.store.snapshot.document.annotations[0], target = { region: { ...a.region, lowHz: 1 }, object: null };
  s.applyChange.mockRejectedValueOnce({ code: 'InvalidInput', message: 'mask rejected', retryable: true });
  await s.actions.mask(target); await s.actions.classify(target, null);
  expect(s.applyChange).toHaveBeenCalledOnce(); expect(s.active.queue.unresolvedFailures[0]).toMatchObject({ owner: 'masks' }); s.active.lifecycle.dispose();
});

it.each(['classify', 'mask'] as const)('a pending %s action never reactivates a deactivated temporary target', async kind => {
  const s = setup(), a = s.active.store.snapshot.document.annotations[0];
  const target = { region: { ...a.region, lowHz: 1 }, object: null }; s.state.select(target);
  const pending = kind === 'mask' ? s.actions.mask(target) : s.actions.classify(target, null);
  s.state.deactivate(); await pending;
  expect(s.applyChange).toHaveBeenCalledOnce(); expect(s.state.getActiveSelection()).toBeNull();
  expect(s.state.getCandidate()).toBe(target); s.active.lifecycle.dispose();
});

it('serializes different region choices into one annotation without losing earlier labels or notes', async () => {
 const s=setup(), doc=s.active.store.snapshot.document;
 const second={id:'00000000-0000-4000-8000-000000000077',name:'第二标签',color:'#123456'}; doc.categories.push(second);
 const target={region:{...doc.annotations[0].region},object:null}; s.state.select(target);
 await Promise.all([s.actions.classify(target,doc.categories[0].id),s.actions.classify(target,second.id)]);
 const annotation=s.active.store.snapshot.document.annotations.at(-1)!;
 expect(annotation.categoryIds).toEqual([doc.categories[0].id,second.id]);
 expect(s.applyChange.mock.calls.filter(c=>c[2].type==='addAnnotation')).toHaveLength(1);
 const saved={region:annotation.region,object:{kind:'annotation' as const,id:annotation.id}};
 const revision=s.active.store.snapshot.document.revision;
 await s.actions.classify(saved,second.id);
 expect(s.active.store.snapshot.document.revision).toBe(revision+1); expect(s.active.store.snapshot.document.annotations.at(-1)?.categoryIds).toEqual([doc.categories[0].id]);
 expect(s.active.store.snapshot.document.annotations).toHaveLength(doc.annotations.length+1);
 s.active.lifecycle.dispose();
});

it('masking geometry already containing gain creates an independent mask',async()=>{
 const s=setup(),doc=s.active.store.snapshot.document;
 doc.edits[0].operation={type:'gain',gainDb:6};
 const gain=structuredClone(doc.edits[0]);
 s.state.select({region:{...gain.region},object:null});
 await s.actions.mask(s.state.getSnapshot()!);
 expect(s.active.store.snapshot.document.edits).toHaveLength(2);
 expect(s.active.store.snapshot.document.edits[0]).toEqual(gain);
 expect(s.active.store.snapshot.document.edits[1].operation).toEqual({type:'mask'});
 s.active.lifecycle.dispose();
});
it('mask success clears only its original selection and preserves saved annotations; failure keeps the target',async()=>{
 const s=setup(),a=s.active.store.snapshot.document.annotations[0],target={region:a.region,object:{kind:'annotation' as const,id:a.id}};
 s.state.select(target);await s.actions.mask(target);expect(s.state.getActiveSelection()).toBeNull();expect(s.state.getCandidate()).toBeNull();expect(s.active.store.snapshot.document.annotations[0]).toEqual(a);
 const next={region:{...a.region,lowHz:1},object:null};s.state.select(next);const work=s.actions.mask(next);const newer={region:{...a.region,lowHz:2},object:null};s.state.select(newer);await work;expect(s.state.getActiveSelection()).toBe(newer);
 s.applyChange.mockRejectedValueOnce({code:'InvalidInput',message:'rejected',retryable:true});await s.actions.mask(newer);expect(s.state.getActiveSelection()).toBe(newer);s.active.lifecycle.dispose();
});
it('regional gain is explicit, zero is a no-op, repetitions accumulate, late success keeps newer intent',async()=>{
 const s=setup(),a=s.active.store.snapshot.document.annotations[0],target={region:a.region,object:{kind:'annotation' as const,id:a.id}};s.state.select(target);const count=s.applyChange.mock.calls.length;
 await s.actions.gain(target,0);expect(s.applyChange).toHaveBeenCalledTimes(count);expect(s.state.getActiveSelection()).toBe(target);
 await s.actions.gain(target,-6);expect(s.state.getActiveSelection()).toBeNull();expect(s.active.store.snapshot.document.annotations[0]).toEqual(a);
 await s.actions.gain(target,-6);expect(s.active.store.snapshot.document.edits.filter(e=>e.operation.type==='gain')).toHaveLength(2);
 s.state.select(target);const work=s.actions.gain(target,6);const newer={region:{...a.region,lowHz:1},object:null};s.state.select(newer);await work;expect(s.state.getActiveSelection()).toBe(newer);s.active.lifecycle.dispose();
});
it('a saved selection keeps its intent through authority reconciliation when mask acknowledgement completes',async()=>{
 const s=setup(),a=s.active.store.snapshot.document.annotations[0],target={region:a.region,object:{kind:'annotation' as const,id:a.id}};s.state.select(target);let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});const hold=s.active.lifecycle.enqueueEdit(()=>gate);const work=s.actions.mask(target);
 s.active.store.snapshot.document.annotations[0]={...a,region:{...a.region,lowHz:a.region.lowHz+1}};s.state.reconcile(s.active.store.snapshot.document);release();await hold;await work;expect(s.state.getActiveSelection()).toBeNull();s.active.lifecycle.dispose();
});
it('retrying a rejected mask clears only the original still-active intent after its native acknowledgement',async()=>{
 const s=setup(),a=s.active.store.snapshot.document.annotations[0],target={region:a.region,object:null};s.state.select(target);s.applyChange.mockRejectedValueOnce({code:'InvalidInput',message:'retry mask',retryable:true});await s.actions.mask(target);expect(s.state.getActiveSelection()).toBe(target);await s.active.lifecycle.retryFailure(s.active.queue.unresolvedFailures[0].id);expect(s.state.getActiveSelection()).toBeNull();expect(s.state.getCandidate()).toBeNull();s.active.lifecycle.dispose();
});
