import { act,renderHook } from '@testing-library/react';
import { beforeEach,expect,it,vi } from 'vitest';
const invoke=vi.hoisted(()=>vi.fn());
vi.mock('@tauri-apps/api/core',()=>({invoke,isTauri:()=>false,Channel:class{onmessage=()=>{};}}));
import fixture from '../../../tests/fixtures/document-v2.json';
import { useProjectLifecycle } from './useProjectLifecycle';
import type { LocalProjectCommands, OpenedProject } from '../../bridge/projects';
import type { CollaborationStatus, Transition } from '../../bridge/collaboration';
const nonceA='11111111-1111-4111-8111-111111111111',nonceB='22222222-2222-4222-8222-222222222222';
function opened(nonce=nonceA):OpenedProject{return{snapshot:{document:structuredClone(fixture) as never,canUndo:false,canRedo:false},persistedRevision:fixture.revision,recovery:null,path:'shared',collaboration:{runtimeNonce:nonce,actor:null,preferences:{volume:.75,deviceId:null,loopEnabled:false,source:'processed'}}};}
function transition(o:OpenedProject):Transition{return{opened:o,status:{formatVersion:1,...o.collaboration,shared:true,projectId:fixture.projectId,pending:false,recoveryRequired:false,busy:false,lastSuccessMs:null,error:null,snapshot:null} as CollaborationStatus};}
function setup(o=opened()){const api:LocalProjectCommands={choose:async()=>'/project',open:async()=>o,create:vi.fn(),save:vi.fn(),close:vi.fn(),recover:vi.fn(),saveAs:vi.fn(),cancelRecovery:vi.fn(),onCloseRequested:async()=>()=>{},destroyWindow:vi.fn()};const hook=renderHook(()=>useProjectLifecycle(api));return{hook,api};}
beforeEach(()=>{invoke.mockReset();invoke.mockImplementation(async(name,args)=>name==='save_project'?args.expectedRevision:undefined);});
it('adopts atomic context and binds all later old closures to their original nonce',async()=>{
 const {hook}=setup();await act(()=>hook.result.current.open('open'));const a=hook.result.current.active!;const oldPlayback=a.commands!.playback;
 await act(()=>hook.result.current.performCollaboration(a,async()=>transition(opened(nonceB))));const b=hook.result.current.active!;expect(b).not.toBe(a);expect(a.store.editingDisabled).toBe(true);
 await oldPlayback.control('stop');await b.commands!.playback.control('stop');expect(invoke.mock.calls.filter(c=>c[0]==='playback_control').map(c=>c[1].runtimeNonce)).toEqual([nonceA,nonceB]);
 expect(invoke).toHaveBeenCalledWith('save_project',expect.objectContaining({runtimeNonce:nonceA}),undefined);hook.unmount();
});
it('failed identity transition preserves current owner and editable personal state',async()=>{
 const {hook}=setup();await act(()=>hook.result.current.open('open'));const a=hook.result.current.active!,original=a.store.snapshot;
 await act(async()=>{await expect(hook.result.current.performCollaboration(a,async()=>{throw{code:'InvalidInput',message:'credentials rejected',retryable:true};})).rejects.toMatchObject({code:'InvalidInput'});});
 expect(hook.result.current.active).toBe(a);expect(a.store.snapshot).toBe(original);expect(a.store.editingDisabled).toBe(false);expect(a.lifecycle.status).toBe('saved');expect(a.lifecycle.error).toBeNull();hook.unmount();
});
it('guest-copy accepts one personal change without retiring its runtime or native undo history',async()=>{
 const {hook}=setup();await act(()=>hook.result.current.open('open'));const a=hook.result.current.active!,copy=opened();copy.snapshot!.document.revision++;copy.snapshot!.canUndo=true;
 await act(()=>hook.result.current.performCollaboration(a,async()=>transition(copy)));expect(hook.result.current.active).toBe(a);expect(a.store.snapshot.canUndo).toBe(true);expect(a.store.isDirty).toBe(true);expect(a.store.editingDisabled).toBe(false);hook.unmount();
});
it('recovery binds preview nonce until resolution returns a new atomic runtime',async()=>{
 const o=opened();o.recovery={primary:null,candidates:[{source:'recovery',document:o.snapshot!.document}]};o.snapshot=null;const{hook,api}=setup(o);invoke.mockImplementation(async name=>name==='resolve_recovery'?opened(nonceB):undefined);
 await act(()=>hook.result.current.open('open'));expect(hook.result.current.active).toBeNull();await act(()=>hook.result.current.recover('recovery'));expect(api.recover).not.toHaveBeenCalled();expect(invoke).toHaveBeenCalledWith('resolve_recovery',{source:'recovery',runtimeNonce:nonceA},undefined);expect(hook.result.current.active?.collaboration?.runtimeNonce).toBe(nonceB);hook.unmount();
});
it('exchange captures nested nonce and shared save-as uses the same owner adapter',async()=>{
 const{hook,api}=setup();await act(()=>hook.result.current.open('open'));const exchange=vi.fn(async()=>null);await act(()=>hook.result.current.performExchange(exchange));expect(exchange).toHaveBeenCalledWith({projectId:fixture.projectId,expectedRevision:fixture.revision,runtimeNonce:nonceA});
 const ordinary=opened();delete ordinary.collaboration;invoke.mockImplementation(async(name,args)=>name==='save_project_as'?ordinary:args?.expectedRevision);
 await act(()=>hook.result.current.saveAs());expect(api.saveAs).not.toHaveBeenCalled();expect(invoke).toHaveBeenCalledWith('save_project_as',expect.objectContaining({runtimeNonce:nonceA}),undefined);expect(hook.result.current.active?.collaboration).toBeUndefined();hook.unmount();
});
