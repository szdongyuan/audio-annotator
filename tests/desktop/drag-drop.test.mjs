import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { start, Key } from './harness.mjs';
import { folder, importDirect, newProject, organization, snapshot, wav } from './workspace-helpers.mjs';

const base = path.resolve(process.env.ANNOTATOR_SUITE_OUTPUT ?? '.test-output/drag-drop');
await fs.mkdir(base, { recursive: true });
const output = await fs.mkdtemp(path.join(base, 'desktop-')), project = path.join(output, 'project');
await fs.mkdir(project);
const paths = [];
for (const name of ['first.wav', 'second.wav', 'third.wav']) {
  const filename = path.join(output, name); await fs.writeFile(filename, wav({ seconds: 1, channels: 1 })); paths.push(filename);
}
const report = { output, checks: [], method: 'Disposable local shared project; real WebDriver pointer and keyboard events; native organization and document reads.' };
const check = name => { report.checks.push(name); console.log('PASS', name); };
const row = name => `.media-select[aria-label=${JSON.stringify(name)}]`;
let h;
async function drag(name, target, cancel = false, probeOverlay = false) {
  const source = await h.element(row(name)), destination = await h.element(target);
  const [a, b] = await Promise.all([source.getRect(), destination.getRect()]);
  const actions = h.driver.actions({ async: true }).move({ origin: 'viewport', x: Math.round(a.x + a.width / 2), y: Math.round(a.y + a.height / 2) }).press()
    .move({ origin: 'viewport', x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2), duration: 220 });
  if (probeOverlay) {
    await actions.perform();
    await h.until("document.querySelector('.media-drag-feedback')", 'drag feedback displayed');
    const hit = await h.evaluate(`const row=document.querySelector(${JSON.stringify(target)}), tip=document.querySelector('.media-drag-feedback');
      const r=row.getBoundingClientRect(),p=tip.offsetParent.getBoundingClientRect();
      Object.assign(tip.style,{top:(r.top-p.top)+'px',left:(r.left-p.left)+'px',right:'auto',bottom:'auto',width:r.width+'px',height:r.height+'px'});
      const t=tip.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;
      return {pointerEvents:getComputedStyle(tip).pointerEvents,covered:x>=t.left&&x<=t.right&&y>=t.top&&y<=t.bottom,hit:document.elementFromPoint(x,y)?.closest('[data-drop-folder]')===row.closest('[data-drop-folder]')};`);
    assert.deepEqual(hit,{pointerEvents:'none',covered:true,hit:true});report.overlayHit=hit;
    await h.driver.actions({async:true}).release().perform();return;
  }
  if (cancel) actions.sendKeys(Key.ESCAPE);
  await actions.release().perform();
}
async function holdNextMove() {
  await h.evaluate(`const original=window.fetch;window.__flatDrop={original,ready:false,release:null};
    window.fetch=function(resource,options){const command=decodeURIComponent(String(resource).split('/').at(-1)),args=typeof options?.body==='string'?JSON.parse(options.body):{};
      const promise=original.call(this,resource,options);if(command==='organization_apply'&&args.operation?.type==='moveMediaBatch')return promise.then(response=>new Promise(resolve=>{window.__flatDrop.ready=true;window.__flatDrop.release=()=>resolve(response);}));return promise;};`);
}
async function releaseMove() { await h.evaluate('const g=window.__flatDrop;window.fetch=g.original;g.release()'); }
try {
  h = await start({ '新建项目 · 选择空文件夹': [project], '': [paths] }, output);
  await newProject(h);
  const target = await folder(h, '拖放目标');
  await importDirect(h, 3);
  await h.selectMedia('first.wav');
  await h.until("document.querySelector('.file-pane h2')?.textContent==='first.wav'&&!document.querySelector('.tile-status')");
  const before = await snapshot(h), initial = await organization(h);
  await drag('first.wav', '.media-folder-select[title="拖放目标"]', true);
  assert.deepEqual(await organization(h), initial);
  assert.equal(await h.evaluate("return document.querySelector('.file-pane h2')?.textContent"), 'first.wav');
  check('Escape cancels a captured pointer drag without changing the organization or selected audio');
  await h.label('多选音频'); await h.label('选择音频 · first.wav'); await h.label('选择音频 · second.wav');
  const beforeBatch = await organization(h);
  await drag('first.wav', '.media-folder-select[title="拖放目标"]', false, true);
  const ids = before.media.filter(item => ['first.wav', 'second.wav'].includes(item.displayName)).map(item => item.id);
  await h.driver.wait(async () => { const head = await organization(h); return ids.every(id => head.media.some(item => item.mediaId === id && item.folderId === target.id)); }, 60000, 'batch move published');
  const after = await organization(h), document = await snapshot(h);
  report.revisions = { initial: initial.revision, beforeBatch: beforeBatch.revision, after: after.revision, layoutBeforeBatch: beforeBatch.layoutRevision, layoutAfter: after.layoutRevision };
  assert.equal(after.revision, beforeBatch.revision + 1); assert.equal(after.layoutRevision, beforeBatch.layoutRevision + 1);
  assert.equal(after.media.find(item => item.mediaId === before.media.find(m => m.displayName === 'third.wav').id).folderId, null);
  assert.deepEqual(document.media, before.media); assert.deepEqual(document.annotations, before.annotations);
  assert.equal(await h.evaluate("return document.querySelector('.file-pane h2')?.textContent"), 'first.wav');
  await h.until("document.activeElement?.matches('.media-folder-select[title=\"拖放目标\"]')", 'destination focused');
  check('Dragging a checked row atomically moves the checked batch, preserves audio identity and playing selection, and focuses the target');
  check('Real hit testing reaches a folder row underneath the noninteractive drag feedback');
  await h.evaluate(`const original=window.fetch;window.__noopResult={original,requests:[]};
    window.fetch=function(resource,options){const command=decodeURIComponent(String(resource).split('/').at(-1)),args=typeof options?.body==='string'?JSON.parse(options.body):{};
      const promise=original.call(this,resource,options);if(command==='organization_apply'&&args.operation?.type==='moveMediaBatch')return promise.then(value=>{window.__noopResult.requests.push({args,status:value.status});return value;});return promise;};`);
  const noOpBefore=await organization(h), firstRow=await h.element(row('first.wav'));
  await h.driver.executeScript('arguments[0].focus()',firstRow);
  await drag('first.wav', '.media-folder-select[title="拖放目标"]');
  await h.until('window.__noopResult.requests.length===1','validated no-op response',10000);
  const noOp=await h.evaluate('const g=window.__noopResult;window.fetch=g.original;return g.requests[0]');
  assert.equal(noOp.args.expectedRevision,noOpBefore.revision);assert.equal(noOp.status,200);
  assert.deepEqual(await organization(h),noOpBefore);assert.equal(await h.evaluate("return document.activeElement?.getAttribute('aria-label')"),'first.wav');
  assert.equal(await h.evaluate("return document.querySelector('.file-pane h2')?.textContent"),'first.wav');
  check('A true no-op reaches native validation, preserves revisions, selection, and source focus');
  // Hold the real native response after commit while the user switches display mode.
  await holdNextMove();
  await drag('third.wav', '.media-folder-select[title="拖放目标"]');
  await h.until('window.__flatDrop.ready','native move committed and response held');
  await h.select('音频显示方式','平铺');
  const initialSearch=await h.element('[aria-label="搜索音频"]');await initialSearch.click();await initialSearch.sendKeys('second');
  const chosenFocus=await h.evaluate("return document.activeElement?.getAttribute('aria-label')");
  await releaseMove();
  await h.until("[...document.querySelectorAll('button')].some(b=>b.textContent==='查看目标')",'destination action after choosing flat mode',10000);
  assert.equal(await h.evaluate("return document.activeElement?.getAttribute('aria-label')"),chosenFocus);
  assert.equal(await h.evaluate("return document.querySelector('[aria-label=音频显示方式]').value"),'flat');
  assert.equal(await h.evaluate("return document.querySelector('[aria-label=平铺显示范围]').value"),'');
  assert.equal(await h.evaluate("return document.querySelector('[aria-label=搜索音频]').value"),'second');
  assert.equal(await h.evaluate("return document.querySelector('.file-pane h2')?.textContent"),'first.wav');
  const third=before.media.find(item=>item.displayName==='third.wav').id;
  assert.equal((await organization(h)).media.find(item=>item.mediaId===third).folderId,target.id);
  await h.clickText('查看目标');await h.until("document.activeElement?.getAttribute('aria-label')==='平铺显示范围'&&document.querySelector('[aria-label=平铺显示范围]').value!==''",'flat destination scope focused on request');
  assert.equal(await h.evaluate("return document.querySelector('[aria-label=平铺显示范围]').value"),target.id);assert.equal(await h.evaluate("return document.querySelector('[aria-label=搜索音频]').value"),'');
  check('A delayed move preserves a flat search and scope until the user chooses the destination');
  await h.select('音频显示方式','目录树');
  await holdNextMove();
  await drag('third.wav', '[data-drop-folder=""] .media-folder-select');await h.until('window.__flatDrop.ready','root move committed and response held');
  await h.select('音频显示方式','平铺');await h.select('平铺显示范围','全部音频');await h.select('平铺显示范围','拖放目标（含子目录）');
  await releaseMove();await h.until("[...document.querySelectorAll('button')].some(b=>b.textContent==='查看目标')",'explicit destination action');
  assert.equal(await h.evaluate("return document.querySelector('[aria-label=平铺显示范围]').value"),target.id);
  assert.ok(await h.evaluate("return document.body.innerText.includes('全部音频')&&document.body.innerText.includes('已移动')"));
  await h.clickText('查看目标');await h.until("document.querySelector('[aria-label=平铺显示范围]')?.value===''&&document.activeElement?.getAttribute('aria-label')==='平铺显示范围'",'root scope selected and focused');
  assert.equal(await h.evaluate("return document.querySelector('.file-pane h2')?.textContent"),'first.wav');
  check('An explicit flat scope change is preserved until the user chooses to view the root destination');
  await h.select('音频显示方式','目录树');
  await holdNextMove();
  await drag('third.wav', '.media-folder-select[title="拖放目标"]');await h.until('window.__flatDrop.ready','folder move committed and response held');
  await h.input('搜索音频','未匹配');await releaseMove();
  await h.until("[...document.querySelectorAll('button')].some(b=>b.textContent==='查看目标')",'hidden destination action');
  assert.equal(await h.evaluate("return document.querySelector('[aria-label=搜索音频]').value"),'未匹配');await h.clickText('查看目标');
  await h.until("document.querySelector('[aria-label=搜索音频]')?.value===''&&document.activeElement?.matches('.media-folder-select[title=拖放目标]')",'searched destination revealed and focused');
  check('A search hiding the destination remains intact until the user chooses to reveal it');
  await holdNextMove();await drag('third.wav', '[data-drop-folder=""] .media-folder-select');await h.until('window.__flatDrop.ready','root move held for typing');
  const search=await h.element('[aria-label="搜索音频"]');await search.click();await search.sendKeys('未匹配');await releaseMove();
  await h.until("[...document.querySelectorAll('button')].some(b=>b.textContent==='查看目标')",'root destination action after typing');
  assert.equal(await h.evaluate("return document.activeElement?.getAttribute('aria-label')"),'搜索音频');assert.equal(await h.evaluate("return document.querySelector('[aria-label=搜索音频]').value"),'未匹配');
  await h.clickText('查看目标');await h.until("document.querySelector('[aria-label=搜索音频]')?.value===''&&document.activeElement?.closest('[data-drop-folder]')?.dataset.dropFolder===''",'root destination revealed after typing');
  check('Typing into search during a delayed root move retains focus and offers the destination');
  await holdNextMove();await drag('third.wav', '.media-folder-select[title="拖放目标"]');await h.until('window.__flatDrop.ready','folder move held for modal');
  await h.menu('快捷键','帮助');await h.until("document.querySelector('dialog[open]')?.matches(':modal')",'help modal open during move');
  const focusDuringMove=await h.evaluate("return document.activeElement?.outerHTML");await releaseMove();
  await h.until("document.querySelector('.media-move-review')?.textContent.includes('查看目标')",'destination retained behind modal');assert.equal(await h.evaluate("return document.activeElement?.outerHTML"),focusDuringMove);
  await (await h.element('dialog[open] header button')).click();await h.until("!document.querySelector('dialog[open]')",'help modal closed');await h.clickText('查看目标');
  await h.until("document.activeElement?.matches('.media-folder-select[title=拖放目标]')",'destination focused after modal closes');
  check('A move completing under the native help modal preserves modal focus and offers the destination afterward');
  await holdNextMove();await drag('third.wav', '[data-drop-folder=""] .media-folder-select');await h.until('window.__flatDrop.ready','root move held for sidebar collapse');
  await h.label('收起音频列表');await h.until("getComputedStyle(document.querySelector('#media-panel')).display==='none'",'media panel hidden');await releaseMove();
  await h.until("document.querySelector('.media-move-review')?.textContent.includes('查看目标')",'destination retained in hidden sidebar');
  await h.label('展开音频列表');await h.clickText('查看目标');await h.until("document.activeElement?.closest('[data-drop-folder]')?.dataset.dropFolder===''",'root destination focused after reopening sidebar');
  check('A move completing with the sidebar hidden leaves its destination action available when reopened');
  await h.menu('快捷键','帮助');await h.until("document.querySelector('dialog[open]')?.matches(':modal')",'native help dialog is modal');
  const modalFocus=await h.evaluate("return document.activeElement?.outerHTML");
  const listeners=await h.evaluate(`const event='tauri://drag-enter',entries=window.__internal_unstable_listeners_object_id__?.[event],ids=Object.getOwnPropertyNames(entries??{});
    for(const id of ids)window.__TAURI_INTERNALS__.runCallback(entries[id].handlerId,{event,id:Number(id),payload:{paths:['C:/disposable.wav'],position:{x:20,y:20}}});return ids.length;`);
  assert.ok(listeners>0,'native drag listener registered');
  await h.until("document.querySelector('dialog[open] .drop-notice')?.textContent.includes('请先关闭当前窗口')",'drop refusal appears inside native dialog');
  const modalNotice=await h.evaluate(`const d=document.querySelector('dialog[open]'),n=d.querySelector('.drop-notice'),r=n.getBoundingClientRect(),b=d.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,e=document.elementFromPoint(x,y);
    const style=getComputedStyle(n),lum=color=>{const rgb=color.match(/[\\d.]+/g).slice(0,3).map(Number).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;});return .2126*rgb[0]+.7152*rgb[1]+.0722*rgb[2];};
    const a=lum(style.color),c=lum(style.backgroundColor),contrast=(Math.max(a,c)+.05)/(Math.min(a,c)+.05);
    return {visible:r.width>0&&r.height>0&&x>=b.left&&x<=b.right&&y>=b.top&&y<=b.bottom,hitInDialog:e===d||d.contains(e),status:n.getAttribute('role'),focus:document.activeElement?.outerHTML,focusable:n.querySelectorAll('button,a,[tabindex]').length,contrast};`);
  assert.equal(modalNotice.visible,true);assert.equal(modalNotice.hitInDialog,true);assert.equal(modalNotice.status,'status');assert.equal(modalNotice.focus,modalFocus);assert.equal(modalNotice.focusable,0);assert.ok(modalNotice.contrast>=4.5);
  report.modalNotice=modalNotice;await h.screenshot('drop-refusal-in-help');check('A simulated native drag refusal is visible and announced inside the real modal HelpDialog without moving focus');
  report.passed = true;
} catch (error) {
  report.error = error.stack; report.state = await h?.evaluate("return {text:document.body.innerText,focus:document.activeElement?.getAttribute('aria-label'),requests:window.__noopResult?.requests}").catch(() => null); console.error(error); await h?.screenshot('failure').catch(() => {}); process.exitCode = 1;
} finally {
  await h?.quit().catch(() => {}); await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
}
