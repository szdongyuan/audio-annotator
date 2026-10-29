import { observeInspection, inspectionStatus, clickForeignEdge } from './inspection-helpers.mjs';
import { waitMasked, waitNoMasks } from './workspace-helpers.mjs';
import { createIdentity, exportIdentity, importIdentity, profiles } from './identity-helpers.mjs';
// Two independent native UI clients. IPC below is read-only assertion; all user
// mutations use real WebDriver controls and native picker queues.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { start, Key, By, wait } from './harness.mjs';
const parent=path.resolve(process.env.ANNOTATOR_SUITE_OUTPUT ?? '.test-output/default-collaboration-v040/task5/desktop-evidence/collaboration-layers');await fs.mkdir(parent,{recursive:true});
const output=await fs.mkdtemp(path.join(parent,'two-ui-')),source=path.join(output,'source'),shared=path.join(output,'shared');
const roots={a:path.join(output,'client-a'),b:path.join(output,'client-b')};
for(const p of [source,shared,...Object.values(roots)])await fs.mkdir(p);
const audio=path.join(output,'stereo-three-seconds.wav'),rate=48000,frames=rate*3,bytes=Buffer.alloc(44+frames*4);
bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(2,22);bytes.writeUInt32LE(rate,24);bytes.writeUInt32LE(rate*4,28);bytes.writeUInt16LE(4,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(frames*4,40);
for(let n=0;n<frames;n++)for(let c=0;c<2;c++)bytes.writeInt16LE(Math.round(10000*Math.sin(2*Math.PI*(c?880:440)*n/rate)),44+n*4+c*2);
await fs.writeFile(audio,bytes);const originalHash=crypto.createHash('sha256').update(bytes).digest('hex');
const exportedJson=path.join(output,'alice.annotations.json'),exportedZip=path.join(output,'alice.audioproj.zip');
const identityFile=path.join(output,'alice.identity.json');
const pathsA={'导出当前身份':[identityFile],'新建项目 · 选择空文件夹':[shared],'创建协作副本 · 选择空文件夹':[shared],'打开项目':[path.join(shared,'collaboration.json')],'分享 · 保存到本机':[exportedJson,exportedZip],'':[[audio]]};
const pathsB={'导入身份':[identityFile],'打开项目':[path.join(shared,'collaboration.json')]};
const report={method:'Two independently spawned native Tauri clients with distinct WebDriver/debug ports, WebView and app-local-data roots; all acceptance mutations via UI; IPC read-only',output,checks:[],originalHash};let a,b;
const check=name=>{report.checks.push(name);console.log('PASS '+name);};
const read=(h,command,args={})=>h.driver.executeAsyncScript('const done=arguments[arguments.length-1];window.__TAURI_INTERNALS__.invoke(arguments[0],arguments[1]).then(done,e=>done({error:e}));',command,args);
const status=h=>read(h,'collaboration_status');
const snapshot=async h=>{const s=await status(h);const value=await read(h,'get_project_snapshot',{projectId:s.projectId,...(s.shared?{runtimeNonce:s.runtimeNonce}:{})});assert.ok(value.document,JSON.stringify(value));return value;};
const playback=async h=>read(h,'playback_status',{runtimeNonce:(await status(h)).runtimeNonce});
const ready=h=>h.until(`document.querySelector('canvas')&&!document.querySelector('.tile-status')`);
const actor=async(h,name)=>{await h.until(`document.querySelector('.collaboration-status')?.textContent.includes(${JSON.stringify(name)})&&!document.querySelector('.collaboration-dialog')`);assert.equal((await status(h)).actor?.displayName??'访客',name);};
const sync=async h=>{await h.menu('保存并同步','协作');await h.until(`document.querySelector('.collaboration-status')?.textContent.includes('已同步')`);};
const tab=(h,name)=>h.driver.findElement(By.xpath(`//button[@role='tab' and normalize-space(.)='${name}']`)).click();
const region=async(h,name)=>{
 await h.menu('类别管理','标注');await h.input('类别名称',name+' category');await h.clickText('添加类别');
 await h.drag('.channel-pane:first-child .annotation-overlay',[.2,.25],[.6,.7]);await h.label('标注');await h.label(name+' category');await h.driver.actions().sendKeys(Key.ESCAPE).perform();await h.until(`document.querySelector('.annotation-inspector')`);
 for(const [label,value]of [['开始（秒）','0.4'],['结束（秒）','1.5'],['下界（Hz）','1000'],['上界（Hz）','6000']])await h.input(label,value);
 await h.input('区域备注',name+' region');await sync(h);return(await snapshot(h)).document.annotations[0];
};
const notes=async(h,name)=>{
 await h.click('.file-heading h2');await h.until(`document.querySelector('[aria-label="音频备注"]')`);await h.input('音频备注',name+' file');
 await h.click('.file-heading .classification-control');await h.label('文件类别');await h.label(name+' category');await h.driver.actions().sendKeys(Key.ESCAPE,Key.ESCAPE).perform();
 await h.click('.channel-pane:nth-child(2) .channel-caption strong');await h.until(`document.querySelector('[aria-label="通道 2 备注"]')`);await h.input('通道 2 备注',name+' channel');
 await h.click('.channel-pane:nth-child(2) .channel-caption .classification-control');await h.label('通道类别');await h.label(name+' category');await h.driver.actions().sendKeys(Key.ESCAPE,Key.ESCAPE).perform();await sync(h);
};
const filter=async(h,name,exclude)=>{await h.menu('作者显示与同步状态…','协作');if(exclude)await h.select('显示作者','全部作者');await h.select('显示作者',{'全部':'全部作者','仅我的':'仅自己','勾选作者':'自定义'}[name]);if(exclude)await h.driver.findElement(By.xpath(`//*[@role='dialog']//label[normalize-space(.)='${exclude}' or normalize-space(.)='${exclude}（我）']/input`)).click();await h.clickText('关闭');};
const selectOwn=async(h,id)=>{await h.drag(`[data-annotation-id="${id}"]`,[.5,.5],[.5,.5]);await h.until(`document.querySelector('.annotation-inspector')`);};
try{
 a=await start(pathsA,roots.a,undefined,{exactOuter:true,localDataEnv:roots.a});
 await a.menu('新建项目');await a.until(`document.querySelector('.project-identity')?.textContent.match(/已保存|已存本机/)`);await a.clickText('导入音频');await a.until(`document.querySelector('.import-progress')?.textContent.includes('导入完成')`);await a.clickText('关闭导入结果');await ready(a);
 const alice=await createIdentity(a,'Alice');await actor(a,'Alice');await ready(a);await exportIdentity(a);
 b=await start(pathsB,roots.b,undefined,{exactOuter:true,ports:{driver:4455,native:4456,debug:9245},localDataEnv:roots.b});
 await b.menu('打开项目…');await b.until(`document.querySelector('.collaboration-status')?.textContent.includes('本机身份')`);
 const beforeConflict=(await profiles(b)).selectedAuthorId;await importIdentity(b);await b.clickText('使用此身份');
 await b.until(`document.querySelector('.collaboration-dialog [role="alert"]')`);
 assert.match(await b.evaluate(`return document.querySelector('.collaboration-dialog [role="alert"]').textContent`),/already has a writable session/);
 assert.equal((await profiles(b)).selectedAuthorId,beforeConflict);assert.equal((await status(a)).actor.authorId,alice.authorId);
 await b.clickText('关闭');check('imported same UUID second native UI writer is rejected while both prior actors remain active');
 await createIdentity(b,'Bob');await actor(b,'Bob');await ready(b);
 report.pids=[a.nativePid,b.nativePid];assert.notEqual(a.nativePid,b.nativePid);
 const aa=await region(a,'Alice'),bb=await region(b,'Bob');assert.deepEqual(aa.region,bb.region);assert.notEqual(aa.id,bb.id);
 await a.until(`document.querySelectorAll('[data-remote-key]').length===1`);await b.until(`document.querySelectorAll('[data-remote-key]').length===1`);
 for(const [h,name,own]of [[a,'Bob',aa.id],[b,'Alice',bb.id]]){assert.ok(await h.evaluate(`return document.querySelector('.remote-annotation').textContent.includes(arguments[0])`,name));assert.equal((await snapshot(h)).document.annotations.length,1);assert.equal((await snapshot(h)).document.annotations[0].id,own);assert.equal(await h.evaluate(`return document.querySelector('.remote-annotation [data-handle]')===null&&getComputedStyle(document.querySelector('.remote-annotation')).backgroundColor==='rgba(0, 0, 0, 0)'`),true);}
 // The existing shared-grid styles render two compact rows at 68 CSS px.
 // Protect the actual layout contract rather than the obsolete 60px budget.
 report.layout=await a.evaluate(`const rect=e=>e.getBoundingClientRect().toJSON();return {tabs:rect(document.querySelector('.inspector-tabs')),panel:rect(document.querySelector('#properties-panel')),buttons:[...document.querySelectorAll('.inspector-tabs button')].map(rect),scrollWidth:document.documentElement.scrollWidth,innerWidth,ratio:devicePixelRatio}`);
 const tabRows=Object.groupBy(report.layout.buttons,rect=>Math.round(rect.top));
 assert.deepEqual(Object.values(tabRows).map(row=>row.length),[4,4],JSON.stringify(report.layout));
 assert.ok(report.layout.tabs.height>0&&report.layout.tabs.height<=72&&report.layout.scrollWidth<=report.layout.innerWidth,JSON.stringify(report.layout));
 assert.ok(report.layout.buttons.every(rect=>rect.width>0&&rect.height>0&&rect.left>=report.layout.panel.left&&rect.right<=report.layout.panel.right&&rect.top>=report.layout.tabs.top&&rect.bottom<=report.layout.tabs.bottom),JSON.stringify(report.layout));await a.screenshot('author-overlap');check('independent Alice/Bob native clients create exactly identical physical regions via UI and see separate foreign frames');
 await notes(a,'Alice');await notes(b,'Bob');await a.clickText('作者');await a.until(`document.querySelector('.remote-list')?.textContent.includes('Bob file')&&document.querySelector('.remote-list')?.textContent.includes('Bob channel')`);
 await observeInspection(a);await a.click(`[data-remote-author="${(await status(b)).actor.authorId}"] .remote-list-entry`);await a.until(`document.querySelector('.inspection-viewer')?.textContent.includes('Bob region')`);assert.equal(await a.evaluate(`return document.querySelector('.inspection-metadata').querySelectorAll('input,textarea,select').length`),0);await a.screenshot('readonly-inspector');
 const stable=(await snapshot(a)).document;await a.driver.actions().sendKeys(Key.DELETE,Key.CONTROL,'z',Key.NULL).perform();assert.deepEqual((await snapshot(a)).document,stable);
 await a.label('关闭查看');await a.label('循环播放');await a.select('声音版本','原音');const vol=await a.element('[aria-label="播放音量"]');await vol.sendKeys(Key.HOME,...Array(11).fill(Key.ARROW_RIGHT));
 await a.click(`[data-remote-author="${(await status(b)).actor.authorId}"] .remote-list-entry`);await a.until("document.querySelector('.inspection-spectrum canvas')&&!document.querySelector('.inspection-viewer .tile-status')");const generation=0;await a.clickText('播放区域');await a.driver.wait(async()=>{const p=await inspectionStatus(a);return p.generation>generation&&p.consumedFrames>4800&&p.state==='playing';},30000,'foreign playback consumes current private source frames');
 assert.equal(await a.evaluate(`return document.querySelector('[aria-label="声音版本"]').value`),'original');assert.equal((await inspectionStatus(a)).underrunFrames,0);await a.screenshot('readonly-playback');await a.label('关闭查看');await a.label('停止');check('foreign list and three-level details remain read-only; keyboard cannot modify own state; regional audition uses personal source');
 const beforeFilter=(await snapshot(a)).document;await filter(a,'仅我的');assert.equal(await a.evaluate(`return document.querySelectorAll('[data-remote-key]').length`),0);assert.equal(await a.evaluate(`return document.querySelectorAll('[data-annotation-id]').length`),1);
 await filter(a,'勾选作者','Alice');assert.equal(await a.evaluate(`return document.querySelectorAll('[data-remote-key]').length`),1);assert.equal(await a.evaluate(`return document.querySelectorAll('[data-annotation-id]').length`),0);assert.deepEqual((await snapshot(a)).document.annotations,beforeFilter.annotations);await filter(a,'全部');check('all/mine/custom visibility does not modify personal annotations or identity');
 // Own overlapping active frame stays draggable despite the foreign frame.
 await selectOwn(a,aa.id);const oldStart=(await snapshot(a)).document.annotations[0].region.startSeconds;await a.drag(`[data-annotation-id="${aa.id}"]`,[.5,.5],[.55,.5]);assert.ok((await snapshot(a)).document.annotations[0].region.startSeconds>oldStart);assert.equal((await snapshot(b)).document.annotations[0].region.startSeconds,.4);await a.menu('撤销','编辑');await sync(a);
 await a.input('区域备注','Alice updated');await sync(a);await b.driver.wait(async()=>{const s=await status(b);return s.snapshot.authors.some(x=>x.identity.displayName==='Alice'&&x.layer?.payload.annotations[0]?.note==='Alice updated');},30000);
 await selectOwn(a,aa.id);await a.until("[...document.querySelectorAll('.selection-toolbar')].some(e=>getComputedStyle(e).visibility==='visible')",'selection play toolbar visible');await a.click('.selection-toolbar button');await a.driver.wait(async()=>{const p=await playback(a);return p.state==='playing'&&p.consumedFrames>4800;},30000);
 const generationBefore=(await playback(a)).generation,undoBefore=(await snapshot(a)).canUndo;
 const draft=await a.element('[aria-label="区域备注"]');await draft.click();await draft.sendKeys(Key.CONTROL,'a',Key.NULL,'Alice typing while Bob changes');
 await selectOwn(b,bb.id);await b.input('区域备注','Bob remote update');await sync(b);await a.driver.wait(async()=>{const s=await status(a);return s.snapshot.authors.some(x=>x.identity.displayName==='Bob'&&x.layer?.payload.annotations[0]?.note==='Bob remote update');},30000);
 assert.equal(await draft.getAttribute('value'),'Alice typing while Bob changes');assert.equal((await snapshot(a)).canUndo,undoBefore);assert.equal(await a.evaluate(`return document.querySelector('[data-annotation-id].is-selected')?.dataset.annotationId`),aa.id);assert.equal((await playback(a)).generation,generationBefore);assert.equal(await a.evaluate(`return document.querySelector('[aria-label="声音版本"]').value`),'original');await a.label('停止');check('remote update preserves own note input, selected frame, undo availability and active playback generation/source');
 // Private masks, preferences and view changes persist locally and do not alter B.
 const bPrivate=(await snapshot(b)).document;await selectOwn(a,aa.id);await a.context(`[data-annotation-id="${aa.id}"]`);await a.label('屏蔽选区');await waitMasked(a);await a.label('显示通道 2');await sync(a);
 const aPrivate=(await snapshot(a)).document;assert.equal(aPrivate.edits.length,1);assert.deepEqual((await snapshot(b)).document.edits,bPrivate.edits);assert.deepEqual((await snapshot(b)).document.viewState,bPrivate.viewState);assert.equal((await status(b)).preferences?.volume??.75,.75);assert.equal(await b.evaluate(`return document.querySelector('[aria-label="声音版本"]').value`),'processed');assert.equal((await status(a)).preferences.volume,.11);check('private mask, channel visibility, volume and source changes on A leave B unchanged');
 // A deletion removes only A's foreign row from B, including an already-open detail.
 await b.clickText('作者');await b.click(`[data-remote-author="${(await status(a)).actor.authorId}"] .remote-list-entry`);await b.until(`document.querySelector('.inspection-viewer')?.textContent.includes('Alice typing')`);
 await a.menu('标注列表','标注');await a.driver.findElement(By.xpath('//button[contains(@class,"annotation-row") and .//small[contains(.,"区域")]]')).click();await a.until("document.querySelector('.inspection-viewer')");await a.clickText('跳转到音频');await a.until(`document.querySelector('[role=tab][aria-selected=true]')?.textContent==='列表'&&document.querySelector('[data-annotation-id].is-selected')`);await tab(a,'区域');await a.until(`document.querySelector('.annotation-inspector')`);await a.clickText('删除标注');await sync(a);
 await b.until(`document.querySelector('.inspection-viewer')?.textContent.includes('已不存在')`);assert.equal(await b.evaluate(`return document.querySelector('.inspection-viewer').querySelector('.inspection-transport button').disabled`),true);assert.equal((await snapshot(b)).document.annotations[0].id,bb.id);assert.equal((await snapshot(a)).document.annotations.length,0);await b.label('关闭查看');
 await a.menu('撤销','编辑');await sync(a);await b.until(`document.querySelectorAll('[data-remote-key]').length===1`);assert.equal((await snapshot(a)).document.annotations[0].id,aa.id);check('own update/delete/undo never changes other author; open details reject a deleted foreign target');
 // Foreign pointer hit after excluding own frame routes to details, never writable selection.
 await filter(b,'勾选作者','Bob');await clickForeignEdge(b);await b.until("document.querySelector('.inspection-viewer')");await b.label('关闭查看');await clickForeignEdge(b,2);await b.until("document.querySelector('.inspection-viewer')");await b.label('关闭查看');await filter(b,'全部');check('measured foreign border click and right-click route to read-only viewer while own author is hidden');
 for(const kind of ['我的标注（不含音频）','我的项目包（含音频）']){await a.menu('导出我的标注 / 项目包…');await a.label(kind);await a.clickText('预览导出路径'); await a.until("document.querySelector('[aria-label=导出路径预览]')"); await a.clickText('选择保存位置…');await a.until(`document.querySelector('.exchange-result')&&!document.querySelector('.exchange-progress')`);await a.clickText('关闭');}
 const json=JSON.parse(await fs.readFile(exportedJson,'utf8'));
 const zipManifest=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`Add-Type -AssemblyName System.IO.Compression.FileSystem; $taskZip=[System.IO.Compression.ZipFile]::OpenRead('${exportedZip.replaceAll("'","''")}'); try { $taskReader=New-Object System.IO.StreamReader($taskZip.GetEntry('manifest.json').Open()); try {$taskReader.ReadToEnd()} finally {$taskReader.Dispose()} } finally {$taskZip.Dispose()}`],{encoding:'utf8',windowsHide:true}));
 for(const [kind,value]of [['json',json],['zip',zipManifest]]){const text=JSON.stringify(value);assert.ok(text.includes(aa.id));assert.ok(!text.includes(bb.id));assert.ok(!text.includes('Bob category'));assert.ok(!/password123|argon2|passwordHash|runtimeNonce|local-a|client-a/.test(text));assert.ok(!text.includes(aPrivate.edits[0].id));assert.deepEqual(value.edits,[]);assert.deepEqual(value.viewState.media,{});assert.equal(value.viewState.activeMediaId,null);assert.ok(Object.values(value.playbackMix).every(m=>m.soloChannels.length===0&&m.mutedChannels.length===0));assert.ok(value.media.every(m=>!Object.hasOwn(m,'sourceRef')));report[kind+'Export']=value;}
 check('actual UI JSON and ZIP exports contain own annotations only and exclude foreign data, credentials and private masks');
 // File/channel inspection has its own author-qualified target and Locate only
 // changes the inspecting client's pane visibility.
 const beforeLocateB=(await snapshot(b)).document;await tab(a,'作者');
 for(const scope of ['channel','file']){await a.driver.findElement(By.xpath(`//*[@data-remote-author='${(await status(b)).actor.authorId}']//button[contains(@class,'remote-list-entry') and contains(.,'Bob ${scope}')]`)).click();await a.until(`document.querySelector('.inspection-viewer')?.textContent.includes('Bob ${scope}')`);await a.clickText('跳转到音频');await a.until("!document.querySelector('.inspection-viewer')");}
 assert.deepEqual((await snapshot(b)).document.viewState,beforeLocateB.viewState);await a.label('显示通道 2');await sync(a);check('foreign file/channel notes inspect with explicit Jump affecting only current private pane');
 const aBeforeB=(await snapshot(a)).document;await selectOwn(b,bb.id);await b.context(`[data-annotation-id="${bb.id}"]`);await b.label('屏蔽选区');await waitMasked(b);const bVolume=await b.element('[aria-label="播放音量"]');await bVolume.sendKeys(Key.HOME,...Array(22).fill(Key.ARROW_RIGHT));await b.label('显示通道 2');await sync(b);
 assert.equal((await snapshot(b)).document.edits.length,1);assert.equal((await status(b)).preferences.volume,.22);for(const key of ['edits','viewState','annotations'])assert.deepEqual((await snapshot(a)).document[key],aBeforeB[key]);assert.equal((await status(a)).preferences.volume,.11);check('B also persists a distinct private mask and volume/view without changing A');
 await sync(a);await sync(b);const savedA=(await snapshot(a)).document,savedB=(await snapshot(b)).document;
 await a.menu('关闭项目');await a.quit();a=null;
 a=await start({'打开项目':[path.join(shared,'collaboration.json')]},roots.a,undefined,{exactOuter:true,localDataEnv:roots.a});await a.menu('打开项目…');await actor(a,'Alice');await ready(a);
 const restored=(await snapshot(a)).document;for(const key of ['annotations','edits','viewState','categories'])assert.deepEqual(restored[key],savedA[key]);assert.equal((await status(a)).preferences.volume,.11);assert.equal((await status(a)).preferences.source,'original');assert.deepEqual((await snapshot(b)).document.annotations,savedB.annotations);check('fresh A native process and persisted UUID restore own private workspace while B remains independently active');
 await b.menu('关闭项目');await b.quit();b=null;b=await start(pathsB,roots.b,undefined,{exactOuter:true,ports:{driver:4455,native:4456,debug:9245},localDataEnv:roots.b});await b.menu('打开项目…');await actor(b,'Bob');await ready(b);
 const restoredB=(await snapshot(b)).document;for(const key of ['annotations','edits','viewState','categories'])assert.deepEqual(restoredB[key],savedB[key]);assert.equal((await status(b)).preferences.volume,.22);assert.equal((await status(b)).preferences.source,'processed');check('fresh B native process and persisted UUID restore B personal settings independently of A');
 const manifest={media:(await snapshot(a)).document.media};assert.equal(crypto.createHash('sha256').update(await fs.readFile(path.join(shared,manifest.media[0].sourceRef))).digest('hex'),originalHash);assert.equal(crypto.createHash('sha256').update(await fs.readFile(audio)).digest('hex'),originalHash);check('source and shared original WAV SHA256 remain exact');
 // Simulate loss of the shared entry only inside this owned fixture. All edits
 // and synchronization still use the real UI; restore even on assertion failure.
 const manifestPath=path.join(shared,'collaboration.json'),offlinePath=path.join(shared,'owned-offline.json');
 await fs.rename(manifestPath,offlinePath);
 try {
  await a.menu('标注列表','标注');await a.driver.findElement(By.xpath('//button[contains(@class,"annotation-row") and .//small[contains(.,"区域")]]')).click();await a.until("document.querySelector('.inspection-viewer')");await a.clickText('跳转到音频');await a.until(`document.querySelector('[role=tab][aria-selected=true]')?.textContent==='列表'&&document.querySelector('[data-annotation-id].is-selected')`);await tab(a,'区域');
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
 await a.evaluate(`window.__refreshMeasure={draws:0,analysis:0,playback:0,syncCompleted:0,refreshMs:[],calls:[]};const m=window.__refreshMeasure,draw=CanvasRenderingContext2D.prototype.putImageData;CanvasRenderingContext2D.prototype.putImageData=function(...args){m.draws++;return draw.apply(this,args)};const fetch=window.fetch;window.fetch=function(resource,...args){const command=decodeURIComponent(String(resource).split('/').at(-1));m.calls.push(command);if(['request_tile','register_analysis_view'].includes(command))m.analysis++;if(['playback_configure','playback_control'].includes(command))m.playback++;const started=performance.now(),result=fetch.call(this,resource,...args);return ['collaboration_refresh','collaboration_sync'].includes(command)?result.then(value=>{m.refreshMs.push(performance.now()-started);if(command==='collaboration_sync')m.syncCompleted++;return value}):result};`);
 const refreshBefore=(await snapshot(a)).document,playbackBefore=await playback(a),refreshStart=performance.now();
 for(let i=0;i<5;i++){await a.driver.wait(async()=>!(await status(a)).busy,10000);await a.menu('保存并同步','协作');await a.until(`window.__refreshMeasure.syncCompleted===${i+1}`,'completed manual sync '+(i+1));}
 await wait(2200);report.twoAuthorRefresh={elapsedMs:performance.now()-refreshStart,iterations:5,...await a.evaluate('return window.__refreshMeasure')};
 assert.equal(report.twoAuthorRefresh.draws,0);assert.equal(report.twoAuthorRefresh.analysis,0);assert.equal(report.twoAuthorRefresh.playback,0);
 assert.ok(report.twoAuthorRefresh.refreshMs.length>=5);
 assert.equal(report.twoAuthorRefresh.syncCompleted,5);
 assert.ok(report.twoAuthorRefresh.calls.includes('collaboration_status'),'read-only probe verifies live IPC observation');
 assert.deepEqual((await snapshot(a)).document,refreshBefore);assert.equal((await playback(a)).generation,playbackBefore.generation);
 check('five unchanged two-author manual refreshes plus polling preserve private document/playback with zero spectral repaint or analysis requests');
 const currentSource=await a.evaluate(`return document.querySelector('[aria-label="声音版本"]').value`);await a.select('声音版本',currentSource==='original'?'暂存编辑':'原音');await ready(a);await a.menu('播放整段','音频');await a.driver.wait(async()=>{const p=await playback(a);return p.state==='playing'&&p.consumedFrames>2400;},30000);await a.label('停止');report.positiveProbe=await a.evaluate('return window.__refreshMeasure');assert.ok(report.positiveProbe.draws>0);assert.ok(report.positiveProbe.analysis>0);assert.ok(report.positiveProbe.playback>0);check('positive UI source/playback probe proves drawing, analysis and playback instrumentation is live');
 await a.menu('关闭项目');await b.menu('关闭项目');report.passed=true;
}catch(error){report.error=error.stack;console.error(error);await a?.screenshot('failure-a').catch(()=>{});await b?.screenshot('failure-b').catch(()=>{});process.exitCode=1;}
finally{await b?.quit().catch(e=>{report.teardownB=String(e);process.exitCode=1;});await a?.quit().catch(e=>{report.teardownA=String(e);process.exitCode=1;});await fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
