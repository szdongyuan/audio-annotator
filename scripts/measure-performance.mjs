import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { canonicalEdits } from '../src/features/spectrogram/analysisSource.ts';
import { start,wait,Key } from '../tests/desktop/harness.mjs';
import { longFixtures } from './performance-fixtures.mjs';
const command=(cmd,args)=>{const r=spawnSync(cmd,args,{stdio:'inherit',shell:cmd.endsWith('.cmd'),windowsHide:true});if(r.status!==0)throw Error(`${cmd}: ${r.status}`);};
const fixtures=await longFixtures();
command('pwsh',['-NoProfile','-ExecutionPolicy','Bypass','-File','scripts/setup-webdriver.ps1']);
if(!process.argv.includes('--skip-build'))command('npm.cmd',['run','tauri','--','build','--no-bundle','--features','e2e','--config','src-tauri/tauri.e2e.conf.json']);
// Finish all builds and the backend benchmark before timing the UI.
const backend=spawnSync('cargo',['run','-p','annotator-core','--release','--example','benchmark','--',fixtures[0].file],{encoding:'utf8',windowsHide:true});
if(backend.status!==0)throw Error(backend.stderr);
await fs.mkdir(path.resolve('.test-output/fidelity-release'), { recursive: true });
const output=await fs.mkdtemp(path.resolve('.test-output/fidelity-release/perf-'));const project=path.join(output,'project');await fs.mkdir(project);
const report={output,environment:{platform:os.version(),cpu:os.cpus()[0].model,memory:os.totalmem(),build:'release + e2e picker feature'},fixtures,backend:JSON.parse(backend.stdout.trim()),method:'Cold app analysis cache and fresh project/PCM; OS cache not purged. Warm feedback measures input event timestamp → terminal dirty strip of full-resolution canvas draw, waits until all tile statuses clear, invalidates superseded draw callbacks → two animation frames (paint opportunity). No first-strip/preview sample. Distinct ten-minute 48kHz 6ch and 2ch sources; real native device output. Memory queries only retain the owned native/WebView2 tree; one-second wait follows each process query, with actual intervals reported.'};
let h,monitor;const stop=path.join(output,'memory.stop');
try {
  h=await start({'新建项目 · 选择空文件夹':[project],'':[[fixtures[0].file,fixtures[1].file],[fixtures[0].file]]},output,path.resolve('target/release/annotator-desktop.exe'));
  h.nativeRect({width:1920,height:1080});
  monitor=spawn('pwsh',['-NoProfile','-File','scripts/monitor-memory.ps1','-RootProcess',String(h.nativePid),'-Output',path.join(output,'memory.json'),'-StopFile',stop],{windowsHide:true});
  await h.menu('新建项目');await h.until(`document.querySelector('.project-identity').textContent.includes('已保存')`);
  const cold=performance.now();await h.clickText('导入音频');
  await h.until(`document.querySelector('.import-progress')?.innerText.includes('导入完成')`,'long import',180000);
  await h.clickText('关闭导入结果');await h.select('声音版本','原音');await h.clickText('全部');await h.menu('双文件对比','视图');await h.label(path.basename(fixtures[1].file));
  await h.until(`document.querySelectorAll('.channel-pane').length===8 && !document.querySelector('.tile-status')`,'cold eight-channel first screen',180000);
  await h.driver.executeAsyncScript('const done=arguments[0];requestAnimationFrame(()=>requestAnimationFrame(done))');
  report.coldImportAndDualFirstScreenMs=performance.now()-cold;
  report.window={densityMethod:'Actual Windows display density; no CDP override in performance run',outer:h.nativeRect(),...await h.evaluate('return {viewport:[innerWidth,innerHeight],dpr:devicePixelRatio,scale:visualViewport.scale}')};
  await h.screenshot('long-dual-cold');
  report.firstReady={originalMs:report.coldImportAndDualFirstScreenMs};
  const bitmap=()=>h.evaluate(`return [...document.querySelectorAll('canvas')].map(c=>{const p=c.width&&c.height?c.getContext('2d').getImageData(0,0,c.width,c.height).data:[];let hash=2166136261;for(const x of p)hash=Math.imul(hash^x,16777619);const r=c.getBoundingClientRect();return {hash:hash>>>0,width:c.width,height:c.height,cssWidth:r.width,cssHeight:r.height,rgbaBytes:c.width*c.height*4};})`);
  report.originalCanvases=await bitmap();
  const projectId=JSON.parse(await fs.readFile(path.join(project,'project.json'),'utf8')).projectId;
  // A real UI selection includes the 300Hz tone on channel one; Delete accepts the edit.
  await h.drag('.annotation-overlay',[.2,.6],[.6,.99]);await h.driver.actions().sendKeys(Key.DELETE).perform();
  await h.until(`document.querySelector('.mask-rect')`);
  await h.driver.wait(async()=>!!(await h.snapshot(projectId)).document.edits.length,10000,'accepted native mask');
  report.mask=(await h.snapshot(projectId)).document.edits[0];assert.ok(report.mask?.enabled);
  const processedStart=performance.now();await h.select('声音版本','暂存编辑');
  await h.driver.wait(async()=>{if(await h.evaluate(`return !!document.querySelector('.tile-status')`))return false;return (await bitmap())[0].hash!==report.originalCanvases[0].hash;},180000,'processed source completes and updates actual masked pixels',50);
  await h.driver.executeAsyncScript('const done=arguments[0];requestAnimationFrame(()=>requestAnimationFrame(done))');
  report.firstReady.processedWithAcceptedMaskMs=performance.now()-processedStart;
  report.processedCanvases=await bitmap();assert.notEqual(report.processedCanvases[0].hash,report.originalCanvases[0].hash,'actual mask changes the rendered pixels');
  for(const c of report.processedCanvases.filter(c=>c.width>1)) {assert.ok(Math.abs(c.width-c.cssWidth*report.window.dpr)<=1);assert.ok(Math.abs(c.height-c.cssHeight*report.window.dpr)<=1);}
  const retained=report.processedCanvases.reduce((n,c)=>n+c.rgbaBytes,0),scratch=Math.max(...report.processedCanvases.map(c=>Math.min(64,c.width)*c.height*4));
  report.budgets={rasterRetainedPlusScratchBytes:retained+scratch,rasterLimitBytes:32*1024*1024,numericLimitBytes:64*1024*1024,pcmLimitBytes:128*1024*1024,analysisPcmLimitBytes:96*1024*1024};assert.ok(retained+scratch<=report.budgets.rasterLimitBytes);
  await h.screenshot('long-dual-processed');
  const doc=(await h.snapshot(projectId)).document, media=doc.media.find(m=>m.id===report.mask.region.mediaId),settings=doc.analysis[media.id];
  const rpc=(command,args)=>h.driver.executeAsyncScript(`const [command,args,done]=arguments;window.__TAURI_INTERNALS__.invoke(command,args).then(done,error=>done({error}));`,command,args);
  const lease=await rpc('register_analysis_view',{projectId});
  try {
    report.energyDb={};
    for(const source of ['original','processed']) {
      const request={requestId:randomUUID(),viewId:lease,projectId,mediaId:media.id,generation:1,analysisSource:source,processingVersion:1,editSignature:source==='original'?'':createHash('sha256').update(canonicalEdits(media.id,doc.edits)).digest('hex'),configHash:createHash('sha256').update(['analysis-v1',settings.window,settings.windowSize,settings.hopSize,settings.fftSize,settings.melBands].join('|')).digest('hex'),settings,channelIndex:0,kind:'stft',startFrame:Math.floor((report.mask.region.startSeconds+report.mask.region.endSeconds)/2*media.sampleRate/settings.hopSize),frameCount:8,timeLod:0,frequencyStart:0,frequencyCount:settings.fftSize/2+1,frequencyLod:0,visible:true};
      const values=await h.driver.executeAsyncScript(`const [request,done]=arguments,api=window.__TAURI_INTERNALS__,callback=api.transformCallback(()=>{});api.invoke('request_tile',{request,onEvent:'__CHANNEL__:'+callback}).then(buffer=>{const length=new DataView(buffer).getUint32(4,true),offset=Math.ceil((8+length)/4)*4;done(Array.from(new Float32Array(buffer,offset)));},error=>done({error})).finally(()=>api.unregisterCallback(callback));`,request);
      assert.ok(Array.isArray(values),JSON.stringify(values));const bin=Math.round(300*settings.fftSize/media.sampleRate),columns=settings.fftSize/2+1;
      report.energyDb[source]=10*Math.log10(Array.from({length:8},(_,row)=>10**(values[row*columns+bin]/10)).reduce((a,b)=>a+b)/8);
    }
    report.energyDb.attenuation=report.energyDb.processed-report.energyDb.original;assert.ok(report.energyDb.attenuation < -30,'actual processed 300Hz energy reduction');
  } finally {await rpc('retire_analysis_view',{projectId,viewId:lease});}


  await h.evaluate(`window.__measure={samples:[],armed:null,terminalStrips:0,serial:0};const arm=e=>{if(e.target.closest('.spectrogram-surface')){window.__measure.armed=performance.now();window.__measure.serial++}};document.addEventListener('wheel',arm,{capture:true});document.addEventListener('pointermove',e=>{if(e.altKey&&e.buttons===1)arm(e)},{capture:true});const original=CanvasRenderingContext2D.prototype.putImageData;CanvasRenderingContext2D.prototype.putImageData=function(...args){const result=original.apply(this,args),m=window.__measure;const [image,x,y,dirtyX=0,dirtyY=0,dirtyWidth=image.width]=args;if(m.armed!==null&&this.canvas.closest('.spectrogram-surface')&&x+dirtyX+dirtyWidth>=this.canvas.width){m.terminalStrips++;const serial=++m.serial;const finish=()=>requestAnimationFrame(()=>requestAnimationFrame(()=>{if(serial!==m.serial||m.armed===null)return;if(document.querySelector('.tile-status')){finish();return;}m.samples.push(performance.now()-m.armed);m.armed=null;}));finish();}return result};`);
  const canvas=await h.element('.spectrogram-surface');const box=await canvas.getRect();
  // Prewarm both neighboring zoom levels, then collect alternating zoom/pan feedback.
  for(let i=0;i<45;i++) {
    await h.driver.actions().scroll(Math.round(box.x+box.width*.5),Math.round(box.y+box.height*.5),0,i%2?100:-100).perform();
    await h.until(`window.__measure.armed===null`,'canvas painted after wheel',30000);await wait(100);
    if(i===4)await h.evaluate('window.__measure.samples=[]');
  }
  report.feedbackSamplesMs=await h.evaluate('return window.__measure.samples');
  assert.equal(report.feedbackSamplesMs.length,40,'40 zoom render samples');
  await h.evaluate(`window.__measure.samples=[]`);
  for(let i=0;i<25;i++) {
    const x=Math.round(box.x+box.width*.5),y=Math.round(box.y+box.height*.5),delta=Math.round(box.width*.05)*(i%2?1:-1);
    await h.driver.actions().keyDown(Key.ALT).move({x,y,origin:'viewport'}).press().move({x:x+delta,y,origin:'viewport',duration:0}).release().keyUp(Key.ALT).perform();
    await h.until(`window.__measure.armed===null`,'canvas painted after pan',30000);await wait(100);
    if(i===4)await h.evaluate('window.__measure.samples=[]');
  }
  report.panFeedbackSamplesMs=await h.evaluate('return window.__measure.samples');
  assert.equal(report.panFeedbackSamplesMs.length,20,'20 Alt-pointer pan render samples');
  await h.evaluate(`window.__measure.samples=[]`);
  for(let i=0;i<25;i++) {
    await h.driver.actions().keyDown(Key.CONTROL).scroll(Math.round(box.x+box.width*.5),Math.round(box.y+box.height*.5),0,i%2?100:-100).keyUp(Key.CONTROL).perform();
    await h.until(`window.__measure.armed===null`,'canvas painted after axis mix',30000);await wait(100);
    if(i===4)await h.evaluate('window.__measure.samples=[]');
  }
  report.mixFeedbackSamplesMs=await h.evaluate('return window.__measure.samples');
  assert.equal(report.mixFeedbackSamplesMs.length,20,'20 Ctrl-wheel axis-mix render samples');
  const p95=samples=>{const sorted=[...samples].sort((a,b)=>a-b);return sorted[Math.ceil(sorted.length*.95)-1];};
  report.warmByActionP95Ms={zoom:p95(report.feedbackSamplesMs),pan:p95(report.panFeedbackSamplesMs),mix:p95(report.mixFeedbackSamplesMs)};
  report.warmFeedbackP95Ms=p95([...report.feedbackSamplesMs,...report.panFeedbackSamplesMs,...report.mixFeedbackSamplesMs]);
  // Separate import cancellation while real large-source hashing/decoding is active.
  await h.clickText('导入音频');await h.until(`document.querySelector('.import-progress') && document.body.innerText.includes('取消')`);
  await h.evaluate(`window.__cancelStart=null;window.__cancelMs=null;document.addEventListener('pointerdown',e=>{if(e.target.closest('button')?.textContent.includes('取消'))window.__cancelStart=performance.now()},{capture:true,once:true});const observer=new MutationObserver(()=>{if(window.__cancelStart!==null && /正在取消|导入完成/.test(document.querySelector('.import-progress')?.textContent??'')){observer.disconnect();requestAnimationFrame(()=>requestAnimationFrame(()=>window.__cancelMs=performance.now()-window.__cancelStart))}});observer.observe(document.querySelector('.import-progress'),{subtree:true,childList:true,characterData:true})`);
  const cancelStart=performance.now();await h.clickText('取消导入');
  await h.until(`window.__cancelMs!==null`,'visible cancellation feedback');
  report.cancelVisibleMs=await h.evaluate('return window.__cancelMs');
  await h.until(`document.querySelector('.import-progress')?.textContent.includes('导入完成')`,'cancel job retirement');
  report.cancelCompletionMs=performance.now()-cancelStart;
  await h.clickText('关闭导入结果');
  await h.menu('输出设备…','音频');
  const devices=await h.evaluate('return [...document.querySelector("select[aria-label=输出设备]").options].map(o=>o.textContent).slice(1)');
  report.device=process.env.ANNOTATOR_PERF_DEVICE??devices.find(d=>d.includes('Headphones'))??devices[0];
  assert.ok(report.device,'native output device required');await h.select('输出设备',report.device);
  await (await h.element('input[aria-label="播放音量"]')).sendKeys(Key.HOME,...Array(5).fill(Key.ARROW_RIGHT));
  report.appVolume=Number(await h.evaluate('return document.querySelector("input[aria-label=播放音量]").value'));
  assert.ok(report.appVolume<=.1,'modest app volume; system volume unchanged');
  report.playback=[];report.playbackDurationsMs={};
  for(const mode of ['原音','暂存编辑']) {
    await h.select('声音版本',mode);await h.menu('播放整段','音频');
    await h.until(`document.querySelector('.playback-counters').textContent.match(/已提交 [1-9]/)`);
    const observationStarted=performance.now();
    for(let i=0;i<30;i++){await wait(1000);const counter=await h.evaluate('return document.querySelector(".playback-counters").textContent');const status=await h.driver.executeAsyncScript('const done=arguments[0];window.__TAURI_INTERNALS__.invoke("playback_status",{}).then(done)');report.playback.push({mode,counter,status});assert.equal(status.state,'playing');assert.equal(status.underrunFrames,0);assert.equal(status.endSeconds,600);if(i)assert.ok(status.consumedFrames>report.playback.at(-2).status.consumedFrames,'native output must advance throughout 30 seconds');}
    report.playbackDurationsMs[mode]=performance.now()-observationStarted;await h.label('停止');
  }
  report.playbackObservationSeconds=60;report.completedTerminalStrips=await h.evaluate('return window.__measure.terminalStrips');await h.screenshot('long-dual-playback');
  report.passed={warm:report.warmFeedbackP95Ms<=100&&Object.values(report.warmByActionP95Ms).every(v=>v<=100),cancel:report.cancelVisibleMs<=500,underruns:report.playback.every(s=>/欠载 0(?:\D|$)/.test(s.counter))};
  if(Object.values(report.passed).some(v=>!v))process.exitCode=1;
}catch(error){report.error=error.stack;process.exitCode=1;await h?.screenshot('failure').catch(()=>{});}
finally{
  await fs.writeFile(stop,'stop');if(monitor)await new Promise(r=>{monitor.once('exit',r);if(monitor.exitCode!==null)r();});
  const memory=JSON.parse(await fs.readFile(path.join(output,'memory.json'),'utf8').catch(()=>'[]'));
  const intervals=memory.slice(1).map((s,i)=>Date.parse(s.utc)-Date.parse(memory[i].utc)).sort((a,b)=>a-b);
  report.memory={actualIntervalMs:{min:intervals[0],median:intervals[Math.floor(intervals.length/2)],max:intervals.at(-1)},intervalMs:1000,samples:memory.length,nativePeakSampledBytes:Math.max(0,...memory.map(s=>s.nativeWorkingSet)),processTreePeakSampledBytes:Math.max(0,...memory.map(s=>s.treeWorkingSet))};
  report.memory.monitorExitCode=monitor?.exitCode??null;if(monitor?.exitCode!==0||!memory.length){report.error??='Owned process-tree memory monitor did not complete with samples';process.exitCode=1;}
  await h?.quit();await fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}

