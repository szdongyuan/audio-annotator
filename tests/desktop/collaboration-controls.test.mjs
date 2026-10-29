import { createIdentity, selectIdentity, profiles } from './identity-helpers.mjs';
// Task 4 acceptance: actual UI actions, with read-only IPC assertions.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { start, Key, wait } from './harness.mjs';
const parent=path.resolve(process.env.ANNOTATOR_SUITE_OUTPUT ?? '.test-output/default-collaboration-v040/task5/desktop-evidence/collaboration-controls');await fs.mkdir(parent,{recursive:true});
const output=await fs.mkdtemp(path.join(parent,'ui-')),source=path.join(output,'source'),shared=path.join(output,'shared'),local=path.join(output,'local');
for(const p of [source,shared,local])await fs.mkdir(p);
const personal=path.join(output,'personal');await fs.mkdir(personal);
const paths={'新建项目 · 选择空文件夹':[shared],'创建协作副本 · 选择空文件夹':[shared],'打开项目':[path.join(shared,'collaboration.json')],'另存我的项目副本 · 选择空文件夹':[personal],'':[[path.resolve('tests/fixtures/audio/mono16.wav')]]};
const report={method:'Fresh debug/e2e Tauri application; owned Selenium pointer/keyboard controls and native picker queues; IPC is read-only assertion only',output,checks:[],frames:[]};let h;
const check=name=>{report.checks.push(name);console.log('PASS '+name);};
try{
 h=await start(paths,output,undefined,{exactOuter:true,localDataEnv:local});
 const read=(command,args={})=>h.driver.executeAsyncScript('const done=arguments[arguments.length-1];window.__TAURI_INTERNALS__.invoke(arguments[0],arguments[1]).then(done,e=>done({error:e}));',command,args);
 const status=()=>read('collaboration_status');
 const snapshot=async()=>{const s=await status();return read('get_project_snapshot',{projectId:s.projectId,...(s.shared?{runtimeNonce:s.runtimeNonce}:{})});};
 const original=(await profiles(h)).selectedAuthorId;
 const actor=async(name)=>{await h.until(`document.querySelector('.collaboration-status')?.textContent.includes(${JSON.stringify(name)})&&!document.querySelector('.collaboration-dialog')`,'identity '+name);assert.equal((await status()).actor?.displayName??'访客',name);};
 const frame=async(name,width,height)=>{h.nativeRect({width,height});await wait(300);const rect=h.nativeRect(),size=await h.evaluate('return {width:innerWidth,height:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth,header:document.querySelector(".project-header").getBoundingClientRect().height,toolbar:document.querySelector(".workspace-toolbar").getBoundingClientRect().height}');assert.equal(rect.width,width);assert.equal(rect.height,height);assert.equal(size.overflow,false);assert.ok(size.header+size.toolbar<=76);report.frames.push({name,outer:rect,...size});await h.screenshot(name);};
 await h.menu('新建项目');await h.until(`document.querySelector('.project-identity')?.textContent.match(/已保存|已存本机/)`);
 await h.clickText('导入音频');await h.until(`document.querySelector('.import-progress')?.textContent.includes('导入完成')`);await h.clickText('关闭导入结果');await h.until(`document.querySelector('canvas')&&!document.querySelector('.tile-status')`);
 const alice=await createIdentity(h,'Alice');await actor('Alice');await h.until(`document.querySelector('canvas')&&!document.querySelector('.tile-status')`);
 const manifest={media:(await snapshot()).document.media},hash=crypto.createHash('sha256').update(await fs.readFile(path.join(shared,manifest.media[0].sourceRef))).digest('hex');assert.equal(hash,manifest.media[0].sha256);assert.equal(await h.evaluate(`return document.querySelector('[aria-label="添加音频"]').disabled`),false);check('default create/import through File menu, explicit UUID identity creation, verified copied media and working analysis');
 await frame('identity-1280x800',1280,800);
 const volume=await h.element('[aria-label="播放音量"]');await volume.sendKeys(Key.HOME,Key.ARROW_RIGHT,Key.ARROW_RIGHT,Key.ARROW_RIGHT);await h.label('循环播放');await h.select('声音版本','原音');await h.clickText('保存');await h.until(`document.querySelector('.project-identity')?.textContent.includes('已存本机')`);assert.equal((await status()).preferences.volume,.03);assert.equal((await status()).preferences.source,'original');
 await selectIdentity(h,original);assert.equal(await h.evaluate(`return document.querySelector('[aria-label="播放音量"]').value`),'0.75');assert.equal(await h.evaluate(`return document.querySelector('[aria-label="循环播放"]').getAttribute('aria-pressed')`),'false');check('switch saves profile preferences and restores local-author defaults');
 await h.menu('类别管理','标注');await h.input('类别名称','default-own');await h.clickText('添加类别');await h.clickText('保存');await h.until(`document.querySelector('.project-identity')?.textContent.includes('已存本机')`);
 const bob=await createIdentity(h,'Bob');await actor('Bob');assert.equal((await snapshot()).document.categories.length,0);
 const before=(await status()).runtimeNonce;await h.menu('类别管理','标注');await h.input('类别名称','bob-own');await h.clickText('添加类别');assert.equal((await snapshot()).document.categories[0].name,'bob-own');await h.menu('撤销','编辑');assert.equal((await snapshot()).document.categories.length,0);await h.menu('重做','编辑');assert.equal((await snapshot()).document.categories[0].name,'bob-own');assert.equal((await status()).runtimeNonce,before);check('new profile starts isolated; own category is undoable without copying local author labels');
 await h.menu('保存并同步','协作');await h.until(`document.querySelector('.collaboration-status')?.textContent.includes('已同步')`);
 await h.menu('作者显示与同步状态…','协作');await h.select('显示作者','仅自己');assert.equal(await (await h.element('[aria-label=显示作者]')).getAttribute('value'),'mine');await h.screenshot('author-filter');await h.clickText('关闭');
 await frame('identity-1920x1080',1920,1080);
 await h.menu('导出我的标注 / 项目包…');await h.until(`document.querySelector('[aria-label="导出我的标注 / 项目包"]')`);assert.ok(await h.evaluate(`return document.querySelector('.exchange-dialog').textContent.includes('包含当前身份')&&document.querySelector('.exchange-dialog').textContent.includes('其他作者内容不在导出范围内')`));await h.clickText('关闭');check('compact author filters and explicit personal-only export scope');
 await selectIdentity(h,original);await selectIdentity(h,alice.authorId);await actor('Alice');assert.equal(await h.evaluate(`return document.querySelector('[aria-label="播放音量"]').value`),'0.03');assert.equal(await h.evaluate(`return document.querySelector('[aria-label="循环播放"]').getAttribute('aria-pressed')`),'true');assert.equal(await h.evaluate(`return document.querySelector('[aria-label="声音版本"]').value`),'original');check('Alice private preferences restore after local/Bob transitions');
 await h.menu('关闭项目');await h.until(`!document.querySelector('.collaboration-status')`);await h.menu('打开项目…');await h.until(`document.querySelector('.collaboration-status')?.textContent.includes('Alice')`);await selectIdentity(h,alice.authorId);await actor('Alice');assert.equal((await status()).preferences.volume,.03);await h.until(`document.querySelector('canvas')&&!document.querySelector('.tile-status')`);check('default collaboration.json opens selected profile; reopen/select restores private preferences and working analysis');
 const priorNonce=(await status()).runtimeNonce;await h.menu('加载共享版本…','协作');await h.until(`document.querySelector('[aria-label="加载共享版本"]')`);assert.equal((await status()).runtimeNonce,priorNonce);await h.clickText('确认加载共享版本');await actor('Alice');assert.notEqual((await status()).runtimeNonce,priorNonce);assert.equal((await snapshot()).canUndo,false);assert.equal((await status()).preferences.volume,.03);check('shared-version load requires explicit confirmation, retires history and preserves private preferences');
 await h.menu('另存我的项目副本…','协作');await h.until(`document.querySelector('.project-identity')?.title.endsWith('personal')&&document.querySelector('.project-identity')?.textContent.match(/已保存|已存本机/)`);const personalDocument=(await snapshot()).document;assert.equal(personalDocument.formatVersion,3);assert.ok(!JSON.stringify(personalDocument).includes('default-own'));assert.equal((await status()).projectFlavor,'default');check('personal Save As creates default project with only current identity document');
 assert.equal(crypto.createHash('sha256').update(await fs.readFile(path.join(shared,manifest.media[0].sourceRef))).digest('hex'),hash);report.originalSha256=hash;
 await h.menu('关闭项目');
}catch(e){report.error=e.stack;console.error(e);await h?.screenshot('failure').catch(()=>{});process.exitCode=1;}
finally{await h?.quit().catch(()=>{});await fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
