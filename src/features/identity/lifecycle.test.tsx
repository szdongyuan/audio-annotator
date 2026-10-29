import { StrictMode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import fixture from '../../../tests/fixtures/document-v3.json';
import { useIdentity } from './useIdentity';
import { useProjectLifecycle } from '../project/useProjectLifecycle';
import type { LocalProjectCommands, OpenedProject } from '../../bridge/projects';
import type { ProfileCommands, ProfileResponse, ProfileSnapshot } from '../../bridge/profiles';
import type { CollaborationUI } from '../collaboration/useCollaboration';
const invoke=vi.hoisted(()=>vi.fn());
vi.mock('@tauri-apps/api/core',()=>({invoke,isTauri:()=>false,Channel:class{onmessage=()=>{};}}));
const a='11111111-1111-4111-8111-111111111111',b='22222222-2222-4222-8222-222222222222';
const profile=(authorId=a)=>({authorId,displayName:authorId===a?'默认':'另一身份',createdAt:'2026-10-26T00:00:00Z'});
function opened(nonce=a,mode:'profile'|'viewOnly'='profile'):OpenedProject{return{snapshot:{document:structuredClone(fixture) as never,canUndo:true,canRedo:false},persistedRevision:fixture.revision,recovery:null,path:'shared',collaboration:{projectFlavor:'default',identityMode:mode,canWriteAnnotations:mode==='profile',canImportMedia:mode==='profile',hiddenMediaIds:[],catalogPending:false,runtimeNonce:nonce,actor:mode==='profile'?profile(nonce):null,preferences:{monitorGainDb:0,mediaMonitorGainDb:{},volume:.25,deviceId:null,loopEnabled:false,source:'original'}}};}
function setup(initial=opened(),strict=false){
 let closeRequested=()=>{};const order:string[]=[];
 const api:LocalProjectCommands={choose:vi.fn(async()=>'/project'),open:async()=>initial,create:vi.fn(),save:vi.fn(async(_id,r)=>r),close:vi.fn(),recover:vi.fn(),saveAs:vi.fn(),cancelRecovery:vi.fn(),onCloseRequested:async(fn)=>{closeRequested=fn;return()=>{};},destroyWindow:vi.fn()};
 let native:ProfileSnapshot={storeRevision:1,runtimeNonce:a,project:null,selectedAuthorId:a,profiles:[profile(),profile(b)]};
 const response=():ProfileResponse=>({profiles:structuredClone(native),transition:null,status:null,warning:null,profile:null,alreadyExists:false});
 const profiles={list:vi.fn(async()=>{order.push('list');return structuredClone(native);}),select:vi.fn(async()=>{native={...native,selectedAuthorId:b,storeRevision:2};return response();}),create:vi.fn(),rename:vi.fn(),import:vi.fn(),export:vi.fn(),chooseImport:vi.fn(),chooseExport:vi.fn()} satisfies ProfileCommands;
 const accept=vi.fn();const collaboration={controller:{accept}} as unknown as CollaborationUI;
 invoke.mockImplementation(async(name,args)=>{if(name==='save_project'){order.push('save');native.project={projectId:fixture.projectId,expectedRevision:args.expectedRevision};return args.expectedRevision;}return undefined;});
 const hook=renderHook(()=>{const project=useProjectLifecycle(api);const identity=useIdentity(project,collaboration,profiles);return{project,identity};},{wrapper:strict?StrictMode:undefined});
 const open=async()=>{native.project={projectId:fixture.projectId,expectedRevision:fixture.revision};await act(()=>hook.result.current.project.open('open'));await waitFor(()=>expect(hook.result.current.identity.snapshot?.project).not.toBeNull());};
 return{hook,api,profiles,open,order,response,setNative:(s:Partial<ProfileSnapshot>)=>{native={...native,...s};},closeRequested:()=>closeRequested()};
}
it('loads the native default identity under StrictMode without project or browser persistence',async()=>{const s=setup(opened(),true);await waitFor(()=>expect(s.hook.result.current.identity.selected?.authorId).toBe(a));expect(s.hook.result.current.project.active).toBeNull();expect(localStorage.length).toBe(0);s.hook.unmount();});
it('uses the fresh post-draft/save revision, then adopts committed selection despite a late cancellation',async()=>{
 const s=setup();await s.open();const old=s.hook.result.current.project.active!,before=old.store.snapshot;
 old.store.setDraft('note','text');old.lifecycle.registerDraft('note',async()=>{s.order.push('draft');old.store.accept({...before,document:{...before.document,revision:before.document.revision+1}});old.store.clearDraftIfUnchanged('note','text');});s.order.length=0;
 let finish!:(r:ProfileResponse)=>void;s.profiles.select.mockImplementation(()=>new Promise(r=>finish=r));let work!:Promise<void>;
 act(()=>{work=s.hook.result.current.identity.select(b);});await waitFor(()=>expect(s.profiles.select).toHaveBeenCalled());expect(s.order).toEqual(['draft','save','list']);expect(s.profiles.select).toHaveBeenCalledWith(expect.objectContaining({project:{projectId:fixture.projectId,expectedRevision:fixture.revision+1}}),expect.any(String),b);
 const next=opened(b);const status={formatVersion:1 as const,...next.collaboration!,shared:true,projectId:fixture.projectId,pending:false,recoveryRequired:false,busy:false,lastSuccessMs:null,error:null,retirement:null,purgeMaintenance:{total:0,items:[]},snapshot:null};
 act(()=>s.hook.result.current.identity.cancel());s.setNative({runtimeNonce:b,selectedAuthorId:b,storeRevision:2});
 await act(async()=>{finish({...s.response(),transition:{opened:next,status}});await work;});
 expect(s.hook.result.current.identity.selected?.authorId).toBe(b);expect(s.hook.result.current.project.active).not.toBe(old);expect(old.store.editingDisabled).toBe(true);s.hook.unmount();
});
it.each(['ordinary','viewOnly'] as const)('%s selection updates global UUID while preserving owner/history/private preferences',async mode=>{
 const initial=opened(a,'viewOnly');if(mode==='ordinary')delete initial.collaboration;const s=setup(initial);await s.open();const owner=s.hook.result.current.project.active!,snapshot=owner.store.snapshot,preferences=owner.collaboration?.preferences;
 await act(()=>s.hook.result.current.identity.select(b));expect(s.hook.result.current.identity.selected?.authorId).toBe(b);expect(s.hook.result.current.project.active).toBe(owner);expect(owner.store.snapshot).toBe(snapshot);expect(owner.collaboration?.preferences).toBe(preferences);expect(owner.collaboration?.canWriteAnnotations??true).toBe(mode==='ordinary');s.hook.unmount();
});
it('same UUID preserves all editor state without a save or native selection',async()=>{const s=setup();await s.open();const owner=s.hook.result.current.project.active!,snapshot=owner.store.snapshot;owner.store.setDraft('note','unsubmitted');s.order.length=0;await act(()=>s.hook.result.current.identity.select(a));expect(s.order).toEqual([]);expect(s.profiles.select).not.toHaveBeenCalled();expect(owner.store.snapshot).toBe(snapshot);expect(owner.store.drafts.get('note')).toBe('unsubmitted');s.hook.unmount();});
it('failed save and pending native publication leave old identity and editor usable for recovery',async()=>{
 const s=setup();await s.open();const owner=s.hook.result.current.project.active!,snapshot=owner.store.snapshot;
 invoke.mockRejectedValueOnce({code:'SaveFailed',message:'save failed',retryable:true});await act(()=>s.hook.result.current.identity.select(b));expect(s.profiles.select).not.toHaveBeenCalled();expect(s.hook.result.current.identity.selected?.authorId).toBe(a);
 invoke.mockImplementation(async(_name,args)=>args?.expectedRevision);s.profiles.select.mockRejectedValueOnce({code:'ResourceLimit',message:'pending import acknowledgement',retryable:true});await act(()=>s.hook.result.current.identity.select(b));expect(s.hook.result.current.project.active).toBe(owner);expect(owner.store.snapshot).toBe(snapshot);expect(owner.store.editingDisabled).toBe(false);expect(owner.lifecycle.error).toBeNull();expect(s.hook.result.current.identity.error?.message).toBe('pending import acknowledgement');s.hook.unmount();
});
it('defers close until a committed selection has replaced the old runtime',async()=>{
 const s=setup();await s.open();let finish!:(r:ProfileResponse)=>void;s.profiles.select.mockImplementation(()=>new Promise(r=>finish=r));let work!:Promise<void>;act(()=>{work=s.hook.result.current.identity.select(b);});await waitFor(()=>expect(s.profiles.select).toHaveBeenCalled());act(()=>s.closeRequested());expect(s.api.destroyWindow).not.toHaveBeenCalled();
 const next=opened(b),status={formatVersion:1 as const,...next.collaboration!,shared:true,projectId:fixture.projectId,pending:false,recoveryRequired:false,busy:false,lastSuccessMs:null,error:null,retirement:null,purgeMaintenance:{total:0,items:[]},snapshot:null};s.setNative({runtimeNonce:b,selectedAuthorId:b});await act(async()=>{finish({...s.response(),transition:{opened:next,status}});await work;});await waitFor(()=>expect(s.api.destroyWindow).toHaveBeenCalledTimes(1));expect(invoke).toHaveBeenCalledWith('close_project',expect.objectContaining({runtimeNonce:b}),undefined);s.hook.unmount();
});
