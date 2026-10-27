import { invoke } from '@tauri-apps/api/core';
import { normalizeError } from './client';
import { organizationCheck as check, organizationShape as shape, organizationUuid as uuid } from './organization';
export interface RecycleOperation { operationId: string; mediaIds: string[]; trash: boolean }
export interface Recycle { kind:'audio-annotator-recycle'; formatVersion:1; projectId:string; revision:number; trashed:{mediaId:string;deletedBy:string}[]; recentOperations:{operationId:string;payloadHash:string;actorId:string}[] }
export interface RecycleSnapshot { runtimeNonce:string; projectId:string; recycle:Recycle }
const integer=(v:unknown)=>check(Number.isSafeInteger(v)&&(v as number)>=0);
export function parseRecycleOperation(v:unknown):RecycleOperation {
  shape(v,{operationId:uuid,mediaIds:v=>{check(Array.isArray(v)&&v.length>0&&v.length<=10000&&new Set(v).size===v.length);v.forEach(uuid);},trash:v=>check(typeof v==='boolean')});
  return v as RecycleOperation;
}
export function parseRecycleSnapshot(v:unknown):RecycleSnapshot {
  shape(v,{runtimeNonce:uuid,projectId:uuid,recycle:v=>{
    shape(v,{kind:v=>check(v==='audio-annotator-recycle'),formatVersion:v=>check(v===1),projectId:uuid,revision:integer,
      trashed:v=>{check(Array.isArray(v)&&v.length<=10000);v.forEach(m=>shape(m,{mediaId:uuid,deletedBy:uuid}));check(new Set(v.map(m=>m.mediaId)).size===v.length);},
      recentOperations:v=>{check(Array.isArray(v)&&v.length<=64);v.forEach(r=>shape(r,{operationId:uuid,payloadHash:v=>check(typeof v==='string'&&/^[0-9a-f]{64}$/.test(v)),actorId:uuid}));check(new Set(v.map(r=>r.operationId)).size===v.length);}});
  }});
  const result=v as RecycleSnapshot;check(result.projectId===result.recycle.projectId);return result;
}
export function createRecycleClient(runtimeNonce:string) {
  uuid(runtimeNonce);
  const call=async(name:string,projectId:string,args:Record<string,unknown>={})=>{
    uuid(projectId);
    try{const value=parseRecycleSnapshot(await invoke(name,{binding:{runtimeNonce,projectId},...args}));check(value.runtimeNonce===runtimeNonce&&value.projectId===projectId);return value;}catch(e){throw normalizeError(e);}
  };
  return {get:(id:string)=>call('recycle_get',id),apply:(id:string,expectedRevision:number,operation:RecycleOperation)=>{integer(expectedRevision);parseRecycleOperation(operation);return call('recycle_apply',id,{expectedRevision,operation});}};
}
export type RecycleCommands=ReturnType<typeof createRecycleClient>;
