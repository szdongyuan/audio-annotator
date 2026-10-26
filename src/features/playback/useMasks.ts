import {createContext,useContext,useEffect,useRef,useState} from 'react';
import type {Region,Change} from '../../bridge/types';
import type {ActiveProject} from '../project/useProjectLifecycle';
import {normalizeError} from '../../bridge/client';
import type {SelectionUI} from '../selection/useSelection';
export function useMasks(active:ActiveProject|null,selection?:SelectionUI){
 const binding=useRef(active);binding.current=active;
 const[fallbackId,setFallbackId]=useState<string|null>(null);
 const selectedId=selection?(selection.selection?.object?.kind==='mask'?selection.selection.object.id:null):fallbackId;
 const select=(id:string|null)=>selection?selection.selectObject('mask',id):setFallbackId(id);
 useEffect(()=>setFallbackId(null),[active]);
 const run=(action:()=>Promise<unknown>)=>{if(!active||binding.current!==active||active.store.editingDisabled)return;const owner=active;void owner.lifecycle.enqueueEdit(async()=>{await owner.lifecycle.submitDrafts();await action();}).catch(e=>owner.store.setError(normalizeError(e)));};
 const command=(change:Change)=>run(()=>active!.queue.enqueue(change,{owner:'masks'}));
 const mutate=(id:string,region:Region)=>run(async()=>{const edit=active!.store.snapshot.document.edits.find(e=>e.id===id);if(edit)await active!.queue.enqueue({type:'updateEdit',edit:{...edit,region}},{owner:'masks'});});
 const remove=(id=selectedId)=>{if(id)run(async()=>{if(active!.store.snapshot.document.edits.some(e=>e.id===id))await active!.queue.enqueue({type:'removeEdit',id},{owner:'masks'});});};
 return{active,selectedId,select,mutate,command,remove};
}
export type MaskUI=ReturnType<typeof useMasks>;
export const MaskContext=createContext<MaskUI|null>(null);
export const useMaskContext=()=>useContext(MaskContext);
