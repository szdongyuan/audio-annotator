import fs from 'node:fs/promises';import path from 'node:path';import assert from 'node:assert/strict';
import {start,Key,By} from './harness.mjs';import {snapshot,playback,hash} from './workspace-helpers.mjs';
const previous=JSON.parse(await fs.readFile(process.env.ANNOTATOR_SCALE_REPORT,'utf8'));assert.equal(previous.passed,true);assert.equal(previous.count,10000);
const output=await fs.mkdtemp(path.join(path.resolve('.test-output/recycle-busy-fix'),'large-ui-'));const report={output,project:previous.project,checks:[]};let h;
try{
 const before=hash(await fs.readFile(path.join(previous.project,'organization.json')));
 h=await start({'打开项目':[path.join(previous.project,'collaboration.json')]},output,process.env.ANNOTATOR_WORKSPACE_EXE,{localDataEnv:path.join(previous.output,'local-data')});await h.menu('打开项目');await h.until('document.querySelector(".file-pane")','large project open',180000);
 const doc=await snapshot(h);assert.equal(doc.media.length,10000);const early=[...doc.media].sort((a,b)=>a.displayName.localeCompare(b.displayName))[0];await h.selectMedia(early.displayName);
 await h.driver.actions().sendKeys(Key.SPACE).perform();await h.driver.wait(async()=>{const p=await playback(h);return p.mediaId===early.id&&p.consumedFrames>0;},20000,'evicted source plays');report.checks.push('Reopened 10000-file project lazily decodes and plays an early evicted file');
 const begin=performance.now();await h.input('搜索音频','');await h.label('展开文件夹 · 10000条');await h.until("document.querySelectorAll('.media-card').length===10000",'expanded large list',60000);report.expandMs=Math.round(performance.now()-begin);
 await h.selectMedia(early.displayName);const neighbors=await h.evaluate("const rows=[...document.querySelectorAll('.media-select')],i=rows.findIndex(e=>e.getAttribute('aria-pressed')==='true');return {direction:i===rows.length-1?'up':'down',id:rows[i===rows.length-1?i-1:i+1].dataset.mediaId};");
 await h.driver.actions().sendKeys(neighbors.direction==='up'?Key.ARROW_UP:Key.ARROW_DOWN).perform();await h.until(`document.activeElement?.dataset.mediaId===${JSON.stringify(neighbors.id)}`);
 assert.equal(await h.evaluate("const a=document.activeElement.getBoundingClientRect(),b=document.querySelector('.media-items').getBoundingClientRect();return a.top>=b.top&&a.bottom<=b.bottom;"),true);report.checks.push('Expanded 10000-row tree supports arrow navigation with focused row scrolled into view');
 await h.label('多选音频');await h.label('全选筛选结果');await h.until("document.querySelector('.media-batch-actions')?.textContent.includes('已选 10000')",'all selected');await h.clickText('移入回收站');await h.until("document.querySelector('[role=dialog]')?.textContent.includes('10000')");await h.screenshot('10000-recycle-review');await h.clickText('取消');
 assert.equal(hash(await fs.readFile(path.join(previous.project,'organization.json'))),before);assert.equal((await snapshot(h)).media.length,10000);report.checks.push('Select all 10000, review recycle operation, cancel without changing shared media or folders');report.passed=true;
}catch(e){report.error=e.stack;await h?.screenshot('failure').catch(()=>{});console.error(e);process.exitCode=1;}
finally{await h?.quit().catch(()=>{});await fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
