import { admissionCancelled } from '../../bridge/admission';
import { admitted } from './admission';
import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { collaborationClient, type CollaborationCommands, type CopyProgress, type Expected, type Transition } from '../../bridge/collaboration';
import { normalizeError } from '../../bridge/client';
import type { AppError } from '../../bridge/types';
import type { ActiveProject, ProjectLifecycleUI } from '../project/useProjectLifecycle';
import { CollaborationController } from './controller';
export type CollaborationDialogKind='create'|'status'|'conflict';
const none=()=>()=>{},zero=()=>0;
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
  let target:string|null=null;if(kind==='create'){target=await api.chooseTarget();if(!target||current.current!==active)return;setDialog({kind:'create',owner:active,target});void run(active,(expected,id)=>api.create(expected,id,target!,p=>setProgress(p)));return;}
  setError(null);setProgress(null);setDialog({kind,owner:active,...(target?{target}:{})});
 };
 const cancel=()=>{const op=operation.current;if(op){op.cancelled=true;void api.cancel(op.id).catch(e=>{if(mounted.current)setError(normalizeError(e));});}else setDialog(null);};
 const run=async(owner:ActiveProject,action:(expected:Expected,id:string)=>Promise<Transition>)=>{
  if(operation.current||current.current!==owner)return;
  const op={id:crypto.randomUUID(),cancelled:false};operation.current=op;setBusy(true);setError(null);
  const resume=await controller?.suspend(false);
  try{
   let transition:Transition|undefined;
   await project.performCollaboration(owner,async()=>{
    const result=await admitted(owner,async()=>{
     const doc=owner.store.snapshot.document;
     let nonce=owner.collaboration?.runtimeNonce;
     if(!nonce){const s=await api.status();if(op.cancelled||!mounted.current||current.current!==owner||s.projectId!==doc.projectId)throw admissionCancelled();if(s.busy)throw {code:'ResourceLimit',message:'busy',retryable:true,details:{operationBusy:true}};nonce=s.runtimeNonce;}
     return action({runtimeNonce:nonce,projectId:doc.projectId,expectedRevision:doc.revision},op.id);
    },()=>!op.cancelled&&mounted.current&&current.current===owner,api);
    // Store adoption precedes status validation when catalog introduces media.
    transition=result;return result;

   });
   if(mounted.current){if(current.current===owner&&owner.collaboration)transition&&controller?.accept(transition.status);setDialog(null);}
  }catch(e){if(mounted.current&&current.current===owner)setError(normalizeError(e));}
  finally{resume?.();operation.current=null;if(mounted.current)setBusy(false);}
 };
 return{active,controller,dialog,busy,error,progress,show,cancel,
  confirm:()=>{if(dialog)void run(dialog.owner,(e,id)=>api.loadShared(e,id));},
  adoptCatalog:()=>{if(active)void run(active,(e,id)=>api.adoptCatalog(e,id));},
  hideMedia:async(mediaId:string,hidden:boolean)=>{if(!active||!controller)return;const owner=active;const resume=await controller.suspend(false);try{await owner.lifecycle.enqueueEdit(async()=>{const s=await admitted(owner,()=>api.hideMedia({runtimeNonce:owner.collaboration!.runtimeNonce,projectId:owner.store.snapshot.document.projectId,expectedRevision:owner.store.snapshot.document.revision},mediaId,hidden),()=>current.current===owner,api);controller.accept(s);});}catch(e){setError(normalizeError(e));throw e;}finally{resume();}},
  sync:()=>{void controller?.sync();},saveAs:()=>{setDialog(null);void project.saveAs();},
 };
}
export type CollaborationUI=ReturnType<typeof useCollaboration>;
export const CollaborationContext=createContext<CollaborationUI|null>(null);
export const useCollaborationContext=()=>useContext(CollaborationContext);
