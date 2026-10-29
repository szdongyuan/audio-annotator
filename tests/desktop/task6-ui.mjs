import assert from 'node:assert/strict';
import { Key, wait } from './harness.mjs';
import { outputAfter, playbackStatus } from './task5-ui.mjs';

export async function toolbarUI(h, projectId, report) {
  const primary = '.file-pane[data-pane="primary"]', compare = '.file-pane[data-pane="compare"]';
  const visible = `([...document.querySelectorAll('.selection-toolbar')].filter(e=>getComputedStyle(e).visibility==='visible'))`;
  const source = () => h.evaluate(`return document.querySelector('.is-playback-source')?.dataset.pane`);
  const check = (name, details = {}) => { report.checks.push({ name, passed: true, ...details }); console.log('PASS ' + name); };
  const documentState = async () => (await h.snapshot(projectId)).document;
  async function geometry() {
    return h.evaluate(`return ${visible}.map(e=>({toolbar:e.getBoundingClientRect().toJSON(),plot:e.closest('.spectrogram-surface').getBoundingClientRect().toJSON(),scroll:e.closest('.channel-scroll').getBoundingClientRect().toJSON(),frame:e.closest('.spectrogram-surface').querySelector('.annotation-rect.is-selected').getBoundingClientRect().toJSON()}));`);
  }
  async function bounded(name) {
    await h.until(`${visible}.length===1`); const [g] = await geometry();
    assert.ok(g.toolbar.left >= g.plot.left - .5 && g.toolbar.right <= g.plot.right + .5);
    assert.ok(g.toolbar.top >= Math.max(g.plot.top, g.scroll.top) - .5 && g.toolbar.bottom <= Math.min(g.plot.bottom, g.scroll.bottom) + .5);
    check(name, g); return g;
  }
  async function draw(plot, a, b) {
    // The first outside click only deactivates. The second gesture creates a new region.
    await h.drag(plot, [.03, .96], [.03, .96]);
    await h.until(`!document.querySelector('.annotation-rect.is-selected')`);
    await h.drag(plot, a, b); await bounded('toolbar follows completed draw within its own plot');
  }
  async function heldDrag(selector, a, b, button = 0, alt = false) {
    const e = await h.element(selector), r = await e.getRect();
    const point = p => ({ x: Math.round(r.x + r.width * p[0]), y: Math.round(r.y + r.height * p[1]), origin: 'viewport' });
    await h.evaluate(`window.__task6Gesture=null;window.addEventListener('pointerdown',()=>requestAnimationFrame(()=>{window.__task6Gesture={hidden:${visible}.length===0};}),{capture:true,once:true});`);
    const action = h.driver.actions({ async: true }); if (alt) action.keyDown(Key.ALT);
    action.move(point(a)).press(button).pause(180).move({ ...point(b), duration: 180 }).release(button); if (alt) action.keyUp(Key.ALT); await action.perform();
    assert.equal(await h.evaluate('return window.__task6Gesture?.hidden'), true);
    await bounded('toolbar hides during held gesture and restores at actual updated frame');
  }
  async function bitmap() {
    await h.until(`!document.querySelector('.tile-status')`); await wait(100);
    return h.evaluate(`return [...document.querySelectorAll('canvas')].map(c=>{let hash=2166136261;for(const v of c.getContext('2d').getImageData(0,0,c.width,c.height).data)hash=Math.imul(hash^v,16777619);return {hash:hash>>>0,width:c.width,height:c.height};})`);
  }
  await h.menu('联动时间轴', '视图');
  await h.select('主面板音频', 'stereo24.wav'); await h.select('对比面板音频', 'cue-long.wav');
  await h.until(`!document.querySelector('.tile-status')`);
  await h.clickText('类别'); await h.input('类别名称', '工具条测试'); await h.clickText('添加类别'); await h.until(`document.querySelector('.category-row')`);
  const plot = `${compare} .annotation-overlay`;
  await draw(plot, [.2, .32], [.55, .72]); const temporary = await geometry();
  const beforeTemporary = await playbackStatus(h); await h.click('.selection-toolbar button:first-child'); const temporaryPlayed = await outputAfter(h, beforeTemporary.generation); await h.label('停止');
  check('temporary toolbar one-click playback consumes native frames', { temporaryPlayed });
  await h.label('stereo24.wav 设为播放源'); assert.equal(await source(), 'primary');
  await h.click('.selection-toolbar [aria-label="标注"]'); await h.label('工具条测试');await h.driver.actions().sendKeys(Key.ESCAPE).perform();
  await h.until(`document.querySelector('${compare} .annotation-rect.is-selected[data-annotation-id]')`);
  const created = (await documentState()).annotations.at(-1), id = created.id;
  assert.equal(await source(), 'primary'); assert.deepEqual(created.categoryIds,[ (await documentState()).categories.find(c => c.name === '工具条测试').id]);
  const categoryButton = await h.element('.selection-toolbar [aria-label="标注"]'); await categoryButton.sendKeys(Key.ENTER);
  await h.until(`document.querySelector('[role=menu]')`); await h.driver.actions().sendKeys(Key.HOME, Key.ENTER).perform();
  await h.driver.wait(async () => (await documentState()).annotations.find(a => a.id === id)?.categoryIds.length === 0, 30000);await h.driver.actions().sendKeys(Key.ESCAPE).perform();
  assert.equal((await documentState()).annotations.length, 1); assert.equal(await source(), 'primary');
  await h.click('.selection-toolbar [aria-label="标注"]'); await h.driver.actions().sendKeys(Key.ESCAPE).perform();
  assert.equal(await h.evaluate(`return document.activeElement?.getAttribute('aria-label')`), '标注');
  await h.driver.actions().keyDown(Key.SHIFT).sendKeys(Key.TAB).keyUp(Key.SHIFT).perform();
  assert.equal(await h.evaluate(`return document.activeElement?.getAttribute('aria-label')`), '应用区域增益');await h.driver.actions().keyDown(Key.SHIFT).sendKeys(Key.TAB).keyUp(Key.SHIFT).perform();assert.equal(await h.evaluate(`return document.activeElement?.getAttribute('aria-label')`), '试听选区版本');
  await h.driver.actions().sendKeys(Key.TAB).perform();
  assert.ok(await h.evaluate(`return !!document.querySelector('.annotation-rect.is-selected')`));
  await heldDrag('.annotation-rect.is-selected', [.5, .6], [.64, .6]);
  await h.driver.wait(async () => (await documentState()).annotations.find(a => a.id === id).region.startSeconds > created.region.startSeconds, 30000);
  const moved = (await documentState()).annotations.find(a => a.id === id); assert.equal(moved.id, id);
  await h.label('循环播放'); const beforePlay = await playbackStatus(h); await h.click('.selection-toolbar button:first-child');
  const played = await outputAfter(h, beforePlay.generation); assert.equal(played.mediaId, moved.region.mediaId); assert.ok(Math.abs(played.firstSeconds - moved.region.startSeconds) < 1/48000); assert.ok(Math.abs(played.endSeconds - moved.region.endSeconds) < 1/48000);
  await h.label('停止'); check('right comparison toolbar category creates once then updates stable ID, preserves playback source, supports keyboard and moved selection actual audio', { temporary, created, moved, played });
  await h.menu('屏蔽选区','音频'); await h.driver.wait(async()=>(await documentState()).edits.length===1,30000); await bitmap();
  const masked = (await documentState()).edits.at(-1);assert.equal(await h.evaluate(`return ${visible}.length`),0,'successful DSP clears toolbar without persistent frame');await h.click(`[data-annotation-id="${id}"]`);await bounded('saved annotation toolbar remains independently reachable after DSP');
  const auditions = [];
  for (const [workspace, label] of [['暂存编辑', '试听选区原音'], ['原音', '试听选区（应用屏蔽）']]) {
    await h.select('声音版本', workspace); const pixels = await bitmap(), previous = await playbackStatus(h);
    await h.click('.selection-toolbar [aria-label="试听选区版本"]'); await h.label(label);
    const status = await outputAfter(h, previous.generation); assert.equal(status.mediaId, masked.region.mediaId);
    assert.equal(await h.evaluate(`return document.querySelector('[aria-label="声音版本"]').selectedOptions[0].textContent`), workspace);
    assert.deepEqual(await bitmap(), pixels); auditions.push({ workspace, label, status }); await h.label('停止');
  }
  await h.click('.selection-toolbar [aria-label="标注"]'); await h.label('工具条测试');await h.driver.actions().sendKeys(Key.ESCAPE).perform();
  await h.driver.wait(async () => (await documentState()).annotations.length === 1, 30000);
  assert.equal((await documentState()).edits.length, 1); check('saved annotation label toggles one stable object independently of DSP and both opposite auditions preserve graphs', { masked, auditions });
  await h.label('循环播放'); await h.select('声音版本', '暂存编辑');
  await draw(plot, [.94, .015], [.98, .045]); const edge = await bounded('tiny top-right selection stays small with toolbar clamped inside'); assert.ok(edge.toolbar.width > edge.frame.width);
  await h.screenshot('toolbar-tiny-top-right');
  await heldDrag(`${compare} .spectrogram-surface`, [.6, .75], [.6, .75], 1);
  await heldDrag(`${compare} .spectrogram-surface`, [.6, .75], [.6, .75], 0, true);
  await h.select('主面板音频', 'six32.wav'); await h.click(`${primary} .channel-select button`); await h.until(`document.querySelectorAll('${primary} canvas').length===6`);
  const sixth = `${primary} .channel-pane:nth-child(6) .annotation-overlay`;
  await draw(sixth, [.15, .3], [.4, .65]); await h.screenshot('toolbar-sixth-channel-scrolled');
  // Native DOM scrolling fires real scroll events and changes the clipping rectangle.
  await h.evaluate(`document.querySelector('${primary} .channel-scroll').scrollTop=0`); await h.until(`${visible}.length===0`);
  await h.evaluate(`const s=document.querySelector('${primary} .channel-scroll');s.scrollTop=s.scrollHeight`); await bounded('scroll away hides toolbar; scroll back restores it within the visible channel');
  await h.click(`${primary} input[aria-label="显示通道 6"]`); await h.until(`${visible}.length===0`);
  check('hidden channel removes the active toolbar without retaining a placeholder');
}
