import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {canonicalEdits} from '../../src/features/spectrogram/analysisSource.ts';
import {read} from './identity-helpers.mjs';
import {snapshot} from './workspace-helpers.mjs';
import {wait} from './harness.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const fixedId=key=>{const b=Buffer.from(hash(`playback-timing-edits-v1/${key}`).slice(0,32),'hex');b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;const hex=b.toString('hex');return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;};
async function rpc(h,command,args={}){
 for(let attempt=0;attempt<100;attempt++){
  const owner=await read(h,'collaboration_status');assert.ok(!owner.error,JSON.stringify(owner));
  const value=await read(h,command,{runtimeNonce:owner.runtimeNonce,...args});
  if(value?.error?.details?.operationBusy){await wait(50);continue;}
  assert.ok(!value?.error,JSON.stringify({command,error:value?.error}));return value;
 }
 throw Error(`Native admission stayed busy: ${command}`);
}
export function processingIdentity(doc,names){
 return {editsHash:hash(JSON.stringify(doc.edits)),media:names.map(name=>{
  const m=doc.media.find(m=>m.displayName===name);assert.ok(m,name);
  const edits=doc.edits.filter(e=>e.region.mediaId===m.id),settings=doc.analysis[m.id];
  return {id:m.id,name,sourceSha256:m.sha256,sampleRate:m.sampleRate,frameCount:m.frameCount,channelCount:m.channelCount,settings,configHash:hash(['analysis-v1',settings.window,settings.windowSize,settings.hopSize,settings.fftSize,settings.melBands].join('|')),editSignature:hash(canonicalEdits(m.id,doc.edits)),edits};
 })};
}
/** The setup app is retired after native save; measurement apps adopt that saved owner afresh. */
export async function prepareProcessingFixture(h,names){
 let doc=await snapshot(h);
 const change=async change=>{doc=(await rpc(h,'apply_change',{projectId:doc.projectId,expectedRevision:doc.revision,change})).document;};
 const category={id:fixedId('category'),name:'Playback timing fixture',color:'#60a5fa'};
 if(!doc.categories.some(c=>c.id===category.id))await change({type:'addCategory',category});
 for(const name of names){
  const media=doc.media.find(m=>m.displayName===name);assert.ok(media,name);
  for(let channelIndex=0;channelIndex<media.channelCount;channelIndex++)for(const operation of [{type:'mask'},{type:'gain',gainDb:-6}]){
   const mask=operation.type==='mask',edit={id:fixedId(`${media.id}/${channelIndex}/${operation.type}`),region:{mediaId:media.id,channelIndex,startSeconds:.25,endSeconds:7.75,lowHz:mask?1000:5500,highHz:mask?2000:6500},enabled:true,processingVersion:2,operation};
   const existing=doc.edits.find(e=>e.id===edit.id);
   if(existing)assert.deepEqual(existing,edit);else await change({type:'addEdit',edit});
  }
  const annotation={id:fixedId(`${media.id}/annotation`),region:{mediaId:media.id,channelIndex:0,startSeconds:.5,endSeconds:7.5,lowHz:1000,highHz:6500},categoryIds:[category.id],note:`Owned playback timing ${media.channelCount}-channel fixture`,createdAt:'2026-10-28T00:00:00Z',updatedAt:'2026-10-28T00:00:00Z'};
  const existing=doc.annotations.find(a=>a.id===annotation.id);
  if(existing)assert.deepEqual(existing,annotation);else await change({type:'addAnnotation',annotation});
 }
 await rpc(h,'save_project',{projectId:doc.projectId,expectedRevision:doc.revision});
 doc=await snapshot(h);
 return {version:1,...processingIdentity(doc,names),category,annotations:doc.annotations.filter(a=>a.categoryIds.includes(category.id))};
}
export async function verifyProcessingFixture(h,doc,expected){
 const identity=processingIdentity(doc,expected.media.map(m=>m.name));
 assert.deepEqual(identity,{editsHash:expected.editsHash,media:expected.media},'Identical saved edits and analysis/source parameters');
 const probes=[];
 for(const media of identity.media){
  assert.equal(media.edits.length,media.channelCount*2,'Mask + gain on every channel');
  const {settings}=media,projectId=doc.projectId,viewId=await rpc(h,'register_analysis_view',{projectId});
  const request=async analysisSource=>{
   const request={requestId:randomUUID(),viewId,projectId,mediaId:media.id,generation:1,analysisSource,processingVersion:2,editSignature:analysisSource==='processed'?media.editSignature:'',configHash:media.configHash,settings,channelIndex:0,kind:'stft',startFrame:Math.round(2*media.sampleRate/settings.hopSize),frameCount:8,timeLod:0,frequencyStart:0,frequencyCount:settings.fftSize/2+1,frequencyLod:0,visible:true};
   const result=await h.driver.executeAsyncScript(`const [request,done]=arguments,api=window.__TAURI_INTERNALS__,callback=api.transformCallback(()=>{});api.invoke('collaboration_status').then(s=>api.invoke('request_tile',{runtimeNonce:s.runtimeNonce,request,onEvent:'__CHANNEL__:'+callback})).then(buffer=>{const length=new DataView(buffer).getUint32(4,true),offset=Math.ceil((8+length)/4)*4,header=JSON.parse(new TextDecoder().decode(new Uint8Array(buffer,8,length)));done({header,values:Array.from(new Float32Array(buffer,offset))});},error=>done({error})).finally(()=>api.unregisterCallback(callback));`,request);
   assert.ok(!result.error,JSON.stringify(result));assert.deepEqual(result.header.request,request);return result.values;
  };
  try{
   const original=await request('original'),processed=await request('processed');
   const energy=(values,hz)=>{const bin=Math.round(hz*settings.fftSize/media.sampleRate),bins=settings.fftSize/2+1;return 10*Math.log10(Array.from({length:8},(_,row)=>10**(values[row*bins+bin]/10)).reduce((a,b)=>a+b)/8);};
   const maskDeltaDb=energy(processed,1500)-energy(original,1500),gainDeltaDb=energy(processed,6000)-energy(original,6000);
   assert.ok(maskDeltaDb<-30,`Actual numeric mask rejection: ${maskDeltaDb} dB`);
   assert.ok(Math.abs(gainDeltaDb+6)<.25,`Actual numeric region gain: ${gainDeltaDb} dB`);
   const originalValuesHash=hash(Buffer.from(new Float32Array(original).buffer)),processedValuesHash=hash(Buffer.from(new Float32Array(processed).buffer));
   assert.notEqual(originalValuesHash,processedValuesHash,'Native processed numeric output differs');
   probes.push({mediaId:media.id,name:media.name,channelIndex:0,atSeconds:2,frames:8,editSignature:media.editSignature,configHash:media.configHash,maskDeltaDb,gainDeltaDb,originalValuesHash,processedValuesHash});
  }finally{await rpc(h,'retire_analysis_view',{projectId,viewId});}
 }
 return {identity,probes};
}
