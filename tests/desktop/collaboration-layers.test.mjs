// Two independent native UI clients. IPC below is read-only assertion; all user
// mutations use real WebDriver controls and native picker queues.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { start, Key, By, wait } from './harness.mjs';
const parent=path.resolve('.test-output/nas-task5');await fs.mkdir(parent,{recursive:true});
const output=await fs.mkdtemp(path.join(parent,'two-ui-')),source=path.join(output,'source'),shared=path.join(output,'shared');
const roots={a:path.join(output,'client-a'),b:path.join(output,'client-b')};
for(const p of [source,shared,...Object.values(roots)])await fs.mkdir(p);
const audio=path.join(output,'stereo-three-seconds.wav'),rate=48000,frames=rate*3,bytes=Buffer.alloc(44+frames*4);
bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(2,22);bytes.writeUInt32LE(rate,24);bytes.writeUInt32LE(rate*4,28);bytes.writeUInt16LE(4,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(frames*4,40);
for(let n=0;n<frames;n++)for(let c=0;c<2;c++)bytes.writeInt16LE(Math.round(10000*Math.sin(2*Math.PI*(c?880:440)*n/rate)),44+n*4+c*2);
await fs.writeFile(audio,bytes);const originalHash=crypto.createHash('sha256').update(bytes).digest('hex');
const exportedJson=path.join(output,'alice.annotations.json'),exportedZip=path.join(output,'alice.audioproj.zip');
const pathsA={'新建项目 · 选择空文件夹':[source],'创建协作副本 · 选择空文件夹':[shared],'打开项目 · 选择 project.json':[path.join(shared,'collaboration.json')],'分享 · 保存到本机':[exportedJson,exportedZip],'':[[audio]]};
const pathsB={'打开项目 · 选择 project.json':[path.join(shared,'collaboration.json')]};
const report={method:'Two independently spawned native Tauri clients with distinct WebDriver/debug ports, WebView and app-local-data roots; all acceptance mutations via UI; IPC read-only',output,checks:[],originalHash};let a,b;
const check=name=>{report.checks.push(name);console.log('PASS '+name);};
const read=(h,command,args={})=>h.driver.executeAsyncScript('const done=arguments[arguments.length-1];window.__TAURI_INTERNALS__.invoke(arguments[0],arguments[1]).then(done,e=>done({error:e}));',command,args);
const status=h=>read(h,'collaboration_status');
const snapshot=async h=>{const s=await status(h);const value=await read(h,'get_project_snapshot',{projectId:s.projectId,...(s.shared?{runtimeNonce:s.runtimeNonce}:{})});assert.ok(value.document,JSON.stringify(value));return value;};
const playback=async h=>read(h,'playback_status',{runtimeNonce:(await status(h)).runtimeNonce});
const ready=h=>h.until(`document.querySelector('canvas')&&!document.querySelector('.tile-status')`);
const actor=async(h,name)=>{await h.until(`document.querySelector('.collaboration-status')?.textContent.includes(${JSON.stringify(name)})&&!document.querySelector('.collaboration-dialog')`);assert.equal((await status(h)).actor?.displayName??'访客',name);};
const form=async(h,login,name)=>{await h.until(`document.querySelector('[aria-label="协作账号名"]')`);await h.input('协作账号名',login);if(name)await h.input('协作显示名称',name);await h.input('协作密码','password123');};
const sync=async h=>{await h.menu('保存并同步','协作');await h.until(`document.querySelector('.collaboration-status')?.textContent.includes('已同步')`);};
const tab=(h,name)=>h.driver.findElement(By.xpath(`//button[@role='tab' and normalize-space(.)='${name}']`)).click();
const region=async(h,name)=>{
 await h.menu('类别管理','标注');await h.input('类别名称',name+' category');await h.clickText('添加类别');
 await h.drag('.channel-pane:first-child .annotation-overlay',[.2,.25],[.6,.7]);await h.label('标注');await h.clickText(name+' category');await h.until(`document.querySelector('.annotation-inspector')`);
 for(const [label,value]of [['开始（秒）','0.4'],['结束（秒）','1.5'],['下界（Hz）','1000'],['上界（Hz）','6000']])await h.input(label,value);
 await h.input('区域备注',name+' region');await sync(h);return(await snapshot(h)).document.annotations[0];
};
const notes=async(h,name)=>{
 await h.click('.file-heading h2');await h.until(`document.querySelector('[aria-label="音频备注"]')`);await h.input('音频备注',name+' file');
 await h.click('.file-heading .classification-control');await h.label('文件类别');await h.label(name+' category');
 await h.click('.channel-pane:nth-child(2) .channel-caption strong');await h.until(`document.querySelector('[aria-label="通道 2 备注"]')`);await h.input('通道 2 备注',name+' channel');
 await h.click('.channel-pane:nth-child(2) .channel-caption .classification-control');await h.label('通道类别');await h.label(name+' category');await sync(h);
};
const filter=async(h,name,exclude)=>{await h.menu('作者显示与同步状态…','协作');await h.driver.findElement(By.xpath(`//label[normalize-space(.)='${name}']/input`)).click();if(exclude)await h.driver.findElement(By.xpath(`//label[normalize-space(.)='${exclude}']/input`)).click();await h.clickText('关闭');};
const selectOwn=async(h,id)=>{await h.drag(`[data-annotation-id="${id}"]`,[.5,.5],[.5,.5]);await h.until(`document.querySelector('.annotation-inspector')`);};
try{
 a=await start(pathsA,roots.a,undefined,{exactOuter:true,localDataEnv:roots.a});
 await a.menu('新建项目');await a.until(`document.querySelector('.project-identity')?.textContent.includes('已保存')`);await a.clickText('导入音频');await a.until(`document.querySelector('.import-progress')?.textContent.includes('导入完成')`);await a.clickText('关闭导入结果');await ready(a);
 await a.menu('创建协作副本…');await form(a,'alice','Alice');await a.clickText('创建副本');await actor(a,'Alice');await ready(a);
 b=await start(pathsB,roots.b,undefined,{exactOuter:true,ports:{driver:4455,native:4456,debug:9245},localDataEnv:roots.b});
 await b.menu('打开项目…');await actor(b,'访客');
 await b.menu('登录…','协作');await form(b,'alice');await b.clickText('登录');
 await b.until(`document.querySelector('.collaboration-dialog [role="alert"]')`);
 assert.match(await b.evaluate(`return document.querySelector('.collaboration-dialog [role="alert"]').textContent`),/already has a writable session/);
 assert.equal((await status(b)).actor,null);assert.equal((await status(a)).actor.displayName,'Alice');
 await b.clickText('关闭');check('same-account second native UI writer is rejected while the first writer remains active');
 await b.menu('注册项目账号…','协作');await form(b,'bob','Bob');await b.clickText('注册并登录');await actor(b,'Bob');await ready(b);
 report.pids=[a.nativePid,b.nativePid];assert.notEqual(a.nativePid,b.nativePid);
 const aa=await region(a,'Alice'),bb=await region(b,'Bob');assert.deepEqual(aa.region,bb.region);assert.notEqual(aa.id,bb.id);
 await a.until(`document.querySelectorAll('[data-remote-key]').length===1`);await b.until(`document.querySelectorAll('[data-remote-key]').length===1`);
 for(const [h,name,own]of [[a,'Bob',aa.id],[b,'Alice',bb.id]]){assert.ok(await h.evaluate(`return document.querySelector('.remote-annotation').textContent.includes(arguments[0])`,name));assert.equal((await snapshot(h)).document.annotations.length,1);assert.equal((await snapshot(h)).document.annotations[0].id,own);assert.equal(await h.evaluate(`return document.querySelector('.remote-annotation [data-handle]')===null&&getComputedStyle(document.querySelector('.remote-annotation')).backgroundColor==='rgba(0, 0, 0, 0)'`),true);}
 assert.ok(await a.evaluate(`return document.querySelector('.inspector-tabs').getBoundingClientRect().height<60&&document.documentElement.scrollWidth<=innerWidth`));await a.screenshot('author-overlap');check('independent Alice/Bob native clients create exactly identical physical regions via UI and see separate foreign frames');
 await notes(a,'Alice');await notes(b,'Bob');await a.clickText('作者');await a.until(`document.querySelector('.remote-list')?.textContent.includes('Bob file')&&document.querySelector('.remote-list')?.textContent.includes('Bob channel')`);
 await a.click('.remote-list-entry');await a.until(`document.querySelector('.remote-inspector')?.textContent.includes('Bob region')`);assert.equal(await a.evaluate(`return document.querySelector('.remote-inspector').querySelectorAll('input,textarea,select').length`),0);await a.screenshot('readonly-inspector');
 const stable=(await snapshot(a)).document;await a.driver.actions().sendKeys(Key.DELETE,Key.CONTROL,'z',Key.NULL).perform();assert.deepEqual((await snapshot(a)).document,stable);
 await a.clickText('关闭只读详情');await a.label('循环播放');await a.select('声音版本','原音');const vol=await a.element('[aria-label="播放音量"]');await vol.sendKeys(Key.HOME,...Array(11).fill(Key.ARROW_RIGHT));
 await a.click('.remote-list-entry');const generation=(await playback(a)).generation;await a.clickText('播放此区域');await a.driver.wait(async()=>{const p=await playback(a);return p.generation>generation&&p.consumedFrames>4800&&p.state==='playing';},30000,'foreign playback consumes current private source frames');
 assert.equal(await a.evaluate(`return document.querySelector('[aria-label="声音版本"]').value`),'original');assert.equal((await playback(a)).underrunFrames,0);await a.screenshot('readonly-playback');await a.clickText('关闭只读详情');await a.label('停止');check('foreign list and three-level details remain read-only; keyboard cannot modify own state; regional audition uses personal source');
 const beforeFilter=(await snapshot(a)).document;await filter(a,'仅我的');assert.equal(await a.evaluate(`return document.querySelectorAll('[data-remote-key]').length`),0);assert.equal(await a.evaluate(`return document.querySelectorAll('[data-annotation-id]').length`),1);
 await filter(a,'勾选作者','Alice');assert.equal(await a.evaluate(`return document.querySelectorAll('[data-remote-key]').length`),1);assert.equal(await a.evaluate(`return document.querySelectorAll('[data-annotation-id]').length`),0);assert.deepEqual((await snapshot(a)).document.annotations,beforeFilter.annotations);await filter(a,'全部');check('all/mine/custom visibility does not modify personal annotations or identity');
 // Own overlapping active frame stays draggable despite the foreign frame.
 await selectOwn(a,aa.id);const oldStart=(await snapshot(a)).document.annotations[0].region.startSeconds;await a.drag(`[data-annotation-id="${aa.id}"]`,[.5,.5],[.55,.5]);assert.ok((await snapshot(a)).document.annotations[0].region.startSeconds>oldStart);assert.equal((await snapshot(b)).document.annotations[0].region.startSeconds,.4);await a.menu('撤销','编辑');await sync(a);
 await a.input('区域备注','Alice updated');await sync(a);await b.driver.wait(async()=>{const s=await status(b);return s.snapshot.authors.some(x=>x.identity.displayName==='Alice'&&x.layer?.payload.annotations[0]?.note==='Alice updated');},30000);
 await selectOwn(a,aa.id);await a.click('.selection-toolbar button');await a.driver.wait(async()=>{const p=await playback(a);return p.state==='playing'&&p.consumedFrames>4800;},30000);
 const generationBefore=(await playback(a)).generation,undoBefore=(await snapshot(a)).canUndo;
 const draft=await a.element('[aria-label="区域备注"]');await draft.click();await draft.sendKeys(Key.CONTROL,'a',Key.NULL,'Alice typing while Bob changes');
 await selectOwn(b,bb.id);await b.input('区域备注','Bob remote update');await sync(b);await a.driver.wait(async()=>{const s=await status(a);return s.snapshot.authors.some(x=>x.identity.displayName==='Bob'&&x.layer?.payload.annotations[0]?.note==='Bob remote update');},30000);
 assert.equal(await draft.getAttribute('value'),'Alice typing while Bob changes');assert.equal((await snapshot(a)).canUndo,undoBefore);assert.equal(await a.evaluate(`return document.querySelector('[data-annotation-id].is-selected')?.dataset.annotationId`),aa.id);assert.equal((await playback(a)).generation,generationBefore);assert.equal(await a.evaluate(`return document.querySelector('[aria-label="声音版本"]').value`),'original');await a.label('停止');check('remote update preserves own note input, selected frame, undo availability and active playback generation/source');
 // Private masks, preferences and view changes persist locally and do not alter B.
 const bPrivate=(await snapshot(b)).document;await selectOwn(a,aa.id);await a.context(`[data-annotation-id="${aa.id}"]`);await a.label('屏蔽选区');await a.until(`document.querySelector('.mask-rect')`);await a.label('显示通道 2');await sync(a);
 const aPrivate=(await snapshot(a)).document;assert.equal(aPrivate.edits.length,1);assert.deepEqual((await snapshot(b)).document.edits,bPrivate.edits);assert.deepEqual((await snapshot(b)).document.viewState,bPrivate.viewState);assert.equal((await status(b)).preferences?.volume??.75,.75);assert.equal(await b.evaluate(`return document.querySelector('[aria-label="声音版本"]').value`),'processed');assert.equal((await status(a)).preferences.volume,.11);check('private mask, channel visibility, volume and source changes on A leave B unchanged');
 // A deletion removes only A's foreign row from B, including an already-open detail.
 await b.clickText('作者');await b.click('.remote-list-entry');await b.until(`document.querySelector('.remote-inspector')?.textContent.includes('Alice typing')`);
 await a.menu('标注列表','标注');await a.driver.findElement(By.xpath('//button[contains(@class,"annotation-row") and .//small[contains(.,"区域")]]')).click();await a.until(`document.querySelector('.annotation-inspector')`);await a.clickText('删除标注');await sync(a);
 await b.until(`document.querySelector('.remote-inspector')?.textContent.includes('已不存在')`);assert.equal(await b.evaluate(`return document.querySelector('.remote-inspector').textContent.includes('播放此区域')`),false);assert.equal((await snapshot(b)).document.annotations[0].id,bb.id);assert.equal((await snapshot(a)).document.annotations.length,0);await b.clickText('关闭只读详情');
 await a.menu('撤销','编辑');await sync(a);await b.until(`document.querySelectorAll('[data-remote-key]').length===1`);assert.equal((await snapshot(a)).document.annotations[0].id,aa.id);check('own update/delete/undo never changes other author; open details reject a deleted foreign target');
 // Foreign pointer hit after excluding own frame routes to details, never writable selection.
 await filter(b,'勾选作者','Bob');await b.drag('.channel-pane:first-child .annotation-overlay',[.3,.9],[.3,.9]); // use exact rendered foreign bounds below if outside
 if(!await b.evaluate(`return !!document.querySelector('.remote-inspector')`))await b.drag('.remote-annotation',[.5,.5],[.5,.5]);
 await b.until(`document.querySelector('.remote-inspector')`);await b.clickText('关闭只读详情');await b.context('.remote-annotation');await b.until(`document.querySelector('.remote-inspector')`);await b.clickText('关闭只读详情');await filter(b,'全部');check('foreign click and right-click route to read-only details while own author is hidden');
 for(const kind of ['我的标注（不含音频）','我的项目包（含音频）']){await a.menu('导出我的标注 / 项目包…');await a.label(kind);await a.clickText('选择保存位置…');await a.until(`document.querySelector('.exchange-result')&&!document.querySelector('.exchange-progress')`);await a.clickText('关闭');}
 const json=JSON.parse(await fs.readFile(exportedJson,'utf8'));
 const zipManifest=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`Add-Type -AssemblyName System.IO.Compression.FileSystem; $taskZip=[System.IO.Compression.ZipFile]::OpenRead('${exportedZip.replaceAll("'","''")}'); try { $taskReader=New-Object System.IO.StreamReader($taskZip.GetEntry('manifest.json').Open()); try {$taskReader.ReadToEnd()} finally {$taskReader.Dispose()} } finally {$taskZip.Dispose()}`],{encoding:'utf8',windowsHide:true}));
 for(const [kind,value]of [['json',json],['zip',zipManifest]]){const text=JSON.stringify(value);assert.ok(text.includes(aa.id));assert.ok(!text.includes(bb.id));assert.ok(!text.includes('Bob category'));assert.ok(!/password123|argon2|passwordHash|runtimeNonce|local-a|client-a/.test(text));assert.ok(!text.includes(aPrivate.edits[0].id));assert.deepEqual(value.edits,[]);assert.deepEqual(value.viewState.media,{});assert.equal(value.viewState.activeMediaId,null);assert.ok(Object.values(value.playbackMix).every(m=>m.soloChannels.length===0&&m.mutedChannels.length===0));assert.ok(value.media.every(m=>!Object.hasOwn(m,'sourceRef')));report[kind+'Export']=value;}
 check('actual UI JSON and ZIP exports contain own annotations only and exclude foreign data, credentials and private masks');
 // File/channel inspection has its own author-qualified target and Locate only
 // changes the inspecting client's pane visibility.
 const beforeLocateB=(await snapshot(b)).document;await tab(a,'作者');const entries=await a.driver.findElements(By.css('.remote-list-entry'));await entries[3].click();await a.until(`document.querySelector('.remote-inspector')?.textContent.includes('Bob channel')`);await a.clickText('定位');await a.clickText('关闭只读详情');await a.until(`document.querySelectorAll('.channel-pane').length===2`);assert.deepEqual((await snapshot(b)).document.viewState,beforeLocateB.viewState);
 await (await a.driver.findElements(By.css('.remote-list-entry')))[1].click();await a.until(`document.querySelector('.remote-inspector')?.textContent.includes('Bob file')`);await a.clickText('定位');await a.clickText('关闭只读详情');await a.label('显示通道 2');await sync(a);check('foreign file/channel notes and categories inspect independently; channel Locate reveals only the current private pane');
 const aBeforeB=(await snapshot(a)).document;await selectOwn(b,bb.id);await b.context(`[data-annotation-id="${bb.id}"]`);await b.label('屏蔽选区');await b.until(`document.querySelector('.mask-rect')`);const bVolume=await b.element('[aria-label="播放音量"]');await bVolume.sendKeys(Key.HOME,...Array(22).fill(Key.ARROW_RIGHT));await b.label('显示通道 2');await sync(b);
 assert.equal((await snapshot(b)).document.edits.length,1);assert.equal((await status(b)).preferences.volume,.22);for(const key of ['edits','viewState','annotations'])assert.deepEqual((await snapshot(a)).document[key],aBeforeB[key]);assert.equal((await status(a)).preferences.volume,.11);check('B also persists a distinct private mask and volume/view without changing A');
 await sync(a);await sync(b);const savedA=(await snapshot(a)).document,savedB=(await snapshot(b)).document;
 await a.menu('关闭项目');await a.quit();a=null;
 a=await start({'打开项目 · 选择 project.json':[path.join(shared,'collaboration.json')]},roots.a,undefined,{exactOuter:true,localDataEnv:roots.a});await a.menu('打开项目…');await actor(a,'访客');await a.menu('登录…','协作');await form(a,'alice');await a.clickText('登录');await actor(a,'Alice');await ready(a);
 const restored=(await snapshot(a)).document;for(const key of ['annotations','edits','viewState','categories'])assert.deepEqual(restored[key],savedA[key]);assert.equal((await status(a)).preferences.volume,.11);assert.equal((await status(a)).preferences.source,'original');assert.deepEqual((await snapshot(b)).document.annotations,savedB.annotations);check('fresh A native process and login restore own private workspace while B remains independently active');
 await b.menu('关闭项目');await b.quit();b=null;b=await start(pathsB,roots.b,undefined,{exactOuter:true,ports:{driver:4455,native:4456,debug:9245},localDataEnv:roots.b});await b.menu('打开项目…');await actor(b,'访客');await b.menu('登录…','协作');await form(b,'bob');await b.clickText('登录');await actor(b,'Bob');await ready(b);
 const restoredB=(await snapshot(b)).document;for(const key of ['annotations','edits','viewState','categories'])assert.deepEqual(restoredB[key],savedB[key]);assert.equal((await status(b)).preferences.volume,.22);assert.equal((await status(b)).preferences.source,'processed');check('fresh B native process and login restore B personal settings independently of A');
 const manifest=JSON.parse(await fs.readFile(path.join(shared,'collaboration.json')));assert.equal(crypto.createHash('sha256').update(await fs.readFile(path.join(shared,manifest.media[0].sourceRef))).digest('hex'),originalHash);assert.equal(crypto.createHash('sha256').update(await fs.readFile(audio)).digest('hex'),originalHash);check('source and shared original WAV SHA256 remain exact');
 // Simulate loss of the shared entry only inside this owned fixture. All edits
 // and synchronization still use the real UI; restore even on assertion failure.
 const manifestPath=path.join(shared,'collaboration.json'),offlinePath=path.join(shared,'owned-offline.json');
 await fs.rename(manifestPath,offlinePath);
 try {
  await a.menu('标注列表','标注');await a.driver.findElement(By.xpath('//button[contains(@class,"annotation-row") and .//small[contains(.,"区域")]]')).click();
  await a.until(`document.querySelector('.annotation-inspector')`);await a.input('区域备注','Alice durable offline note');await a.menu('保存并同步','协作');
  await a.driver.wait(async()=>{const s=await status(a);return s.pending&&!s.busy&&!!s.error;},30000);
  assert.ok(await a.evaluate(`return document.querySelector('.collaboration-status').textContent.includes('同步异常')`));
  assert.equal((await snapshot(a)).document.annotations[0].note,'Alice durable offline note');
  assert.equal((await snapshot(b)).document.annotations[0].note,restoredB.annotations[0].note);
  await a.screenshot('offline-pending');
 }finally{await fs.rename(offlinePath,manifestPath);}
 await sync(a);await b.driver.wait(async()=>{const s=await status(b);return s.snapshot.authors.some(x=>x.identity.displayName==='Alice'&&x.layer?.payload.annotations[0]?.note==='Alice durable offline note');},30000);
 check('real UI local save remains pending during owned manifest disconnect and publishes after reconnect without changing B');
 // Instrument only reads/draw calls; unchanged foreign polling must not redraw
 // spectral pixels or reset private playback/analysis authority.
 await ready(a);await wait(250);
 await a.evaluate(`window.__refreshMeasure={draws:0,analysis:0,playback:0,refreshMs:[],calls:[]};const m=window.__refreshMeasure,draw=CanvasRenderingContext2D.prototype.putImageData;CanvasRenderingContext2D.prototype.putImageData=function(...args){m.draws++;return draw.apply(this,args)};const fetch=window.fetch;window.fetch=function(resource,...args){const command=decodeURIComponent(String(resource).split('/').at(-1));m.calls.push(command);if(['request_tile','register_analysis_view'].includes(command))m.analysis++;if(['playback_configure','playback_control'].includes(command))m.playback++;const started=performance.now(),result=fetch.call(this,resource,...args);return ['collaboration_refresh','collaboration_sync'].includes(command)?result.then(value=>{m.refreshMs.push(performance.now()-started);return value}):result};`);
 const refreshBefore=(await snapshot(a)).document,playbackBefore=await playback(a),refreshStart=performance.now();
 for(let i=0;i<5;i++){await a.menu('保存并同步','协作');await wait(100);}
 await wait(2200);report.twoAuthorRefresh={elapsedMs:performance.now()-refreshStart,iterations:5,...await a.evaluate('return window.__refreshMeasure')};
 assert.equal(report.twoAuthorRefresh.draws,0);assert.equal(report.twoAuthorRefresh.analysis,0);assert.equal(report.twoAuthorRefresh.playback,0);
 assert.ok(report.twoAuthorRefresh.refreshMs.length>=5);
 assert.ok(report.twoAuthorRefresh.calls.includes('collaboration_status'),'read-only probe verifies live IPC observation');
 assert.deepEqual((await snapshot(a)).document,refreshBefore);assert.equal((await playback(a)).generation,playbackBefore.generation);
 check('five unchanged two-author manual refreshes plus polling preserve private document/playback with zero spectral repaint or analysis requests');
 await a.menu('关闭项目');await b.menu('关闭项目');report.passed=true;
}catch(error){report.error=error.stack;console.error(error);await a?.screenshot('failure-a').catch(()=>{});await b?.screenshot('failure-b').catch(()=>{});process.exitCode=1;}
finally{await b?.quit().catch(e=>{report.teardownB=String(e);process.exitCode=1;});await a?.quit().catch(e=>{report.teardownA=String(e);process.exitCode=1;});await fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
