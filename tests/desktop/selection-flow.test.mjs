import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { start, Key, wait } from './harness.mjs';

export async function selectionFlow(h, context) {
  await h.clickText('类别'); await h.input('类别名称', '选区测试'); await h.clickText('添加类别');
  await h.until(`document.querySelector('.category-row')`);
  const before = (await h.snapshot(context.id)).document;
  const primaryName=await h.evaluate(`return document.querySelector('.file-pane h2').textContent`),primaryId=before.media.find(m=>m.displayName===primaryName)?.id;
  assert.ok(primaryId,'the actual visible primary pane has a catalog identity');
  await h.drag('.annotation-overlay', [.2,.25], [.6,.7]);
  assert.equal((await h.snapshot(context.id)).document.annotations.length, before.annotations.length, 'drawing stays temporary');
  const temporaryStyle = () => h.evaluate(`const e=document.querySelector('.is-temporary');return e?{left:e.style.left,top:e.style.top,width:e.style.width,height:e.style.height,active:e.classList.contains('is-selected'),handles:e.querySelectorAll('.region-handle').length}:null`);
  const firstTemporary = await temporaryStyle(); assert.equal(firstTemporary.active, true); assert.equal(firstTemporary.handles, 8);
  await h.drag('.annotation-overlay', [.8,.1], [.9,.2]);
  const inactive = await temporaryStyle(); assert.equal(inactive, null, 'first external gesture clears temporary frame and candidate');
  await h.driver.actions().sendKeys(Key.DELETE).perform();
  assert.equal((await h.snapshot(context.id)).document.edits.length, before.edits.length, 'inactive Delete cannot mask');
  await h.screenshot('inactive-outline');
  await h.drag('.annotation-overlay', [.4,.45], [.4,.45]); assert.equal(await temporaryStyle(), null, 'plain click keeps no retained outline');
  assert.ok(await h.evaluate("return !!document.querySelector('.audio-cue')"));
  await h.drag('.annotation-overlay', [.2,.25], [.6,.7]);
  await h.drag('.annotation-overlay', [.4,.45], [.45,.45]);
  const movedTemporary = await temporaryStyle(); assert.ok(parseFloat(movedTemporary.left)>parseFloat(firstTemporary.left)); assert.equal(movedTemporary.width,firstTemporary.width,'interior drag moves without changing width');
  await h.drag('.annotation-overlay', [.8,.1], [.9,.2]);
  await h.drag('.annotation-overlay', [.2,.25], [.6,.7]);
  assert.deepEqual(await temporaryStyle(), firstTemporary, 'second blank gesture draws a replacement active region');
  assert.equal(await h.evaluate(`return document.querySelectorAll('.is-temporary').length`), 1);
  await h.screenshot('active-replacement');
  await h.context('.annotation-overlay', [.4,.45]);
  await h.label('标注类型'); await h.label('选区测试'); await h.driver.actions().sendKeys(Key.ESCAPE,Key.ESCAPE).perform();
  await h.until(`document.querySelector('.annotation-inspector')`);
  let doc = (await h.snapshot(context.id)).document;
  assert.equal(doc.annotations.length, before.annotations.length + 1);
  const annotation = doc.annotations.at(-1);
  assert.deepEqual(annotation.categoryIds,[ doc.categories.find(c => c.name === '选区测试').id]);
  await h.input('区域备注', '右键选区备注');
  await h.context('.annotation-overlay', [.4,.45]);
  await h.label('标注类型'); await h.label('清空标签');await h.driver.actions().sendKeys(Key.ESCAPE,Key.ESCAPE).perform();
  await h.driver.wait(async()=>(await h.snapshot(context.id)).document.annotations[0].categoryIds.length===0,30000);
  doc = (await h.snapshot(context.id)).document;
  assert.equal(doc.annotations.length, 1); assert.equal(doc.annotations[0].note, '右键选区备注');
  // The restored focus is the plot, so Delete is a physical keyboard event.
  await h.driver.actions().move({origin:await h.element('.annotation-overlay')}).click().perform();
  await h.context(`[data-annotation-id="${annotation.id}"]`); await h.driver.actions().sendKeys(Key.ESCAPE).perform();
  await h.driver.actions().sendKeys(Key.DELETE).perform();
  await h.driver.wait(async()=>(await h.snapshot(context.id)).document.edits.length===1,30000);
  assert.equal(await h.evaluate("return document.querySelector('.mask-rect')"),null);
  doc = (await h.snapshot(context.id)).document;
  assert.equal(doc.edits.length, 1); assert.deepEqual(doc.edits[0].region, annotation.region); assert.equal(doc.annotations.length, 1);
  await h.click(`[data-annotation-id="${annotation.id}"]`);await h.driver.actions().sendKeys(Key.DELETE).perform();
  assert.equal((await h.snapshot(context.id)).document.edits.length, 1, 'identical mask deduplicates');
  await h.label('撤销 · Ctrl Z');
  await h.driver.wait(async()=>(await h.snapshot(context.id)).document.edits.length===0,30000);
  assert.equal((await h.snapshot(context.id)).document.annotations.length, 1);

  // First blank gesture deactivates; the second creates the next temporary range.
  await h.drag('.annotation-overlay', [.65,.2], [.9,.6]);
  await h.drag('.annotation-overlay', [.65,.2], [.9,.6]);
  await h.label('循环播放');
  const playbackStatus = () => h.driver.executeAsyncScript('const done=arguments[arguments.length-1];window.__TAURI_INTERNALS__.invoke("collaboration_status").then(s=>window.__TAURI_INTERNALS__.invoke("playback_status",{runtimeNonce:s.runtimeNonce})).then(done,e=>done({error:e}));');
  const awaitNativeOutput = async (mediaId, priorGeneration) => {
    let lastStatus;
    try{return await h.driver.wait(async () => {
      const status = lastStatus = await playbackStatus();
      return status.mediaId === mediaId && status.generation > priorGeneration && status.consumedFrames > 4800 && status.deviceChannels > 0 && status.state === 'playing' ? status : false;
    }, 60000, 'new native generation must consume actual device frames', 50);}
    catch(error){throw Error(`${error.message}; context=${JSON.stringify({mediaId,priorGeneration,privateActiveMediaId:before.viewState.activeMediaId,primaryName,primaryId,lastStatus})}`);}
  };
  const played = [];
  for (const label of ['试听选区原音', '试听选区（应用屏蔽）']) {
    const priorGeneration = (await playbackStatus()).generation;
    await h.context('.annotation-overlay', [.8,.4]); await h.label(label);
    const status = await awaitNativeOutput(primaryId, priorGeneration);
    assert.equal(await h.evaluate('return document.querySelector("select[aria-label=声音版本]").value'), 'processed', 'explicit audition preserves workspace source');
    assert.equal(status.underrunFrames, 0); played.push({ label, expectedMediaId:primaryId, privateActiveMediaId:before.viewState.activeMediaId, primaryName, status });
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
  await h.until("document.querySelectorAll('[role=menu]').length===2&&[...document.querySelectorAll('[role=menu]')].every(e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight;})",'nested menu placement committed');
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
  assert.equal(await temporaryStyle(), null, 'comparison deactivation clears the temporary candidate');
  await h.drag(second, [.2,.25], [.6,.7]); await h.context(second, [.4,.45]); await h.label('备注');
  await h.until(`document.activeElement?.getAttribute('aria-label')==='区域备注'`);
  await h.input('区域备注', '来自对比面板');
  doc = (await h.snapshot(context.id)).document;
  const compared = doc.annotations.find(a => a.region.mediaId === before.media.find(m=>m.id!==primaryId).id);
  assert.ok(compared); assert.equal(compared.note, '来自对比面板');
  const priorCompareGeneration = (await playbackStatus()).generation;
  await h.context(second, [.4,.45]); await h.label('试听选区（应用屏蔽）');
  const comparePlayback = await awaitNativeOutput(before.media.find(m=>m.id!==primaryId).id, priorCompareGeneration); assert.equal(comparePlayback.underrunFrames, 0); await h.label('停止');
  await h.context(second, [.4,.45]); await h.label('屏蔽选区'); await h.driver.wait(async()=>(await h.snapshot(context.id)).document.edits.length===1,30000);
  assert.equal(await h.evaluate("return document.querySelector('.mask-rect')"),null,'DSP is absent from overlay hits');
  await h.click(`[data-annotation-id="${compared.id}"]`);
  await h.context(second, [.4,.45]); await h.label('删除标注');
  doc = (await h.snapshot(context.id)).document; assert.equal(doc.annotations.length, 1); assert.equal(doc.edits.length, 1, 'explicit annotation delete retains overlapping mask');
  await h.context(second); await h.driver.actions().sendKeys(Key.ESCAPE).perform();
  // Removed edit-frame interactions now prove DSP geometry cannot be hit/moved.
  const maskBefore = doc.edits[0];
  await h.drag(second, [.005,.3], [.1,.3]);
  doc = (await h.snapshot(context.id)).document; assert.deepEqual(doc.edits[0].region, maskBefore.region, 'blank drag cannot move a DSP border');
  const borderMovedMask = doc.edits[0];
  await h.drag(second, [.5,.5], [.6,.5]);
  doc = (await h.snapshot(context.id)).document; assert.deepEqual(doc.edits[0].region, borderMovedMask.region, 'blank interior gesture cannot change DSP geometry');
  assert.equal(doc.edits.length, 1);await h.driver.actions().sendKeys(Key.ESCAPE).perform();
  assert.equal(await h.evaluate(`return document.querySelectorAll('.mask-rect,.region-handle').length`),0,'no DSP resize handles');
  await h.clickText('处理');await h.label('定位屏蔽 1');await wait(400);
  const beforePan = (await h.snapshot(context.id)).document, panMedia = beforePan.edits[0].region.mediaId;
  await h.driver.actions().keyDown(Key.ALT).perform();
  try { await h.drag(second, [.5,.5], [.65,.5]); } finally { await h.driver.actions().keyUp(Key.ALT).perform(); }
  await h.driver.wait(async () => (await h.snapshot(context.id)).document.viewState.media[panMedia].startSeconds !== beforePan.viewState.media[panMedia].startSeconds, 10000, 'Alt-left drag must pan the zoomed view');
  const afterPan = (await h.snapshot(context.id)).document;
  assert.deepEqual(afterPan.edits[0].region, beforePan.edits[0].region, 'pan priority leaves mask geometry unchanged');
  assert.equal(await h.evaluate(`return document.querySelectorAll('.mask-rect.is-selected').length`),0);
  await h.context(second); await h.label('重置当前视图');
  await h.screenshot('selection-compare-context');
  await h.clickText('保存');
  return { activation: { firstTemporary, inactive, movedTemporary, priorCompareDraw }, pan: { before: beforePan.viewState.media[panMedia], after: afterPan.viewState.media[panMedia], regionBefore: beforePan.edits[0].region, regionAfter: afterPan.edits[0].region }, played, comparePlayback, frames, menu, nestedMenu, finalDocument: (await h.snapshot(context.id)).document };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const output = path.resolve(process.env.ANNOTATOR_SELECTION_OUTPUT ?? process.env.ANNOTATOR_SUITE_OUTPUT ?? '.test-output/fidelity-release/selection', (process.env.ANNOTATOR_SELECTION_OUTPUT || process.env.ANNOTATOR_SUITE_OUTPUT) ? '' : `run-${Date.now()}-${process.pid}`); await fs.mkdir(output, { recursive: true });
  const project = await fs.mkdtemp(path.join(output, 'project-'));
  const paths = { '新建项目 · 选择空文件夹': [project], '': [[path.resolve('tests/fixtures/audio/stereo.mp3'), path.resolve('tests/fixtures/audio/mono16.wav')]] };
  const report = { method: 'Owned native Tauri process, official tauri-driver and EdgeDriver; native picker paths only use the e2e feature. Edits use WebDriver pointer/keyboard.', output };
  let h;
  try {
    h = await start(paths, output); await h.menu('新建项目'); await h.until(`document.querySelector('.project-identity')?.innerText.match(/已保存|已存本机/)`);
    const id = JSON.parse(await fs.readFile(path.join(project, 'collaboration.json'), 'utf8')).projectId;
    await h.clickText('导入音频'); await h.until(`document.querySelector('.import-progress')?.innerText.includes('导入完成')`); await h.clickText('关闭导入结果'); await h.until(`document.querySelector('canvas') && !document.querySelector('.tile-status')`);
    await h.selectMedia('stereo.mp3');report.evidence = await selectionFlow(h, { id }); report.passed = true;
  } catch (error) { report.error = error.stack; process.exitCode = 1; await h?.screenshot('failure').catch(() => {}); }
  finally { await h?.quit(); await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); }
}
