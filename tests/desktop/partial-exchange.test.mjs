import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {start,By} from './harness.mjs';
import {createIdentity,selectIdentity} from './identity-helpers.mjs';
import {newProject,importDirect,addCategory,escape,saved,snapshot,status,wav,zipEntries,hash,expectDocument} from './workspace-helpers.mjs';
const base=path.resolve(process.env.ANNOTATOR_SUITE_OUTPUT??'.test-output/partial-exchange');await fs.mkdir(base,{recursive:true});
const output=await fs.mkdtemp(path.join(base,'desktop-')),project=path.join(output,'project');await fs.mkdir(project);
const names=['alpha.wav','beta.wav','gamma.wav'],sources=[];
for(let i=0;i<names.length;i++){const file=path.join(output,names[i]);await fs.writeFile(file,wav({seconds:1+i,channels:1}));sources.push(file);}
const fresh=path.join(output,'fresh-target');await fs.mkdir(fresh);
const bundle=path.join(output,'selected.audioproj.zip'),audio=path.join(output,'selected-audio.zip');
const paths={'新建项目 · 选择空文件夹':[project,fresh],'':[sources],'分享 · 保存到本机':[bundle,audio,audio],'导入标注文件或完整项目包':[bundle,bundle,bundle,bundle],'选择新项目的存放位置 · 将创建独立子文件夹':[output]};
const report={output,checks:[],method:'Fresh Windows Tauri e2e executable; Selenium pointer and keyboard operate the production UI. Native file dialogs are preselected. One input event creates a pending note draft just before export; one preview response is delayed and shared-job status is held busy to reproduce a slow NAS. Saves, sync, exports and ZIP hashes use the real native implementation. All projects and files are test-owned.'};let h;
const check=name=>{report.checks.push(name);console.log('PASS '+name);};
const labelInput=text=>By.xpath(`//label[normalize-space(.)='${text}']/input`);
async function annotate(name){await h.selectMedia(name);await escape(h);await saved(h);await h.drag('.channel-pane:first-child .annotation-overlay',[.1,.2],[.4,.6]);await h.until("document.querySelector('.is-temporary.is-selected')");await h.label('标注');await h.label('异响');await escape(h);await saved(h);}
async function exportSelection(audioOnly){
 if(audioOnly){await h.selectMedia(names[0]);await h.click('.file-heading h2');await h.until("document.querySelector('[aria-label=音频备注]')");}
 await h.label('多选音频');for(const name of names.slice(0,2))await h.label(`选择音频 · ${name}`);
 await h.clickText('导出…');await h.until("document.querySelector('[role=dialog][aria-label=导出所选音频]')");
 if(audioOnly){
  await h.driver.findElement(labelInput('原始音频 ZIP')).click();
  await h.evaluate("const original=window.fetch;window.__originalExportFetch=original;window.__holdExportBusy=true;window.__exportBusyReads=0;window.__exportSaveRequests=[];let first=true;window.fetch=(url,...rest)=>{if(String(url).includes('/save_project')){try{window.__exportSaveRequests.push(JSON.parse(rest[0].body));}catch{}}const result=original(url,...rest);if(String(url).includes('/export_path_preview')&&first){first=false;return result.then(value=>new Promise(resolve=>{window.__releaseExportPreview=()=>resolve(value);}));}if(String(url).includes('/collaboration_status'))return result.then(async value=>{if(!window.__holdExportBusy)return value;const body=await value.clone().json();window.__exportBusyReads++;return new Response(JSON.stringify({...body,busy:true}),{status:value.status,headers:value.headers});});return result;};");
  await h.click('.export-layout-preview summary');await h.until("document.querySelector('.export-layout-preview [role=status]')&&window.__releaseExportPreview");
  assert.equal(await (await h.element('.exchange-dialog .button-accent')).isEnabled(),true,'a delayed directory preview must not gate the save picker');
 }else await h.clickText('全选');
 await h.screenshot(audioOnly?'audio-export-options':'author-export-options');
 if(audioOnly)await h.evaluate("const note=document.querySelector('[aria-label=音频备注]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(note,'导出前待保存备注');note.dispatchEvent(new Event('input',{bubbles:true}));");
 await h.click('.exchange-dialog .button-accent');
 if(audioOnly){
  await h.until("document.querySelector('.exchange-progress')?.textContent.includes('等待共享任务完成')&&window.__exportBusyReads>0");
  assert.equal(await h.evaluate("return window.__exportSaveRequests.some(request=>request.deferSync===true)"),true,'pending draft must be persisted without scheduling a competing refresh');
  assert.equal((await snapshot(h)).media.find(m=>m.displayName===names[0]).note,'导出前待保存备注');
  await h.clickText('取消任务');await h.until("document.querySelector('.exchange-dialog')?.textContent.includes('任务已取消')&&!document.querySelector('.exchange-progress')");
  assert.equal(await fs.stat(audio).then(()=>true,()=>false),false,'cancelled waiting must not create an archive');
  await h.click('.exchange-dialog .button-accent');await h.until("document.querySelector('.exchange-progress')?.textContent.includes('等待共享任务完成')");
  await new Promise(resolve=>setTimeout(resolve,11000));
  assert.equal(await h.evaluate("return !!document.querySelector('.exchange-progress')&&!document.querySelector('.exchange-dialog [role=alert]')"),true,'a slow shared job must not fail at the previous 10-second limit');
  await h.evaluate('window.__holdExportBusy=false;');
 }
 await h.until("document.querySelector('.exchange-result')&&!document.querySelector('.exchange-progress')");await h.clickText('关闭');await h.clickText('完成');
 if(audioOnly){await h.evaluate("window.fetch=window.__originalExportFetch;window.__releaseExportPreview();");assert.equal(await h.evaluate("return !!document.querySelector('.exchange-dialog')"),false);}
}
async function importPackage(merge){
 await h.menu('导入分享文件…');await h.driver.findElement(labelInput(merge?'合并到当前项目':'建立独立项目')).click();await h.clickText('选择交换文件…');
 await h.until("document.querySelector('.exchange-result')&&!document.querySelector('.exchange-progress')");await h.clickText('关闭');
}
try{
 h=await start(paths,output,process.env.ANNOTATOR_WORKSPACE_EXE);
 const alice=await createIdentity(h,'Alice');await newProject(h);await importDirect(h,3);await addCategory(h,'异响');await annotate('alpha.wav');
 const bob=await createIdentity(h,'Bob');await addCategory(h,'异响');await annotate('beta.wav');await selectIdentity(h,alice.authorId);await saved(h);
 await h.driver.wait(async()=>((await status(h)).snapshot?.authors.length??0)>=2,30000);
 await exportSelection(false);const bundleEntries=zipEntries(bundle);assert.equal(bundleEntries.filter(e=>!e.name.endsWith('/')&&e.name!=='manifest.json').length,2);
 const ownBefore=await snapshot(h);assert.equal(ownBefore.media.length,3);assert.equal(ownBefore.annotations.length,1);
 check('multiselect two of three audio files and export selected author layers through UI');
 await exportSelection(true);const audioEntries=zipEntries(audio);assert.ok(!audioEntries.some(e=>e.name==='manifest.json'));
 const originals=new Set(await Promise.all(sources.slice(0,2).map(async p=>hash(await fs.readFile(p)))));
 assert.equal(audioEntries.filter(e=>!e.name.endsWith('/')).length,2);for(const e of audioEntries.filter(e=>!e.name.endsWith('/')))assert.ok(originals.has(e.sha256));
 await h.driver.wait(async()=>(await status(h)).snapshot?.authors.some(a=>a.identity.authorId===alice.authorId&&a.layer?.payload.mediaLabels.some(m=>m.note==='导出前待保存备注')),30000,'deferred note is eventually shared');
 check('pending note saved and shared; slow shared job cancelled and retried after 11 seconds; ZIP contains exact original audio');
 await importPackage(true);let current=await snapshot(h);assert.equal(current.media.length,3);assert.deepEqual(current.annotations,ownBefore.annotations);
 let shared=await status(h);assert.ok(shared.snapshot.authors.some(a=>a.identity.displayName==='Alice（导入）'));assert.ok(shared.snapshot.authors.some(a=>a.identity.displayName==='Bob（导入）'));
 const imported=shared.snapshot.authors.filter(a=>a.identity.displayName.endsWith('（导入）'));assert.equal(imported.reduce((n,a)=>n+(a.layer?.payload.annotations.length??0),0),2);
 const checkpoints=imported.map(a=>[a.identity.authorId,a.layer?.revision,a.layer?.hash]);
 await importPackage(true);shared=await status(h);assert.deepEqual(shared.snapshot.authors.filter(a=>a.identity.displayName.endsWith('（导入）')).map(a=>[a.identity.authorId,a.layer?.revision,a.layer?.hash]),checkpoints);
 assert.equal((await snapshot(h)).media.length,3);check('merge is additive and repeat import leaves live authors and imported checkpoints intact');
 await newProject(h);await importPackage(true);await expectDocument(h,d=>d.media.length===2,'merge into empty project adopts new catalog');
 await h.until("document.querySelector('.file-pane')&&!document.querySelector('.tile-status')");
 assert.equal((await status(h)).snapshot.authors.filter(a=>a.identity.displayName.endsWith('（导入）')).length,2);
 check('merge into an empty project publishes new audio and displays its spectrum without reopening');
 await importPackage(false);current=await expectDocument(h,d=>d.media.length===2,'independent selected project opens');assert.notEqual(current.projectId,ownBefore.projectId);assert.equal(current.annotations.length,0);
 await h.driver.wait(async()=>((await status(h)).snapshot?.authors.filter(a=>a.identity.displayName.endsWith('（导入）')).length??0)===2,30000);
 assert.ok(current.media.every(m=>names.slice(0,2).includes(m.displayName)));await h.screenshot('independent-import-result');
 check('independent import contains only selected audio and keeps annotations under original author names');
}catch(error){report.error=error.stack;console.error(error);await h?.screenshot('failure').catch(()=>{});process.exitCode=1;}
finally{await h?.quit().catch(()=>{});await fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
