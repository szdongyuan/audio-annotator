import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { start, By, Key } from './harness.mjs';
import { addCategory, importDirect, newProject, saved, snapshot, status, wav } from './workspace-helpers.mjs';

const parent = path.resolve(process.env.ANNOTATOR_SUITE_OUTPUT ?? '.test-output/list-workflow');
await fs.mkdir(parent, { recursive: true });
const output = await fs.mkdtemp(path.join(parent, 'run-'));
const project = path.join(output, 'project');
await fs.mkdir(project);
const audio = ['list-a.wav', 'list-b.wav'].map(name => path.join(output, name));
for (const file of audio) await fs.writeFile(file, wav({ seconds: 3 }));
const paths = {
  '新建项目 · 选择空文件夹': [project],
  '打开项目': [path.join(project, 'collaboration.json')],
  '': [audio],
};
const report = { output, method: 'Owned native WebView2 process; WebDriver pointer/keyboard mutations and fixture picker queues only. Native IPC is read-only. Project close/reopen uses the same process.', checks: [] };
let h;
const check = name => { report.checks.push({ name, passed: true }); console.log('PASS ' + name); };
const tab = name => h.driver.findElement(By.xpath(`//button[@role='tab' and normalize-space(.)='${name}']`)).click();
const filters = () => h.evaluate(`return ['筛选类别','筛选通道','筛选备注'].map(label=>document.querySelector('[aria-label="'+label+'"]').value)`);
async function listRetained(expected, count) {
  await h.until(`document.querySelector('[role="tab"][aria-selected="true"]')?.textContent==='列表'&&!document.querySelector('.tile-status')`);
  // Let render effects finish before observing the retained tab and inputs.
  await h.driver.executeAsyncScript('const done=arguments[arguments.length-1];requestAnimationFrame(()=>requestAnimationFrame(done));');
  assert.equal(await h.evaluate(`return document.querySelector('[role="tab"][aria-selected="true"]').textContent`), '列表');
  assert.deepEqual(await filters(), expected);
  assert.equal(await h.evaluate(`return document.querySelectorAll('.annotation-row').length`), count);
  assert.match(await h.evaluate(`return document.querySelector('.annotation-list > .subtle-label').textContent`), new RegExp(`^${count} / 8 个对象`));
}
async function locate(note, expected, count) {
  const row = await h.driver.findElement(By.xpath(`//button[contains(@class,'annotation-row') and .//span[@class='note-summary' and .='${note}']]`));
  await row.click();
  const name = note.endsWith('a') ? 'list-a.wav' : 'list-b.wav';
  await h.until(`document.querySelector('.file-pane h2')?.textContent===${JSON.stringify(name)}&&!document.querySelector('.tile-status')`);
  if (note.includes('region')) {
    const doc = await snapshot(h), annotation = doc.annotations.find(a => a.note === note);
    assert.ok(annotation);
    await h.until(`document.querySelector('[data-annotation-id="${annotation.id}"].is-selected')`);
  } else {
    await h.until(`!document.querySelector('[data-annotation-id].is-selected')`);
    if (note.includes('channel')) assert.ok(await h.evaluate(`return !!document.querySelector('.channel-pane[aria-label="通道 2"]')`));
  }
  await listRetained(expected, count);
  assert.equal(await h.evaluate(`return !!document.querySelector('[aria-label="播放 · 空格"]')`), true, 'locating does not start playback');
}
async function classify(selector, submenu) {
  await h.click(selector); await h.label(submenu); await h.label('列表验收');
  await h.driver.actions().sendKeys(Key.ESCAPE, Key.ESCAPE).perform();
}
try {
  h = await start(paths, output);
  report.pid = h.nativePid;
  await newProject(h); await importDirect(h, 2); await addCategory(h, '列表验收');
  for (const letter of ['a', 'b']) {
    await h.selectMedia(`list-${letter}.wav`);
    await h.click('.file-heading h2'); await h.until(`document.querySelector('[aria-label="音频备注"]')`);
    await h.input('音频备注', `list memory file ${letter}`);
    await classify('.file-heading .classification-control', '文件类别');
    await h.click('.channel-pane[aria-label="通道 2"] .channel-caption strong');
    await h.until(`document.querySelector('[aria-label="通道 2 备注"]')`);
    await h.input('通道 2 备注', `list memory channel ${letter}`);
    await classify('.channel-pane[aria-label="通道 2"] .classification-control', '通道类别');
    await h.drag('.channel-pane[aria-label="通道 2"] .annotation-overlay', [.2, .25], [.6, .7]);
    await h.menu('标注类型', '标注'); await h.label('列表验收');
    await h.driver.actions().sendKeys(Key.ESCAPE, Key.ESCAPE).perform();
    await h.until(`document.querySelector('.annotation-inspector')`);
    await h.input('区域备注', `list memory region ${letter}`);
  }
  await saved(h);
  const initial = await snapshot(h), categoryId = initial.categories.find(c => c.name === '列表验收').id;
  assert.equal(initial.annotations.length, 2);
  await h.menu('标注列表', '标注');
  for (const note of ['file a', 'channel b', 'region a']) await locate(`list memory ${note}`, ['*', '*', ''], 8);
  check('unfiltered file/channel/region results locate across files and retain the list');
  await h.select('筛选类别', '列表验收'); await h.input('筛选备注', 'list memory');
  const allChannels = [categoryId, '*', 'list memory'];
  for (const note of ['file b', 'file a', 'channel b', 'region b', 'region b', 'region a']) await locate(`list memory ${note}`, allChannels, 6);
  await h.screenshot('filtered-continuous-results');
  check('category/query filters survive repeated, continuous, same-file and cross-file result clicks');
  await h.select('筛选通道', '通道 2');
  const expected = [categoryId, '1', 'list memory'];
  for (const note of ['channel a', 'region b', 'channel b', 'region a']) await locate(`list memory ${note}`, expected, 4);
  check('combined category/channel/query filters retain exact inputs and recomputed result count');
  await tab('类别'); await tab('列表'); await listRetained(expected, 4);
  await h.label('收起属性面板'); await h.until(`!document.querySelector('#properties-panel')`);
  await h.label('展开属性面板'); await listRetained(expected, 4);
  await h.screenshot('restored-tab-and-panel');
  check('leaving/reentering list and collapsing/reopening properties restores all filters');
  // A later edit must change derived results, while retaining all three conditions.
  await tab('区域'); await h.input('区域备注', 'no longer matches'); await saved(h);
  await tab('列表'); await listRetained(expected, 3);
  check('latest document edits recompute results instead of restoring cached rows');
  const beforeClose = await status(h);
  await h.menu('关闭项目'); await h.until(`!document.querySelector('.annotation-list')`);
  await h.menu('打开项目…'); await h.until(`document.querySelector('canvas')&&!document.querySelector('.tile-status')`);
  const reopened = await status(h);
  assert.equal(h.nativePid, report.pid); assert.equal(reopened.projectId, beforeClose.projectId);
  assert.equal(reopened.actor.authorId, beforeClose.actor.authorId);
  assert.notEqual(reopened.runtimeNonce, beforeClose.runtimeNonce);
  await tab('列表'); await listRetained(expected, 3);
  assert.equal(await h.evaluate(`return [...document.querySelectorAll('.note-summary')].some(e=>e.textContent==='list memory region a')`), false);
  await h.screenshot('same-process-project-reopen');
  check('same process closes/reopens a fresh project runtime and restores filters against latest document');
  await locate('list memory channel a', expected, 3);
  await h.click('.channel-pane[aria-label="通道 2"] .channel-caption strong');
  await h.until(`document.querySelector('[role="tab"][aria-selected="true"]')?.textContent==='文件/通道'&&document.querySelector('[aria-label="通道 2 备注"]')`);
  await tab('列表'); await locate('list memory channel a', expected, 3);
  await h.click('.file-heading h2');
  await h.until(`document.querySelector('[role="tab"][aria-selected="true"]')?.textContent==='文件/通道'&&document.querySelector('[aria-label="音频备注"]')`);
  await h.menu('标注列表', '标注'); await listRetained(expected, 3);
  await h.menu('类别管理', '标注');
  await h.until(`document.querySelector('[role="tab"][aria-selected="true"]')?.textContent==='类别'`);
  await h.screenshot('other-entry-tabs');
  check('same channel/file title and explicit menu entries retain their automatic/explicit tab behavior');
  await tab('列表'); await h.select('筛选类别', '所有类别'); await h.select('筛选通道', '所有通道'); await h.input('筛选备注', '');
  await tab('类别'); await tab('列表'); await listRetained(['*', '*', ''], 8);
  check('explicit default filters replace previous remembered values');
  await h.menu('关闭项目'); report.passed = true;
} catch (error) {
  report.error = error.stack; console.error(error);
  if (h) { report.body = await h.evaluate('return document.body.innerText').catch(e => `Diagnostic read failed: ${e.message}`); await h.screenshot('failure').catch(e => console.error('Failure screenshot:', e)); }
  process.exitCode = 1;
} finally {
  await h?.quit();
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log('Report: ' + path.join(output, 'report.json'));
}
