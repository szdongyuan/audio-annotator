import {Channel,invoke} from '@tauri-apps/api/core';
import {open} from '@tauri-apps/plugin-dialog';
import {normalizeError} from './client';
import {parseOpened} from './projects';
import {collaborationInputs,validateExpected,parseCopyProgress,parsePreferences,parseCollaborationTransition,type Transition,type Expected,type CopyProgress,type PlaybackPreferences} from './collaborationSchema';
import {validateNativeStatus} from './collaborationStatusWorker';
export * from './collaborationSchema';
const {uuid,bool,nonempty}=collaborationInputs;
const check:(value:unknown)=>asserts value=collaborationInputs.check;
const parseNativeStatus=validateNativeStatus;
export function parseTransition(value:unknown):Transition{return parseCollaborationTransition(value,parseOpened);}
async function call<T>(name:string,args:Record<string,unknown>,parse:(v:unknown)=>T|Promise<T>):Promise<T>{try{return await parse(await invoke(name,args));}catch(e){throw normalizeError(e);}}
export const collaborationClient={
 adoptCatalog:(e:Expected,operationId:string)=>{validateExpected(e);uuid(operationId);return call('collaboration_adopt_catalog',{expected:e,operationId},parseTransition);},
 hideMedia:(e:Expected,mediaId:string,hidden:boolean)=>{validateExpected(e);uuid(mediaId);bool(hidden);return call('collaboration_hide_media',{expected:e,mediaId,hidden},parseNativeStatus);},
 hideMediaBatch:(e:Expected,mediaIds:string[],hidden:boolean)=>{validateExpected(e);check(mediaIds.length > 0 && mediaIds.length <= 10000 && new Set(mediaIds).size === mediaIds.length);mediaIds.forEach(uuid);bool(hidden);return call('collaboration_hide_media_batch',{expected:e,mediaIds,hidden},parseNativeStatus);},
 status:()=>call('collaboration_status',{},parseNativeStatus),
 refresh:(e:Expected)=>{validateExpected(e);return call('collaboration_refresh',{expected:e},parseNativeStatus);},
 sync:(e:Expected)=>{validateExpected(e);return call('collaboration_sync',{expected:e},parseNativeStatus);},
 preferences:(e:Expected,preferences:PlaybackPreferences)=>{validateExpected(e);parsePreferences(preferences);return call('collaboration_preferences',{expected:e,preferences},parseNativeStatus);},
 create:(e:Expected,operationId:string,target:string,progress:(p:CopyProgress)=>void)=>{validateExpected(e);uuid(operationId);nonempty(32768)(target);const onProgress=new Channel<unknown>();onProgress.onmessage=v=>{parseCopyProgress(v);if((v as CopyProgress).operationId===operationId)progress(v as CopyProgress);};return call('collaboration_create',{expected:e,operationId,target,onProgress},parseTransition);},
 loadShared:(e:Expected,operationId:string)=>{validateExpected(e);uuid(operationId);return call('collaboration_load_shared',{expected:e,operationId},parseTransition);},
 cancel:(operationId:string)=>{uuid(operationId);return call('collaboration_cancel',{operationId},()=>undefined);},
 chooseTarget:async()=>{const p=await open({directory:true,multiple:false,title:'创建协作副本 · 选择空文件夹'});return typeof p==='string'?p:null;},
};
export type CollaborationCommands=typeof collaborationClient;
