import { collaborationClient, type CollaborationCommands } from '../../bridge/collaboration';
import { admissionCancelled, retryAdmission } from '../../bridge/admission';
import type { ActiveProject } from '../project/useProjectLifecycle';
import type { ProjectLifecycle } from '../project/lifecycle';
const suspensions=new WeakMap<ProjectLifecycle,()=>Promise<()=>void>>();
export function registerSuspension(lifecycle:ProjectLifecycle,suspend:()=>Promise<()=>void>){suspensions.set(lifecycle,suspend);return()=>{if(suspensions.get(lifecycle)===suspend)suspensions.delete(lifecycle);};}
export async function suspendRefresh(lifecycle?:ProjectLifecycle){return lifecycle?await suspensions.get(lifecycle)?.():undefined;}
export async function admitted<T>(owner:ActiveProject|null,action:()=>Promise<T>,valid:()=>boolean=()=>true,api:CollaborationCommands=collaborationClient):Promise<T>{
 const deadline=Date.now()+10000;
 return retryAdmission(action,{valid,before:owner?.collaboration?async()=>{
  for(let n=0;n<100&&Date.now()<deadline;n++){
   if(!valid())throw admissionCancelled();
   const s=await api.status();
   if(s.runtimeNonce!==owner.collaboration!.runtimeNonce||s.projectId!==owner.store.snapshot.document.projectId)throw admissionCancelled();
   if(!s.busy)return;
   await new Promise(r=>setTimeout(r,100));
  }
  throw {code:'ResourceLimit',message:'共享任务繁忙，请稍后重试。',retryable:true};
 }:undefined});
}
