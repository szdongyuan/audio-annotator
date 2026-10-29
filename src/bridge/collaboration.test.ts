import { describe, expect, it } from 'vitest';
import { createCollaborationStatusParser, parseCollaborationStatus, parseSharedContext, parseTransition } from './collaboration';
import { parseProjectDocument, type ProjectDocument } from './types';
import fixture from '../../tests/fixtures/document-v3.json';
const id='11111111-1111-4111-8111-111111111111';
const actor={authorId:id,displayName:'Alice',createdAt:'2026-10-23T00:00:00Z'};
const preferences={monitorGainDb:0,mediaMonitorGainDb:{},volume:.75,deviceId:null,loopEnabled:false,source:'processed'};
export const statusFixture=()=>({formatVersion:1,runtimeNonce:id,projectId:id,shared:true,projectFlavor:'default' as const,identityMode:'profile' as const,canWriteAnnotations:true,canImportMedia:true,hiddenMediaIds:[],catalogPending:false,actor,preferences,pending:false,recoveryRequired:false,busy:false,lastSuccessMs:null,error:null,retirement:null,purgeMaintenance:{total:0,items:[]},snapshot:{projectId:id,authors:[]}});
function documentStatus(document:ProjectDocument){
 const payload={categories:document.categories,annotations:document.annotations,mediaLabels:document.media.map(m=>({mediaId:m.id,note:m.note,channelNotes:m.channelNotes,categoryIds:m.categoryIds,channelCategoryIds:m.channelCategoryIds}))};
 const layer={kind:'audio-annotator-author-layer',formatVersion:2,projectId:document.projectId,authorId:id,revision:1,parent:null,hash:'a'.repeat(64),payload};
 return {...statusFixture(),projectId:document.projectId,snapshot:{projectId:document.projectId,authors:[{identity:actor,layer,error:null}]}};
}
describe('collaboration boundary',()=>{
 it.each(['region','file','channel'] as const)('accepts native-valid %s notes above one MiB in status and identity transitions',target=>{
  const document=parseProjectDocument(structuredClone(fixture)),note='n'.repeat(1048577);
  if(target==='region')document.annotations[0].note=note;else if(target==='file')document.media[0].note=note;else document.media[0].channelNotes[0]=note;
  parseProjectDocument(document);
  const status=documentStatus(document),layer=status.snapshot.authors[0].layer;
  expect(new TextEncoder().encode(JSON.stringify(layer)).length).toBeLessThan(16*1024*1024);
  const wire=JSON.parse(JSON.stringify({opened:{snapshot:{document,canUndo:false,canRedo:false},path:'shared',persistedRevision:document.revision,recovery:null,collaboration:{runtimeNonce:id,projectFlavor:'default' as const,identityMode:'profile' as const,canWriteAnnotations:true,canImportMedia:true,hiddenMediaIds:[],catalogPending:false,actor,preferences}},status}));
  expect(parseCollaborationStatus(wire.status,document).snapshot?.authors[0].layer?.payload).toEqual(layer.payload);
  expect(parseTransition(wire).opened.snapshot?.document).toEqual(document);
 });
 it('accepts long category names and NUL in native-valid category/file/channel/region text',()=>{
  const document=parseProjectDocument(structuredClone(fixture));document.categories[0].name=' category\0'+ 'x'.repeat(4097)+'\n';document.annotations[0].note='region\0note';document.media[0].note='file\0note';document.media[0].channelNotes[0]='channel\0note';
  parseProjectDocument(document);const wire=JSON.parse(JSON.stringify(documentStatus(document)));
  expect(parseCollaborationStatus(wire,document).snapshot?.authors[0].layer?.payload.categories[0].name).toBe(document.categories[0].name);
  document.categories[0].name=' \n\t';expect(()=>parseCollaborationStatus(documentStatus(document),document)).toThrow();
 });
 it('still rejects malformed payload text and layers exceeding sixteen MiB',()=>{
  const document=parseProjectDocument(structuredClone(fixture)),status=documentStatus(document);
  (status.snapshot.authors[0].layer.payload.mediaLabels[0] as unknown as {note:unknown}).note=7;expect(()=>parseCollaborationStatus(status)).toThrow();
  document.media[0].note='n'.repeat(16*1024*1024);expect(()=>parseCollaborationStatus(documentStatus(document))).toThrow();
 });
 it('rejects combined layer bytes above sixty-four MiB even within the status metadata allowance',()=>{
  const document=parseProjectDocument(structuredClone(fixture));document.media[0].note='n'.repeat(Math.floor(64*1024*1024/5));const status=documentStatus(document),author=status.snapshot.authors[0];
  status.snapshot.authors=Array.from({length:5},(_,index)=>{const authorId=`22222222-2222-4222-8222-22222222222${index}`;return {identity:{...actor,authorId},layer:{...author.layer,authorId},error:null};});
  expect(()=>parseCollaborationStatus(status)).toThrow();
 });
 it('enforces profile nickname limits independently from payload strings',()=>{
  for(const patch of [{displayName:'x'.repeat(257)},{normalizedLogin:'alice\0'}])expect(()=>parseCollaborationStatus({...statusFixture(),actor:{...actor,...patch}})).toThrow();
 });
 it('accepts native shared context and status without changing project documents',()=>{
  expect(parseCollaborationStatus(statusFixture()).actor?.displayName).toBe('Alice');
  expect(parseSharedContext({runtimeNonce:id,projectFlavor:'default' as const,identityMode:'profile' as const,canWriteAnnotations:true,canImportMedia:true,hiddenMediaIds:[],catalogPending:false,actor,preferences}).runtimeNonce).toBe(id);
 });
 it('rejects versions, unknown fields, credentials and unbounded collections',()=>{
  for(const patch of [{formatVersion:2},{password:'secret'},{actor:{...actor,passwordHash:'hash'}},{preferences:{...preferences,volume:2}},{snapshot:{projectId:id,authors:Array(129).fill({identity:actor,layer:null,error:null})}}])expect(()=>parseCollaborationStatus({...statusFixture(),...patch})).toThrow();
 });
 it('rejects invalid geometry and private fields nested in foreign layers',()=>{
  const layer={kind:'audio-annotator-author-layer',formatVersion:2,projectId:id,authorId:id,revision:1,parent:null,hash:'a'.repeat(64),payload:{categories:[],annotations:[{id:'22222222-2222-4222-8222-222222222222',region:{mediaId:id,channelIndex:0,startSeconds:2,endSeconds:1,lowHz:0,highHz:100},categoryIds:[],note:'',createdAt:actor.createdAt,updatedAt:actor.createdAt}],mediaLabels:[]}};
  expect(()=>parseCollaborationStatus({...statusFixture(),snapshot:{projectId:id,authors:[{identity:actor,layer,error:null}]}})).toThrow();
  layer.payload.annotations=[];
  expect(()=>parseCollaborationStatus({...statusFixture(),snapshot:{projectId:id,authors:[{identity:actor,layer:{...layer,payload:{...layer.payload,edits:[]}},error:null}]}})).toThrow();
 });
 it('rejects credential injection hidden inside error details and cyclic malformed inputs',()=>{
  expect(()=>parseCollaborationStatus({...statusFixture(),error:{code:'InvalidInput',message:'failure',retryable:false,details:{password:'never expose'}}})).toThrow();
  const cyclic:Record<string,unknown>={};cyclic.self=cyclic;
  expect(()=>parseCollaborationStatus({...statusFixture(),error:{code:'InvalidInput',message:'failure',retryable:false,details:cyclic}})).toThrow();
 });
});

it('keeps multilabel references inside each author and rejects retired author envelopes',()=>{
 const document=parseProjectDocument(structuredClone(fixture));
 const second={...document.categories[0],id:'00000000-0000-4000-8000-000000000077',name:'第二标签'};
 document.categories.push(second);
 const ids=[second.id,document.categories[0].id];
 document.media[0].categoryIds=ids;document.media[0].channelCategoryIds[0]=ids;document.annotations[0].categoryIds=ids;
 const status=documentStatus(document);
 expect(parseCollaborationStatus(status,document).snapshot?.authors[0].layer?.payload.annotations[0].categoryIds).toEqual(ids);
 for(const mutate of [
  (s:typeof status)=>{s.snapshot.authors[0].layer.formatVersion=1;},
  (s:typeof status)=>{s.snapshot.authors[0].layer.payload.annotations[0].categoryIds=[document.projectId];},
  (s:typeof status)=>{s.snapshot.authors[0].layer.payload.mediaLabels[0].categoryIds=[document.projectId];},
  (s:typeof status)=>{s.snapshot.authors[0].layer.payload.mediaLabels[0].channelCategoryIds[0]=[document.projectId];},
 ]) {const bad=structuredClone(status);mutate(bad);expect(()=>parseCollaborationStatus(bad,document)).toThrow();}
 const author=structuredClone(status.snapshot.authors[0]),foreign='00000000-0000-4000-8000-000000000078';
 author.identity.authorId=foreign;author.layer.authorId=foreign;author.layer.payload.categories=[];
 status.snapshot.authors.push(author);
 expect(()=>parseCollaborationStatus(status,document)).toThrow();
});

it('validates private monitor defaults and explicit nullable absolute overrides',async()=>{
 const {parsePreferences}=await import('./collaboration');
 const valid={...preferences,monitorGainDb:6,mediaMonitorGainDb:{[id]:6}};
 expect(parsePreferences(valid)).toEqual(valid);
 expect(parsePreferences({...valid,mediaMonitorGainDb:{[id]:null}})).toMatchObject({mediaMonitorGainDb:{[id]:null}});
 for(const patch of [{monitorGainDb:NaN},{monitorGainDb:24.1},{monitorGainDb:-60.1},{mediaMonitorGainDb:{[id]:Infinity}},{mediaMonitorGainDb:{bad:0}},{mediaMonitorGainDb:{[id]:{gain:0}}}])expect(()=>parsePreferences({...valid,...patch})).toThrow();
});

it('rejects private monitor overrides for media outside the current document',()=>{
 const document=parseProjectDocument(structuredClone(fixture));
 const status={...statusFixture(),projectId:document.projectId,snapshot:{projectId:document.projectId,authors:[]},preferences:{...preferences,monitorGainDb:0,mediaMonitorGainDb:{[document.media[0].id]:3}}};
 expect(()=>parseCollaborationStatus(status,document)).not.toThrow();
 status.preferences.mediaMonitorGainDb={[id]:3};
 expect(()=>parseCollaborationStatus(status,document)).toThrow();
});

it('accepts bounded private monitor maps beyond the former small context budget',()=>{
 const mediaMonitorGainDb=Object.fromEntries(Array.from({length:6000},(_,i)=>[`${i.toString(16).padStart(8,'0')}-0000-4000-8000-000000000001`,-59.99999999999999]));
 expect(()=>parseSharedContext({runtimeNonce:id,projectFlavor:'default',identityMode:'profile',canWriteAnnotations:true,canImportMedia:true,hiddenMediaIds:[],catalogPending:false,actor,preferences:{...preferences,monitorGainDb:0,mediaMonitorGainDb}})).not.toThrow();
 expect(()=>parseCollaborationStatus({...statusFixture(),preferences:{...preferences,monitorGainDb:0,mediaMonitorGainDb}})).not.toThrow();
});

it('strictly parses native personal retirement and maintenance independently of foreign snapshots',()=>{
 const document=parseProjectDocument(structuredClone(fixture)),retired=document.media[0].id;
 document.media=[];document.annotations=[];document.edits=[];document.analysis={};document.playbackMix={};document.viewState={...document.viewState,media:{},activeMediaId:null,compareMediaId:null};
 const status={...statusFixture(),projectId:document.projectId,snapshot:null,retirement:{mediaIds:[retired],snapshot:{document,canUndo:false,canRedo:false}},purgeMaintenance:{total:1,items:[{operationId:id,status:'committed-pending-cleanup',committed:true,cleanupPendingCount:2,cleanupFailedCount:1,deletedAudioBytes:0}]}};
 expect(parseCollaborationStatus(status).retirement?.snapshot.document.media).toEqual([]);
 for(const patch of [{retirement:{...status.retirement,extra:1}},{retirement:{...status.retirement,mediaIds:[retired,retired]}},{purgeMaintenance:{total:1,items:[{...status.purgeMaintenance.items[0],cleanupFailedCount:3}]}},{purgeMaintenance:{total:1,items:[{...status.purgeMaintenance.items[0],status:'accepted'}]}}])expect(()=>parseCollaborationStatus({...status,...patch})).toThrow();
});

it('accepts legitimate personal document maps beyond 32 keys and rejects unknown snapshot fields',()=>{
 const document=parseProjectDocument(structuredClone(fixture)),source=document.media[0],view={visibleChannels:[0,1],startSeconds:0,endSeconds:2,lowHz:0,highHz:24000,frequencyMix:0,spectrumKind:'stft' as const,gainDb:0,dynamicRangeDb:80,palette:'magma'},analysis=document.analysis[source.id],mix=document.playbackMix[source.id];
 document.media=Array.from({length:80},(_,i)=>({...structuredClone(source),id:`${(i+200).toString(16).padStart(8,'0')}-0000-4000-8000-000000000001`}));document.annotations=[];document.edits=[];
 document.analysis=Object.fromEntries(document.media.map(m=>[m.id,analysis]));document.playbackMix=Object.fromEntries(document.media.map(m=>[m.id,mix]));document.viewState={...document.viewState,media:Object.fromEntries(document.media.map(m=>[m.id,view])),activeMediaId:document.media[0].id,compareMediaId:null};
 const status={...statusFixture(),projectId:document.projectId,snapshot:null,retirement:{mediaIds:[source.id],snapshot:{document,canUndo:false,canRedo:false}}};
 expect(()=>parseCollaborationStatus(status)).not.toThrow();expect(()=>parseCollaborationStatus({...status,retirement:{...status.retirement,snapshot:{...status.retirement.snapshot,secret:true}}})).toThrow();
});

it('revalidates changes regardless of claimed revision and protects the cache from caller mutation',()=>{
 const parse=createCollaborationStatusParser(),status=parseCollaborationStatus(statusFixture());parse(status);
 const next={...structuredClone(status),lastSuccessMs:42};expect(parse(next)).toBe(next);
 next.snapshot!.authors.push({identity:status.actor!,layer:null,error:null});expect(parse(next)).toBe(next);
 next.snapshot!.authors.push({identity:status.actor!,layer:null,error:null});expect(()=>parse(next)).toThrow();
 expect(()=>parse({...status,lastSuccessMs:-1})).toThrow();
 expect(()=>parse({...status,unrecognized:true})).toThrow();
});
it('rejects cyclic, sparse and changed nested payloads after a warm cache',()=>{
 const parse=createCollaborationStatusParser(),status=parseCollaborationStatus(statusFixture());parse(status);
 const cyclic=structuredClone(status);Object.assign(cyclic.snapshot!,{authors:[cyclic]});expect(()=>parse(cyclic)).toThrow();
 const sparse=structuredClone(status);sparse.hiddenMediaIds.length=1;expect(()=>parse(sparse)).toThrow();
 const extra=structuredClone(status);Object.assign(extra.preferences!,{volume:NaN});expect(()=>parse(extra)).toThrow();
});
it('checks references against the current document on every cached response',()=>{
 const parse=createCollaborationStatusParser(),doc=parseProjectDocument(structuredClone(fixture)),status={...statusFixture(),projectId:doc.projectId,snapshot:{projectId:doc.projectId,authors:[]},hiddenMediaIds:[doc.media[0].id]};
 parse(status,doc);expect(()=>parse(structuredClone(status),{...doc,media:[]})).toThrow();
 const annotated=documentStatus(doc);parse(annotated,doc);const shorter={...doc,media:doc.media.map(m=>({...m,frameCount:1}))};expect(()=>parse(structuredClone(annotated),shorter)).toThrow();
});
