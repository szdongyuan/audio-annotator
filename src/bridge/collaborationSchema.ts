import {parseProfile,type Profile} from './profileMetadata';
import {jsonStringBytes} from './jsonStringBytes';
import type {OpenedProject} from './projects';
import {parseAppError,parseChange,parseProjectSnapshot,type Annotation,type AppError,type Category,type ProjectDocument,type ProjectSnapshot} from './types';
export type AuthorIdentity = Profile;
export interface PlaybackPreferences { monitorGainDb:number; mediaMonitorGainDb:Record<string,number|null>; volume:number; deviceId:string|null; loopEnabled:boolean; source:'original'|'processed' }
export interface Capabilities { projectFlavor:'ordinary'|'default'; identityMode:'ordinary'|'profile'|'viewOnly'; canWriteAnnotations:boolean; canImportMedia:boolean; hiddenMediaIds:string[]; catalogPending:boolean }
export interface SharedContext extends Capabilities { runtimeNonce:string; actor:AuthorIdentity|null; preferences:PlaybackPreferences|null }
export interface MediaLabels { mediaId:string; note:string; channelNotes:string[]; categoryIds:string[]; channelCategoryIds:string[][] }
export interface AuthorLayer { kind:'audio-annotator-author-layer'; formatVersion:2; projectId:string; authorId:string; revision:number; parent:{revision:number;hash:string}|null; payload:{categories:Category[];annotations:Annotation[];mediaLabels:MediaLabels[]};hash:string }
export interface AuthorSnapshot { identity:AuthorIdentity; layer:AuthorLayer|null; error:AppError|null }
export interface CollaborationSnapshot { projectId:string; authors:AuthorSnapshot[] }
export interface PurgeMaintenanceItem { operationId:string; status:'accepted'|'preparing'|'rollback-pending'|'committed-pending-cleanup'; committed:boolean; cleanupPendingCount:number|null; cleanupFailedCount:number|null; deletedAudioBytes:number|null }
export interface CollaborationStatus extends SharedContext { formatVersion:1; projectId:string|null; shared:boolean; pending:boolean; recoveryRequired:boolean; busy:boolean; lastSuccessMs:number|null;error:AppError|null;snapshot:CollaborationSnapshot|null; retirement:{mediaIds:string[];snapshot:ProjectSnapshot}|null;purgeMaintenance:{total:number;items:PurgeMaintenanceItem[]} }
export interface Expected { runtimeNonce:string; projectId:string; expectedRevision:number }
export interface Transition { opened:OpenedProject; status:CollaborationStatus }
export interface CopyProgress {operationId:string;phase:string;completed:number}
type Check=(v:unknown)=>void;
function check(v:unknown):asserts v {if(!v)throw new Error('Invalid collaboration response');}
/** Count one bounded value at a time; never stringify an untrusted whole graph. */
function boundedJson(value:unknown,limit:number,records:ReadonlySet<object>=new Set()){
 let bytes=0,nodes=0;const ancestors=new Set<object>();
 const add=(n:number)=>{bytes+=n;check(bytes<=limit);};
 const visit=(v:unknown,depth:number)=>{
  check(depth<=24&&++nodes<=50000000);
  if(typeof v==='string'){check(v.length<=limit-bytes);add(jsonStringBytes(v));return;}
  if(v===null||typeof v==='boolean'||typeof v==='number'){check(typeof v!=='number'||Number.isFinite(v));add(String(v).length);return;}
  check(v!==undefined&&typeof v==='object'&&!ancestors.has(v));ancestors.add(v);add(2);
  if(Array.isArray(v)){check(v.length<=100000);let index=0;for(const item of v){if(index++)add(1);visit(item,depth+1);}}
  else{let fields=0;for(const key in v){if(!Object.hasOwn(v,key))continue;if(fields)add(1);check(++fields<=(records.has(v)?10000:32)&&!/password|credential|passwordHash|salt|phc/i.test(key));visit(key,depth+1);add(1);visit((v as Record<string,unknown>)[key],depth+1);}}
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
const uuid:Check=v=>{text(36)(v);check(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(v as string)&&v!=='00000000-0000-0000-0000-000000000000');};
const integer:Check=v=>check(Number.isSafeInteger(v)&&(v as number)>=0);
const bool:Check=v=>check(typeof v==='boolean');
const nullable=(f:Check):Check=>v=>{if(v!==null)f(v);};
const array=(max:number,f:Check):Check=>v=>{check(Array.isArray(v)&&v.length<=max);v.forEach(f);};
const labels:Check=v=>{array(64,uuid)(v);check(new Set(v as string[]).size===(v as string[]).length);};
const hash:Check=v=>{text(64)(v);check(/^[a-f0-9]{64}$/.test(v as string));};
const identity:Check=v=>{parseProfile(v);};
export function parseCollaborationError(v:unknown):AppError{parseAppError(v);text(16384)(object(v).message);if(object(v).details!==undefined)boundedJson(object(v).details,65536);return v as AppError;}
const error:Check=parseCollaborationError;
export function parseCopyProgress(v:unknown):CopyProgress{shape(v,{operationId:uuid,phase:nonempty(256),completed:integer});return v as CopyProgress;}
const monitorDb:Check=v=>check(typeof v==='number'&&Number.isFinite(v)&&v>=-60&&v<=24);
export function parsePreferences(v:unknown):PlaybackPreferences{shape(v,{monitorGainDb:monitorDb,mediaMonitorGainDb:v=>{check(v!==null&&typeof v==='object'&&!Array.isArray(v));const entries=Object.entries(v as Record<string,unknown>);check(entries.length<=10000);for(const [id,db] of entries){uuid(id);nullable(monitorDb)(db);}},volume:v=>check(typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=1),deviceId:nullable(text(4096)),loopEnabled:bool,source:v=>check(v==='original'||v==='processed')});return v as PlaybackPreferences;}
const capabilityFields = {projectFlavor:(v:unknown)=>check(['ordinary','default'].includes(v as string)),identityMode:(v:unknown)=>check(['ordinary','profile','viewOnly'].includes(v as string)),canWriteAnnotations:bool,canImportMedia:bool,hiddenMediaIds:array(10000,uuid),catalogPending:bool};
function capabilities(c:SharedContext, hasProject=true){
 check(new Set(c.hiddenMediaIds).size===c.hiddenMediaIds.length);
 if(c.projectFlavor==='ordinary')check(c.identityMode==='ordinary'&&c.actor===null&&c.hiddenMediaIds.length===0&&!c.catalogPending&&c.canWriteAnnotations===hasProject&&c.canImportMedia===hasProject);
 else check((c.identityMode==='viewOnly'&&c.actor===null&&!c.canWriteAnnotations&&!c.canImportMedia)||(c.identityMode==='profile'&&c.actor!==null&&c.canWriteAnnotations&&c.canImportMedia));
}
export function validatePreferenceMedia(preferences:PlaybackPreferences|null,doc:ProjectDocument){if(preferences){const media=new Set(doc.media.map(m=>m.id));check(Object.keys(preferences.mediaMonitorGainDb).every(id=>media.has(id)));}}
// Only this strictly validated UUID map can exceed the DTO field-count budget.
function monitorMaps(value:unknown):ReadonlySet<object>{
 const context=value as {preferences?:{mediaMonitorGainDb?:unknown}}|null;
 const record=context?.preferences?.mediaMonitorGainDb;
 return new Set(record!==null&&typeof record==='object'&&!Array.isArray(record)?[record]:[]);
}
export function parseSharedContext(v:unknown):SharedContext{boundedJson(v,1024*1024,monitorMaps(v));shape(v,{runtimeNonce:uuid,actor:nullable(identity),preferences:nullable(parsePreferences),...capabilityFields});capabilities(v as SharedContext);return v as SharedContext;}
const unique=(ids:string[])=>check(new Set(ids).size===ids.length);
function layer(v:unknown,doc?:ProjectDocument){
 const bytes=boundedJson(v,16*1024*1024);
 shape(v,{kind:v=>check(v==='audio-annotator-author-layer'),formatVersion:v=>check(v===2),projectId:uuid,authorId:uuid,revision:integer,parent:nullable(v=>shape(v,{revision:integer,hash})),payload:v=>shape(v,{categories:array(4096,v=>{parseChange({type:'addCategory',category:v});}),annotations:array(100000,v=>{parseChange({type:'addAnnotation',annotation:v});}),mediaLabels:array(10000,v=>shape(v,{mediaId:uuid,note:payloadText,channelNotes:array(6,payloadText),categoryIds:labels,channelCategoryIds:array(6,labels)}))}),hash});
 const l=v as AuthorLayer;check(l.revision>0&&(l.parent===null?l.revision===1:l.parent.revision===l.revision-1));
 const p=l.payload,categories=new Set(p.categories.map(c=>c.id));unique([...p.categories,...p.annotations].map(x=>x.id));unique(p.mediaLabels.map(m=>m.mediaId));
 const mediaById=doc?new Map(doc.media.map(m=>[m.id,m])):null;
 for(const a of p.annotations){check(a.categoryIds.every(id=>categories.has(id)));check(Date.parse(a.createdAt)<=Date.parse(a.updatedAt));if(doc){const m=mediaById!.get(a.region.mediaId);check(m&&a.region.channelIndex<m.channelCount&&a.region.endSeconds<=m.frameCount/m.sampleRate&&a.region.highHz<=m.sampleRate/2);}}
 for(const m of p.mediaLabels){check(m.channelNotes.length===m.channelCategoryIds.length);for(const c of [m.categoryIds,...m.channelCategoryIds].flat())check(categories.has(c));if(doc)check(mediaById!.get(m.mediaId)?.channelCount===m.channelNotes.length);}
 return bytes;
}
function statusMaps(value:unknown):ReadonlySet<object>{
 const maps=new Set(monitorMaps(value));
 const doc=(value as CollaborationStatus|null)?.retirement?.snapshot?.document;
 for(const map of [doc?.analysis,doc?.playbackMix,doc?.viewState?.media])if(map!==null&&typeof map==='object'&&!Array.isArray(map))maps.add(map);
 return maps;
}
function maintenance(v:unknown){
 shape(v,{total:integer,items:array(50,v=>shape(v,{operationId:uuid,status:v=>check(['accepted','preparing','rollback-pending','committed-pending-cleanup'].includes(v as string)),committed:bool,cleanupPendingCount:nullable(integer),cleanupFailedCount:nullable(integer),deletedAudioBytes:nullable(integer)}))});
 const m=v as CollaborationStatus['purgeMaintenance'];check(m.items.length===Math.min(50,m.total));unique(m.items.map(i=>i.operationId));check(m.items.every((i,n)=>n===0||m.items[n-1].operationId<i.operationId));
 for(const i of m.items){check(i.committed===(i.status==='committed-pending-cleanup'));if(i.committed)check(i.cleanupPendingCount!==null&&i.cleanupPendingCount>0&&i.cleanupFailedCount!==null&&i.cleanupFailedCount<=i.cleanupPendingCount&&i.deletedAudioBytes!==null);else check(i.cleanupPendingCount===null&&i.cleanupFailedCount===null&&i.deletedAudioBytes===null);}
}
export function parseCollaborationStatus(v:unknown,doc?:ProjectDocument):CollaborationStatus{
 boundedJson(v,128*1024*1024+1024*1024,statusMaps(v));
 let layerBytes=0;
 shape(v,{...capabilityFields,formatVersion:v=>check(v===1),runtimeNonce:uuid,projectId:nullable(uuid),shared:bool,actor:nullable(identity),preferences:nullable(parsePreferences),pending:bool,recoveryRequired:bool,busy:bool,lastSuccessMs:nullable(integer),error:nullable(error),snapshot:nullable(v=>shape(v,{projectId:uuid,authors:array(128,v=>shape(v,{identity,layer:nullable(v=>{layerBytes+=layer(v,doc);check(layerBytes<=64*1024*1024);}),error:nullable(error)}))})),retirement:nullable(v=>shape(v,{mediaIds:array(10000,uuid),snapshot:v=>{parseProjectSnapshot(v);}})),purgeMaintenance:maintenance});
 const s=v as CollaborationStatus;capabilities(s,s.projectId!==null);check(s.shared===(s.projectFlavor!=='ordinary'));check(!s.pending||s.shared&&s.actor!==null);check(s.shared||s.actor===null&&s.preferences===null&&s.snapshot===null);
 if(s.retirement){const r=s.retirement;check(s.shared&&r.snapshot.document.projectId===s.projectId);unique(r.mediaIds);check(r.mediaIds.every((id,n)=>n===0||r.mediaIds[n-1]<id));check(r.snapshot.document.media.every(m=>!r.mediaIds.includes(m.id)));}
 if(s.snapshot){check(s.snapshot.projectId===s.projectId);unique(s.snapshot.authors.map(a=>a.identity.authorId));for(const a of s.snapshot.authors)if(a.layer)check(a.layer.projectId===s.projectId&&a.layer.authorId===a.identity.authorId);}
 if(doc){validatePreferenceMedia(s.preferences,doc);check(s.projectId===doc.projectId);const media=new Set(doc.media.map(m=>m.id));check(s.hiddenMediaIds.every(id=>media.has(id)));}
 return s;
}
/** Compare against a private validated copy, including every field except the poll time.
 * The finite reference tree bounds recursion even for cyclic/untrusted input. */
function sameValidated(reference:unknown,value:unknown,root=false):boolean{
 if(reference===null||typeof reference!=='object')return reference===value;
 if(value===null||typeof value!=='object'||Object.getPrototypeOf(reference)!==Object.getPrototypeOf(value))return false;
 if(Array.isArray(reference)&&(!Array.isArray(value)||reference.length!==value.length))return false;
 const keys=Object.keys(reference),other=Object.keys(value);
 if(keys.length!==other.length)return false;
 return keys.every(key=>Object.hasOwn(value,key)&&(root&&key==='lastSuccessMs'||sameValidated((reference as Record<string,unknown>)[key],(value as Record<string,unknown>)[key])));
}
function statusInDocument(s:CollaborationStatus,doc:ProjectDocument){
 validatePreferenceMedia(s.preferences,doc);check(s.projectId===doc.projectId);
 const media=new Map(doc.media.map(m=>[m.id,m]));check(s.hiddenMediaIds.every(id=>media.has(id)));
 for(const author of s.snapshot?.authors??[]){
  for(const a of author.layer?.payload.annotations??[]){const m=media.get(a.region.mediaId);check(m&&a.region.channelIndex<m.channelCount&&a.region.endSeconds<=m.frameCount/m.sampleRate&&a.region.highHz<=m.sampleRate/2);}
  for(const labels of author.layer?.payload.mediaLabels??[])check(media.get(labels.mediaId)?.channelCount===labels.channelNotes.length);
 }
}
/** One size-bounded cache per client/owner. Changed bytes always receive full validation;
 * a caller cannot mutate the private reference, and document references are rechecked. */
const verifiedStatuses=new WeakSet<object>();
/** Worker results are immutable so approval cannot outlive a caller mutation. */
export function acceptVerifiedStatus(status:CollaborationStatus){
 const freeze=(value:unknown)=>{if(value!==null&&typeof value==='object'&&!Object.isFrozen(value)){Object.values(value).forEach(freeze);Object.freeze(value);}};
 freeze(status);verifiedStatuses.add(status);return status;
}
export function createCollaborationStatusParser(){
 let reference:CollaborationStatus|null=null;
 return (value:unknown,doc?:ProjectDocument):CollaborationStatus=>{
  if(value!==null&&typeof value==='object'&&verifiedStatuses.has(value)){const result=value as CollaborationStatus;if(doc)statusInDocument(result,doc);return result;}
  const time=object(value).lastSuccessMs;nullable(integer)(time);
  if(!reference||!sameValidated(reference,value,true)){
   const parsed=parseCollaborationStatus(value);
   const json=JSON.stringify(parsed);reference=json.length<=8*1024*1024?JSON.parse(json) as CollaborationStatus:null;
  }
  const result=value as CollaborationStatus;if(doc)statusInDocument(result,doc);return result;
 };
}
export function parseCollaborationTransition(v:unknown,parseOpened:(v:unknown)=>OpenedProject):Transition{shape(v,{opened:parseOpened,status:parseCollaborationStatus});const t=v as Transition;const c=t.opened.collaboration;check(c&&c.runtimeNonce===t.status.runtimeNonce&&c.actor?.authorId===t.status.actor?.authorId);for(const key of Object.keys(capabilityFields) as (keyof Capabilities)[])check(JSON.stringify(c[key])===JSON.stringify(t.status[key]));if(t.opened.snapshot)parseCollaborationStatus(t.status,t.opened.snapshot.document);return t;}
export function validateExpected(v:Expected){shape(v,{runtimeNonce:uuid,projectId:uuid,expectedRevision:integer});}

export const collaborationInputs={uuid,bool,nonempty,check};
