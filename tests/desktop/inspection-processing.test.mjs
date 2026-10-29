import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { start, Key, wait } from './harness.mjs';
import * as w from './workspace-helpers.mjs';
import { observeInspection, inspectionStatus, inspectionTile } from './inspection-helpers.mjs';
import { coordinates } from '../../src/features/spectrogram/coordinates.ts';
const root=path.resolve(process.env.ANNOTATOR_SUITE_OUTPUT??'.test-output/collaborative-workspace/task10/processing');await fs.mkdir(root,{recursive:true});
const output=await fs.mkdtemp(path.join(root,'desktop-')),project=path.join(output,'project');await fs.mkdir(project);
const source=path.join(output,'tones.wav');await fs.writeFile(source,w.wav({seconds:8,channels:1}));
const report={output,checks:[],method:'Actual owned Windows client; UI private edits and inspection controls; read-only native preview tile/status assertions; synthetic tone peaks, no acoustic loopback claim.'};let h;
const check=(name,details={})=>{report.checks.push({name,...details});console.log('PASS',name);};
const plot='.annotation-overlay';
try{
 h=await start({'新建项目 · 选择空文件夹':[project],'':[[source]]},output,undefined,{ports:{driver:4525,native:4526,debug:9325}});
 await w.newProject(h);await w.importDirect(h,1);await h.selectMedia('tones.wav');
 await h.label('监听增益');await (await h.element('[aria-label=输出音量]')).sendKeys(Key.HOME);await w.escape(h);
 const doc=await w.snapshot(h),media=doc.media[0],view=doc.viewState.media[media.id]??{startSeconds:0,endSeconds:8,lowHz:0,highHz:24000,spectrumKind:'stft',frequencyMix:.65},c=coordinates(view,24000,1,1);
 await h.drag(plot,[.2,c.hzToY(6500)],[.7,c.hzToY(5500)]);await h.driver.actions().sendKeys(Key.DELETE).perform();await w.waitMasked(h);
 await h.drag(plot,[.2,c.hzToY(2100)],[.7,c.hzToY(900)]);await h.context(plot,[.4,c.hzToY(1500)]);await h.label('区域增益…');await h.input('区域增益（dB）','-6');await h.clickText('应用增益');await w.expectDocument(h,d=>d.edits.length===2,'private gain and mask accepted');
 await w.addCategory(h,'处理试听');await w.toggleLabels(h,'.file-heading .classification-control','文件类别',['处理试听']);await w.saved(h);const before=await h.snapshot(doc.projectId),prefs=(await w.status(h)).preferences,audio=path.join(project,media.sourceRef),audioHash=w.hash(await fs.readFile(audio));
 await observeInspection(h);await h.clickText('作者');const actor=(await w.status(h)).actor.authorId;await h.click(`[data-remote-author="${actor}"] .remote-list-entry`);await h.until("document.querySelector('.inspection-spectrum canvas')&&!document.querySelector('.inspection-viewer .tile-status')");
 const originalPixels=await h.evaluate("const c=document.querySelector('.inspection-spectrum canvas');return Array.from(c.getContext('2d').getImageData(0,0,c.width,c.height).data).reduce((n,v)=>Math.imul(n^v,16777619)>>>0,2166136261)");const original=await inspectionTile(h,'original');
 assert.equal(await h.evaluate("return !!document.querySelector('[aria-label=查看试听来源]')"),false);
 const bin=Math.round(1500*original.header.request.settings.fftSize/48000),maskBin=Math.round(6000*original.header.request.settings.fftSize/48000);
 assert.ok(Math.abs(original.values[bin]-original.values[maskBin])<.5,'original review retains equal-amplitude tones despite private gain/mask');check('review shows original spectrum without applying private gain or mask',{originalPixels,tones:[original.values[bin],original.values[maskBin]]});
 await h.label('播放音频');await h.driver.wait(async()=>{const p=await inspectionStatus(h);return p.state==='playing'&&p.consumedFrames>4800;},30000);assert.equal((await inspectionStatus(h)).underrunFrames,0);await h.click('.inspection-transport [aria-label=停止]');
 await h.label('播放音频');await h.driver.wait(async()=>(await inspectionStatus(h)).state==='playing',30000);await h.click('.inspection-settings summary');await h.input('查看窗长','1024');await h.input('查看步长','256');await h.clickText('应用分析参数');await h.until("document.querySelector('.inspection-spectrum canvas')&&!document.querySelector('.inspection-viewer .tile-status')");assert.notEqual((await inspectionStatus(h)).state,'playing');await h.label('关闭查看');assert.notEqual((await w.playback(h)).state,'playing');check('original review consumes without underrun; analysis change/close stop preview and do not resume main');
 for(let i=0;i<4;i++){await h.click(`[data-remote-author="${actor}"] .remote-list-entry`);await h.until("document.querySelector('.inspection-viewer')");await h.label('关闭查看');}
 await h.click(`[data-remote-author="${actor}"] .remote-list-entry`);await h.until("document.querySelector('.inspection-spectrum canvas')&&!document.querySelector('.inspection-viewer .tile-status')");await h.label('播放音频');await h.driver.wait(async()=>(await inspectionStatus(h)).state==='playing',30000);
 const resolved=await fs.realpath(audio),owned=await fs.realpath(project);assert.ok(resolved.startsWith(owned+path.sep));const offline=audio+'.owned-offline';assert.equal(path.dirname(offline),path.dirname(audio));await fs.rename(audio,offline);
 try{await h.until("document.querySelector('.inspection-viewer [role=alert]')",'actual missing owned source detected',15000);assert.equal(await h.evaluate("return document.querySelector('.inspection-transport').textContent.includes('播放中')"),false);await h.screenshot('source-unavailable');}finally{await fs.rename(offline,audio);}
 await h.clickText('重试打开');await h.until("document.querySelector('.inspection-spectrum canvas')&&!document.querySelector('.inspection-viewer [role=alert]')");await h.label('关闭查看');assert.deepEqual(await h.snapshot(doc.projectId),before);assert.deepEqual((await w.status(h)).preferences,prefs);assert.equal(w.hash(await fs.readFile(audio)),audioHash);check('rapid open/close and actual source unavailability release stale audition; retry preserves main history/preferences/edits/audio');report.passed=true;
}catch(e){report.error=e.stack;report.body=await h?.evaluate('return document.body.innerText').catch(()=>null);await h?.screenshot('failure').catch(()=>{});console.error(e);process.exitCode=1;}finally{await h?.quit();await fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
