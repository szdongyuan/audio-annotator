import {acceptVerifiedStatus,createCollaborationStatusParser,type CollaborationStatus} from './collaborationSchema';
const fallback=createCollaborationStatusParser();
let worker:Worker|undefined,serial=0;
let approved:{id:number;value:CollaborationStatus}|undefined;
const pending=new Map<number,{resolve:(value:CollaborationStatus)=>void;reject:(error:unknown)=>void;timer:ReturnType<typeof setTimeout>}>();
const failure=()=>({code:'InvalidInput',message:'共享状态校验失败，请重试',retryable:true});
function retire(){
 worker?.terminate();worker=undefined;approved=undefined;
 for(const job of pending.values()){clearTimeout(job.timer);job.reject(failure());}pending.clear();
}
function service(){
 if(worker)return worker;
 const next=new Worker(new URL('./collaborationValidation.worker.ts',import.meta.url),{type:'module'});
 next.onerror=()=>{if(worker===next)retire();};next.onmessageerror=()=>{if(worker===next)retire();};
 next.onmessage=event=>{
  if(worker!==next)return;
  const message=event.data as {id:number;ok:boolean;base:number;patch:Partial<CollaborationStatus>},job=pending.get(message.id);
  if(!job)return;pending.delete(message.id);clearTimeout(job.timer);
  try{
   if(message.ok!==true){job.reject(failure());return;}
   if(message.base!==(approved?.id??0))throw new Error('Retired validation baseline');
   const value=acceptVerifiedStatus({...approved?.value,...message.patch} as CollaborationStatus);
   approved={id:message.id,value};job.resolve(value);
  }catch{job.reject(failure());retire();}
 };
 worker=next;return next;
}
/** Bound one worker and eight in-flight requests; validation never blocks audio/UI. */
export async function validateNativeStatus(value:unknown):Promise<CollaborationStatus>{
 if(typeof Worker==='undefined')return fallback(value);
 if(pending.size>=8)throw {code:'ResourceLimit',message:'共享状态校验繁忙，请稍后重试',retryable:true};
 const active=service(),id=++serial;
 return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{if(worker===active&&pending.has(id))retire();},30000);pending.set(id,{resolve,reject,timer});
  try{active.postMessage({id,value});}catch{clearTimeout(timer);pending.delete(id);reject(failure());}
 });
}
