import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { start, By, Key, wait, clickFresh } from './harness.mjs';
import { newProject, importDirect, addCategory, saved, snapshot, status, organization, playback, expectDocument, escape, wav, hash, cleanOwnedShutdown } from './workspace-helpers.mjs';
import { createIdentity, profiles, read } from './identity-helpers.mjs';

// All mutations use pointer/keyboard UI. IPC is used only to assert native state.
const base=path.resolve(process.env.ANNOTATOR_EXAMPLES_OUTPUT??'.test-output/examples/task3');
await fs.mkdir(base,{recursive:true});
const output=await fs.mkdtemp(path.join(base,'desktop-'));
const projectA=process.env.ANNOTATOR_EXAMPLES_PROJECT??`N:/精成数据标注/.codex-example-verification-${Date.now()}`;
assert.match(projectA.replaceAll('\\','/'),/\/\.codex-example-verification-[\w-]+$/,'owned NAS project only');
await fs.mkdir(projectA); // Deliberately fail if an existing directory was supplied.
const projectB=path.join(output,'project-b');await fs.mkdir(projectB);
const source=path.join(output,'owned-six-channel.wav');
const bytes=wav({seconds:2,channels:6});
// Different tones make channel routing observable in rendered FFT pixels.
for(let frame=0;frame<96000;frame++)for(let channel=0;channel<6;channel++)bytes.writeInt16LE(Math.round((.12*Math.sin(2*Math.PI*(800+channel*500)*frame/48000)+.12*Math.sin(2*Math.PI*(4500+channel*650)*frame/48000))*32767),44+(frame*6+channel)*2);
await fs.writeFile(source,bytes);
const missing=path.join(output,'owned-missing.wav');
const exe=process.env.ANNOTATOR_WORKSPACE_EXE;assert.ok(exe,'explicit E2E executable required');
const options={localDataEnv:path.join(output,'local'),webviewDirectory:path.join(output,'webview')};
const paths={'新建项目 · 选择空文件夹':[projectA,projectB],'打开项目':[path.join(projectA,'collaboration.json')],'':[[source]],'导入示例音频':[[source,missing],[source]]};
const report={output,exe,projectA,projectB,method:'Actual Windows Tauri + official tauri-driver + EdgeDriver; native picker paths injected by E2E harness. Mutations through UI; read-only IPC assertions.',checks:[],limitations:['No subjective physical audio listening','No physical native file-picker interaction','Single Windows workstation; identities share one isolated local profile','Installer and normal-build smoke are separate parent delivery checks']};
let h;
function stableMenus(h){h.menu=async(text,group='文件')=>{await clickFresh(()=>h.driver.findElement(By.xpath(`//nav[@role='menubar']/button[normalize-space(.)='${group}']`)));await clickFresh(()=>h.driver.wait(async()=>{for(const item of await h.driver.findElements(By.xpath(`//div[@role='menu']/button[starts-with(@aria-label,'${text}')]`)))if(await item.isDisplayed()&&await item.isEnabled())return item;return false;},10000,`mounted menu item ${text}`,50));};return h;}
const checkpoint=message=>{report.checks.push(message);console.log(`PASS ${message}`);};
const tab=async text=>{await (await h.driver.findElement(By.xpath(`//div[@aria-label='属性分区']/button[normalize-space(.)='${text}']`))).click();await h.until(`[...document.querySelectorAll('[aria-label=属性分区] button')].some(e=>e.textContent===${JSON.stringify(text)}&&e.getAttribute('aria-selected')==='true')${text==='示例'?'&&document.querySelector(".example-library")':''}`);};
const scope=async text=>{await h.clickText(text);await h.until("!document.querySelector('.example-library [role=status]')?.textContent.includes('正在读取')");};
const names=()=>h.evaluate("return [...document.querySelectorAll('.example-name')].map(e=>e.textContent)");
const expectNames=async wanted=>h.driver.wait(async()=>await h.evaluate('return !!document.querySelector(".example-library")')&&JSON.stringify((await names()).sort())===JSON.stringify([...wanted].sort()),10000,`example names ${wanted}`,50);
const action=async(name,action)=>{await h.label(`示例操作 ${name}`);await h.label(action);};
const library=async scope=>{const s=await status(h);return read(h,'examples_list',{runtimeNonce:s.runtimeNonce,projectId:s.projectId,scope});};
const idle=async label=>{const started=Date.now();let busyReads=0;await h.driver.wait(async()=>{const s=await status(h);assert.equal(typeof s.busy,'boolean');if(s.busy)busyReads++;return !s.busy;},20000,label,50);(report.idleWaits??=[]).push({label,elapsedMs:Date.now()-started,busyReads});};
const identityResult=async text=>{await h.until(`!document.querySelector('[aria-label="身份操作进度"]')&&(document.querySelector('.collaboration-dialog [role="status"]')?.textContent.includes(${JSON.stringify(text)})||document.querySelector('.collaboration-dialog [role="alert"]'))`);return h.evaluate("return document.querySelector('.collaboration-dialog [role=alert]')?.textContent??null");};
const recordIdentityRetry=(kind,error,before,after)=>{assert.match(error,/^Collaboration job already running$/);(report.identityRetries??=[]).push({kind,error,beforeIds:before.profiles.map(p=>p.authorId),afterIds:after.profiles.map(p=>p.authorId)});};
async function selectIdentityUI(id){
 await idle('before identity switch UI');await h.menu('切换身份…','协作');await h.until('document.querySelector(".identity-list")');
 for(let attempt=0;attempt<3;attempt++){
  const before=await profiles(h);if(before.selectedAuthorId===id){await h.clickText('关闭');return;}
  await idle('before explicit identity select attempt');const row=await h.driver.findElement(By.xpath(`//ul[@class='identity-list']/li[.//input[@value='${id}']]`));await(await row.findElement(By.xpath('./button'))).click();const error=await identityResult('当前身份已更新'),after=await profiles(h);
  if(!error){assert.equal(after.selectedAuthorId,id);await h.clickText('关闭');return;}
  recordIdentityRetry('select',error,before,after);assert.deepEqual(after.profiles,before.profiles,'busy select never recreates identities');
 }
 throw Error('Identity select stayed busy after three explicit UI attempts');
}
async function createIdentityUI(name){
 await idle('before identity create UI');await h.menu('创建身份…','协作');await h.input('身份昵称',name);const before=await profiles(h);
 for(let attempt=0;attempt<3;attempt++){
  await idle('before explicit identity create attempt');await h.clickText('创建并使用');const error=await identityResult('身份已创建'),after=await profiles(h),created=after.profiles.filter(p=>!before.profiles.some(old=>old.authorId===p.authorId));
  if(!error){const profile=after.profiles.find(p=>p.authorId===after.selectedAuthorId);assert.equal(profile.displayName,name);await h.clickText('关闭');return profile;}
  recordIdentityRetry('create',error,before,after);assert.ok(created.length<=1,'at most one committed profile');
  if(created.length){assert.equal(created[0].displayName,name);await h.clickText('关闭');await selectIdentityUI(created[0].authorId);return created[0];}
  assert.equal(after.storeRevision,before.storeRevision,'busy create rejected before profile write');
 }
 throw Error('Identity create stayed busy after three explicit UI attempts');
}
const closeImport=async()=>{await h.clickText('关闭');await h.until("!document.querySelector('[role=dialog]')");};
const importExamples=async(target,names)=>{await h.label('导入示例');await h.until("document.querySelector('[aria-label=\"导入名称 1\"]')");await h.select('保存示例到',target);for(let i=0;i<names.length;i++)await h.input(`导入名称 ${i+1}`,names[i]);await h.clickText('导入待处理文件');await h.until("[...document.querySelectorAll('.example-import-row')].every(e=>e.querySelector('[role=alert]')||e.textContent.includes('已导入'))");};
const previewCanvas=async()=>{
 await h.until("document.querySelector('.example-spectrum canvas')&&!document.querySelector('.example-spectrum .tile-status')",'native example tiles rendered');
 await h.driver.wait(async()=>{const pixels=await h.evaluate("const c=document.querySelector('.example-spectrum canvas');if(!c||!c.width||!c.height)return null;const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let lit=0,fingerprint=2166136261;const colors=new Set();for(let i=0;i<d.length;i+=4){if(d[i]+d[i+1]+d[i+2]>30)lit++;colors.add(`${d[i]},${d[i+1]},${d[i+2]}`);fingerprint=Math.imul(fingerprint^d[i],16777619);fingerprint=Math.imul(fingerprint^d[i+1],16777619);fingerprint=Math.imul(fingerprint^d[i+2],16777619);}return {width:c.width,height:c.height,lit,colors:colors.size,channel:c.dataset.channel,fingerprint:fingerprint>>>0};");report.lastCanvas=pixels;if(pixels?.lit>100&&pixels.colors>=3)return true;return false;},20000,'real nonblack multicolor FFT canvas',100);
};
const ruler=()=>h.evaluate("return document.querySelector('.example-spectrum .time-ruler').textContent");
const stateUnchanged=async(before,org,ui)=>{
 assert.deepEqual(await snapshot(h),before,'main native document unchanged');assert.deepEqual(await organization(h),org,'main organization/counts unchanged');
 assert.deepEqual(await h.evaluate("return {heading:document.querySelector('.file-heading h2')?.textContent,selected:document.querySelector('.media-select[aria-pressed=true]')?.getAttribute('aria-label'),gain:document.querySelector('[aria-label=\"快捷监听增益（dB）\"]')?.value,counts:[...document.querySelectorAll('.media-folder-select .count')].map(e=>e.textContent)}"),ui,'main selection, monitor and counts unchanged');
};
try{
 h=stableMenus(await start(paths,output,exe,options));
 const actorA=await createIdentity(h,'示例作者 A');await newProject(h);await importDirect(h,1);await h.selectMedia('owned-six-channel.wav');await addCategory(h,'示例验收标签');
 await tab('区域');await h.drag('.annotation-overlay',[.1,.2],[.3,.5]);await h.label('标注');await h.label('示例验收标签');await expectDocument(h,d=>d.annotations.length===1,'main annotation committed');await escape(h);await h.click('.annotation-rect[data-annotation-id]');await h.until("document.querySelector('[aria-label=区域备注]')");await h.input('区域备注','原项目备注必须保留');await h.click('.file-heading h2');await escape(h);
 await h.drag('.annotation-overlay',[.6,.6],[.8,.8]);await h.driver.actions().sendKeys(Key.DELETE).perform();await expectDocument(h,d=>d.edits.length===1,'ordinary main mask');await h.input('快捷监听增益（dB）','20');await saved(h);
 await h.click('.file-heading h2');await escape(h);
 const before=await snapshot(h),org=await organization(h),ui=await h.evaluate("return {heading:document.querySelector('.file-heading h2')?.textContent,selected:document.querySelector('.media-select[aria-pressed=true]')?.getAttribute('aria-label'),gain:document.querySelector('[aria-label=\"快捷监听增益（dB）\"]')?.value,counts:[...document.querySelectorAll('.media-folder-select .count')].map(e=>e.textContent)}");
 const localSettings=await h.evaluate("return localStorage.getItem('audio-annotator.global-settings.v1')");
 assert.equal(before.annotations.length,1);assert.equal(before.annotations[0].note,'原项目备注必须保留');assert.deepEqual(before.annotations[0].categoryIds,[before.categories.find(c=>c.name==='示例验收标签').id]);assert.equal(before.edits.length,1);assert.equal(before.edits[0].operation.type,'mask');assert.equal(ui.gain,'20');checkpoint('Main project has one original audio, label, note, private mask and +20 dB baseline');
 await tab('示例');await expectNames([]);
 await importExamples('我的示例',['OK1','NG1']);await h.until("document.querySelector('.example-import-row')?.textContent.includes('已导入')&&document.querySelectorAll('.example-import-row [role=alert]').length===1");
 report.importResults=await h.evaluate("return [...document.querySelectorAll('.example-import-row')].map(e=>e.textContent)");await h.screenshot('import-row-success-and-error');await closeImport();await expectNames(['OK1']);checkpoint('Batch import retains per-row successful custom name and missing-file error');
 await h.input('筛选示例','不存在');await expectNames([]);await h.input('筛选示例','OK1');await expectNames(['OK1']);await h.input('筛选示例','');
 await action('OK1','重命名');await h.input('示例名称','NG1');await h.clickText('保存名称');await h.until("!document.querySelector('[aria-label=\"重命名示例\"]')");await expectNames(['NG1']);
 await action('NG1','复制到共享示例');await scope('共享示例');await expectNames(['NG1']);
 await importExamples('共享示例',['转动异常']);await h.until("document.querySelector('.example-import-row')?.textContent.includes('已导入')");await closeImport();await expectNames(['NG1','转动异常']);
 await h.clickText('添加当前音频为示例');await h.input('示例名称','OK1');await h.clickText('添加示例');await h.until("!document.querySelector('[aria-label=\"添加当前音频为示例\"]')");await expectNames(['NG1','转动异常','OK1']);
 await action('OK1','移除示例');await expectNames(['NG1','转动异常']);await scope('我的示例');await expectNames(['NG1']);
 await action('NG1','重命名');await h.input('示例名称','OK1');await h.clickText('保存名称');await h.until("!document.querySelector('[aria-label=\"重命名示例\"]')");await expectNames(['OK1']);
 const shared=await library('shared');assert.equal(shared.entries.length,2);
 const copiedFiles=await fs.readdir(path.join(projectA,'examples',actorA.authorId));
 const sharedWavs=copiedFiles.filter(n=>n.endsWith('.wav'));assert.equal(sharedWavs.length,2);
 for(const name of sharedWavs)assert.equal(hash(await fs.readFile(path.join(projectA,'examples',actorA.authorId,name))),hash(bytes));
 report.sourceHash=hash(bytes);await fs.unlink(source);assert.equal(await fs.stat(source).then(()=>true,()=>false),false);checkpoint('Search/rename/copy/add-current/remove work; shared originals match source SHA256; only owned external fixture removed');
 await scope('共享示例');await h.clickText('转动异常');await previewCanvas();
 assert.equal(await h.evaluate("return document.querySelectorAll('[aria-label=示例通道] option').length"),6);
 report.channels=[];for(let i=1;i<=6;i++){await h.select('示例通道',`通道 ${i}`);await previewCanvas();assert.equal(report.lastCanvas.channel,String(i-1));report.channels.push({...report.lastCanvas});}
 assert.ok(new Set(report.channels.map(c=>c.fingerprint)).size>=2,'different channel tones produce different FFT pixels');
 const whole=await ruler();await h.clickText('放大时间');await previewCanvas();assert.notEqual(await ruler(),whole);const zoomed=await ruler();
 await h.driver.actions().keyDown(Key.ALT).perform();await h.drag('.example-spectrum .spectrogram-surface',[.6,.5],[.4,.5]);await h.driver.actions().keyUp(Key.ALT).perform();await previewCanvas();assert.notEqual(await ruler(),zoomed);
 await h.clickText('重置示例视图');await previewCanvas();assert.equal(await ruler(),whole);await h.screenshot('six-channel-preview-after-source-removal');
 // Transparent wire observation: forward every request/event unchanged.
 await h.evaluate("window.__exampleWire=[];const rawFetch=window.fetch;window.fetch=function(resource,options){const command=decodeURIComponent(String(resource).split('/').at(-1));if(!/^(example_preview_playback|profile_|collaboration_|save_project|close_project)/.test(command))return rawFetch.apply(this,arguments);const args=typeof options?.body==='string'?JSON.parse(options.body):null;window.__exampleWire.push({kind:'request',command,args,at:performance.now()});const promise=rawFetch.apply(this,arguments);promise.then(response=>response.clone().json().then(result=>window.__exampleWire.push({kind:'response',command,result,at:performance.now()})));return promise;};const callbacks=window.__TAURI_INTERNALS__.callbacks,register=callbacks.set;const observe=callback=>function(value,...rest){if(value?.event==='playback-progress')window.__exampleWire.push({kind:'progress',value,at:performance.now()});return callback.call(this,value,...rest);};for(const [id,callback] of callbacks.entries())register.call(callbacks,id,observe(callback));callbacks.set=function(id,callback){return register.call(this,id,observe(callback));};");
 await h.label('播放示例原音');await h.until("document.querySelector('.example-audition small')?.textContent==='播放中'");
 const playing=await playback(h);assert.notEqual(playing.projectId,before.projectId);assert.match(await h.evaluate("return document.querySelector('.example-preview header').textContent"),/只读 · 原音/);
 await h.driver.wait(async()=>{const p=await playback(h);if(p.projectId===playing.projectId&&p.positionSeconds>playing.positionSeconds&&p.consumedFrames>0){report.previewPlayback={initial:playing,advanced:p};return true;}return false;},5000,'native preview presentation progresses',50);
 await h.label('暂停示例');await h.until("document.querySelector('.example-audition small')?.textContent==='已暂停'");report.pausedBeforeSeek=await playback(h);
 await h.drag('[aria-label=示例播放位置]',[.8,.5],[.8,.5]);await h.driver.wait(async()=>{const p=await playback(h);if(p.projectId===playing.projectId&&p.state==='paused'&&p.positionSeconds>1.4&&p.positionSeconds<1.8){report.previewSeek=p.positionSeconds;return true;}return false;},5000,'native paused seek to 80 percent',50);
 report.pausedSeekRequests=await h.evaluate("return window.__exampleWire.filter(e=>e.kind==='request'&&e.command==='example_preview_playback_configure'&&e.args.request.seekSeconds!==null).map(e=>e.args.request)");assert.ok(report.pausedSeekRequests.length>0);assert.ok(report.pausedSeekRequests.every(request=>request.play===false),'paused UI seek never requests playback');
 await h.clickText('停止示例');await h.until("document.querySelector('.example-audition small')?.textContent==='已停止'");await h.clickText('关闭示例');await h.until("!document.querySelector('.example-preview')");await stateUnchanged(before,org,ui);
 assert.equal(await h.evaluate("return localStorage.getItem('audio-annotator.global-settings.v1')"),localSettings,'local analysis/display/monitor preferences unchanged');assert.equal(hash(await fs.readFile(path.join(projectA,before.media[0].sourceRef))),hash(bytes),'ordinary original bytes unchanged');
 await h.label('播放 · 空格');await h.driver.wait(async()=>{const p=await playback(h);return p.state==='playing'&&p.mediaId===before.media[0].id;},10000);await h.label('停止');checkpoint('Six native FFT channels, zoom/pan/reset, original play/pause/seek/stop/close; main document/selection/counts unchanged and main playback resumes');
 await h.menu('输出设备','音频');await h.until("document.querySelector('[role=dialog][aria-label=输出设备]')");await h.select('输出设备','系统默认');await h.clickText('刷新设备');await escape(h);await h.until("!document.querySelector('[role=dialog]')");assert.equal(await h.evaluate("return document.activeElement?.textContent"),'音频');
 await h.label('更多播放操作');await h.label('输出设备…');await h.until("document.querySelector('[role=dialog][aria-label=输出设备]')");await h.screenshot('device-dialog');await h.driver.actions().move({x:5,y:5,origin:'viewport'}).click().perform();await h.until("!document.querySelector('[role=dialog]')");assert.equal(await h.evaluate("return document.activeElement?.getAttribute('aria-label')"),'更多播放操作');
 h.nativeRect({width:1000,height:800});await wait(300);
 report.layout=await h.evaluate("const p=document.querySelector('#properties-panel'),tabs=[...p.querySelectorAll('[aria-label=属性分区] button')],r=p.getBoundingClientRect();return {inner:innerWidth,inspector:r.width,panel:{left:r.left,right:r.right},overflow:document.documentElement.scrollWidth>innerWidth,tabs:tabs.map(e=>({text:e.textContent,left:e.getBoundingClientRect().left,right:e.getBoundingClientRect().right,width:e.getBoundingClientRect().width,textFits:e.scrollWidth<=e.clientWidth})),diagnostics:/submitted|underrun|已提交帧|欠载|帧计数/i.test(document.body.textContent)}");assert.equal(report.layout.tabs.length,8);assert.equal(report.layout.inspector,220);assert.equal(report.layout.overflow,false);assert.equal(report.layout.diagnostics,false);
 for(const t of report.layout.tabs){assert.ok(t.width>0&&t.left>=report.layout.panel.left&&t.right<=report.layout.panel.right&&t.right<=report.layout.inner&&t.textFits);await tab(t.text);}await tab('示例');await h.screenshot('1000px-eight-inspector-tabs');checkpoint('Audio and bottom menus reach device modal; default/refresh/Escape/outside/focus; all eight tabs fit established 1000px/220px responsive layout without counters or horizontal overflow');
 await idle('Authors-tab refresh settles before creating identity B');const actorB=await createIdentityUI('示例作者 B');await tab('示例');await scope('我的示例');await expectNames([]);await scope('共享示例');await expectNames(['NG1','转动异常']);
 await h.label('示例操作 NG1');const menu=await h.evaluate("return document.querySelector('[role=menu]').textContent");assert.ok(!menu.includes('重命名')&&!menu.includes('移除示例'));await h.label('复制到我的示例');await scope('我的示例');await expectNames(['NG1']);assert.equal((await library('private')).entries[0].creatorId,actorB.authorId);
 await idle('shared refresh settles before switching identity A');await selectIdentityUI(actorA.authorId);await tab('示例');await scope('我的示例');await expectNames(['OK1']);checkpoint('Second identity sees shared records, cannot rename/remove first author, copies own record; switching back restores first private library');
 await idle('shared refresh settles before project B');await newProject(h);await h.driver.wait(async()=>{const s=await status(h);return s.projectId&&s.projectId!==before.projectId;},10000,'native project B adopted');await h.until("document.querySelector('.project-identity > span')?.textContent==='project-b'&&!document.querySelector('.file-pane')&&[...document.querySelectorAll('[aria-label=属性分区] button')].some(e=>e.textContent==='区域'&&e.getAttribute('aria-selected')==='true')");await tab('示例');await expectNames([]);await scope('共享示例');await expectNames([]);assert.equal((await snapshot(h)).media.length,0);
 await idle('shared refresh settles before reopening project A');await h.menu('打开项目');await h.driver.wait(async()=>(await status(h)).projectId===before.projectId,10000,'native project A reopened');await h.until(`document.querySelector('.project-identity > span')?.textContent===${JSON.stringify(before.name)}&&document.querySelector('.file-pane')`);await tab('示例');await scope('我的示例');await expectNames(['OK1']);await scope('共享示例');await expectNames(['NG1','转动异常']);
 report.wireTrace=await h.evaluate('return window.__exampleWire??[]');await cleanOwnedShutdown(h);h=null;
 h=stableMenus(await start({'打开项目':[path.join(projectA,'collaboration.json')]},output,exe,options));await h.until("document.querySelector('.restore-session-dialog')");await h.clickText('恢复项目与工作状态');await h.driver.wait(async()=>(await status(h)).projectId===before.projectId,10000,'native project A after restart');await h.until(`document.querySelector('.project-identity > span')?.textContent===${JSON.stringify(before.name)}&&document.querySelector('.file-pane')`);await tab('示例');await expectNames(['OK1']);await scope('共享示例');await expectNames(['NG1','转动异常']);
 assert.deepEqual(await snapshot(h),before);assert.deepEqual(await organization(h),org);await h.screenshot('restart-persisted-shared-examples');checkpoint('Project B has no examples; reopening A and restarting preserves both scopes and original main annotations/settings');report.passed=true;
}catch(error){report.error=error.stack;console.error(error);if(h)report.failureUi=await h.evaluate("return {dialogs:[...document.querySelectorAll('[role=dialog]')].map(e=>e.textContent),library:document.querySelector('.example-library')?.textContent,alerts:[...document.querySelectorAll('[role=alert]')].map(e=>e.textContent)}").catch(()=>null);await h?.screenshot('failure').catch(()=>{});process.exitCode=1;}
finally{if(h)report.wireTrace=[...(report.wireTrace??[]),...await h.evaluate('return window.__exampleWire??[]').catch(()=>[])];await h?.quit().catch(()=>{});await fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
