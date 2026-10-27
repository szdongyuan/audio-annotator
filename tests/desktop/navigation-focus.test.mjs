import fs from 'node:fs/promises';import path from 'node:path';import assert from 'node:assert/strict';
import {start,Key,By} from './harness.mjs';
import {newProject,importDirect,folder,playback,snapshot,organization,wav} from './workspace-helpers.mjs';
const root=path.resolve('.test-output/recycle-busy-fix');const output=await fs.mkdtemp(path.join(root,'navigation-'));const project=path.join(output,'project'),inputs=path.join(output,'inputs');await fs.mkdir(project);await fs.mkdir(inputs);
const files=[];for(let i=0;i<82;i++){const file=path.join(inputs,`nav-${String(i).padStart(3,'0')}.wav`);await fs.writeFile(file,wav({seconds:4,channels:1,rate:8000}));files.push(file);}
const exe=process.env.ANNOTATOR_WORKSPACE_EXE;assert.ok(exe,'explicit current e2e executable required');let h;const report={output,checks:[]};
const folderClick=async name=>h.click(`.media-folder-select[title=${JSON.stringify(name)}]`);
const key=async key=>h.driver.actions().sendKeys(key).perform();
const counts=()=>h.evaluate(`return Object.fromEntries([...document.querySelectorAll('.media-folder-select')].map(e=>[e.title||'root',e.querySelector('.count').textContent]));`);
try{
 h=await start({'新建项目 · 选择空文件夹':[project],'':[files.slice(0,80),files.slice(80)]},output,exe);await newProject(h);
 await folder(h,'A');await folderClick('A');await importDirect(h,80);
 await folder(h,'B');await folderClick('B');await importDirect(h,82);
 await h.until("document.querySelector('.media-folder-select[title=B] .count')?.textContent==='2'");
 const baseline=await counts();assert.deepEqual(baseline,{root:'82',A:'80',B:'2'});
 for(const name of ['A','B','A']){await folderClick(name);assert.deepEqual(await counts(),baseline);}report.checks.push('Selecting A/B repeatedly preserves A=80, B=2 and total=82');
 await (await h.driver.findElement(By.xpath("//button[contains(@class,'media-folder-select') and not(@title)]"))).click();
 const names=await h.evaluate("return [...document.querySelectorAll('.media-select')].map(e=>e.getAttribute('aria-label'))");
 await h.selectMedia(names[0]);await h.label('折叠文件夹 · A');await key(Key.ARROW_DOWN);
 await h.until(`document.activeElement?.getAttribute('aria-label')===${JSON.stringify(names[1])}`);
 for(let i=0;i<35;i++)await key(Key.ARROW_DOWN);
 await h.until(`document.activeElement?.getAttribute('aria-label')===${JSON.stringify(names[36])}`);
 let rect=await h.evaluate("const e=document.activeElement,r=e.getBoundingClientRect(),p=e.closest('.media-items').getBoundingClientRect();return {top:r.top,bottom:r.bottom,parentTop:p.top,parentBottom:p.bottom,selected:e.getAttribute('aria-pressed')};");
 assert.equal(rect.selected,'true');assert.ok(rect.top>=rect.parentTop&&rect.bottom<=rect.parentBottom);await h.screenshot('arrow-focus-scroll');
 await key(Key.SPACE);await h.driver.wait(async()=>['playing','buffering'].includes((await playback(h)).state),10000);const playing=await playback(h),doc=await snapshot(h);assert.equal(playing.mediaId,doc.media.find(m=>m.displayName===names[36]).id);await key(Key.SPACE);
 await h.selectMedia('nav-040.wav');await key(Key.SPACE);await h.driver.wait(async()=>{const p=await playback(h);return p.mediaId===doc.media.find(m=>m.displayName==='nav-040.wav').id&&p.state==='playing';},10000);await key(Key.SPACE);
 report.checks.push('ArrowDown expands collapsed ancestors, focuses and scrolls offscreen selected row; Space starts selected audio after arrows and mouse selection');
 await h.input('搜索音频','nav-040');await key(Key.ARROW_UP);assert.equal(await h.evaluate("return document.querySelector('.media-select[aria-pressed=true]')?.getAttribute('aria-label')"),'nav-040.wav');
 assert.equal((await organization(h)).media.length,82);report.passed=true;
}catch(e){report.error=e.stack;await h?.screenshot('failure').catch(()=>{});process.exitCode=1;console.error(e);}
finally{await h?.quit().catch(()=>{});await fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
