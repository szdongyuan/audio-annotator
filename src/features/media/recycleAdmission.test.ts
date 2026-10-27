import { afterEach, expect, it, vi } from 'vitest';
import { RecycleController } from './recycle';
import { registerSuspension } from '../collaboration/admission';
import { collaborationClient, type CollaborationStatus } from '../../bridge/collaboration';
import type { ActiveProject } from '../project/useProjectLifecycle';
import type { RecycleCommands, RecycleSnapshot } from '../../bridge/recycle';
const id='11111111-1111-4111-8111-111111111111';
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();});
function setup(){
 const owner={collaboration:{runtimeNonce:id},store:{snapshot:{document:{projectId:id}}},lifecycle:{admissionClosed:false,enqueueEdit:async(action:()=>Promise<unknown>)=>action()}} as unknown as ActiveProject;
 const response:RecycleSnapshot={runtimeNonce:id,projectId:id,recycle:{kind:'audio-annotator-recycle',formatVersion:1,projectId:id,revision:1,trashed:[],recentOperations:[]}};
 const apply=vi.fn<RecycleCommands['apply']>().mockResolvedValue(response),api={get:vi.fn(async()=>response),apply};
 vi.spyOn(collaborationClient,'status').mockResolvedValue({runtimeNonce:id,projectId:id,busy:false} as CollaborationStatus);
 const controller=new RecycleController(id,id,true,api,owner);
 controller.snapshot={...response.recycle,revision:0};
 const draft=controller.beginEdit({operationId:id,mediaIds:[id],trash:true});
 return{owner,controller,draft,apply,response};
}
it('waits for in-flight background refresh and resumes it after one 319-item delete',async()=>{
 const s=setup();s.draft.operation.mediaIds=Array.from({length:319},(_,i)=>`00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`);
 let finish!:()=>void;const flight=new Promise<void>(r=>{finish=r;}),resume=vi.fn();
 const suspend=vi.fn(async()=>{await flight;return resume;});const unregister=registerSuspension(s.owner.lifecycle,suspend);
 const result=s.controller.submit(s.draft);await Promise.resolve();await Promise.resolve();
 expect(s.controller.pending).toBe(true);expect(s.apply).not.toHaveBeenCalled();
 finish();expect(await result).toBe(true);expect(s.apply).toHaveBeenCalledTimes(1);expect(s.apply.mock.calls[0][2].mediaIds).toHaveLength(319);expect(resume).toHaveBeenCalledTimes(1);unregister();s.controller.dispose();
});
it('retries only admission races with the same immutable operation and releases suspension',async()=>{
 vi.useFakeTimers();const s=setup(),resume=vi.fn(),unregister=registerSuspension(s.owner.lifecycle,async()=>resume);
 s.apply.mockRejectedValueOnce({code:'ResourceLimit',message:'Collaboration job already running',retryable:true,details:{operationBusy:true}});
 const result=s.controller.submit(s.draft);await vi.runAllTimersAsync();expect(await result).toBe(true);expect(s.apply).toHaveBeenCalledTimes(2);expect(s.apply.mock.calls[0]).toEqual(s.apply.mock.calls[1]);expect(resume).toHaveBeenCalledTimes(1);unregister();s.controller.dispose();
});
it('retiring the owner while waiting prevents a stale delete and resumes refresh',async()=>{
 const s=setup();let finish!:()=>void;const flight=new Promise<void>(r=>{finish=r;}),resume=vi.fn(),unregister=registerSuspension(s.owner.lifecycle,async()=>{await flight;return resume;});
 const result=s.controller.submit(s.draft);await Promise.resolve();s.controller.dispose();finish();expect(await result).toBe(false);expect(s.apply).not.toHaveBeenCalled();expect(resume).toHaveBeenCalledTimes(1);unregister();
});
it('keeps real revision conflicts explicit rather than auto-replaying the delete',async()=>{
 const s=setup(),resume=vi.fn(),unregister=registerSuspension(s.owner.lifecycle,async()=>resume);s.apply.mockRejectedValue({code:'RevisionConflict',message:'changed',retryable:true});
 expect(await s.controller.submit(s.draft)).toBe(false);expect(s.apply).toHaveBeenCalledTimes(1);expect(s.controller.error?.code).toBe('RevisionConflict');expect(resume).toHaveBeenCalledTimes(1);unregister();s.controller.dispose();
});
