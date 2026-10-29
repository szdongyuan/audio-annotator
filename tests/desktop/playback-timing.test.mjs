// Owned Windows diagnostic: explicit executable + previously prepared owned catalog.
// ANNOTATOR_PLAYBACK_MANIFEST points to switch-performance's manifest.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import net from 'node:net';
import {start, wait} from './harness.mjs';
import {snapshot, playback, wav, saved} from './workspace-helpers.mjs';
import {read,createIdentity} from './identity-helpers.mjs';
import {prepareProcessingFixture,verifyProcessingFixture} from './playback-processing-fixture.mjs';

const exe=process.env.ANNOTATOR_WORKSPACE_EXE;
assert.ok(exe,'Set ANNOTATOR_WORKSPACE_EXE');
assert.ok(process.env.ANNOTATOR_PLAYBACK_MANIFEST,'Set ANNOTATOR_PLAYBACK_MANIFEST');
const fixture=JSON.parse(await fs.readFile(process.env.ANNOTATOR_PLAYBACK_MANIFEST,'utf8')).fixtures[0];
assert.ok(path.basename(fixture.project).startsWith('.codex-switch-owned-'),'Only prepared owned fixtures');
const base=path.resolve(process.env.ANNOTATOR_SUITE_OUTPUT??'.test-output/collaborative-workspace/task4/playback');
await fs.mkdir(base,{recursive:true});
const label=(process.env.ANNOTATOR_PLAYBACK_LABEL??'baseline').replace(/[^a-z0-9_-]/gi,'_');
const output=await fs.mkdtemp(path.join(base,`${label}-`));
const report={sourceCheckDelayMs:Number(process.env.ANNOTATOR_E2E_SOURCE_CHECK_DELAY_MS??0),output,exe:path.resolve(exe),label,fixture,workload:fixture.processing?'nonempty mask + gain on every channel':'empty edits',trials:[],checks:[],limitations:['Consumed frames describe callback submission, not physical speaker output. No acoustic loopback was captured.'],method:'Owned native Windows process, unique ephemeral ports, Selenium UI controls; separate native event listener, RAF/cursor/long-task observations. A separately labelled induced renderer stall is excluded from steady-state summaries.'};
const uniquePort=()=>new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const port=s.address().port;s.close(()=>resolve(port));});});
let h, cpu;
async function profile(port){
 const pages=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();
 const socket=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);await new Promise((r,j)=>{socket.addEventListener('open',r,{once:true});socket.addEventListener('error',j,{once:true});});
 let serial=0;const pending=new Map();socket.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p?.reject(m.error):p?.resolve(m.result);}});
 const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++serial;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});
 await send('Performance.enable');await fs.writeFile(path.join(output,'renderer-metrics.json'),JSON.stringify(await send('Performance.getMetrics')));await send('Profiler.enable');await send('Profiler.start');return {async stop(){try{await fs.writeFile(path.join(output,'renderer.cpuprofile'),JSON.stringify((await send('Profiler.stop')).profile));}finally{socket.close();}}};
}
const check=(name,passed,detail)=>{report.checks.push({name,passed,detail});assert.ok(passed,name);};
const quantile=(a,q)=>a.length?[...a].sort((a,b)=>a-b)[Math.ceil(a.length*q)-1]:null;
function observe(){
 const p=window.__playbackTiming={events:[],frames:[],cursors:[],longTasks:[],errors:[],polls:[],phase:'setup'};
 if(window.__profilePlaybackPolls){const original=window.__TAURI_INTERNALS__.invoke,last={};window.__TAURI_INTERNALS__.invoke=async function(command,args,...rest){const at=performance.now(),value=await original.call(this,command,args,...rest);if(['collaboration_refresh','collaboration_status','collaboration_preferences'].includes(command)){const changed=[];for(const key of Object.keys(value)){const signature=JSON.stringify(value[key]);if(last[key]!==signature)changed.push(key);last[key]=signature;}p.polls.push({at,returned:performance.now(),phase:p.phase,command,changed,revision:value.retirement?.snapshot.document.revision});}return value;};}
 window.addEventListener('error',e=>p.errors.push(e.message));
 window.addEventListener('unhandledrejection',e=>p.errors.push(String(e.reason)));
 new PerformanceObserver(list=>p.longTasks.push(...list.getEntries().map(e=>({at:e.startTime,duration:e.duration,phase:p.phase})))).observe({type:'longtask'});
 const plotWidth=document.querySelector('.spectrogram-surface')?.getBoundingClientRect().width??1;
 const record=()=>{const e=document.querySelector('.audio-playhead');if(e)p.cursors.push({at:performance.now(),left:e.style.transform?parseFloat(e.style.transform.slice(12)):parseFloat(e.style.left)*plotWidth/100,phase:p.phase});};
 new MutationObserver(records=>{if(records.some(r=>r.target.matches?.('.audio-playhead')))record();}).observe(document.body,{subtree:true,attributes:true,attributeFilter:['style']});
 let previous=performance.now();const frame=now=>{p.frames.push({at:now,gap:now-previous,phase:p.phase});previous=now;requestAnimationFrame(frame);};requestAnimationFrame(frame);
 const handler=window.__TAURI_INTERNALS__.transformCallback(event=>p.events.push({at:performance.now(),phase:p.phase,...event.payload}));
 return window.__TAURI_INTERNALS__.invoke('plugin:event|listen',{event:'playback-progress',target:{kind:'Any'},handler});
}
async function setValue(selector,value){await h.evaluate('const e=document.querySelector(arguments[0]);Object.getOwnPropertyDescriptor(e.tagName==="SELECT"?HTMLSelectElement.prototype:HTMLInputElement.prototype,"value").set.call(e,arguments[1]);e.dispatchEvent(new Event("input",{bubbles:true}));e.dispatchEvent(new Event("change",{bubbles:true}));',selector,String(value));}
async function waitState(state){await h.driver.wait(async()=> (await playback(h)).state===state,30000,`native ${state}`,50);return playback(h);}
function summarize(p,phase){
 const events=p.events.filter(x=>x.phase===phase&&x.state==='playing'),frames=p.frames.filter(x=>x.phase===phase),cursors=p.cursors.filter(x=>x.phase===phase);
 const gaps=events.slice(1).filter((x,i)=>x.generation===events[i].generation).map((x,i)=>x.at-events[i].at);
 const steps=cursors.slice(1).map((x,i)=>({at:x.at,delta:x.left-cursors[i].left,gap:x.at-cursors[i].at}));
 const movements=[];for(const sample of cursors){if(!movements.length||Math.abs(sample.left-movements.at(-1).left)>.25)movements.push(sample);}
 const holds=movements.slice(1).map((x,i)=>({from:movements[i].at,to:x.at,duration:x.at-movements[i].at}));
 if(movements.length&&frames.length){const last=frames.at(-1).at-movements.at(-1).at;if(last>0)holds.push({from:movements.at(-1).at,to:frames.at(-1).at,duration:last});}
 return {phase,events:events.length,nativeGapP50:quantile(gaps,.5),nativeGapP95:quantile(gaps,.95),nativeGapMax:gaps.length?Math.max(...gaps):null,rafP95:quantile(frames.map(x=>x.gap),.95),rafMax:Math.max(0,...frames.map(x=>x.gap)),longTasks:p.longTasks.filter(x=>x.phase===phase),backsteps:steps.filter(x=>x.delta<-.00001),cursorUpdates:cursors.length,motionUpdates:movements.length,motionGapMax:Math.max(0,...holds.map(x=>x.duration)),motionHolds:holds.filter(x=>x.duration>=100),cursorGapMax:Math.max(0,...steps.map(x=>x.gap)),generations:[...new Set(events.map(x=>x.generation))],consumedFirst:events[0]?.consumedFrames,consumedLast:events.at(-1)?.consumedFrames,underrunMax:Math.max(0,...events.map(x=>x.underrunFrames))};
}
try{
 const multi=path.join(fixture.project,'timing-six-channel.wav');
 try{await fs.access(multi);}catch{await fs.writeFile(multi,wav({seconds:20,channels:6}));}
 // Reuse actor identity but give this run a private local-data copy and WebView profile.
 const localData=path.join(output,'local-data');await fs.cp(fixture.localData,localData,{recursive:true});
 const ports=new Set();while(ports.size<3)ports.add(await uniquePort());const [driver,native,debug]=[...ports];
 h=await start({'打开项目':[path.join(fixture.project,'collaboration.json'),path.join(fixture.project,'collaboration.json')],'':[[multi]]},output,exe,{localDataEnv:localData,ports:{driver,native,debug},exactOuter:true});
 h.nativeRect({width:Number(process.env.ANNOTATOR_PLAYBACK_WINDOW_WIDTH??1500),height:Number(process.env.ANNOTATOR_PLAYBACK_WINDOW_HEIGHT??940)});await wait(500);
 if(await h.evaluate('return !!document.querySelector("[aria-label=恢复上次工作]")'))await h.clickText('暂不打开');
 if(fixture.kind.startsWith('recorded'))await createIdentity(h,'播放测试');
 await h.menu('打开项目');await h.until('document.querySelector(".file-pane")','project opens',180000);
 if(fixture.kind.startsWith('recorded'))await h.select('音频显示方式','平铺');
 let doc=await snapshot(h);
 if(!doc.media.some(m=>m.displayName==='timing-six-channel.wav')){await h.clickText('导入音频');await h.until('document.querySelector(".import-progress")?.textContent.includes("导入完成")','six channel native import',180000);await h.clickText('关闭导入结果');doc=await snapshot(h);await saved(h);}
 check('representative catalog mounted',doc.media.length>=876,doc.media.length);
 if(process.argv.includes('--prepare-edits')){
  report.processing=await prepareProcessingFixture(h,[fixture.selected[0].name,'timing-six-channel.wav']);
  report.workload='nonempty mask + gain on every channel';
  report.manifest=path.join(output,'edited-manifest.json');
  await fs.writeFile(report.manifest,JSON.stringify({fixtures:[{...fixture,localData,mediaCount:doc.media.length,processing:report.processing}]},null,2));
  report.passed=true;
 }else{
 if(fixture.processing){report.processing=await verifyProcessingFixture(h,doc,fixture.processing);check('actual processed numeric mask and gain differ from original on both sources',report.processing.probes.length===2,report.processing.probes);}
 const inspector=process.env.ANNOTATOR_PLAYBACK_INSPECTOR??'作者';await h.clickText(inspector);
 check('Requested inspector tab open',await h.evaluate('return [...document.querySelectorAll("[role=tab]")].some(e=>e.textContent===arguments[0]&&e.getAttribute("aria-selected")==="true")',inspector));
 if(fixture.processing&&inspector==='作者')check('own representative regions appear in Authors',await h.evaluate('return document.querySelectorAll(".remote-list-entry").length>=2'));
 if(process.env.ANNOTATOR_PLAYBACK_CPU_PROFILE==='1')await h.evaluate('window.__profilePlaybackPolls=true');
 await h.evaluate(`return (${observe.toString()})()`);
 if(process.env.ANNOTATOR_PLAYBACK_CPU_PROFILE==='1')cpu=await profile(debug);
 const dimensions=await h.evaluate('return [innerWidth,innerHeight,...[...document.querySelectorAll(".spectrogram-surface canvas")].flatMap(c=>[c.width,c.height])]');report.dimensions=dimensions;
 for(const name of [fixture.selected[0].name,'timing-six-channel.wav']){
  await h.selectMedia(name);await wait(300);
  for(const mode of ['original','processed']){
   await setValue('select[aria-label="声音版本"]',mode);
   await setValue('input[aria-label="播放音量"]',.01);
   await h.label('停止');await h.label('播放 · 空格');const started=await waitState('playing');
   const media=doc.media.find(m=>m.id===started.mediaId);assert.equal(media?.displayName,name,'Selected source name matches actual native media (duplicate imported names are possible)');const duration=media.frameCount/media.sampleRate;
   check(`${name}/${mode} full-file intent`,started.projectId===doc.projectId&&started.mediaId===media.id&&started.firstSeconds===0&&started.endSeconds===duration&&await h.evaluate('return document.querySelector("[aria-label=循环播放]").getAttribute("aria-pressed")==="false"'),{generation:started.generation,firstSeconds:started.firstSeconds,endSeconds:started.endSeconds,expectedDuration:duration});
   const phase=`${name}/${mode}/steady`,canvasSize=await h.evaluate('return [...document.querySelectorAll(".spectrogram-surface canvas")].map(c=>[c.width,c.height])');
   await h.evaluate('window.__playbackTiming.phase=arguments[0]',phase);await wait(5000);
   assert.deepEqual(await h.evaluate('return [...document.querySelectorAll(".spectrogram-surface canvas")].map(c=>[c.width,c.height])'),canvasSize,'Stable canvas dimensions during each trial');
   await h.evaluate('window.__playbackTiming.phase="control"');
   await h.input('快捷监听增益（dB）','20'); await wait(150);
   const gained=await playback(h);check(`${name}/${mode} live gain preserves stream`,gained.generation===started.generation&&gained.state==='playing'&&gained.underrunFrames===0);
   await h.input('快捷监听增益（dB）','0');
   await h.label('暂停 · 空格');const paused=await waitState('paused');await wait(200);const held=await playback(h);check(`${name}/${mode} pause freezes consumption`,held.consumedFrames===paused.consumedFrames&&held.positionSeconds===paused.positionSeconds);
   await h.label('播放 · 空格');await waitState('playing');await wait(250);
   await setValue('input[aria-label="播放位置"]',1.5);await waitState('playing');await wait(250);
   const seek=await playback(h);check(`${name}/${mode} seek honors new generation`,seek.generation>paused.generation&&seek.positionSeconds>=1.5,seek);
   await h.label('停止');await waitState('stopped');
   const data=await h.evaluate('return window.__playbackTiming');report.trials.push({...summarize(data,phase),canvasSize});
   const trial=report.trials.at(-1),consumedSeconds=(trial.consumedLast-trial.consumedFirst)/started.deviceRate;
   trial.consumedSeconds=consumedSeconds;trial.expectedGeneration=started.generation;
   check(`${phase} meaningful continuous playback`,trial.events>=90&&consumedSeconds>=4&&trial.generations.length===1&&trial.generations[0]===started.generation,{eventCount:trial.events,consumedSeconds,expectedGeneration:started.generation,generations:trial.generations});
   if(process.env.ANNOTATOR_PLAYBACK_EXPECT_MONOTONIC==='1')check(`${phase} cursor monotonic`,report.trials.at(-1).backsteps.length===0);
   if(process.env.ANNOTATOR_PLAYBACK_MAX_GAP_MS)check(`${phase} bounded pointer and progress gaps`,trial.motionGapMax<+process.env.ANNOTATOR_PLAYBACK_MAX_GAP_MS&&trial.nativeGapMax<+process.env.ANNOTATOR_PLAYBACK_MAX_GAP_MS,{motionGapMax:trial.motionGapMax,nativeGapMax:trial.nativeGapMax});
   console.log(JSON.stringify(report.trials.at(-1)));
  }
 }
 // Repainting must yield while the same native stream keeps consuming.
 await h.selectMedia('timing-six-channel.wav');await h.label('播放 · 空格');const repaintStarted=await waitState('playing');
 await h.evaluate('window.__playbackTiming.phase="repaint-playing"');
 await h.label('timing-six-channel.wav 分析设置');await setValue('input[aria-label="显示增益"]',12);await wait(450);
 await setValue('input[aria-label="显示增益"]',0);await wait(900);await h.click('.analysis-popover header button');await wait(300);
 const repaintStatus=await playback(h);await h.evaluate('window.__playbackTiming.phase="control"');
 const repaint=summarize(await h.evaluate('return window.__playbackTiming'),'repaint-playing');report.trials.push(repaint);
 check('live display repaint preserves native audio generation and zero underruns',repaintStatus.generation===repaintStarted.generation&&repaintStatus.state==='playing'&&repaintStatus.underrunFrames===0,repaintStatus);
 check('live display repaint keeps actual cursor moving',repaint.events>=15&&repaint.backsteps.length===0&&repaint.motionGapMax<Number(process.env.ANNOTATOR_PLAYBACK_MAX_GAP_MS??150),repaint);
 await h.label('停止');
 // Isolate delayed renderer delivery from natural scheduler measurements.
 await h.selectMedia('timing-six-channel.wav');await h.label('播放 · 空格');await waitState('playing');
 await h.evaluate('window.__playbackTiming.phase="induced-stall"');await wait(300);
 await h.evaluate('const end=performance.now()+220;while(performance.now()<end){}');await wait(600);
 // Pause acknowledgements intentionally snap to native time; keep that control
 // transition out of the continuous-playing delayed-event observations.
 await h.evaluate('window.__playbackTiming.phase="control"');
 await h.label('暂停 · 空格');await waitState('paused');
 const stalled=await h.evaluate('return window.__playbackTiming');report.trials.push(summarize(stalled,'induced-stall'));
 if(process.env.ANNOTATOR_PLAYBACK_EXPECT_MONOTONIC==='1')check('delayed native delivery keeps continuous cursor monotonic',report.trials.at(-1).events>=15&&report.trials.at(-1).backsteps.length===0,report.trials.at(-1));
 // UI selection audition and short looping range; wrap jumps are intentional.
 await h.label('停止');await h.drag('.spectrogram-surface',[.12,.3],[.18,.65]);
 await h.label('循环播放');await h.label('播放 · 空格');await waitState('playing');await wait(1700);
 const loop=await playback(h);check('selection looping stays inside native range',loop.firstSeconds>0&&loop.endSeconds<20&&loop.positionSeconds>=loop.firstSeconds&&loop.positionSeconds<=loop.endSeconds,loop);
 await h.label('停止');await h.label('循环播放');
 await h.evaluate('window.__playbackTiming.phase="terminal-controls"');
 await h.selectMedia(fixture.selected[0].name);await setValue('input[aria-label="播放位置"]',8.65);
 await h.driver.wait(async()=>{const s=await playback(h);return s.state==='stopped'&&s.positionSeconds>=8.65;},10000,'seek before natural end',50);
 await h.label('播放 · 空格');const ended=await waitState('ended');
 check('native natural end drains and stops at range end',ended.presentation.drained&&ended.positionSeconds===ended.endSeconds,ended);
 await h.menu('关闭项目');await h.until('!document.querySelector(".file-pane")');
 // No runtime binding exists after close; do not send the retired collaboration nonce.
 await h.driver.wait(async()=> (await read(h,'playback_status')).mediaId===null,10000,'native owner closed',50);
 check('owner close clears stream',true);
 await h.menu('打开项目');await h.until('document.querySelector(".file-pane")','replacement runtime opens',180000);await wait(250);
 const replacement=await playback(h);check('replacement runtime has no stale stream or autoplay',replacement.mediaId===null&&replacement.state==='stopped',replacement);
 const data=await h.evaluate('return window.__playbackTiming');report.observations=data;
 check('no renderer errors',data.errors.length===0,data.errors);
 check('fixed window dimensions',JSON.stringify(dimensions.slice(0,2))===JSON.stringify(await h.evaluate('return [innerWidth,innerHeight]')));
 await h.screenshot('terminal');report.passed=true;
 }
}catch(e){report.error=e.stack;report.body=await h?.evaluate('return document.body.innerText').catch(()=>null);report.observations=await h?.evaluate('return window.__playbackTiming').catch(()=>null);await h?.screenshot('failure').catch(()=>{});process.exitCode=1;console.error(e);}
finally{await cpu?.stop().catch(e=>{report.profileError=String(e);});await h?.quit().catch(e=>{report.cleanupError=String(e);process.exitCode=1;});await fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({output,passed:report.passed,manifest:report.manifest,error:report.error}));}
