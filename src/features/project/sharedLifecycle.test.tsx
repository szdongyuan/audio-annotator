import { useCollaboration } from '../collaboration/useCollaboration';
import type { CollaborationCommands } from '../../bridge/collaboration';
import { act,renderHook,waitFor } from '@testing-library/react';
import { beforeEach,expect,it,vi } from 'vitest';
const invoke=vi.hoisted(()=>vi.fn());
vi.mock('@tauri-apps/api/core',()=>({invoke,isTauri:()=>false,Channel:class{onmessage=()=>{};}}));
import fixture from '../../../tests/fixtures/document-v3.json';
import { useProjectLifecycle } from './useProjectLifecycle';
import type { LocalProjectCommands, OpenedProject } from '../../bridge/projects';
import type { CollaborationStatus, Transition } from '../../bridge/collaboration';
const nonceA='11111111-1111-4111-8111-111111111111',nonceB='22222222-2222-4222-8222-222222222222';
function opened(nonce=nonceA):OpenedProject{return{snapshot:{document:structuredClone(fixture) as never,canUndo:false,canRedo:false},persistedRevision:fixture.revision,recovery:null,path:'shared',collaboration:{projectFlavor:'default' as const,identityMode:'profile' as const,canWriteAnnotations:true,canImportMedia:true,hiddenMediaIds:[],catalogPending:false,runtimeNonce:nonce,actor:{authorId:'11111111-1111-4111-8111-111111111111',displayName:'本机身份',createdAt:'2026-10-26T00:00:00Z'},preferences:{monitorGainDb:0,mediaMonitorGainDb:{},volume:.75,deviceId:null,loopEnabled:false,source:'processed'}}};}
function transition(o:OpenedProject):Transition{return{opened:o,status:{formatVersion:1,...o.collaboration,shared:true,projectId:fixture.projectId,pending:false,recoveryRequired:false,busy:false,lastSuccessMs:null,error:null,snapshot:null} as CollaborationStatus};}
function setup(o=opened()){const api:LocalProjectCommands={choose:async()=>'/project',open:async()=>o,create:vi.fn(),save:vi.fn(),close:vi.fn(),recover:vi.fn(),saveAs:vi.fn(),cancelRecovery:vi.fn(),onCloseRequested:async()=>()=>{},destroyWindow:vi.fn()};const hook=renderHook(()=>useProjectLifecycle(api));return{hook,api};}
beforeEach(()=>{invoke.mockReset();invoke.mockImplementation(async(name,args)=>name==='collaboration_status'?transition(opened()).status:name==='save_project'?args.expectedRevision:undefined);});
it('adopts atomic context and binds all later old closures to their original nonce',async()=>{
 const {hook}=setup();await act(()=>hook.result.current.open('open'));const a=hook.result.current.active!;const oldPlayback=a.commands!.playback;
 await act(()=>hook.result.current.performCollaboration(a,async()=>transition(opened(nonceB))));const b=hook.result.current.active!;expect(b).not.toBe(a);expect(a.store.editingDisabled).toBe(true);
 await oldPlayback.control('stop');await b.commands!.playback.control('stop');expect(invoke.mock.calls.filter(c=>c[0]==='playback_control').map(c=>c[1].runtimeNonce)).toEqual([nonceA,nonceB]);
 expect(invoke).toHaveBeenCalledWith('save_project',expect.objectContaining({runtimeNonce:nonceA}),undefined);hook.unmount();
});
it('failed identity transition preserves current owner and editable personal state',async()=>{
 const {hook}=setup();await act(()=>hook.result.current.open('open'));const a=hook.result.current.active!,original=a.store.snapshot;
 await act(async()=>{await expect(hook.result.current.performCollaboration(a,async()=>{throw{code:'InvalidInput',message:'identity selection rejected',retryable:true};})).rejects.toMatchObject({code:'InvalidInput'});});
 expect(hook.result.current.active).toBe(a);expect(a.store.snapshot).toBe(original);expect(a.store.editingDisabled).toBe(false);expect(a.lifecycle.status).toBe('saved');expect(a.lifecycle.error).toBeNull();hook.unmount();
});
it('catalog refresh accepts one personal change without retiring its runtime or native undo history',async()=>{
 const {hook}=setup();await act(()=>hook.result.current.open('open'));const a=hook.result.current.active!,copy=opened();copy.snapshot!.document.revision++;copy.snapshot!.canUndo=true;
 await act(()=>hook.result.current.performCollaboration(a,async()=>transition(copy)));expect(hook.result.current.active).toBe(a);expect(a.store.snapshot.canUndo).toBe(true);expect(a.store.isDirty).toBe(true);expect(a.store.editingDisabled).toBe(false);hook.unmount();
});
it('recovery binds preview nonce until resolution returns a new atomic runtime',async()=>{
 const o=opened();o.recovery={primary:null,candidates:[{source:'recovery',document:o.snapshot!.document}]};o.snapshot=null;const{hook,api}=setup(o);invoke.mockImplementation(async name=>name==='resolve_recovery'?opened(nonceB):undefined);
 await act(()=>hook.result.current.open('open'));expect(hook.result.current.active).toBeNull();await act(()=>hook.result.current.recover('recovery'));expect(api.recover).not.toHaveBeenCalled();expect(invoke).toHaveBeenCalledWith('resolve_recovery',{source:'recovery',runtimeNonce:nonceA},undefined);expect(hook.result.current.active?.collaboration?.runtimeNonce).toBe(nonceB);hook.unmount();
});
it('exchange captures nested nonce and shared save-as uses the same owner adapter',async()=>{
 const{hook,api}=setup();await act(()=>hook.result.current.open('open'));const exchange=vi.fn(async()=>null);await act(()=>hook.result.current.performExchange(exchange));expect(exchange).toHaveBeenCalledWith({projectId:fixture.projectId,expectedRevision:fixture.revision,runtimeNonce:nonceA});
 const copied=opened(nonceB);Object.assign(copied.collaboration!,{projectFlavor:'default',identityMode:'profile',actor:{authorId:nonceB,displayName:'本机作者',createdAt:'2026-10-25T00:00:00Z'},canImportMedia:true});invoke.mockImplementation(async(name,args)=>name==='collaboration_status'?transition(opened()).status:name==='save_project_as_controlled'?copied:args?.expectedRevision);
 await act(()=>hook.result.current.saveAs());expect(api.saveAs).not.toHaveBeenCalled();expect(invoke).toHaveBeenCalledWith('save_project_as_controlled',expect.objectContaining({runtimeNonce:nonceA,operationId:expect.any(String),onProgress:expect.anything()}),undefined);expect(hook.result.current.active?.collaboration?.projectFlavor).toBe('default');hook.unmount();
});

it('same-nonce catalog no-op preserves owner, snapshot and playback adapter',async()=>{
 const {hook}=setup();await act(()=>hook.result.current.open('open'));const a=hook.result.current.active!,snapshot=a.store.snapshot,playback=a.commands!.playback;
 await act(()=>hook.result.current.performCollaboration(a,async()=>transition(opened())));expect(hook.result.current.active).toBe(a);expect(a.store.snapshot).toBe(snapshot);expect(a.commands!.playback).toBe(playback);hook.unmount();
});
it('controlled Save As exposes progress and cancellation keeps the source owner and snapshot',async()=>{
 const {hook}=setup();await act(()=>hook.result.current.open('open'));const a=hook.result.current.active!,snapshot=a.store.snapshot;let reject!:(e:unknown)=>void;
 invoke.mockImplementation(async(name,args)=>{if(name==='collaboration_status')return transition(opened()).status;if(name==='save_project_as_controlled'){args.onProgress.onmessage({operationId:args.operationId,phase:'copyMedia',completed:123});return new Promise((_r,j)=>reject=j);}if(name==='collaboration_cancel'){reject({code:'Cancelled',message:'copy cancelled',retryable:true});return;}return args?.expectedRevision;});
 let copying!:Promise<void>;await act(async()=>{copying=hook.result.current.saveAs();});expect(hook.result.current.copyProgress).toMatchObject({phase:'copyMedia',completed:123});await act(async()=>{hook.result.current.cancelCopy();await copying;});expect(hook.result.current.active).toBe(a);expect(a.store.snapshot).toBe(snapshot);expect(a.store.editingDisabled).toBe(false);expect(hook.result.current.copyProgress).toBeNull();expect(a.lifecycle.error).toBeNull();hook.unmount();
});

it('explicit catalog adoption saves drafts, suspends polling and preserves the active owner while installing new media',async()=>{
 const initial=opened();Object.assign(initial.collaboration!,{projectFlavor:'default',identityMode:'profile',canImportMedia:true,actor:{authorId:nonceA,displayName:'本机作者',createdAt:'2026-10-25T00:00:00Z'}});
 const next=structuredClone(initial);next.snapshot!.document.media.push({...next.snapshot!.document.media[0],id:'33333333-3333-4333-8333-333333333333'});next.snapshot!.document.revision=1;next.persistedRevision=1;
 const remote={...transition(initial).status,catalogPending:true},order:string[]=[];let finish!:(t:Transition)=>void;
 const refresh=vi.fn(async()=>remote),adoptCatalog=vi.fn(()=>{order.push('adopt');return new Promise<Transition>(r=>finish=r);});
 const collabApi={refresh,status:async()=>remote,adoptCatalog,cancel:vi.fn()} as unknown as CollaborationCommands;
 const api={choose:async()=>'/project',open:async()=>initial,create:vi.fn(),save:vi.fn(),close:vi.fn(),recover:vi.fn(),saveAs:vi.fn(),cancelRecovery:vi.fn(),onCloseRequested:async()=>()=>{},destroyWindow:vi.fn()} as LocalProjectCommands;
 invoke.mockImplementation(async(name,args)=>{if(name==='save_project'){order.push('save');return args.expectedRevision;}});
 const hook=renderHook(()=>{const project=useProjectLifecycle(api);return{project,collaboration:useCollaboration(project,collabApi)};});await act(()=>hook.result.current.project.open('open'));
 const owner=hook.result.current.project.active!,before=owner.store.snapshot;await waitFor(()=>expect(hook.result.current.collaboration.controller?.status?.catalogPending).toBe(true));expect(owner.store.snapshot).toBe(before);
 owner.store.setDraft('catalog-note','draft');owner.lifecycle.registerDraft('catalog-note',async()=>{order.push('draft');owner.store.clearDraftIfUnchanged('catalog-note','draft');});
 act(()=>hook.result.current.collaboration.adoptCatalog());await waitFor(()=>expect(adoptCatalog).toHaveBeenCalledTimes(1));expect(order).toEqual(['draft','save','adopt']);const reads=refresh.mock.calls.length;await hook.result.current.collaboration.controller!.refresh();expect(refresh).toHaveBeenCalledTimes(reads);
 await act(async()=>finish(transition(next)));await waitFor(()=>expect(hook.result.current.collaboration.busy).toBe(false));expect(hook.result.current.project.active).toBe(owner);expect(owner.store.snapshot.document.media).toHaveLength(2);expect(owner.store.drafts.size).toBe(0);expect(hook.result.current.collaboration.controller!.status?.catalogPending).toBe(false);hook.unmount();
});


it('identity admission serializes an empty workspace against new/open and adopts a committed transition',async()=>{
 const {hook,api}=setup();let done!:(r:import('../../bridge/profiles').ProfileResponse)=>void;
 const action=vi.fn(()=>new Promise<import('../../bridge/profiles').ProfileResponse>(r=>done=r));let work!:Promise<unknown>;
 await act(async()=>{work=hook.result.current.performIdentity(null,action,true);});
 await act(()=>hook.result.current.open('open'));expect(hook.result.current.active).toBeNull();expect(api.create).not.toHaveBeenCalled();
 const t=transition(opened(nonceB));await act(async()=>{done({profiles:{} as never,transition:t,status:null,warning:null,profile:null,alreadyExists:false});await work;});
 expect(hook.result.current.active?.collaboration?.runtimeNonce).toBe(nonceB);hook.unmount();
});
it('identity mutations drain drafts before fresh expectations and metadata responses preserve history',async()=>{
 const {hook}=setup();await act(()=>hook.result.current.open('open'));const owner=hook.result.current.active!,before=owner.store.snapshot,order:string[]=[];
 owner.store.setDraft('identity-test','draft');owner.lifecycle.registerDraft('identity-test',async()=>{order.push('draft');owner.store.clearDraftIfUnchanged('identity-test','draft');});
 invoke.mockImplementation(async(name,args)=>{if(name==='save_project'){order.push('save');return args.expectedRevision;}});
 await act(()=>hook.result.current.performIdentity(owner,async()=>{order.push('fresh-list');expect(owner.store.editingDisabled).toBe(true);return null;},true));
 expect(order).toEqual(['draft','save','fresh-list']);expect(hook.result.current.active).toBe(owner);expect(owner.store.snapshot).toBe(before);expect(owner.store.editingDisabled).toBe(false);hook.unmount();
});
