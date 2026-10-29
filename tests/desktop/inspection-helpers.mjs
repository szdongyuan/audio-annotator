import assert from 'node:assert/strict';
import { read } from './identity-helpers.mjs';
import { randomUUID } from 'node:crypto';
export async function observeInspection(h) {
 await h.evaluate(`window.__desktopInspectionCalls=[];const original=window.fetch;window.fetch=function(resource,options){const command=decodeURIComponent(String(resource).split('/').at(-1));if(command.startsWith('inspection_')){try{window.__desktopInspectionCalls.push({command,args:JSON.parse(options.body)});}catch{}}return original.call(this,resource,options);};`);
}
export async function inspectionStatus(h) {
 const args=await h.evaluate("return [...window.__desktopInspectionCalls].reverse().find(c=>c.args.previewId)?.args");
 assert.ok(args?.previewId,'actual native preview lease observed');
 const owner=await read(h,'collaboration_status');
 return read(h,'inspection_playback_status',{runtimeNonce:owner.runtimeNonce,projectId:owner.projectId,previewId:args.previewId});
}
export async function clickForeignEdge(h,button=0) {
 const r=await h.evaluate("return document.querySelector('.remote-annotation').getBoundingClientRect().toJSON()");
 await h.driver.actions().move({x:Math.round(r.x+1),y:Math.round(r.y+r.height*.5),origin:'viewport'}).press(button).release(button).perform();
}
export async function inspectionTile(h,source,seconds=3) {
 await h.until(`window.__desktopInspectionCalls.some(c=>c.command==='inspection_request_tile'&&c.args.request.analysisSource===${JSON.stringify(source)})`);
 const observed=await h.evaluate("return [...window.__desktopInspectionCalls].reverse().find(c=>c.command==='inspection_request_tile'&&c.args.request.analysisSource===arguments[0]).args",source);
 const request={...observed.request,requestId:randomUUID(),startFrame:Math.round(seconds*48000/observed.request.settings.hopSize),frameCount:8,timeLod:0,frequencyStart:0,frequencyCount:observed.request.settings.fftSize/2+1,frequencyLod:0};
 const owner=await read(h,'collaboration_status');
 const result=await h.driver.executeAsyncScript(`const [args,done]=arguments,api=window.__TAURI_INTERNALS__,callback=api.transformCallback(()=>{});api.invoke('inspection_request_tile',{...args,onEvent:'__CHANNEL__:'+callback}).then(buffer=>{const v=new DataView(buffer),length=v.getUint32(4,true),offset=Math.ceil((8+length)/4)*4;done({header:JSON.parse(new TextDecoder().decode(new Uint8Array(buffer,8,length))),values:Array.from(new Float32Array(buffer,offset))});},e=>done({error:e})).finally(()=>api.unregisterCallback(callback));`,{runtimeNonce:owner.runtimeNonce,projectId:owner.projectId,previewId:observed.previewId,request});
 assert.ok(!result.error,JSON.stringify(result));return result;
}
