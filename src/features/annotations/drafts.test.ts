import { expect, it, vi } from 'vitest';
import fixture from '../../../tests/fixtures/document-v3.json';
import { parseProjectDocument } from '../../bridge/types';
import { CommandQueue } from '../../app/commands';
import { ProjectStore } from '../../app/store';
import { ProjectLifecycle } from '../project/lifecycle';
import { AnnotationDrafts } from './drafts';
function setup() {
  const store = new ProjectStore({ document: parseProjectDocument(fixture), canUndo: false, canRedo: false });
  const applyChange = vi.fn(async (_id, _revision, change) => ({ ...store.snapshot, document: { ...store.snapshot.document, revision: store.dirtyRevision + 1, media: store.snapshot.document.media.map(m => m.id === change.mediaId ? { ...m, note: change.note } : m) } }));
  const queue = new CommandQueue(store, { applyChange, getSnapshot: async () => store.snapshot, undo: async () => store.snapshot, redo: async () => store.snapshot });
  const lifecycle = new ProjectLifecycle(store, queue, { save: async (_, revision) => revision, close: async () => {} });
  const active = { store, queue, lifecycle, path: '' };
  return { ...active, applyChange, drafts: new AnnotationDrafts(active) };
}
it('retains hidden object submitters and never applies an old note to a newly selected object', async () => {
  const s = setup(), id = fixture.media[0].id;
  s.drafts.write('note:a', { type: 'updateMediaNote', mediaId: id, note: 'A', mergeKey: null });
  s.drafts.write('note:b', { type: 'updateChannelNote', mediaId: id, channelIndex: 1, note: 'B', mergeKey: null });
  await s.lifecycle.submitDrafts();
  expect(s.applyChange.mock.calls.map(c => c[2])).toMatchObject([{ type: 'updateMediaNote', note: 'A', mediaId: id }, { type: 'updateChannelNote', note: 'B', channelIndex: 1 }]);
  expect(s.store.drafts.size).toBe(0); s.lifecycle.dispose();
});
it('preserves newer typing during flight, and corrected failed drafts resolve the same failure', async () => {
  const s = setup(), id = fixture.media[0].id;
  let finish!: (v: typeof s.store.snapshot) => void;
  s.applyChange.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  s.drafts.write('note', { type: 'updateMediaNote', mediaId: id, note: 'old', mergeKey: null });
  const pending = s.drafts.submit('note'); await vi.waitFor(() => expect(s.applyChange).toHaveBeenCalledTimes(1));
  s.drafts.write('note', { type: 'updateMediaNote', mediaId: id, note: 'new', mergeKey: null });
  finish({ ...s.store.snapshot, document: { ...s.store.snapshot.document, revision: 1 } }); await pending;
  expect(s.store.drafts.get('note')).toContain('new');
  s.applyChange.mockRejectedValueOnce({ code: 'InvalidInput', message: 'rejected', retryable: true });
  await expect(s.drafts.submit('note')).rejects.toMatchObject({ code: 'InvalidInput' });
  expect(s.queue.unresolvedFailures).toHaveLength(1);
  s.drafts.write('note', { type: 'updateMediaNote', mediaId: id, note: 'corrected', mergeKey: null });
  await s.drafts.submit('note');
  expect(s.queue.unresolvedFailures).toHaveLength(0); expect(s.store.drafts.size).toBe(0); s.lifecycle.dispose();
});
it('allows explicit correction of one failed draft while another failure remains unresolved', async () => {
  const s = setup(), id = fixture.media[0].id;
  s.applyChange.mockRejectedValueOnce({ code: 'InvalidInput', message: 'first', retryable: true });
  s.drafts.write('first', { type: 'updateMediaNote', mediaId: id, note: 'first', mergeKey: null });
  await expect(s.drafts.submit('first')).rejects.toBeTruthy();
  s.applyChange.mockRejectedValueOnce({ code: 'InvalidInput', message: 'second', retryable: true });
  await expect(s.queue.enqueue({ type: 'updateChannelNote', mediaId: id, channelIndex: 0, note: 'second', mergeKey: null })).rejects.toBeTruthy();
  s.drafts.write('first', { type: 'updateMediaNote', mediaId: id, note: 'corrected', mergeKey: null });
  await s.drafts.submit('first');
  expect(s.queue.unresolvedFailures).toHaveLength(1); expect(s.queue.unresolvedFailures[0].error.message).toBe('second');
  s.lifecycle.dispose();
});

it('releases only precisely retired draft registrations while a pending submit rereads safely and B survives',async()=>{
 const s=setup(),a=fixture.media[0].id,b='22222222-2222-4222-8222-222222222222',before=s.store.snapshot;
 s.store.accept({...before,document:{...before.document,media:[...before.document.media,{...structuredClone(before.document.media[0]),id:b}],analysis:{...before.document.analysis,[b]:before.document.analysis[a]},playbackMix:{...before.document.playbackMix,[b]:before.document.playbackMix[a]}}});
 s.drafts.write('media-note:'+a,{type:'updateMediaNote',mediaId:a,note:'A',mergeKey:null});s.drafts.write('arbitrary-B',{type:'updateChannelNote',mediaId:b,channelIndex:0,note:'B',mergeKey:null});
 let release!:(v:typeof s.store.snapshot)=>void;s.applyChange.mockImplementationOnce(()=>new Promise(r=>{release=r;}));const blocking=s.queue.enqueue({type:'resetMediaMasks',mediaId:b});await vi.waitFor(()=>expect(s.applyChange).toHaveBeenCalledOnce());const pending=s.drafts.submit('media-note:'+a);
 const d=s.store.snapshot.document;s.store.retire([a],{...s.store.snapshot,document:{...d,revision:1,media:d.media.filter(m=>m.id!==a),annotations:[],edits:[],analysis:{[b]:d.analysis[b]},playbackMix:{[b]:d.playbackMix[b]},viewState:{...d.viewState,activeMediaId:b,compareMediaId:null}}});
 expect(s.drafts.owns('media-note:'+a)).toBe(false);expect(s.drafts.owns('arbitrary-B')).toBe(true);release(s.store.snapshot);await blocking;await pending;expect(s.applyChange).toHaveBeenCalledOnce();await s.drafts.submit('arbitrary-B');expect(s.applyChange.mock.calls[1][2]).toMatchObject({mediaId:b,note:'B'});
 s.drafts.write('stale-A',{type:'updateMediaNote',mediaId:a,note:'late',mergeKey:null});expect(s.drafts.owns('stale-A')).toBe(false);s.drafts.dispose();s.lifecycle.dispose();
});

it('retires invalid in-progress A bounds by object identity while preserving invalid B bounds and opaque text',()=>{
 const s=setup(),before=s.store.snapshot,a=before.document.media[0].id,b='22222222-2222-4222-8222-222222222222',annotationA=before.document.annotations[0],annotationB={...structuredClone(annotationA),id:'33333333-3333-4333-8333-333333333333',region:{...annotationA.region,mediaId:b}};
 s.store.accept({...before,document:{...before.document,media:[...before.document.media,{...structuredClone(before.document.media[0]),id:b}],annotations:[annotationA,annotationB],analysis:{...before.document.analysis,[b]:before.document.analysis[a]},playbackMix:{...before.document.playbackMix,[b]:before.document.playbackMix[a]}}});
 // Clearing a numeric input creates NaN, serialized as null until the user corrects it.
 s.drafts.write('annotation-bounds:'+annotationA.id,{type:'updateAnnotation',annotation:{...annotationA,region:{...annotationA.region,startSeconds:NaN}}});s.drafts.write('invalid-B',{type:'updateAnnotation',annotation:{...annotationB,region:{...annotationB.region,startSeconds:NaN}}});s.store.setDraft('opaque',JSON.stringify({type:'unrelated',note:a}));
 const d=s.store.snapshot.document;s.store.retire([a],{...s.store.snapshot,document:{...d,revision:1,media:d.media.filter(m=>m.id!==a),annotations:[annotationB],edits:[],analysis:{[b]:d.analysis[b]},playbackMix:{[b]:d.playbackMix[b]},viewState:{...d.viewState,activeMediaId:b,compareMediaId:null}}});
 expect(s.store.drafts.has('annotation-bounds:'+annotationA.id)).toBe(false);expect(s.drafts.owns('annotation-bounds:'+annotationA.id)).toBe(false);expect(s.store.drafts.has('invalid-B')).toBe(true);expect(s.drafts.owns('invalid-B')).toBe(true);expect(s.store.drafts.has('opaque')).toBe(true);s.drafts.dispose();s.lifecycle.dispose();
});
