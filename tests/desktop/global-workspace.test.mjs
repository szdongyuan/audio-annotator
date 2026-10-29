import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {start,Key,wait} from './harness.mjs';
import {newProject,importDirect,snapshot,status,playback,saved,wav,addCategory,escape,expectDocument,hash,cleanOwnedShutdown} from './workspace-helpers.mjs';
import {createIdentity,profiles,selectIdentity} from './identity-helpers.mjs';

const root=path.resolve(process.env.ANNOTATOR_SUITE_OUTPUT??'.test-output/update-0.7.2');await fs.mkdir(root,{recursive:true});
const baseline=process.argv.includes('--baseline'),output=await fs.mkdtemp(path.join(root,baseline?'baseline-':'desktop-'));
const exe=path.resolve(process.env.ANNOTATOR_WORKSPACE_EXE??'C:/Users/DY/AppData/Local/Temp/annotator-071-production-20261027/release/annotator-desktop.exe');
const report={output,baseline,freshFixture:process.argv.includes('--fresh-fixture'),executable:exe,checks:[],method:'Actual owned Windows Tauri client, real WebDriver clicks/keys; native IPC and DOM/localStorage reads only for assertions.'};
let h;
const check=(name,details={})=>{report.checks.push({name,passed:true,...details});console.log('PASS '+name);};
const layer=(s,id)=>s.snapshot.authors.find(a=>a.identity.authorId===id)?.layer;
const plot='.channel-pane:first-child .annotation-overlay';
const tabs=async()=>h.evaluate('const p=document.querySelector(".properties-panel").getBoundingClientRect(),nav=document.querySelector(".inspector-tabs").getBoundingClientRect();return {navHeight:nav.height,panelTop:p.top,panelBottom:p.bottom,tabs:[...document.querySelectorAll(".inspector-tabs button")].map(b=>{const r=b.getBoundingClientRect();return {text:b.textContent,height:r.height,top:r.top,bottom:r.bottom,visible:r.left>=p.left&&r.right<=p.right&&r.top>=nav.top&&r.bottom<=nav.bottom&&r.bottom<=p.bottom&&r.height>=20}})}');
async function linear(name){await h.label(`${name} 分析设置`);const value=await(await h.element(`[aria-label="${name} 线性对数混合"]`)).getAttribute('value');await escape(h);return Number(value);}
async function applyGlobals(kind='mel',db='20'){
 await h.label('全局播放与显示设置');await h.input('全局监听增益（dB）',db);await h.select('全局频谱类型',kind==='mel'?'梅尔频谱':'STFT 频谱');
 await(await h.element('[aria-label="全局线性对数混合"]')).sendKeys(Key.HOME);await(await h.element('[aria-label="全局输出音量"]')).sendKeys(Key.HOME);
 await h.click('.global-analysis-details summary');await h.input('全局FFT 长度','4096');await h.input('全局步长','256');await h.input('全局梅尔频带','96');
 await h.clickText('应用到全部音频');await h.until('document.querySelector(".global-settings-dialog [role=status]")?.textContent.includes("已保存")');await escape(h);
}
try{
 if(process.argv.includes('--fresh-fixture')){
  const project=path.join(output,'project'),local=path.join(output,'local-data'),inputs=path.join(output,'inputs');await fs.mkdir(project);await fs.mkdir(inputs);
  const files=[];for(const [name,channels]of [['alpha.wav',1],['beta.wav',2],['gamma.wav',6]]){const file=path.join(inputs,name);await fs.writeFile(file,wav({seconds:5,channels}));files.push(file);}
  h=await start({'新建项目 · 选择空文件夹':[project],'':[files]},output,exe,{localDataEnv:local,webviewDirectory:path.join(output,'fixture-profile')});
  const alice=await createIdentity(h,'测试甲');await newProject(h);await importDirect(h,3);await h.selectMedia('alpha.wav');await addCategory(h,'共享异响');await h.drag(plot,[.15,.35],[.4,.65]);await h.label('标注');await h.label('共享异响');await escape(h);await h.input('区域备注','甲的原始标注，不可被乙覆盖');await saved(h);await h.menu('保存并同步','协作');await h.driver.wait(async()=>!!layer(await status(h),alice.authorId),30000);
  const bob=await createIdentity(h,'测试乙');await saved(h);const document=await snapshot(h);
  await fs.writeFile(path.join(root,'baseline.json'),JSON.stringify({project,local,webview:path.join(output,'candidate-profile'),alice,bob,document,aliceLayer:layer(await status(h),alice.authorId),files:await Promise.all(document.media.map(async m=>({id:m.id,sha256:hash(await fs.readFile(path.resolve(project,m.sourceRef)))})))},null,2));
  await h.menu('关闭项目');await h.quit();h=null;
 }
 if(process.argv.includes('--baseline-layout')){
  const old=JSON.parse(await fs.readFile(path.join(root,'baseline.json')));
  h=await start({'打开项目':[path.join(old.project,'collaboration.json')]},output,exe,{localDataEnv:old.local,webviewDirectory:old.webview});await h.menu('打开项目');await h.until('document.querySelector(".file-pane")');h.nativeRect({width:1000,height:680});await h.clickText('作者');await h.until('document.querySelector(".remote-list-entry")');report.oldTabs=await tabs();await h.screenshot('old-authors-minimum');assert.ok(report.oldTabs.tabs.some(t=>!t.visible));check('v0.7.1 reproduces clipped author-panel tabs at minimum size',report.oldTabs);
 }else if(baseline){
  const project=path.join(output,'project'),local=path.join(output,'local-data'),webview=path.join(output,'webview'),inputs=path.join(output,'inputs');await fs.mkdir(project);await fs.mkdir(inputs);
  const files=[];for(const [name,channels] of [['alpha.wav',1],['beta.wav',2],['gamma.wav',6]]){const file=path.join(inputs,name);await fs.writeFile(file,wav({seconds:5,channels}));files.push(file);}
  h=await start({'新建项目 · 选择空文件夹':[project],'':[files]},output,exe,{localDataEnv:local,webviewDirectory:webview});
  const alice=await createIdentity(h,'测试甲');await newProject(h);await importDirect(h,3);await h.selectMedia('alpha.wav');
  await h.label('监听增益');await(await h.element('[aria-label="输出音量"]')).sendKeys(Key.HOME);await escape(h);
  await addCategory(h,'共享异响');await h.drag(plot,[.15,.35],[.4,.65]);await h.label('标注');await h.label('共享异响');await escape(h);await h.input('区域备注','甲的原始标注，不可被乙覆盖');await h.click('.file-heading h2');
  const first=(await snapshot(h)).annotations[0];await h.click(`[data-annotation-id="${first.id}"]`);await h.driver.actions().sendKeys(Key.DELETE).perform();
  await expectDocument(h,d=>d.edits.length===1,'old Delete masks a saved annotation');assert.equal((await snapshot(h)).annotations.length,1);check('v0.7.1 reproduced Delete masking a saved annotation');
  await h.menu('撤销','编辑');await expectDocument(h,d=>d.edits.length===0,'undo old baseline mask');await saved(h);
  const bob=await createIdentity(h,'测试乙');await h.clickText('作者');await h.until('document.querySelector(".remote-list-entry")');
  report.oldTabs=await tabs();await h.screenshot('old-authors-tabs');check('v0.7.1 author layout geometry captured',report.oldTabs);
  const document=await snapshot(h),collab=await status(h);assert.ok(layer(collab,alice.authorId).payload.categories.some(c=>c.name==='共享异响'));assert.equal(document.categories.length,0);
  check('v0.7.1 shares author category payload but does not offer it in the current author category set');await saved(h);
  await fs.writeFile(path.join(root,'baseline.json'),JSON.stringify({project,local,webview,alice,bob,document,aliceLayer:layer(await status(h),alice.authorId),files:await Promise.all(document.media.map(async m=>({id:m.id,sha256:hash(await fs.readFile(path.resolve(project,m.sourceRef)))})))},null,2));
 }else{
  const old=JSON.parse(await fs.readFile(path.join(root,'baseline.json'))),added=path.join(output,'new-after-global.wav');await fs.writeFile(added,wav({seconds:1,channels:1}));
  h=await start({'打开项目':[path.join(old.project,'collaboration.json')],'':[[added]]},output,exe,{localDataEnv:old.local,webviewDirectory:old.webview});
  await h.menu('打开项目');await h.until('document.querySelector(".file-pane")');const opened=await snapshot(h);for(const key of ['media','categories','annotations','edits'])assert.deepEqual(opened[key],old.document[key],key);assert.equal((await profiles(h)).selectedAuthorId,old.bob.authorId);check(report.freshFixture?'Owned current fixture reopens with exact project, identity, private data and original audio':'v0.7.1 project, identity, private data and original audio reopen in the update');
  await h.clickText('作者');await h.until('document.querySelector(".remote-list-entry")');h.nativeRect({width:1000,height:680});
  const geometry=await tabs();assert.equal(geometry.tabs.length,8);assert.ok(geometry.tabs.every(t=>t.visible),JSON.stringify(geometry));await h.screenshot('authors-fixed-compact');
  for(const title of ['区域','列表','文件/通道','类别','处理','混合','示例','作者']){await h.clickText(title);assert.ok((await tabs()).tabs.every(t=>t.visible),title);}
  check('all eight property tabs remain visible and clickable with overflowing author content at minimum size',geometry);h.nativeRect({width:1440,height:900});
  await h.clickText('类别');await h.until('document.querySelector(".shared-categories")?.textContent.includes("共享异响")');await h.selectMedia('alpha.wav');
  await h.drag(plot,[.5,.15],[.8,.35]);await h.label('标注');await h.label('共享异响');await escape(h);await expectDocument(h,d=>d.annotations.length===1&&d.categories.some(c=>c.name==='共享异响'),'adopt shared category and annotate own region');
  const own=(await snapshot(h)).annotations[0],ownCategory=(await snapshot(h)).categories.find(c=>c.name==='共享异响');assert.deepEqual(own.categoryIds,[ownCategory.id]);assert.notEqual(ownCategory.id,old.aliceLayer.payload.categories[0].id);
  await h.label('alpha.wav 文件 类别');await h.label('文件类别');await h.label('共享异响');await escape(h);await escape(h);
  await h.label('alpha.wav 通道 1 类别');await h.label('通道类别');await h.label('共享异响');await escape(h);await escape(h);await saved(h);
  const labelled=await snapshot(h),alpha=labelled.media.find(m=>m.displayName==='alpha.wav');assert.ok(alpha.categoryIds.includes(ownCategory.id));assert.ok(alpha.channelCategoryIds[0].includes(ownCategory.id));assert.deepEqual(layer(await status(h),old.alice.authorId),old.aliceLayer);
  check('shared category is reusable for own region/file/channel while the colleague layer stays byte-equivalent');
  await h.click(`[data-annotation-id="${own.id}"]`);await h.driver.actions().sendKeys(Key.DELETE).perform();await expectDocument(h,d=>d.annotations.length===0,'Delete removes own annotation');assert.equal((await snapshot(h)).edits.length,0);
  await h.menu('撤销','编辑');await expectDocument(h,d=>d.annotations.length===1,'undo restores annotation');await h.menu('重做','编辑');await expectDocument(h,d=>d.annotations.length===0,'redo removes annotation');await h.menu('撤销','编辑');await expectDocument(h,d=>d.annotations.length===1,'restore for shared test');await escape(h);
  await h.drag(plot,[.1,.1],[.3,.2]);await h.driver.actions().sendKeys(Key.DELETE).perform();await expectDocument(h,d=>d.edits.length===1,'Delete masks a temporary selection');assert.equal((await snapshot(h)).annotations.length,1);await h.menu('撤销','编辑');await expectDocument(h,d=>d.edits.length===0,'undo temporary mask');
  check('Delete distinguishes saved annotation from temporary selection; delete/mask undo and redo preserve labels');
  await applyGlobals();
  for(const name of ['alpha.wav','beta.wav','gamma.wav']){await h.selectMedia(name);assert.equal(await(await h.element(`select[aria-label="${name} 频谱类型"]`)).getAttribute('value'),'mel');assert.equal(await(await h.element('[aria-label="快捷监听增益（dB）"]')).getAttribute('value'),'20');}
  await applyGlobals('stft');for(const name of ['alpha.wav','beta.wav']){await h.selectMedia(name);assert.equal(await linear(name),0);}
  await h.selectMedia('alpha.wav');await h.label('alpha.wav 分析设置');await(await h.element('[aria-label="alpha.wav 线性对数混合"]')).sendKeys(Key.END);await escape(h);assert.equal(await linear('alpha.wav'),1);await h.selectMedia('beta.wav');assert.equal(await linear('beta.wav'),0);
  await h.selectMedia('alpha.wav');await h.label('alpha.wav 分析设置');await h.clickText('恢复跟随全局显示与分析');await escape(h);assert.equal(await linear('alpha.wav'),0);
  check('global STFT linear zero persists across files; individual overrides remain isolated and can follow globals again');
  await applyGlobals();await h.label('播放 · 空格');await h.driver.wait(async()=> (await playback(h)).state==='playing',15000);const generation=(await playback(h)).generation;
  await h.input('快捷监听增益（dB）','3');await wait(150);assert.equal((await playback(h)).generation,generation);await h.label('监听增益');await h.select('监听目标','此音频 · alpha.wav');await h.clickText('恢复跟随全局');await escape(h);assert.equal(await(await h.element('[aria-label="快捷监听增益（dB）"]')).getAttribute('value'),'20');await h.label('停止');
  await importDirect(h,4);await h.selectMedia('new-after-global.wav');assert.equal(await(await h.element('select[aria-label="new-after-global.wav 频谱类型"]')).getAttribute('value'),'mel');assert.equal(await(await h.element('[aria-label="快捷监听增益（dB）"]')).getAttribute('value'),'20');
  check('live monitor override does not restart playback; newly imported audio inherits +20 dB and mel');
  await h.clickText('双文件对比');await h.clickText('作者');h.nativeRect({width:1000,height:680});assert.ok((await tabs()).tabs.every(t=>t.visible));await h.screenshot('global-mel-compare-authors');h.nativeRect({width:1440,height:900});await saved(h);
  const before=await snapshot(h),globalBefore=await h.evaluate('return localStorage.getItem("audio-annotator.global-settings.v1")');assert.ok(globalBefore);await cleanOwnedShutdown(h);h=null;
  const other=path.join(output,'other-client');await fs.mkdir(other);h=await start({'打开项目':[path.join(old.project,'collaboration.json')]},other,exe,{localDataEnv:path.join(other,'local-data'),webviewDirectory:path.join(other,'webview')});await h.menu('打开项目');await h.until('document.querySelector(".file-pane")');assert.equal(await h.evaluate('return localStorage.getItem("audio-annotator.global-settings.v1")'),null);assert.equal(await(await h.element('.spectrum-kind-select')).getAttribute('value'),'stft');assert.equal(await(await h.element('[aria-label="快捷监听增益（dB）"]')).getAttribute('value'),'0');await h.clickText('类别');await h.until('document.querySelector(".shared-categories")?.textContent.includes("共享异响")');check('another isolated client sees shared categories but does not receive private global display or gain');await h.quit();h=null;
  const restart=path.join(output,'restart');await fs.mkdir(restart);h=await start({'打开项目':[path.join(old.project,'collaboration.json')]},restart,exe,{localDataEnv:old.local,webviewDirectory:old.webview});await h.until("document.querySelector('.restore-session-dialog')");await h.clickText('恢复项目与工作状态');await h.until('document.querySelector(".file-pane")');const after=await snapshot(h);for(const key of ['media','annotations','categories','edits'])assert.deepEqual(after[key],before[key]);assert.equal(await h.evaluate('return localStorage.getItem("audio-annotator.global-settings.v1")'),globalBefore);assert.equal(await(await h.element('.spectrum-kind-select')).getAttribute('value'),'mel');assert.equal(await(await h.element('[aria-label="快捷监听增益（dB）"]')).getAttribute('value'),'20');
  for(const file of old.files){const m=after.media.find(m=>m.id===file.id);assert.equal(hash(await fs.readFile(path.resolve(old.project,m.sourceRef))),file.sha256);}assert.deepEqual(layer(await status(h),old.alice.authorId),old.aliceLayer);await h.screenshot('restarted-global-settings');check('process restart restores private globals, all labels and original audio while retaining the colleague layer');
 }
 report.passed=true;
}catch(error){report.passed=false;report.error=String(error.stack??error);if(h){try{report.dom=await h.evaluate('return document.body.innerText.slice(0,14000)');await h.screenshot('failure');}catch{}}throw error;}
finally{if(h)await h.quit();await fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
