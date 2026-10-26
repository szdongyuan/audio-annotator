import { afterEach,expect,it,vi } from 'vitest';
import fixture from '../../../tests/fixtures/document-v2.json';
import { ProjectStore } from '../../app/store';
import { CommandQueue } from '../../app/commands';
import { ProjectLifecycle } from '../project/lifecycle';
import type { ActiveProject } from '../project/useProjectLifecycle';
import type { CollaborationCommands, CollaborationStatus } from '../../bridge/collaboration';
import { CollaborationController, PreferenceDraft } from './controller';
import { syncLabel } from './CollaborationStatus';
export function owner():ActiveProject{const store=new ProjectStore({document:structuredClone(fixture) as never,canUndo:false,canRedo:false});const queue=new CommandQueue(store,{getSnapshot:async()=>store.snapshot,applyChange:vi.fn(),undo:vi.fn(),redo:vi.fn()});return{store,queue,lifecycle:new ProjectLifecycle(store,queue,{save:async(_id,r)=>r,close:async()=>{}}),path:'shared',collaboration:{projectFlavor:'default' as const,identityMode:'profile' as const,canWriteAnnotations:true,canImportMedia:true,hiddenMediaIds:[],catalogPending:false,runtimeNonce:'11111111-1111-4111-8111-111111111111',actor:{authorId:'11111111-1111-4111-8111-111111111111',displayName:'本机身份',createdAt:'2026-10-26T00:00:00Z'},preferences:{volume:.75,deviceId:null,loopEnabled:false,source:'processed'}}};}
export function status(o:ActiveProject):CollaborationStatus{return{formatVersion:1,...o.collaboration!,projectId:fixture.projectId,shared:true,pending:false,recoveryRequired:false,busy:false,lastSuccessMs:1,error:null,snapshot:{projectId:fixture.projectId,authors:[]}};}
afterEach(()=>vi.useRealTimers());
it.each(['chosen','default'] as const)('exposes per-author read errors in compact %s status and clears them after recovery',mode=>{
 const o=owner();if(mode==='chosen')Object.assign(o.collaboration!,{identityMode:'profile',actor:{authorId:'33333333-3333-4333-8333-333333333333',displayName:'Alice',createdAt:'2026-10-23T00:00:00Z'}});
 const c=new CollaborationController(o),remote=status(o);remote.snapshot!.authors=[{identity:{authorId:'22222222-2222-4222-8222-222222222222',displayName:'Bob',createdAt:'2026-10-23T00:00:00Z'},layer:null,error:{code:'InvalidInput',message:'corrupt author layer',retryable:true}}];
 expect(remote.error).toBeNull();expect(remote.lastSuccessMs).toBeGreaterThan(0);c.accept(remote);expect(syncLabel(c)).toBe('部分作者读取异常');
 remote.snapshot!.authors[0].error=null;c.accept({...remote});expect(syncLabel(c)).toBe('已同步');c.dispose();o.lifecycle.dispose();
});
it('keeps author read errors visible alongside own pending or unsaved state',()=>{
 const o=owner(),actor={authorId:'33333333-3333-4333-8333-333333333333',displayName:'Alice',createdAt:'2026-10-23T00:00:00Z'};Object.assign(o.collaboration!,{actor,identityMode:'profile'});const c=new CollaborationController(o),remote=status(o);remote.pending=true;remote.snapshot!.authors=[{identity:{...actor,authorId:'22222222-2222-4222-8222-222222222222'},layer:null,error:{code:'InvalidInput',message:'corrupt author layer',retryable:true}}];c.accept(remote);
 expect(syncLabel(c)).toBe('作者读取异常 · 待同步');o.store.setDraft('note','unsaved');expect(syncLabel(c)).toBe('作者读取异常 · 未保存');c.dispose();o.lifecycle.dispose();
});
it('does not describe unsaved live content as synchronized',()=>{
 const o=owner();Object.assign(o.collaboration!,{identityMode:'profile',actor:{authorId:'22222222-2222-4222-8222-222222222222',displayName:'Alice',createdAt:'2026-10-23T00:00:00Z'}});const c=new CollaborationController(o);c.accept(status(o));o.store.setDraft('note','not saved');expect(syncLabel(c)).toBe('本机未保存');c.dispose();o.lifecycle.dispose();
});
it('polls at two seconds without overlap and ignores retired completion without touching personal state',async()=>{
 vi.useFakeTimers();const o=owner();let finish!:(s:CollaborationStatus)=>void;const refresh=vi.fn(()=>new Promise<CollaborationStatus>(r=>{finish=r;}));const c=new CollaborationController(o,{refresh} as unknown as CollaborationCommands);const original=o.store.snapshot;o.store.setDraft('note','unsaved');c.start();await vi.advanceTimersByTimeAsync(10000);expect(refresh).toHaveBeenCalledTimes(1);c.dispose();finish(status(o));await Promise.resolve();expect(c.status).toBeNull();expect(o.store.snapshot).toBe(original);expect(o.store.drafts.get('note')).toBe('unsaved');o.lifecycle.dispose();
});
it('successful foreign refresh and repeated errors preserve personal drafts and undo state',async()=>{
 const o=owner();o.store.snapshot.canUndo=true;o.store.setDraft('note','unsaved');const original=o.store.snapshot,changed=vi.fn(),unsubscribe=o.store.subscribe(changed);const remote=status(o);remote.snapshot!.authors=[{identity:{authorId:'22222222-2222-4222-8222-222222222222',displayName:'Bob',createdAt:'2026-10-23T00:00:00Z'},layer:null,error:null}];const refresh=vi.fn().mockResolvedValueOnce(remote).mockRejectedValue({code:'MissingMedia',message:'offline',retryable:true});const c=new CollaborationController(o,{refresh} as unknown as CollaborationCommands);
 await c.refresh();await c.refresh();await c.refresh();expect(c.status?.snapshot?.authors[0].identity.displayName).toBe('Bob');expect(c.error?.message).toBe('offline');expect(o.store.snapshot).toBe(original);expect(o.store.snapshot.canUndo).toBe(true);expect(o.store.drafts.get('note')).toBe('unsaved');expect(changed).not.toHaveBeenCalled();unsubscribe();c.dispose();o.lifecycle.dispose();
});
it('manual sync commits registered drafts and saves before requesting sync',async()=>{
 const o=owner(),order:string[]=[];o.store.setDraft('note','text');o.lifecycle.registerDraft('note',async()=>{order.push('draft');o.store.clearDraftIfUnchanged('note','text');});vi.spyOn(o.lifecycle,'save').mockImplementation(async()=>{await o.lifecycle.submitDrafts();order.push('save');});const c=new CollaborationController(o,{status:async()=>status(o),sync:async()=>{order.push('sync');return status(o);}} as unknown as CollaborationCommands);await c.sync();expect(order).toEqual(['draft','save','sync']);c.dispose();o.lifecycle.dispose();
});
it('coalesces repeated manual synchronization while a request is in flight',async()=>{
 const o=owner();let resolve!:(s:CollaborationStatus)=>void;const sync=vi.fn(()=>new Promise<CollaborationStatus>(r=>{resolve=r;}));const c=new CollaborationController(o,{status:async()=>status(o),sync} as unknown as CollaborationCommands);const first=c.sync(),second=c.sync();await vi.waitFor(()=>expect(sync).toHaveBeenCalled());expect(sync).toHaveBeenCalledTimes(1);resolve(status(o));await Promise.all([first,second]);c.dispose();o.lifecycle.dispose();
});
it('failed preferences remain a draft and prevent identity transition until retried',async()=>{
 const o=owner(),preferences=vi.fn().mockRejectedValueOnce({code:'SaveFailed',message:'disk',retryable:true}).mockResolvedValue(status(o));const draft=new PreferenceDraft(o,{preferences} as unknown as CollaborationCommands);draft.update({volume:.3,deviceId:null,loopEnabled:true,source:'original'});const switchIdentity=vi.fn();await expect(o.lifecycle.transitionAfterSave(switchIdentity)).rejects.toMatchObject({code:'SaveFailed'});expect(switchIdentity).not.toHaveBeenCalled();expect(o.store.drafts.size).toBe(1);await o.lifecycle.transitionAfterSave(switchIdentity);expect(o.store.drafts.size).toBe(0);expect(preferences.mock.calls[1][1].volume).toBe(.3);draft.dispose();o.lifecycle.dispose();
});
