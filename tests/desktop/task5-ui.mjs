import assert from 'node:assert/strict';
import { coordinates } from '../../src/features/spectrogram/coordinates.ts';
import { Key, wait } from './harness.mjs';
export const rpc = (h,command,args={}) => h.driver.executeAsyncScript(`const [command,args,done]=arguments;window.__TAURI_INTERNALS__.invoke("collaboration_status").then(s=>window.__TAURI_INTERNALS__.invoke(command,{...(s.shared?{runtimeNonce:s.runtimeNonce}:{}),...args})).then(done,e=>done({error:e}));`,command,args);
export const playbackStatus = h => rpc(h,'playback_status');
export async function outputAfter(h, previous) {
 return h.driver.wait(async()=>{const s=await playbackStatus(h);return s.generation>previous&&s.state==='playing'&&s.consumedFrames>2400?s:false;},60000,'actual native output frames',50);
}
async function bitmap(h) {
 await h.until(`!document.querySelector('.tile-status')`);await wait(200);
 return h.evaluate(`return [...document.querySelectorAll('canvas')].map(c=>{const a=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let hash=2166136261;for(const x of a)hash=Math.imul(hash^x,16777619);return {hash:hash>>>0,width:c.width,height:c.height};})`);
}
export async function processedUI(h,projectId,report) {
 await h.clickText('双文件对比');await h.until(`document.querySelectorAll('canvas').length===4&&!document.querySelector('.tile-status')`);
 assert.equal(await h.evaluate(`return document.querySelector('[aria-label="声音版本"]').value`),'processed');
 await h.evaluate(`window.__task5tiles=[];const callbacks=window.__TAURI_INTERNALS__.callbacks,register=callbacks.set;callbacks.set=function(id,callback){return register.call(this,id,function(result){if(result instanceof ArrayBuffer&&result.byteLength>8&&new DataView(result).getUint32(0,false)===0x41543031){const v=new DataView(result),length=v.getUint32(4,true),offset=Math.ceil((8+length)/4)*4,header=JSON.parse(new TextDecoder().decode(new Uint8Array(result,8,length)));window.__task5tiles.push({request:header.request,header,values:Array.from(new Float32Array(result,offset))});}return callback(result);});};`);
 const original=await bitmap(h),doc=(await h.snapshot(projectId)).document,primaryName=await h.evaluate(`return document.querySelector('.file-pane[data-pane="primary"] h2').textContent`),m=doc.media.find(m=>m.displayName===primaryName);assert.ok(m,'actual selected primary media');
 const view=doc.viewState.media[m.id]??{startSeconds:0,endSeconds:2,lowHz:0,highHz:24000,frequencyMix:.65,spectrumKind:'stft'};
 const c=coordinates(view,m.sampleRate/2,1,1),plot='.file-pane[data-pane="primary"] .annotation-overlay';
 await h.drag(plot,[.2,c.hzToY(2100)],[.8,c.hzToY(900)]);
 await h.driver.actions().sendKeys(Key.DELETE).perform();await h.until(`document.querySelector('.mask-rect.is-selected')`);
 let accepted=(await h.snapshot(projectId)).document,edit=accepted.edits[0];assert.ok(edit.region.lowHz<1500&&edit.region.highHz>1500);
 const processed=await bitmap(h);assert.notEqual(processed[0].hash,original[0].hash);assert.deepEqual(processed.slice(1),original.slice(1));
 const tiles=await h.evaluate('return window.__task5tiles');const t=tiles.find(t=>t.request.mediaId===m.id&&t.request.channelIndex===0&&t.request.analysisSource==='processed');assert.ok(t);
 const bin=Math.round(1500*t.request.settings.fftSize/m.sampleRate),row=Math.round(.8*m.sampleRate/t.request.settings.hopSize)-t.request.startFrame;
 const rejectedDb=t.values[row*t.header.tile.columns+bin];assert.ok(rejectedDb < -40,`masked 1500Hz ${rejectedDb}`);
 report.checks.push({name:'UI Delete accepts mask; actual processed tile and canvas change only selected channel/file',region:edit.region,rejectedDb,original,processed,requestCount:tiles.length});await h.screenshot('ui-processed-mask');
 await h.label('撤销 · Ctrl Z');const undone=await bitmap(h);assert.deepEqual(undone,original);
 await h.label('重做 · Ctrl Y');assert.deepEqual(await bitmap(h),processed);
 await h.select('声音版本','原音');assert.deepEqual(await bitmap(h),original);
 await h.select('声音版本','暂存编辑');assert.deepEqual(await bitmap(h),processed);
 await h.clickText('屏蔽');await h.label('启用屏蔽 1');assert.deepEqual(await bitmap(h),original);
 await h.clickText('屏蔽');await h.label('启用屏蔽 1');assert.deepEqual(await bitmap(h),processed);
 await h.click('.mask-rect');await h.drag('.mask-rect.is-selected',[.5,.5],[.65,.5]);const moved=await bitmap(h);assert.notEqual(moved[0].hash,processed[0].hash);
 await h.label('撤销 · Ctrl Z');assert.deepEqual(await bitmap(h),processed);
 await h.label('重做 · Ctrl Y');assert.deepEqual(await bitmap(h),moved);
 await h.label('删除屏蔽 1');assert.deepEqual(await bitmap(h),original);
 await h.label('撤销 · Ctrl Z');assert.deepEqual(await bitmap(h),moved);
 report.checks.push({name:'real UI undo/redo, raw switch, disable/enable, move and delete recompute matching pixels',moved});
 // Explicit opposite auditions preserve both file graphs, while consuming native device frames.
 await h.context('.mask-rect');await h.label('播放选区');await outputAfter(h,0);await h.label('停止');
 await h.label('循环播放');const auditions=[];
 for(const [workspace,label] of [['暂存编辑','试听选区原音'],['原音','试听选区（应用屏蔽）']]) {
  await h.select('声音版本',workspace);const before=await bitmap(h),count=await h.evaluate('return window.__task5tiles.length'),prior=await playbackStatus(h);
  await h.context('.mask-rect');await h.label(label);const status=await outputAfter(h,prior.generation);
  assert.equal(await h.evaluate(`return document.querySelector('[aria-label="声音版本"]').selectedOptions[0].textContent`),workspace);assert.deepEqual(await bitmap(h),before);assert.equal(await h.evaluate('return window.__task5tiles.length'),count);
  await h.label('暂停 · 空格');const paused=await playbackStatus(h);await h.label('播放 · 空格');const resumed=await outputAfter(h,paused.generation);assert.equal(resumed.firstSeconds,status.firstSeconds);assert.equal(resumed.endSeconds,status.endSeconds);
  auditions.push({workspace,label,status,paused,resumed});await h.label('停止');
 }
 await h.label('循环播放');await h.select('声音版本','暂存编辑');
 await h.clickText('保存');await h.until(`document.querySelector('.project-identity')?.textContent.match(/已保存|已存本机/)`);
 const saved=(await h.snapshot(projectId)).document;
 await h.menu('关闭项目');await h.until(`!document.querySelector('.file-pane')`);await h.menu('打开项目…');await h.until(`document.querySelectorAll('canvas').length===4&&!document.querySelector('.tile-status')`);
 assert.equal(await h.evaluate(`return document.querySelector('[aria-label="声音版本"]').value`),'processed');assert.deepEqual((await h.snapshot(projectId)).document.edits,saved.edits);
 // Tile readiness precedes the RAF that commits a reopened canvas. Require the
 // exact previous four bitmaps, rather than treating an arbitrary 200ms as a draw barrier.
 const reopenStarted=performance.now();report.reopenPixels={expected:moved,samples:[]};let reopenedPixels;
 await h.driver.wait(async()=>{reopenedPixels=await bitmap(h);report.reopenPixels.samples.push({elapsedMs:performance.now()-reopenStarted,bitmaps:reopenedPixels});return JSON.stringify(reopenedPixels)===JSON.stringify(moved);},10000,'reopened canvases must commit all four exact saved bitmaps',50);
 assert.deepEqual(reopenedPixels,moved);
 report.checks.push({name:'opposite explicit auditions preserve both graphs/source; pause/resume actual frames; saved mask reconstructs after UI reopen',auditions});
 await h.context('.mask-rect');await h.label('删除屏蔽');await h.until(`!document.querySelector('.mask-rect')`);await bitmap(h);
}

export async function cueUI(h,projectId,report) {
 const primary='.file-pane[data-pane="primary"]',compare='.file-pane[data-pane="compare"]';
 const escape=()=>h.driver.actions().sendKeys(Key.ESCAPE).perform();
 await h.select('主面板音频','cue-long.wav');await h.select('对比面板音频','float32.wav');
 await h.until(`!document.querySelector('.tile-status')`);
 await h.drag(`${primary} .annotation-overlay`,[.2,.3],[.5,.65]);
 await h.label('循环播放');await h.label('播放 · 空格');const auto=await outputAfter(h,0);
 assert.ok(auto.firstSeconds>.75&&auto.firstSeconds<.85);assert.ok(auto.endSeconds>1.95&&auto.endSeconds<2.05);
 const active=await h.evaluate(`return document.querySelector('.is-selected.annotation-rect').outerHTML`);
 await h.context(`${compare} .annotation-overlay`,[.8,.3]);
 const before=await playbackStatus(h);assert.equal(before.generation,auto.generation);assert.equal(before.mediaId,auto.mediaId);
 assert.equal(await h.evaluate(`return document.querySelector('[role="menuitem"][aria-label="从此处播放"]').getAttribute('aria-disabled')`),'true');
 await wait(150);const after=await playbackStatus(h);assert.equal(after.generation,before.generation);assert.ok(after.consumedFrames>before.consumedFrames);await escape();
 assert.equal(await h.evaluate(`return document.querySelector('.is-selected.annotation-rect').outerHTML`),active);
 await h.context(`${primary} .annotation-overlay`,[.65,.15]);
 const cue=await h.evaluate(`return [...document.querySelectorAll('${primary} .audio-cue')].map(e=>({seconds:+e.dataset.seconds,left:e.getBoundingClientRect().left,plot:e.parentElement.getBoundingClientRect().toJSON(),width:getComputedStyle(e).borderLeftWidth,color:getComputedStyle(e).borderLeftColor,style:getComputedStyle(e).borderLeftStyle,pointer:getComputedStyle(e).pointerEvents}))`);
 assert.equal(cue.length,2);assert.equal(cue[0].seconds,cue[1].seconds);for(const line of cue){assert.equal(line.width,'1px');assert.equal(line.color,'rgb(255, 255, 255)');assert.equal(line.style,'dashed');assert.equal(line.pointer,'none');assert.ok(Math.abs(line.left-(line.plot.left+line.plot.width*line.seconds/4))<.5);}
 const prior=await playbackStatus(h);assert.equal(prior.generation,auto.generation);
 await h.label('从此处播放');const from=await outputAfter(h,prior.generation);assert.equal(from.firstSeconds,0);assert.equal(from.endSeconds,4);assert.ok(Math.abs(from.startSeconds-cue[0].seconds)<1/48000);
 assert.equal(await h.evaluate(`return document.querySelector('.is-selected.annotation-rect').outerHTML`),active);
 await h.label('暂停 · 空格');const paused=await playbackStatus(h);await wait(150);assert.equal((await playbackStatus(h)).positionSeconds,paused.positionSeconds);
 await h.label('播放 · 空格');const resumed=await outputAfter(h,paused.generation);assert.equal(resumed.startSeconds,from.startSeconds);assert.equal(resumed.firstSeconds,0);
 await h.label('停止');await h.label('播放 · 空格');const restored=await outputAfter(h,resumed.generation);assert.equal(restored.firstSeconds,auto.firstSeconds);assert.equal(restored.endSeconds,auto.endSeconds);
 await h.menu('播放整段','音频');const whole=await outputAfter(h,restored.generation);assert.equal(whole.startSeconds,0);assert.equal(whole.firstSeconds,0);assert.equal(whole.endSeconds,4);
 await h.label('停止');await h.label('循环播放');await h.label('播放 · 空格');await h.until(`document.querySelector('.playback-position span')?.textContent==='播放结束'`);const ended=await playbackStatus(h);assert.equal(ended.endSeconds,auto.endSeconds);assert.ok(ended.consumedFrames>0);
 await h.label('播放 · 空格');const again=await outputAfter(h,ended.generation);assert.equal(again.firstSeconds,auto.firstSeconds);await h.label('停止');
 // Zoom-to-selection hides the fixed cue outside the visible interval without deleting it.
 await h.menu('放大到选区','视图');await h.until(`!document.querySelector('${primary} .audio-cue')`);
 await h.menu('重置当前视图','视图');await h.until(`document.querySelectorAll('${primary} .audio-cue').length===2`);
 const targets=await(await fetch('http://127.0.0.1:9235/json/list')).json(),page=targets.find(t=>t.type==='page'),ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener('open',r,{once:true}));let sequence=0;
 const cdp=(method,params)=>new Promise((resolve,reject)=>{const id=++sequence;const listener=e=>{const m=JSON.parse(e.data);if(m.id===id){ws.removeEventListener('message',listener);m.error?reject(Error(JSON.stringify(m.error))):resolve(m.result);}};ws.addEventListener('message',listener);ws.send(JSON.stringify({id,method,params}));});
 const densities=[];
 try{for(const dpr of [1,1.25,2]){const inner=await h.evaluate('return [innerWidth,innerHeight]');await cdp('Emulation.setDeviceMetricsOverride',{width:inner[0],height:inner[1],deviceScaleFactor:dpr,mobile:false});await wait(200);const lines=await h.evaluate(`return [...document.querySelectorAll('${primary} .audio-cue')].map(e=>{const r=e.getBoundingClientRect(),p=e.parentElement.getBoundingClientRect();return{error:Math.abs(r.left-p.left-p.width*(+e.dataset.seconds)/4),width:getComputedStyle(e).borderLeftWidth,dpr:devicePixelRatio}})`);assert.ok(lines.every(l=>l.error<=.5&&l.width==='1px'&&l.dpr===dpr));densities.push({dpr,lines});}}finally{await cdp('Emulation.clearDeviceMetricsOverride',{});ws.close();}
 await h.screenshot('cue-native-white-dashed');
 // Deactivation makes the current-file cue the ordinary stopped-play start.
 await escape();await h.label('播放 · 空格');const inactive=await outputAfter(h,again.generation);assert.equal(inactive.firstSeconds,0);assert.ok(Math.abs(inactive.startSeconds-cue[0].seconds)<1/48000);await h.label('停止');
 report.checks.push({name:'native cue semantics, no audio mutation on other-file/blank-tail menu, automatic/explicit/pause/stop/end, zoom and simulated DPR',auto,before,after,cue,from,paused,resumed,restored,whole,ended,again,inactive,densities});
}
