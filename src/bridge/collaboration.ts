import { Channel, invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { normalizeError } from './client';
import { parseOpened, type OpenedProject } from './projects';
import { parseAppError, parseChange, type Annotation, type AppError, type Category, type ProjectDocument } from './types';

export interface AuthorIdentity { authorId:string; normalizedLogin:string; displayName:string; createdAt:string }
export interface PlaybackPreferences { volume:number; deviceId:string|null; loopEnabled:boolean; source:'original'|'processed' }
export interface Capabilities { projectFlavor:'ordinary'|'legacyShared'|'default'; identityMode:'ordinary'|'guest'|'local'|'account'|'viewOnly'; canWriteAnnotations:boolean; canImportMedia:boolean; hiddenMediaIds:string[]; catalogPending:boolean }
export interface SharedContext extends Capabilities { runtimeNonce:string; actor:AuthorIdentity|null; preferences:PlaybackPreferences|null }
export interface MediaLabels { mediaId:string; note:string; channelNotes:string[]; categoryId:string|null; channelCategoryIds:(string|null)[] }
export interface AuthorLayer { kind:'audio-annotator-author-layer'; formatVersion:1; projectId:string; authorId:string; revision:number; parent:{revision:number;hash:string}|null; payload:{categories:Category[];annotations:Annotation[];mediaLabels:MediaLabels[]};hash:string }
export interface AuthorSnapshot { identity:AuthorIdentity; layer:AuthorLayer|null; error:AppError|null }
export interface CollaborationSnapshot { projectId:string; authors:AuthorSnapshot[] }
export interface CollaborationStatus extends SharedContext { formatVersion:1; projectId:string|null; shared:boolean; pending:boolean; recoveryRequired:boolean; busy:boolean; lastSuccessMs:number|null;error:AppError|null;snapshot:CollaborationSnapshot|null }
export interface Expected { runtimeNonce:string; projectId:string; expectedRevision:number }
export interface Transition { opened:OpenedProject; status:CollaborationStatus }
export interface Credentials { login:string; displayName:string; password:string }
export type IdentityAction={type:'register';login:string;displayName:string;password:string}|{type:'login';login:string;password:string}|{type:'logout'};
export interface CopyProgress {operationId:string;phase:string;completed:number}
type Check=(v:unknown)=>void;
function check(v:unknown):asserts v {if(!v)throw new Error('Invalid collaboration response');}
/** Count one bounded value at a time; never stringify an untrusted whole graph. */
function boundedJson(value:unknown,limit:number){
 let bytes=0,nodes=0;const ancestors=new Set<object>(),encoder=new TextEncoder();
 const add=(n:number)=>{bytes+=n;check(bytes<=limit);};
 const visit=(v:unknown,depth:number)=>{
  check(depth<=24&&++nodes<=50000000);
  if(typeof v==='string'){check(v.length<=limit-bytes);add(encoder.encode(JSON.stringify(v)).length);return;}
  if(v===null||typeof v==='boolean'||typeof v==='number'){check(typeof v!=='number'||Number.isFinite(v));add(String(v).length);return;}
  check(v!==undefined&&typeof v==='object'&&!ancestors.has(v));ancestors.add(v);add(2);
  if(Array.isArray(v)){check(v.length<=100000);let index=0;for(const item of v){if(index++)add(1);visit(item,depth+1);}}
  else{let fields=0;for(const key in v){if(!Object.hasOwn(v,key))continue;if(fields)add(1);check(++fields<=32&&!/password|credential|passwordHash|salt|phc/i.test(key));visit(key,depth+1);add(1);visit((v as Record<string,unknown>)[key],depth+1);}}
  ancestors.delete(v);
 };visit(value,0);return bytes;
}
function object(v:unknown):Record<string,unknown>{check(v!==null&&typeof v==='object'&&!Array.isArray(v));return v as Record<string,unknown>;}
function shape(v:unknown,fields:Record<string,Check>){const o=object(v);check(Object.keys(o).length===Object.keys(fields).length);for(const [k,c]of Object.entries(fields)){check(Object.hasOwn(o,k));c(o[k]);}}
const text=(max:number):Check=>v=>check(typeof v==='string'&&v.length<=max&&!v.includes('\0'));
// Annotation text follows ProjectDocument validation. Layer byte budgets bound
// its size; account/path restrictions must not impose extra payload semantics.
const payloadText:Check=v=>check(typeof v==='string');
const nonempty=(max:number):Check=>v=>{text(max)(v);check((v as string).trim().length>0);};
const password:Check=v=>{text(512)(v);const value=v as string;check([...value].length>=8&&[...value].length<=128&&new TextEncoder().encode(value).length<=512);};
const uuid:Check=v=>{text(36)(v);check(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(v as string)&&v!=='00000000-0000-0000-0000-000000000000');};
const integer:Check=v=>check(Number.isSafeInteger(v)&&(v as number)>=0);
const bool:Check=v=>check(typeof v==='boolean');
const nullable=(f:Check):Check=>v=>{if(v!==null)f(v);};
const array=(max:number,f:Check):Check=>v=>{check(Array.isArray(v)&&v.length<=max);v.forEach(f);};
const hash:Check=v=>{text(64)(v);check(/^[a-f0-9]{64}$/.test(v as string));};
const utc:Check=v=>{text(64)(v);check(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(v as string)&&Number.isFinite(Date.parse(v as string)));check(new Date(v as string).toISOString().slice(0,19)===(v as string).slice(0,19));};
const identity:Check=v=>shape(v,{authorId:uuid,normalizedLogin:nonempty(256),displayName:nonempty(256),createdAt:utc});
const error:Check=v=>{parseAppError(v);text(16384)(object(v).message);if(object(v).details!==undefined)boundedJson(object(v).details,65536);};
export function parseCopyProgress(v:unknown):CopyProgress{shape(v,{operationId:uuid,phase:nonempty(256),completed:integer});return v as CopyProgress;}
export function parsePreferences(v:unknown):PlaybackPreferences{shape(v,{volume:v=>check(typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=1),deviceId:nullable(text(4096)),loopEnabled:bool,source:v=>check(v==='original'||v==='processed')});return v as PlaybackPreferences;}
const capabilityFields = {projectFlavor:(v:unknown)=>check(['ordinary','legacyShared','default'].includes(v as string)),identityMode:(v:unknown)=>check(['ordinary','guest','local','account','viewOnly'].includes(v as string)),canWriteAnnotations:bool,canImportMedia:bool,hiddenMediaIds:array(4096,uuid),catalogPending:bool};
function capabilities(c:SharedContext, hasProject=true){
 check(new Set(c.hiddenMediaIds).size===c.hiddenMediaIds.length);
 if(c.projectFlavor==='ordinary')check(c.identityMode==='ordinary'&&c.actor===null&&c.hiddenMediaIds.length===0&&!c.catalogPending&&c.canWriteAnnotations===hasProject&&c.canImportMedia===hasProject);
 else if(c.projectFlavor==='legacyShared')check((c.identityMode==='guest'&&c.actor===null||c.identityMode==='account'&&c.actor!==null)&&c.canWriteAnnotations&&!c.canImportMedia&&c.hiddenMediaIds.length===0&&!c.catalogPending);
 else check((c.identityMode==='viewOnly'&&c.actor===null&&!c.canWriteAnnotations&&!c.canImportMedia)||(['local','account'].includes(c.identityMode)&&c.actor!==null&&c.canWriteAnnotations&&c.canImportMedia));
}
export function parseSharedContext(v:unknown):SharedContext{boundedJson(v,256*1024);shape(v,{runtimeNonce:uuid,actor:nullable(identity),preferences:nullable(parsePreferences),...capabilityFields});capabilities(v as SharedContext);return v as SharedContext;}
const unique=(ids:string[])=>check(new Set(ids).size===ids.length);
function layer(v:unknown,doc?:ProjectDocument){
 const bytes=boundedJson(v,16*1024*1024);
 shape(v,{kind:v=>check(v==='audio-annotator-author-layer'),formatVersion:v=>check(v===1),projectId:uuid,authorId:uuid,revision:integer,parent:nullable(v=>shape(v,{revision:integer,hash})),payload:v=>shape(v,{categories:array(4096,v=>{parseChange({type:'addCategory',category:v});}),annotations:array(100000,v=>{parseChange({type:'addAnnotation',annotation:v});}),mediaLabels:array(4096,v=>shape(v,{mediaId:uuid,note:payloadText,channelNotes:array(6,payloadText),categoryId:nullable(uuid),channelCategoryIds:array(6,nullable(uuid))}))}),hash});
 const l=v as AuthorLayer;check(l.revision>0&&(l.parent===null?l.revision===1:l.parent.revision===l.revision-1));
 const p=l.payload,categories=new Set(p.categories.map(c=>c.id));unique([...p.categories,...p.annotations].map(x=>x.id));unique(p.mediaLabels.map(m=>m.mediaId));
 for(const a of p.annotations){check(a.categoryId===null||categories.has(a.categoryId));check(Date.parse(a.createdAt)<=Date.parse(a.updatedAt));if(doc){const m=doc.media.find(m=>m.id===a.region.mediaId);check(m&&a.region.channelIndex<m.channelCount&&a.region.endSeconds<=m.frameCount/m.sampleRate&&a.region.highHz<=m.sampleRate/2);}}
 for(const m of p.mediaLabels){check(m.channelNotes.length===m.channelCategoryIds.length);for(const c of [m.categoryId,...m.channelCategoryIds])check(c===null||categories.has(c));if(doc)check(doc.media.some(d=>d.id===m.mediaId&&d.channelCount===m.channelNotes.length));}
 return bytes;
}
export function parseCollaborationStatus(v:unknown,doc?:ProjectDocument):CollaborationStatus{
 boundedJson(v,64*1024*1024+1024*1024);
 let layerBytes=0;
 shape(v,{...capabilityFields,formatVersion:v=>check(v===1),runtimeNonce:uuid,projectId:nullable(uuid),shared:bool,actor:nullable(identity),preferences:nullable(parsePreferences),pending:bool,recoveryRequired:bool,busy:bool,lastSuccessMs:nullable(integer),error:nullable(error),snapshot:nullable(v=>shape(v,{projectId:uuid,authors:array(128,v=>shape(v,{identity,layer:nullable(v=>{layerBytes+=layer(v,doc);check(layerBytes<=64*1024*1024);}),error:nullable(error)}))}))});
 const s=v as CollaborationStatus;capabilities(s,s.projectId!==null);check(s.shared===(s.projectFlavor!=='ordinary'));check(!s.pending||s.shared&&s.actor!==null);check(s.shared||s.actor===null&&s.preferences===null&&s.snapshot===null);
 if(s.snapshot){check(s.snapshot.projectId===s.projectId);unique(s.snapshot.authors.map(a=>a.identity.authorId));for(const a of s.snapshot.authors)if(a.layer)check(a.layer.projectId===s.projectId&&a.layer.authorId===a.identity.authorId);}
 if(doc){check(s.projectId===doc.projectId);check(s.hiddenMediaIds.every(id=>doc.media.some(m=>m.id===id)));}
 return s;
}
export function parseTransition(v:unknown):Transition{shape(v,{opened:parseOpened,status:parseCollaborationStatus});const t=v as Transition;const c=t.opened.collaboration;check(c&&c.runtimeNonce===t.status.runtimeNonce&&c.actor?.authorId===t.status.actor?.authorId);for(const key of Object.keys(capabilityFields) as (keyof Capabilities)[])check(JSON.stringify(c[key])===JSON.stringify(t.status[key]));if(t.opened.snapshot)parseCollaborationStatus(t.status,t.opened.snapshot.document);return t;}
function expected(v:Expected){shape(v,{runtimeNonce:uuid,projectId:uuid,expectedRevision:integer});}
async function call<T>(name:string,args:Record<string,unknown>,parse:(v:unknown)=>T):Promise<T>{try{return parse(await invoke(name,args));}catch(e){throw normalizeError(e);}}
export const collaborationClient={
 adoptCatalog:(e:Expected,operationId:string)=>{expected(e);uuid(operationId);return call('collaboration_adopt_catalog',{expected:e,operationId},parseTransition);},
 hideMedia:(e:Expected,mediaId:string,hidden:boolean)=>{expected(e);uuid(mediaId);bool(hidden);return call('collaboration_hide_media',{expected:e,mediaId,hidden},parseCollaborationStatus);},
 status:()=>call('collaboration_status',{},parseCollaborationStatus),
 refresh:(e:Expected)=>{expected(e);return call('collaboration_refresh',{expected:e},parseCollaborationStatus);},
 sync:(e:Expected)=>{expected(e);return call('collaboration_sync',{expected:e},parseCollaborationStatus);},
 preferences:(e:Expected,preferences:PlaybackPreferences)=>{expected(e);parsePreferences(preferences);return call('collaboration_preferences',{expected:e,preferences},parseCollaborationStatus);},
 identity:(e:Expected,operationId:string,action:IdentityAction)=>{expected(e);uuid(operationId);shape(action,action.type==='logout'?{type:v=>check(v==='logout')}:action.type==='login'?{type:v=>check(v==='login'),login:nonempty(256),password}:{type:v=>check(v==='register'),login:nonempty(256),displayName:nonempty(256),password});return call('collaboration_identity',{expected:e,operationId,action},parseTransition);},
 create:(e:Expected,operationId:string,target:string,credentials:Credentials|undefined,progress:(p:CopyProgress)=>void)=>{expected(e);uuid(operationId);nonempty(32768)(target);if(credentials)shape(credentials,{login:nonempty(256),displayName:nonempty(256),password});const onProgress=new Channel<unknown>();onProgress.onmessage=v=>{parseCopyProgress(v);if((v as CopyProgress).operationId===operationId)progress(v as CopyProgress);};return call('collaboration_create',{expected:e,operationId,target,credentials,onProgress},parseTransition);},
 publishGuest:(e:Expected,operationId:string)=>{expected(e);uuid(operationId);return call('collaboration_publish_guest',{expected:e,operationId},parseTransition);},
 loadShared:(e:Expected,operationId:string)=>{expected(e);uuid(operationId);return call('collaboration_load_shared',{expected:e,operationId},parseTransition);},
 cancel:(operationId:string)=>{uuid(operationId);return call('collaboration_cancel',{operationId},()=>undefined);},
 chooseTarget:async()=>{const p=await open({directory:true,multiple:false,title:'创建协作副本 · 选择空文件夹'});return typeof p==='string'?p:null;},
};
export type CollaborationCommands=typeof collaborationClient;
