import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { start, Key, wait } from './harness.mjs';

export async function selectionFlow(h, context) {
  await h.clickText('类别'); await h.input('类别名称', '选区测试'); await h.clickText('添加类别');
  await h.until(`document.querySelector('.category-row')`);
  const before = (await h.snapshot(context.id)).document;
  await h.drag('.annotation-overlay', [.2,.25], [.6,.7]);
  assert.equal((await h.snapshot(context.id)).document.annotations.length, before.annotations.length, 'drawing stays temporary');
  const temporaryStyle = () => h.evaluate(`const e=document.querySelector('.is-temporary');return e?{left:e.style.left,top:e.style.top,width:e.style.width,height:e.style.height,active:e.classList.contains('is-selected'),handles:e.querySelectorAll('.region-handle').length}:null`);
  const firstTemporary = await temporaryStyle(); assert.equal(firstTemporary.active, true); assert.equal(firstTemporary.handles, 8);
  await h.drag('.annotation-overlay', [.8,.1], [.9,.2]);
  const inactive = await temporaryStyle(); assert.deepEqual(inactive, { ...firstTemporary, active: false, handles: 0 });
  await h.driver.actions().sendKeys(Key.DELETE).perform();
  assert.equal((await h.snapshot(context.id)).document.edits.length, before.edits.length, 'inactive Delete cannot mask');
  await h.screenshot('inactive-outline');
  await h.drag('.annotation-overlay', [.4,.45], [.4,.45]); assert.equal((await temporaryStyle()).active, true, 'click reactivates retained outline');
  await h.drag('.annotation-overlay', [.4,.45], [.45,.45]);
  const movedTemporary = await temporaryStyle(); assert.ok(parseFloat(movedTemporary.left)>parseFloat(firstTemporary.left)); assert.equal(movedTemporary.width,firstTemporary.width,'interior drag moves without changing width');
  await h.drag('.annotation-overlay', [.8,.1], [.9,.2]);
  await h.drag('.annotation-overlay', [.2,.25], [.6,.7]);
  assert.deepEqual(await temporaryStyle(), firstTemporary, 'second blank gesture draws a replacement active region');
  assert.equal(await h.evaluate(`return document.querySelectorAll('.is-temporary').length`), 1);
  await h.screenshot('active-replacement');
  await h.context('.annotation-overlay', [.4,.45]);
  await h.label('标注类型'); await h.clickText('选区测试');
  await h.until(`document.querySelector('.annotation-inspector')`);
  let doc = (await h.snapshot(context.id)).document;
  assert.equal(doc.annotations.length, before.annotations.length + 1);
  const annotation = doc.annotations.at(-1);
  assert.equal(annotation.categoryId, doc.categories.find(c => c.name === '选区测试').id);
  await h.input('区域备注', '右键选区备注');
  await h.context('.annotation-overlay', [.4,.45]);
  await h.label('标注类型'); await h.clickText('未分类');
  await h.until(`document.querySelector('select[aria-label="区域类别"]')?.value===''`);
  doc = (await h.snapshot(context.id)).document;
  assert.equal(doc.annotations.length, 1); assert.equal(doc.annotations[0].note, '右键选区备注');
  // The restored focus is the plot, so Delete is a physical keyboard event.
  await h.driver.actions().move({origin:await h.element('.annotation-overlay')}).click().perform();
  await h.context(`[data-annotation-id="${annotation.id}"]`); await h.driver.actions().sendKeys(Key.ESCAPE).perform();
  await h.driver.actions().sendKeys(Key.DELETE).perform();
  await h.until(`document.querySelector('.mask-rect.is-selected')`);
  doc = (await h.snapshot(context.id)).document;
  assert.equal(doc.edits.length, 1); assert.deepEqual(doc.edits[0].region, annotation.region); assert.equal(doc.annotations.length, 1);
  await h.driver.actions().sendKeys(Key.DELETE).perform();
  assert.equal((await h.snapshot(context.id)).document.edits.length, 1, 'identical mask deduplicates');
  await h.label('撤销 · Ctrl Z');
  await h.until(`!document.querySelector('.mask-rect')`);
  assert.equal((await h.snapshot(context.id)).document.annotations.length, 1);

  // First blank gesture deactivates; the second creates the next temporary range.
  await h.drag('.annotation-overlay', [.65,.2], [.9,.6]);
  await h.drag('.annotation-overlay', [.65,.2], [.9,.6]);
  await h.label('循环播放');
  const playbackStatus = () => h.driver.executeAsyncScript('const done=arguments[arguments.length-1];window.__TAURI_INTERNALS__.invoke("playback_status",{}).then(done);');
  const awaitNativeOutput = (mediaId, priorGeneration) => h.driver.wait(async () => {
    const status = await playbackStatus();
    return status.mediaId === mediaId && status.generation > priorGeneration && status.consumedFrames > 4800 && status.deviceChannels > 0 && status.state === 'playing' ? status : false;
  }, 60000, 'new native generation must consume actual device frames', 50);
  const played = [];
  for (const label of ['试听选区原音', '试听选区（应用屏蔽）']) {
    const priorGeneration = (await playbackStatus()).generation;
    await h.context('.annotation-overlay', [.8,.4]); await h.label(label);
    const status = await awaitNativeOutput(before.media[0].id, priorGeneration);
    assert.equal(await h.evaluate('return document.querySelector("select[aria-label=声音版本]").value'), 'processed', 'explicit audition preserves workspace source');
    assert.equal(status.underrunFrames, 0); played.push({ label, status });
    await h.label('停止');
  }
  assert.equal((await h.snapshot(context.id)).document.annotations.length, 1);
  const frames = await h.evaluate(`return [...document.querySelectorAll('.annotation-rect')].map(e=>({class:e.className,background:getComputedStyle(e).backgroundColor,image:getComputedStyle(e).backgroundImage,shadow:getComputedStyle(e).boxShadow}))`);
  assert.ok(frames.every(f => f.background === 'rgba(0, 0, 0, 0)' && f.image === 'none' && f.shadow === 'none'));
  await h.screenshot('selection-transparent');
  await h.context('.annotation-overlay', [.98,.98]);
  const menu = await h.evaluate(`return [...document.querySelectorAll('[role="menu"]')].map(e=>{const r=e.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:innerWidth,height:innerHeight}})`);
  assert.ok(menu.every(r => r.left >= 0 && r.top >= 0 && r.right <= r.width && r.bottom <= r.height));
  await h.driver.actions().sendKeys(Key.ARROW_DOWN, Key.ARROW_RIGHT).perform();
  const nestedMenu = await h.evaluate(`return [...document.querySelectorAll('[role="menu"]')].map(e=>{const r=e.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:innerWidth,height:innerHeight}})`);
  assert.equal(nestedMenu.length,2,'keyboard opens a real nested context menu');
  assert.ok(nestedMenu.every(r=>r.left>=0&&r.top>=0&&r.right<=r.width&&r.bottom<=r.height));
  await h.screenshot('selection-menu');
  await h.driver.actions().sendKeys(Key.ESCAPE, Key.ESCAPE).perform();
  await h.clickText('双文件对比'); await h.until(`document.querySelectorAll('.file-pane').length===2 && !document.querySelector('.tile-status')`);
  assert.equal(await h.evaluate(`return document.querySelector('.file-pane:last-child .channel-select')===null`),true,'mono comparison hides meaningless channel selectors');
  const second = '.file-pane:last-child .annotation-overlay';
  const priorCompareDraw = await temporaryStyle();
  await h.drag(second, [.2,.25], [.6,.7]);
  assert.equal(await h.evaluate(`return document.querySelectorAll('.annotation-rect.is-selected').length`), 0, 'first comparison blank gesture only deactivates the global active selection');
  assert.deepEqual(await temporaryStyle(), { ...priorCompareDraw, active: false, handles: 0 });
  await h.drag(second, [.2,.25], [.6,.7]); await h.context(second, [.4,.45]); await h.label('备注');
  await h.until(`document.activeElement?.getAttribute('aria-label')==='区域备注'`);
  await h.input('区域备注', '来自对比面板');
  doc = (await h.snapshot(context.id)).document;
  const compared = doc.annotations.find(a => a.region.mediaId === before.media[1].id);
  assert.ok(compared); assert.equal(compared.note, '来自对比面板');
  const priorCompareGeneration = (await playbackStatus()).generation;
  await h.context(second, [.4,.45]); await h.label('试听选区（应用屏蔽）');
  const comparePlayback = await awaitNativeOutput(before.media[1].id, priorCompareGeneration); assert.equal(comparePlayback.underrunFrames, 0); await h.label('停止');
  await h.context(second, [.4,.45]); await h.label('屏蔽选区'); await h.until(`document.querySelector('.mask-rect.is-selected')`);
  await h.context(second, [.4,.45]); await h.label('重叠对象'); await h.label('未分类标注 2');
  await h.context(second, [.4,.45]); await h.label('删除标注');
  doc = (await h.snapshot(context.id)).document; assert.equal(doc.annotations.length, 1); assert.equal(doc.edits.length, 1, 'explicit annotation delete retains overlapping mask');
  await h.context('.mask-rect'); await h.driver.actions().sendKeys(Key.ESCAPE).perform();
  // Context opening is neutral; explicitly select the retained mask before moving it.
  await h.click('.mask-rect');
  await h.until(`document.querySelector('.mask-rect.is-selected')`);
  const maskBefore = doc.edits[0];
  await h.drag('.mask-rect', [.005,.3], [.1,.3]);
  doc = (await h.snapshot(context.id)).document; assert.notEqual(doc.edits[0].region.startSeconds, maskBefore.region.startSeconds, 'border moves mask');
  const borderMovedMask = doc.edits[0];
  await h.drag('.mask-rect', [.5,.5], [.6,.5]);
  doc = (await h.snapshot(context.id)).document; assert.notEqual(doc.edits[0].region.startSeconds, borderMovedMask.region.startSeconds, 'active mask interior moves its persistent geometry');
  assert.equal(doc.edits.length, 1); assert.equal(await h.evaluate(`return document.querySelectorAll('.is-temporary').length`), 0);
  const movedMask = doc.edits[0]; await h.drag('.mask-rect .handle-e', [.5,.5], [2,.5]);
  doc = (await h.snapshot(context.id)).document; assert.notEqual(doc.edits[0].region.endSeconds, movedMask.region.endSeconds, 'handle resizes mask');
  await h.context('.mask-rect'); await h.label('放大到选区'); await wait(400);
  const beforePan = (await h.snapshot(context.id)).document, panMedia = beforePan.edits[0].region.mediaId;
  await h.driver.actions().keyDown(Key.ALT).perform();
  try { await h.drag(second, [.5,.5], [.65,.5]); } finally { await h.driver.actions().keyUp(Key.ALT).perform(); }
  await h.driver.wait(async () => (await h.snapshot(context.id)).document.viewState.media[panMedia].startSeconds !== beforePan.viewState.media[panMedia].startSeconds, 10000, 'Alt-left drag must pan the zoomed view');
  const afterPan = (await h.snapshot(context.id)).document;
  assert.deepEqual(afterPan.edits[0].region, beforePan.edits[0].region, 'pan priority leaves mask geometry unchanged');
  assert.equal(await h.evaluate(`return document.querySelectorAll('.mask-rect.is-selected').length`),1);
  await h.context(second); await h.label('重置当前视图');
  await h.screenshot('selection-compare-context');
  await h.clickText('保存');
  return { activation: { firstTemporary, inactive, movedTemporary, priorCompareDraw }, pan: { before: beforePan.viewState.media[panMedia], after: afterPan.viewState.media[panMedia], regionBefore: beforePan.edits[0].region, regionAfter: afterPan.edits[0].region }, played, comparePlayback, frames, menu, nestedMenu, finalDocument: (await h.snapshot(context.id)).document };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const output = path.resolve(process.env.ANNOTATOR_SELECTION_OUTPUT ?? '.test-output/fidelity-release/selection'); await fs.mkdir(output, { recursive: true });
  const project = await fs.mkdtemp(path.join(output, 'project-'));
  const paths = { '新建项目 · 选择空文件夹': [project], '': [[path.resolve('tests/fixtures/audio/stereo.mp3'), path.resolve('tests/fixtures/audio/mono16.wav')]] };
  const report = { method: 'Owned native Tauri process, official tauri-driver and EdgeDriver; native picker paths only use the e2e feature. Edits use WebDriver pointer/keyboard.', output };
  let h;
  try {
    h = await start(paths, output); await h.menu('新建项目'); await h.until(`document.querySelector('.project-identity')?.innerText.includes('已保存')`);
    const id = JSON.parse(await fs.readFile(path.join(project, 'project.json'), 'utf8')).projectId;
    await h.clickText('导入音频'); await h.until(`document.querySelector('.import-progress')?.innerText.includes('导入完成')`); await h.clickText('关闭导入结果'); await h.until(`document.querySelector('canvas') && !document.querySelector('.tile-status')`);
    report.evidence = await selectionFlow(h, { id }); report.passed = true;
  } catch (error) { report.error = error.stack; process.exitCode = 1; await h?.screenshot('failure').catch(() => {}); }
  finally { await h?.quit(); await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); }
}
