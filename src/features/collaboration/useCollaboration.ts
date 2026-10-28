import { admissionCancelled, operationBusy } from '../../bridge/admission';
import { admitted } from './admission';
import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { collaborationClient, type CollaborationCommands, type CopyProgress, type Expected, type Transition } from '../../bridge/collaboration';
import { normalizeError } from '../../bridge/client';
import type { AppError } from '../../bridge/types';
import type { ActiveProject, ProjectLifecycleUI } from '../project/useProjectLifecycle';
import { CollaborationController } from './controller';
export type CollaborationDialogKind='create'|'status'|'conflict';
const none=()=>()=>{},zero=()=>0;
function modalInteractionActive(){
 return [...document.querySelectorAll('dialog[open],[role="dialog"],[role="alertdialog"]')]
  .some(node=>!node.closest('[hidden],[aria-hidden="true"]')&&(node.tagName!=='DIALOG'||node.hasAttribute('open')));
}
export function useCollaboration(project:ProjectLifecycleUI,api:CollaborationCommands=collaborationClient){
 const active=project.active,current=useRef(active);current.current=active;
 const controller=useMemo(()=>active?.collaboration?new CollaborationController(active,api):null,[active,api]);
 const version=useSyncExternalStore(controller?.subscribe??none,controller?.getVersion??zero);
 useEffect(()=>{controller?.start();return()=>controller?.dispose();},[controller]);
 const [dialog,setDialog]=useState<{kind:CollaborationDialogKind;owner:ActiveProject;target?:string}|null>(null);
 const [busy,setBusy]=useState(false),[error,setError]=useState<AppError|null>(null),[progress,setProgress]=useState<CopyProgress|null>(null);
 const operation=useRef<{id:string;cancelled:boolean;owner:ActiveProject}|null>(null),mounted=useRef(true);
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;const op=operation.current;if(op){op.cancelled=true;void api.cancel(op.id).catch(()=>{});}};},[api]);
 useEffect(()=>{if(dialog&&dialog.owner!==active&&!operation.current)setDialog(null);},[active,dialog]);
 useEffect(()=>{const op=operation.current;if(op&&op.owner!==active){op.cancelled=true;void api.cancel(op.id).catch(()=>{});}},[active,api]);
 const show=async(kind:CollaborationDialogKind)=>{
  if(!active||operation.current||active.store.editingDisabled)return;
  let target:string|null=null;if(kind==='create'){target=await api.chooseTarget();if(!target||current.current!==active)return;setDialog({kind:'create',owner:active,target});void run(active,(expected,id)=>api.create(expected,id,target!,p=>setProgress(p)));return;}
  setError(null);setProgress(null);setDialog({kind,owner:active,...(target?{target}:{})});
 };
 const cancel=()=>{const op=operation.current;if(op){op.cancelled=true;void api.cancel(op.id).catch(e=>{if(mounted.current)setError(normalizeError(e));});}else setDialog(null);};
 const run=async(owner:ActiveProject,action:(expected:Expected,id:string)=>Promise<Transition>,automatic=false)=>{
  if(operation.current||current.current!==owner||!mounted.current)return;
  const op={id:crypto.randomUUID(),cancelled:false,owner};operation.current=op;if(!automatic){setBusy(true);setError(null);}
  const resume=await controller?.suspend(false);
  try{
   if(automatic){const s=await api.status();if(s.busy||op.cancelled||!mounted.current||current.current!==owner||s.runtimeNonce!==owner.collaboration?.runtimeNonce)return;}
   let transition:Transition|undefined;
   // Background admission defers a competing job instead of waiting with the editor frozen.
   const admissionApi=automatic?{...api,status:async()=>{const s=await api.status();if(s.busy)throw admissionCancelled();return s;}}:api;
   await project.performCollaboration(owner,async()=>{
    const result=await admitted(owner,async()=>{
     const doc=owner.store.snapshot.document;
     let nonce=owner.collaboration?.runtimeNonce;
     if(!nonce){const s=await api.status();if(op.cancelled||!mounted.current||current.current!==owner||s.projectId!==doc.projectId)throw admissionCancelled();if(s.busy)throw {code:'ResourceLimit',message:'busy',retryable:true,details:{operationBusy:true}};nonce=s.runtimeNonce;}
     try{return await action({runtimeNonce:nonce,projectId:doc.projectId,expectedRevision:doc.revision},op.id);}catch(e){if(automatic&&operationBusy(e))throw admissionCancelled();throw e;}
    },()=>!op.cancelled&&mounted.current&&current.current===owner,admissionApi);
    // Store adoption precedes status validation when catalog introduces media.
    transition=result;return result;

   },automatic?()=>!modalInteractionActive():false);
   if(mounted.current){if(current.current===owner&&owner.collaboration)transition&&controller?.accept(transition.status,true);if(!automatic)setDialog(null);}
  }catch(e){if(mounted.current&&current.current===owner){const failure=normalizeError(e);if(!automatic)setError(failure);else if(failure.code!=='Cancelled'&&!operationBusy(failure))controller?.catalogFailed(failure);}}
  finally{resume?.();operation.current=null;if(!automatic&&mounted.current)setBusy(false);}
 };
 const attemptedCatalog=useRef<{controller:CollaborationController;poll:number}|null>(null);
 useEffect(()=>{
  if(!controller||!active||project.busy||operation.current||!controller.canAdoptCatalog||!controller.catalogRefresh||!active.lifecycle.allowsBackgroundTransition||modalInteractionActive())return;
  const prior=attemptedCatalog.current;if(prior?.controller===controller&&prior.poll===controller.catalogRefresh)return;
  attemptedCatalog.current={controller,poll:controller.catalogRefresh};
  void run(active,(e,id)=>api.adoptCatalog(e,id),true);
 },[controller,version,active,project.busy]);
 return{active,controller,dialog,busy,error,progress,show,cancel,
  confirm:()=>{if(dialog)void run(dialog.owner,(e,id)=>api.loadShared(e,id));},
  adoptCatalog:()=>{if(active)void run(active,(e,id)=>api.adoptCatalog(e,id));},
  hideMedia:async(mediaId:string,hidden:boolean)=>{if(!active||!controller)return;const owner=active;const resume=await controller.suspend(false);try{await owner.lifecycle.enqueueEdit(async()=>{const s=await admitted(owner,()=>api.hideMedia({runtimeNonce:owner.collaboration!.runtimeNonce,projectId:owner.store.snapshot.document.projectId,expectedRevision:owner.store.snapshot.document.revision},mediaId,hidden),()=>current.current===owner,api);controller.accept(s);});}catch(e){setError(normalizeError(e));throw e;}finally{resume();}},
  hideMediaBatch:async(mediaIds:string[],hidden:boolean)=>{if(!active||!controller)return;const owner=active;const resume=await controller.suspend(false);try{await owner.lifecycle.enqueueEdit(async()=>{const s=await admitted(owner,()=>api.hideMediaBatch({runtimeNonce:owner.collaboration!.runtimeNonce,projectId:owner.store.snapshot.document.projectId,expectedRevision:owner.store.snapshot.document.revision},mediaIds,hidden),()=>current.current===owner,api);controller.accept(s);});}catch(e){setError(normalizeError(e));throw e;}finally{resume();}},
  sync:()=>{void controller?.sync();},saveAs:()=>{setDialog(null);void project.saveAs();},
 };
}
export type CollaborationUI=ReturnType<typeof useCollaboration>;
export const CollaborationContext=createContext<CollaborationUI|null>(null);
export const useCollaborationContext=()=>useContext(CollaborationContext);
