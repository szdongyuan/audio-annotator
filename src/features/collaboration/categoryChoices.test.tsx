import { act, renderHook } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { useSyncExternalStore } from 'react';
import fixture from '../../../tests/fixtures/document-v3.json';
import { parseProjectDocument, type Change } from '../../bridge/types';
import { ProjectStore } from '../../app/store';
import { CommandQueue } from '../../app/commands';
import { ProjectLifecycle } from '../project/lifecycle';
import { useSelection } from '../selection/useSelection';
import { useAnnotations } from '../annotations/useAnnotations';
import { CollaborationContext, type CollaborationUI } from './useCollaboration';
import { categoryChoices } from './categoryChoices';

function setup(){
 const store=new ProjectStore({document:parseProjectDocument(structuredClone(fixture)),canUndo:false,canRedo:false});
 const applyChange=vi.fn(async(_id:string,revision:number,c:Change)=>{const doc=structuredClone(store.snapshot.document);doc.revision=revision+1;if(c.type==='addCategory')doc.categories.push(c.category);if(c.type==='addAnnotation')doc.annotations.push(c.annotation);if(c.type==='updateAnnotation')doc.annotations=doc.annotations.map(a=>a.id===c.annotation.id?c.annotation:a);if(c.type==='setMediaCategories')doc.media.find(m=>m.id===c.mediaId)!.categoryIds=c.categoryIds;if(c.type==='setChannelCategories')doc.media.find(m=>m.id===c.mediaId)!.channelCategoryIds[c.channelIndex]=c.categoryIds;return {...store.snapshot,document:doc};});
 const queue=new CommandQueue(store,{applyChange,getSnapshot:async()=>store.snapshot,undo:async()=>store.snapshot,redo:async()=>store.snapshot});const lifecycle=new ProjectLifecycle(store,queue,{save:async(_,r)=>r,close:async()=>{}});
 const owner={store,queue,lifecycle,path:'owned',collaboration:{actor:{authorId:'owner'}}} as unknown as import('../project/useProjectLifecycle').ActiveProject;
 const foreign={identity:{authorId:'other',displayName:'同事'},layer:{payload:{categories:[{...store.snapshot.document.categories[0],name:'共享异响'}],annotations:structuredClone(store.snapshot.document.annotations),mediaLabels:[]}}};
 const collab={active:owner,controller:{owner,status:{snapshot:{authors:[foreign]}},visible:()=>false}} as unknown as CollaborationUI;
 const wrapper=({children}:{children:ReactNode})=><CollaborationContext.Provider value={collab}>{children}</CollaborationContext.Provider>;
 return {owner,collab,foreign,applyChange,wrapper};
}
it('offers colleague categories even when frames are filtered, deduplicates names and never changes the colleague layer',async()=>{
 const s=setup(),before=structuredClone(s.foreign),m=s.owner.store.snapshot.document.media[0];
 const hook=renderHook(()=>{useSyncExternalStore(s.owner.store.subscribe,()=>s.owner.store.snapshot);return useAnnotations(s.owner);},{wrapper:s.wrapper});
 const shared=hook.result.current.categories.find(c=>c.name==='共享异响')!;expect(shared.authorName).toBe('同事');expect(shared.id).not.toBe(before.layer.payload.categories[0].id);
 await act(async()=>{await Promise.all([hook.result.current.classify({mediaId:m.id,channelIndex:null},shared.id),hook.result.current.classify({mediaId:m.id,channelIndex:0},shared.id)]);});
 const doc=s.owner.store.snapshot.document,category=doc.categories.find(c=>c.name==='共享异响')!;
 expect(doc.media[0].categoryIds).toContain(category.id);expect(doc.media[0].channelCategoryIds[0]).toContain(category.id);expect(s.applyChange.mock.calls.filter(c=>c[2].type==='addCategory')).toHaveLength(1);
 expect(hook.result.current.categories.filter(c=>c.name==='共享异响')).toHaveLength(1);expect(s.foreign).toEqual(before);
 hook.unmount();s.owner.lifecycle.dispose();
});
it('a temporary region adopts a shared category into its own author layer before creating its annotation',async()=>{
 const s=setup(),before=structuredClone(s.foreign),doc=s.owner.store.snapshot.document;
 const hook=renderHook(()=>{useSyncExternalStore(s.owner.store.subscribe,()=>s.owner.store.snapshot);return useSelection(s.owner,doc.media[0].id);},{wrapper:s.wrapper});
 const category=hook.result.current.categories.find(c=>c.name==='共享异响')!,target={region:{...doc.annotations[0].region},object:null};
 act(()=>hook.result.current.state.select(target));await act(()=>hook.result.current.actions!.classify(target,category.id));
 const result=s.owner.store.snapshot.document,local=result.categories.find(c=>c.name==='共享异响')!;
 expect(result.annotations.at(-1)!.categoryIds).toEqual([local.id]);expect(result.annotations.at(-1)!.id).not.toBe(doc.annotations[0].id);expect(s.foreign).toEqual(before);expect(hook.result.current.selection?.object?.kind).toBe('annotation');
 hook.unmount();s.owner.lifecycle.dispose();
});
it('stale foreign snapshots from another runtime do not enter the category list',()=>{
 const s=setup();expect(categoryChoices(s.owner,{...s.collab,active:{...s.owner}})).toEqual(s.owner.store.snapshot.document.categories);s.owner.lifecycle.dispose();
});
