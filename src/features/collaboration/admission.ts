import { collaborationClient, type CollaborationCommands } from '../../bridge/collaboration';
import { admissionCancelled, retryAdmission } from '../../bridge/admission';
import type { ActiveProject } from '../project/useProjectLifecycle';
import type { ProjectLifecycle } from '../project/lifecycle';
const suspensions=new WeakMap<ProjectLifecycle,()=>Promise<()=>void>>();
export function registerSuspension(lifecycle:ProjectLifecycle,suspend:()=>Promise<()=>void>){suspensions.set(lifecycle,suspend);return()=>{if(suspensions.get(lifecycle)===suspend)suspensions.delete(lifecycle);};}
export async function suspendRefresh(lifecycle?:ProjectLifecycle,signal?:AbortSignal){
 if(signal?.aborted)throw admissionCancelled();
 const waiting=lifecycle?suspensions.get(lifecycle)?.():undefined;
 if(!waiting||!signal)return await waiting;
 return new Promise<(()=>void)|undefined>((resolve,reject)=>{
  let settled=false;
  const abort=()=>{if(!settled){settled=true;reject(admissionCancelled());}};
  signal.addEventListener('abort',abort,{once:true});
  waiting.then(release=>{
   signal.removeEventListener('abort',abort);
   if(settled)release?.();else{settled=true;resolve(release);}
  },error=>{signal.removeEventListener('abort',abort);if(!settled){settled=true;reject(error);}});
  if(signal.aborted)abort();
 });
}
export async function admitted<T>(owner:ActiveProject|null,action:()=>Promise<T>,valid:()=>boolean=()=>true,api:CollaborationCommands=collaborationClient,options:{waitMs?:number;attempts?:number}={}):Promise<T>{
 const deadline=Date.now()+(options.waitMs??10000);
 return retryAdmission(action,{valid,attempts:options.attempts,before:owner?.collaboration?async()=>{
  while(Date.now()<deadline){
   if(!valid())throw admissionCancelled();
   const s=await api.status();
   if(s.runtimeNonce!==owner.collaboration!.runtimeNonce||s.projectId!==owner.store.snapshot.document.projectId)throw admissionCancelled();
   if(!s.busy)return;
   await new Promise(r=>setTimeout(r,100));
  }
  throw {code:'ResourceLimit',message:'共享任务繁忙，请稍后重试。',retryable:true};
 }:undefined});
}
