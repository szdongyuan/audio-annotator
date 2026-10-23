import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { collaborationClient, type CollaborationCommands, type CopyProgress, type Credentials, type Expected, type IdentityAction, type Transition } from '../../bridge/collaboration';
import { normalizeError } from '../../bridge/client';
import type { AppError } from '../../bridge/types';
import type { ActiveProject, ProjectLifecycleUI } from '../project/useProjectLifecycle';
import { CollaborationController } from './controller';
export type CollaborationDialogKind='create'|'register'|'login'|'status'|'guest'|'conflict';
const none=()=>()=>{},zero=()=>0;
const cancelled=():AppError=>({code:'Cancelled',message:'协作操作已取消',retryable:true});
export function useCollaboration(project:ProjectLifecycleUI,api:CollaborationCommands=collaborationClient){
 const active=project.active,current=useRef(active);current.current=active;
 const controller=useMemo(()=>active?.collaboration?new CollaborationController(active,api):null,[active,api]);
 useSyncExternalStore(controller?.subscribe??none,controller?.getVersion??zero);
 useEffect(()=>{controller?.start();return()=>controller?.dispose();},[controller]);
 const [dialog,setDialog]=useState<{kind:CollaborationDialogKind;owner:ActiveProject;target?:string}|null>(null);
 const [busy,setBusy]=useState(false),[error,setError]=useState<AppError|null>(null),[progress,setProgress]=useState<CopyProgress|null>(null);
 const operation=useRef<{id:string;cancelled:boolean}|null>(null),mounted=useRef(true);
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;const op=operation.current;if(op){op.cancelled=true;void api.cancel(op.id).catch(()=>{});}};},[api]);
 useEffect(()=>{if(dialog&&dialog.owner!==active&&!operation.current)setDialog(null);},[active,dialog]);
 const show=async(kind:CollaborationDialogKind)=>{
  if(!active||operation.current||active.store.editingDisabled)return;
  let target:string|null=null;if(kind==='create'){target=await api.chooseTarget();if(!target||current.current!==active)return;}
  setError(null);setProgress(null);setDialog({kind,owner:active,...(target?{target}:{})});
 };
 const cancel=()=>{const op=operation.current;if(op){op.cancelled=true;void api.cancel(op.id).catch(e=>{if(mounted.current)setError(normalizeError(e));});}else setDialog(null);};
 const run=async(owner:ActiveProject,action:(expected:Expected,id:string)=>Promise<Transition>)=>{
  if(operation.current||current.current!==owner)return;
  const op={id:crypto.randomUUID(),cancelled:false};operation.current=op;setBusy(true);setError(null);
  const resume=await controller?.suspend();
  try{
   await project.performCollaboration(owner,async()=>{
    // Local save may have admitted a native background publisher. Wait for its
    // bounded slot without queuing identity work or restarting the save barrier.
    for(let attempt=0;attempt<300;attempt++){
     if(op.cancelled||!mounted.current||current.current!==owner)throw cancelled();
     const status=await api.status(),doc=owner.store.snapshot.document;
     if(op.cancelled||!mounted.current||current.current!==owner)throw cancelled();
     if(status.projectId!==doc.projectId||owner.collaboration&&status.runtimeNonce!==owner.collaboration.runtimeNonce)throw cancelled();
     if(!status.busy){
      const expected={runtimeNonce:owner.collaboration?.runtimeNonce??status.runtimeNonce,projectId:doc.projectId,expectedRevision:doc.revision};
      try{const result=await action(expected,op.id);if(result.status.runtimeNonce===owner.collaboration?.runtimeNonce)controller?.accept(result.status);return result;}
      catch(e){if(normalizeError(e).code!=='ResourceLimit')throw e;}
     }
     await new Promise(r=>setTimeout(r,100));
    }
    throw {code:'ResourceLimit',message:'协作任务仍在结束，请稍后重试。',retryable:true} satisfies AppError;
   });
   if(mounted.current)setDialog(null);
  }catch(e){if(mounted.current&&current.current===owner)setError(normalizeError(e));}
  finally{resume?.();operation.current=null;if(mounted.current)setBusy(false);}
 };
 const submit=(values:Credentials)=>{if(!dialog)return;const d=dialog;if(d.kind==='create')void run(d.owner,(expected,id)=>api.create(expected,id,d.target!,values,p=>{if(mounted.current&&operation.current?.id===p.operationId&&!operation.current.cancelled)setProgress(p);}));else if(d.kind==='register'||d.kind==='login'){const action:IdentityAction=d.kind==='register'?{type:'register',...values}:{type:'login',login:values.login,password:values.password};void run(d.owner,(expected,id)=>api.identity(expected,id,action));}};
 return{active,controller,dialog,busy,error,progress,show,cancel,submit,
  logout:()=>{if(active){setDialog({kind:'status',owner:active});void run(active,(e,id)=>api.identity(e,id,{type:'logout'}));}},
  confirm:()=>{if(dialog)void run(dialog.owner,(e,id)=>dialog.kind==='guest'?api.publishGuest(e,id):api.loadShared(e,id));},
  sync:()=>{void controller?.sync();},saveAs:()=>{setDialog(null);void project.saveAs();},
 };
}
export type CollaborationUI=ReturnType<typeof useCollaboration>;
export const CollaborationContext=createContext<CollaborationUI|null>(null);
export const useCollaborationContext=()=>useContext(CollaborationContext);
