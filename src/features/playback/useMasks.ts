import {createContext,useContext,useEffect,useState} from 'react';
import type {Region,Change} from '../../bridge/types';
import type {ActiveProject} from '../project/useProjectLifecycle';
import {normalizeError} from '../../bridge/client';
import {shortcutAction} from '../project/shortcuts';
export function useMasks(active:ActiveProject|null){
 const[selectedId,select]=useState<string|null>(null);
 useEffect(()=>select(null),[active]);
 const run=(action:()=>Promise<unknown>)=>{if(!active||active.store.editingDisabled)return;const owner=active;void owner.lifecycle.enqueueEdit(async()=>{await owner.lifecycle.submitDrafts();await action();}).catch(e=>owner.store.setError(normalizeError(e)));};
 const command=(change:Change)=>run(()=>active!.queue.enqueue(change,{owner:'masks'}));
 const mutate=(id:string,region:Region)=>run(async()=>{const edit=active!.store.snapshot.document.edits.find(e=>e.id===id);if(edit)await active!.queue.enqueue({type:'updateEdit',edit:{...edit,region}},{owner:'masks'});});
 const remove=(id=selectedId)=>{if(id)run(async()=>{if(active!.store.snapshot.document.edits.some(e=>e.id===id))await active!.queue.enqueue({type:'removeEdit',id},{owner:'masks'});});};
 const create=(region:Region)=>{const id=crypto.randomUUID();run(async()=>{await active!.queue.enqueue({type:'addEdit',edit:{id,region,enabled:true,processingVersion:1}},{owner:'masks'});select(id);});};
 useEffect(()=>{const handler=(e:KeyboardEvent)=>{if(!active||active.store.editingDisabled)return;const action=shortcutAction(e);
 // Escape cancels both independent selection models, even when annotations
 // already handled it. shortcutAction still protects text and editable inputs.
 if(action==='cancel'){select(null);return;}
 if(e.defaultPrevented)return;if(action==='delete'&&selectedId){e.preventDefault();remove();}};window.addEventListener('keydown',handler);return()=>window.removeEventListener('keydown',handler);},[active,selectedId]);
 return{active,selectedId,select,create,mutate,command,remove};
}
export type MaskUI=ReturnType<typeof useMasks>;
export const MaskContext=createContext<MaskUI|null>(null);
export const useMaskContext=()=>useContext(MaskContext);
