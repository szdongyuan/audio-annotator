import { describe, expect, it } from 'vitest';
import { parseCollaborationStatus, parseSharedContext, parseTransition } from './collaboration';
import { parseProjectDocument, type ProjectDocument } from './types';
import fixture from '../../tests/fixtures/document-v2.json';
const id='11111111-1111-4111-8111-111111111111';
const actor={authorId:id,normalizedLogin:'alice',displayName:'Alice',createdAt:'2026-10-23T00:00:00Z'};
const preferences={volume:.75,deviceId:null,loopEnabled:false,source:'processed'};
export const statusFixture=()=>({formatVersion:1,runtimeNonce:id,projectId:id,shared:true,projectFlavor:'legacyShared' as const,identityMode:'account' as const,canWriteAnnotations:true,canImportMedia:false,hiddenMediaIds:[],catalogPending:false,actor,preferences,pending:false,recoveryRequired:false,busy:false,lastSuccessMs:null,error:null,snapshot:{projectId:id,authors:[]}});
function documentStatus(document:ProjectDocument){
 const payload={categories:document.categories,annotations:document.annotations,mediaLabels:document.media.map(m=>({mediaId:m.id,note:m.note,channelNotes:m.channelNotes,categoryId:m.categoryId,channelCategoryIds:m.channelCategoryIds}))};
 const layer={kind:'audio-annotator-author-layer',formatVersion:1,projectId:document.projectId,authorId:id,revision:1,parent:null,hash:'a'.repeat(64),payload};
 return {...statusFixture(),projectId:document.projectId,snapshot:{projectId:document.projectId,authors:[{identity:actor,layer,error:null}]}};
}
describe('collaboration boundary',()=>{
 it.each(['region','file','channel'] as const)('accepts native-valid %s notes above one MiB in status and identity transitions',target=>{
  const document=parseProjectDocument(structuredClone(fixture)),note='n'.repeat(1048577);
  if(target==='region')document.annotations[0].note=note;else if(target==='file')document.media[0].note=note;else document.media[0].channelNotes[0]=note;
  parseProjectDocument(document);
  const status=documentStatus(document),layer=status.snapshot.authors[0].layer;
  expect(new TextEncoder().encode(JSON.stringify(layer)).length).toBeLessThan(16*1024*1024);
  const wire=JSON.parse(JSON.stringify({opened:{snapshot:{document,canUndo:false,canRedo:false},path:'shared',persistedRevision:document.revision,recovery:null,collaboration:{runtimeNonce:id,projectFlavor:'legacyShared' as const,identityMode:'account' as const,canWriteAnnotations:true,canImportMedia:false,hiddenMediaIds:[],catalogPending:false,actor,preferences}},status}));
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
 it('still enforces account text limits independently from payload strings',()=>{
  for(const patch of [{displayName:'x'.repeat(257)},{normalizedLogin:'alice\0'}])expect(()=>parseSharedContext({runtimeNonce:id,actor:{...actor,...patch},preferences})).toThrow();
 });
 it('accepts native shared context and status without changing project documents',()=>{
  expect(parseCollaborationStatus(statusFixture()).actor?.displayName).toBe('Alice');
  expect(parseSharedContext({runtimeNonce:id,projectFlavor:'legacyShared' as const,identityMode:'account' as const,canWriteAnnotations:true,canImportMedia:false,hiddenMediaIds:[],catalogPending:false,actor,preferences}).runtimeNonce).toBe(id);
 });
 it('rejects versions, unknown fields, credentials and unbounded collections',()=>{
  for(const patch of [{formatVersion:2},{password:'secret'},{actor:{...actor,passwordHash:'hash'}},{preferences:{...preferences,volume:2}},{snapshot:{projectId:id,authors:Array(129).fill({identity:actor,layer:null,error:null})}}])expect(()=>parseCollaborationStatus({...statusFixture(),...patch})).toThrow();
 });
 it('rejects invalid geometry and private fields nested in foreign layers',()=>{
  const layer={kind:'audio-annotator-author-layer',formatVersion:1,projectId:id,authorId:id,revision:1,parent:null,hash:'a'.repeat(64),payload:{categories:[],annotations:[{id:'22222222-2222-4222-8222-222222222222',region:{mediaId:id,channelIndex:0,startSeconds:2,endSeconds:1,lowHz:0,highHz:100},categoryId:null,note:'',createdAt:actor.createdAt,updatedAt:actor.createdAt}],mediaLabels:[]}};
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
