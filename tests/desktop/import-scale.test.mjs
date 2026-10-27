import fs from 'node:fs/promises';import path from 'node:path';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';
import {start} from './harness.mjs';import {newProject,folder,snapshot,organization,saved,hash,status} from './workspace-helpers.mjs';
const base=path.resolve('.test-output/recycle-busy-fix');const output=await fs.mkdtemp(path.join(base,'scale-'));
const real=process.env.ANNOTATOR_REAL_ZIP;const count=real?920:10000;
const project=real?path.join('N:/精成数据标注',`.codex-import-verification-${Date.now()}`):path.join(output,'project');await fs.mkdir(project);
const source=real??path.join(output,'ten-thousand.zip');
if(!real){const r=spawnSync('python',['-c',`import sys,zipfile,struct\nwith zipfile.ZipFile(sys.argv[1],'w',zipfile.ZIP_DEFLATED) as z:\n for i in range(10000):\n  pcm=struct.pack('<h',i)*800\n  data=b'RIFF'+struct.pack('<I',36+len(pcm))+b'WAVEfmt '+struct.pack('<IHHIIHH',16,1,1,8000,16000,2,16)+b'data'+struct.pack('<I',len(pcm))+pcm\n  z.writestr('records/%05d/audio/CH1.wav'%i,data)`,source],{encoding:'utf8',windowsHide:true});assert.equal(r.status,0,r.stderr);}
const exe=process.env.ANNOTATOR_WORKSPACE_EXE;assert.ok(exe);let h;const report={output,project,source,count,checks:[],progress:[]};
try{
 const options=real?{ports:{driver:4455,native:4456,debug:9245}}:{};report.nativeTemp=process.env.TEMP;
 h=await start({'新建项目 · 选择空文件夹':[project],'选择 ZIP 音频':[[source]],'打开项目':[path.join(project,'collaboration.json')]},output,exe,options);
 // The native local-data directory must not be inside a new empty project.
 await newProject(h);await folder(h,real?'20261026NG':'10000条');
 await h.menu('导入 ZIP 音频');await h.select('导入方案',real?'精成·保留来源目录':'通用·平铺');await h.select('目录布局','平铺');await h.select('目标文件夹',real?'20261026NG':'10000条');await h.clickText('选择 ZIP…');
 const started=performance.now();await h.clickText('扫描预览');await h.until(`document.querySelector('.source-preview strong')?.textContent==='${count} 个音频'`,'scan complete',180000);
 report.scanMs=Math.round(performance.now()-started);await h.screenshot('preview');await h.clickText(`导入 ${count} 个音频`);const importStart=performance.now();
 await h.driver.wait(async()=>{const text=await h.evaluate("return document.querySelector('.source-import-progress')?.textContent??''");if(/导入已暂停|导入失败/.test(text))throw Error(text);const n=await h.evaluate("return document.querySelector('.panel-heading .count')?.textContent");const now=performance.now();if(!report.progress.length||now-importStart-report.progress.at(-1).timeMs>15000){report.progress.push({timeMs:Math.round(now-importStart),count:n});console.log(JSON.stringify(report.progress.at(-1)));}return text.includes('音频导入完成');},2400000,'complete native source import',500);
 report.importMs=Math.round(performance.now()-importStart);const doc=await snapshot(h);assert.equal(doc.media.length,count);assert.equal(new Set(doc.media.map(m=>m.id)).size,count);
 const org=await organization(h);assert.equal(org.folders.length,1);assert.ok(org.media.every(m=>m.folderId===org.folders[0].id));assert.equal(org.media.length,count);assert.equal(new Set(doc.media.map(m=>m.sourceRef)).size,count);
 for(const media of [doc.media[0],doc.media[Math.floor(count/2)],doc.media.at(-1)])assert.equal(hash(await fs.readFile(path.join(project,media.sourceRef))),media.sha256);
 await h.screenshot('completed');await h.clickText('关闭结果');await saved(h);report.checks.push(`${count} real native imports, stable distinct IDs, exactly one flat target folder, sampled SHA256 verified`);
 const nonce=(await status(h)).runtimeNonce;await h.menu('打开项目');await h.driver.wait(async()=>{try{return (await status(h)).runtimeNonce!==nonce&&(await snapshot(h)).media.length===count;}catch{return false;}},180000,'reopen complete');assert.deepEqual((await snapshot(h)).media,doc.media);report.checks.push('Saved project reopens with identical imported media');report.passed=true;
}catch(e){report.error=e.stack;report.body=await h?.evaluate('return document.body.innerText').catch(()=>null);await h?.screenshot('failure').catch(()=>{});process.exitCode=1;console.error(e);}
finally{await h?.quit().catch(()=>{});await fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
