import fs from 'node:fs/promises';import path from 'node:path';import assert from 'node:assert/strict';
import {start,Key} from './harness.mjs';
import {newProject,importDirect,addCategory,saved,snapshot,status,expectDocument,escape,wav,hash} from './workspace-helpers.mjs';
import {createIdentity,profiles,read} from './identity-helpers.mjs';
const base=path.resolve(process.env.ANNOTATOR_COMPAT_OUTPUT??'.test-output/update-0.7.3');await fs.mkdir(base,{recursive:true});const output=await fs.mkdtemp(path.join(base,'compatibility-')),project=path.join(output,'project');await fs.mkdir(project);
const source=path.join(output,'old.wav');await fs.writeFile(source,wav({seconds:2,channels:1}));
const options={localDataEnv:path.join(output,'local'),webviewDirectory:path.join(output,'webview')};
const current=process.env.ANNOTATOR_WORKSPACE_EXE??'C:/Users/DY/AppData/Local/Temp/annotator-071-production-20261027/release/annotator-desktop.exe';
const previous=path.resolve(process.env.ANNOTATOR_PREVIOUS_EXE??'.test-output/update-0.7.2/e2e-executable/annotator-desktop.exe');
let h;const report={output,previous,current,checks:[]};
try{
 h=await start({'新建项目 · 选择空文件夹':[project],'':[[source]]},output,previous,options);const identity=await createIdentity(h,'旧版作者');await newProject(h);await importDirect(h,1);await addCategory(h,'旧标签');
 await h.drag('.annotation-overlay',[.1,.2],[.3,.5]);await h.label('标注');await h.label('旧标签');await escape(h);await h.input('区域备注','升级前标注');await h.click('.file-heading h2');await escape(h);
 await h.drag('.annotation-overlay',[.6,.6],[.8,.8]);await h.driver.actions().sendKeys(Key.DELETE).perform();await expectDocument(h,d=>d.edits.length===1,'old temporary mask');
 await h.input('快捷监听增益（dB）','20');await saved(h);const before=await snapshot(h),audioHash=hash(await fs.readFile(path.join(project,before.media[0].sourceRef)));await h.quit();h=null;
 h=await start({'打开项目':[path.join(project,'collaboration.json')]},output,current,options);await h.menu('打开项目');await h.until('document.querySelector(".file-pane")');const after=await snapshot(h);
 for(const key of ['media','annotations','categories','edits'])assert.deepEqual(after[key],before[key],key);assert.equal((await profiles(h)).selectedAuthorId,identity.authorId);assert.equal(await(await h.element('[aria-label="快捷监听增益（dB）"]')).getAttribute('value'),'20');assert.equal(hash(await fs.readFile(path.join(project,after.media[0].sourceRef))),audioHash);
 const s=await status(h),r=await read(h,'recycle_get',{binding:{projectId:s.projectId,runtimeNonce:s.runtimeNonce}});assert.equal(r.recycle.revision,0);assert.equal(await fs.stat(path.join(project,'recycle.json')).then(()=>true,()=>false),false);
 report.checks.push('Previous-version project opens in candidate with original audio, identity, labels, notes, temporary edits and +20 dB monitor; no migration or recycle file created on read');report.passed=true;await h.screenshot('old-project-opened');
}catch(error){report.error=error.stack;console.error(error);await h?.screenshot('failure').catch(()=>{});process.exitCode=1;}
finally{await h?.quit().catch(()=>{});await fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
