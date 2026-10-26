import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import { normalizeError } from './client';
import { parseCollaborationError, parseCollaborationStatus, parseTransition, type CollaborationStatus, type Transition } from './collaboration';
import { type AppError } from './types';
import { metadataBytes, normalizeNickname, parseProfile, profileShape, profileUuid, requireProfile, type Profile } from './profileMetadata';
export { normalizeNickname, parseProfile, type Profile } from './profileMetadata';
export interface ProfileExpected {storeRevision:number;runtimeNonce:string;project:{projectId:string;expectedRevision:number}|null}
export interface ProfileSnapshot extends ProfileExpected {selectedAuthorId:string;profiles:Profile[]}
export interface ProfileResponse {profiles:ProfileSnapshot;transition:Transition|null;status:CollaborationStatus|null;warning:AppError|null;profile:Profile|null;alreadyExists:boolean}
const integer=(v:unknown)=>requireProfile(Number.isSafeInteger(v)&&(v as number)>=0);
function expectation(o:Record<string,unknown>){integer(o.storeRevision);profileUuid(o.runtimeNonce);if(o.project!==null){const p=profileShape(o.project,['projectId','expectedRevision']);profileUuid(p.projectId);integer(p.expectedRevision);}}
export function parseProfileExpected(v:unknown):ProfileExpected{expectation(profileShape(v,['storeRevision','runtimeNonce','project']));return v as ProfileExpected;}
export function parseProfileSnapshot(v:unknown):ProfileSnapshot{
 const o=profileShape(v,['storeRevision','runtimeNonce','project','selectedAuthorId','profiles']);expectation(o);profileUuid(o.selectedAuthorId);
 requireProfile(Array.isArray(o.profiles)&&o.profiles.length>0&&o.profiles.length<=128);let bytes=0;for(const p of o.profiles){parseProfile(p);bytes+=metadataBytes(p);requireProfile(bytes<=1024*1024);}
 const ids=o.profiles.map(p=>(p as Profile).authorId);requireProfile(new Set(ids).size===ids.length&&ids.includes(o.selectedAuthorId));metadataBytes({kind:'annotator.profile-store',formatVersion:1,revision:o.storeRevision,lastSelectedAuthorId:o.selectedAuthorId,profiles:o.profiles});return v as ProfileSnapshot;
}
export function parseProfileResponse(v:unknown):ProfileResponse {
 const o=profileShape(v,['profiles','transition','status','warning','profile','alreadyExists']);const profiles=parseProfileSnapshot(o.profiles);
 if(o.profile!==null){parseProfile(o.profile);metadataBytes(o.profile);requireProfile(profiles.profiles.some(p=>p.authorId===(o.profile as Profile).authorId&&p.displayName===(o.profile as Profile).displayName&&p.createdAt===(o.profile as Profile).createdAt));}
 if(o.warning!==null)parseCollaborationError(o.warning);
 requireProfile(typeof o.alreadyExists==='boolean');
 if(o.transition!==null){const t=parseTransition(o.transition);requireProfile(t.status.runtimeNonce===profiles.runtimeNonce&&t.status.projectId===profiles.project?.projectId&&t.status.actor?.authorId===profiles.selectedAuthorId);}
 if(o.status!==null){const s=parseCollaborationStatus(o.status);requireProfile(s.runtimeNonce===profiles.runtimeNonce&&s.projectId===profiles.project?.projectId);}
 return v as ProfileResponse;
}
async function call<T>(name:string,args:Record<string,unknown>,parse:(v:unknown)=>T):Promise<T>{try{return parse(await invoke(name,args));}catch(e){throw normalizeError(e);}}
function mutation(name:string,expected:ProfileExpected,operationId:string,extra:Record<string,unknown>){parseProfileExpected(expected);requireProfile(typeof operationId==='string'&&operationId.length>0&&new TextEncoder().encode(operationId).length<=128);return call(name,{expected,operationId,...extra},parseProfileResponse);}
function pathValue(path:string|null){requireProfile(path===null||typeof path==='string'&&path.length>0&&!path.includes('\0'));return path;}
export const profileClient={
 list:()=>call('profile_list',{},parseProfileSnapshot),
 create:(e:ProfileExpected,id:string,displayName:string)=>mutation('profile_create',e,id,{displayName:normalizeNickname(displayName)}),
 rename:(e:ProfileExpected,id:string,authorId:string,displayName:string)=>{profileUuid(authorId);return mutation('profile_rename',e,id,{authorId,displayName:normalizeNickname(displayName)});},
 select:(e:ProfileExpected,id:string,authorId:string)=>{profileUuid(authorId);return mutation('profile_select',e,id,{authorId});},
 import:(e:ProfileExpected,id:string,path:string|null)=>mutation('profile_import',e,id,{path:pathValue(path)}),
 export:(e:ProfileExpected,id:string,authorId:string,path:string|null)=>{profileUuid(authorId);return mutation('profile_export',e,id,{authorId,path:pathValue(path)});},
 chooseImport:async()=>{const p=await open({multiple:false,title:'导入身份',filters:[{name:'身份文件',extensions:['json']}]});return typeof p==='string'?p:null;},
 chooseExport:async(authorId:string)=>{profileUuid(authorId);return save({title:'导出当前身份',defaultPath:`identity-${authorId}.json`,filters:[{name:'身份文件',extensions:['json']}]});},
};
export type ProfileCommands=typeof profileClient;
