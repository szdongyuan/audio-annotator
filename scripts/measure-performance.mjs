import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { start,wait,Key } from '../tests/desktop/harness.mjs';
import { longFixtures } from './performance-fixtures.mjs';
const command=(cmd,args)=>{const r=spawnSync(cmd,args,{stdio:'inherit',shell:cmd.endsWith('.cmd'),windowsHide:true});if(r.status)throw Error(`${cmd}: ${r.status}`);};
const fixtures=await longFixtures();
command('pwsh',['-NoProfile','-ExecutionPolicy','Bypass','-File','scripts/setup-webdriver.ps1']);
if(!process.argv.includes('--skip-build'))command('npm.cmd',['run','tauri','--','build','--no-bundle','--features','e2e','--config','src-tauri/tauri.e2e.conf.json']);
// Finish all builds and the backend benchmark before timing the UI.
const backend=spawnSync('cargo',['run','-p','annotator-core','--release','--example','benchmark','--',fixtures[0].file],{encoding:'utf8',windowsHide:true});
if(backend.status)throw Error(backend.stderr);
const output=await fs.mkdtemp(path.resolve('.test-output/perf-'));const project=path.join(output,'project');await fs.mkdir(project);
const report={output,environment:{platform:os.version(),cpu:os.cpus()[0].model,memory:os.totalmem(),build:'release + e2e picker feature'},fixtures,backend:JSON.parse(backend.stdout.trim()),method:'Cold app analysis cache and fresh project/PCM; OS cache not purged. Warm feedback measures input event timestamp → actual canvas draw → two animation frames (paint opportunity). Distinct ten-minute 48kHz 6ch and 2ch sources; real native device output. Memory sampled once per second across owned native/WebView2 process tree.'};
let h,monitor;const stop=path.join(output,'memory.stop');
try {
  h=await start({'新建项目 · 选择空文件夹':[project],'':[[fixtures[0].file,fixtures[1].file],[fixtures[0].file]]},output,path.resolve('target/release/annotator-desktop.exe'));
  monitor=spawn('pwsh',['-NoProfile','-File','scripts/monitor-memory.ps1','-RootProcess',String(h.nativePid),'-Output',path.join(output,'memory.json'),'-StopFile',stop],{windowsHide:true});
  await h.menu('新建项目');await h.until(`document.querySelector('.project-identity').textContent.includes('已保存')`);
  const cold=performance.now();await h.clickText('导入音频');
  await h.until(`document.querySelector('.import-progress')?.innerText.includes('导入完成')`,'long import',180000);
  await h.clickText('关闭导入结果');await h.clickText('全部');await h.menu('双文件对比','视图');await h.label(path.basename(fixtures[1].file));
  await h.until(`document.querySelectorAll('.channel-pane').length===8 && !document.querySelector('.tile-status')`,'cold eight-channel first screen',180000);
  await h.driver.executeAsyncScript('const done=arguments[0];requestAnimationFrame(()=>requestAnimationFrame(done))');
  report.coldImportAndDualFirstScreenMs=performance.now()-cold;
  report.window={outer:h.nativeRect(),...await h.evaluate('return {viewport:[innerWidth,innerHeight],dpr:devicePixelRatio,scale:visualViewport.scale}')};
  await h.screenshot('long-dual-cold');
  await h.evaluate(`window.__measure={samples:[],armed:null};document.addEventListener('wheel',e=>{if(e.target.closest('.spectrogram-surface'))window.__measure.armed=performance.now()},{capture:true});document.addEventListener('pointermove',e=>{if(e.altKey&&e.buttons===1&&e.target.closest('.spectrogram-surface'))window.__measure.armed=performance.now()},{capture:true});const original=CanvasRenderingContext2D.prototype.putImageData;CanvasRenderingContext2D.prototype.putImageData=function(...args){const result=original.apply(this,args);const m=window.__measure;if(m.armed!==null && this.canvas.closest('.spectrogram-surface')){const start=m.armed;m.armed=null;requestAnimationFrame(()=>requestAnimationFrame(()=>m.samples.push(performance.now()-start)))}return result};`);
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
  // Exercise a genuinely edited processed source through the same public selection action.
  await h.drag('.annotation-overlay',[.2,.2],[.6,.7]);
  await h.driver.actions().sendKeys(Key.DELETE).perform();
  await h.until(`document.querySelector('.mask-rect')`,'non-destructive mask before processed playback');
  await h.menu('输出设备…','音频');
  report.playback=[];
  for(const mode of ['原音','处理后']) {
    await h.select('试听模式',mode);await h.label('播放 · 空格');
    await h.until(`document.querySelector('.playback-counters').textContent.match(/已提交 [1-9]/)`);
    for(let i=0;i<30;i++){await wait(1000);report.playback.push({mode,counter:await h.evaluate('return document.querySelector(".playback-counters").textContent')});}
    await h.label('停止');
  }
  report.playbackObservationSeconds=60;await h.screenshot('long-dual-playback');
  report.passed={warm:report.warmFeedbackP95Ms<=100,cancel:report.cancelVisibleMs<=500,underruns:report.playback.every(s=>/欠载 0(?:\D|$)/.test(s.counter))};
  if(Object.values(report.passed).some(v=>!v))process.exitCode=1;
}catch(error){report.error=error.stack;process.exitCode=1;await h?.screenshot('failure').catch(()=>{});}
finally{
  await fs.writeFile(stop,'stop');if(monitor)await new Promise(r=>{monitor.once('exit',r);if(monitor.exitCode!==null)r();});
  const memory=JSON.parse(await fs.readFile(path.join(output,'memory.json'),'utf8').catch(()=>'[]'));
  report.memory={intervalMs:1000,samples:memory.length,nativePeakSampledBytes:Math.max(0,...memory.map(s=>s.nativeWorkingSet)),processTreePeakSampledBytes:Math.max(0,...memory.map(s=>s.treeWorkingSet))};
  await h?.quit();await fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}

