import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { start, Key } from './harness.mjs';
import * as w from './workspace-helpers.mjs';

const base = path.resolve(process.env.ANNOTATOR_SUITE_OUTPUT ?? '.test-output/random-navigation');
await fs.mkdir(base, { recursive: true });
const output = await fs.mkdtemp(path.join(base, 'actual-'));
const project = path.join(output, 'project');
await fs.mkdir(project);
const names = ['A-current.wav', 'B-unique-search-target.wav', 'C-file-tag.wav', 'D-channel-tag.wav', 'E-region-tag.wav'];
const audio = names.map(name => path.join(output, name));
for (const file of audio) await fs.writeFile(file, w.wav({ seconds: 4 }));
const executable = process.env.ANNOTATOR_WORKSPACE_EXE ?? path.resolve('target/debug/annotator-desktop.exe');
const report = {
  output, executable, passed: false,
  method: 'Owned Windows Tauri/WebView2 process and matching EdgeDriver. Real WebDriver mouse/keyboard classification and navigation; native snapshot/playback IPC is read-only. E2E picker paths only. No subjective listening claim.',
  checks: [],
};
let h;
const primary = '.file-pane[data-pane="primary"]';
const fileLabels = `${primary} .file-heading .classification-control`;
const channelLabels = `${primary} .channel-pane:first-child .classification-control`;
const plot = `${primary} .channel-pane:first-child .annotation-overlay`;
const row = name => `.media-select[aria-label=${JSON.stringify(name)}]`;
const check = (name, details = {}) => {
  report.checks.push({ name, passed: true, ...details });
  console.log(`PASS ${name}`);
};
const key = value => h.driver.actions().sendKeys(value).perform();
async function selected(name, focus = false) {
  await h.until(`document.querySelector('${primary} h2')?.textContent===${JSON.stringify(name)}
    && document.querySelector(${JSON.stringify(row(name))})?.getAttribute('aria-pressed')==='true'
    && document.querySelector('${primary}')?.classList.contains('is-playback-source')
    && document.querySelector('.playback-bar')?.title===${JSON.stringify(`播放源：${name}`)}
    ${focus ? `&& document.activeElement===document.querySelector(${JSON.stringify(row(name))})` : ''}`,
  `primary, playback source${focus ? ' and completed navigation focus' : ''}: ${name}`);
}
async function labels(selector, submenu, values) {
  await w.toggleLabels(h, selector, submenu, values);
}
async function playing(mediaId) {
  return h.driver.wait(async () => {
    const status = await w.playback(h);
    return status.mediaId === mediaId && status.state === 'playing' && status.consumedFrames > 2400 ? status : false;
  }, 60000, 'native output consumes frames from selected target', 50);
}
async function unchangedPlayback(before) {
  const after = await w.playback(h);
  assert.equal(after.mediaId, before.mediaId, 'empty navigation preserves native media');
  assert.equal(after.generation, before.generation, 'empty navigation does not reconfigure');
  assert.equal(after.state, before.state, 'empty navigation does not pause/reset');
  assert.ok(after.consumedFrames >= before.consumedFrames);
  return after;
}

try {
  h = await start({ '新建项目 · 选择空文件夹': [project], '': [audio] }, output, executable, {
    localDataEnv: path.join(output, 'local-data'),
    webviewDirectory: path.join(output, 'webview'),
  });
  report.nativePid = h.nativePid;
  report.stage = 'create isolated project and classify three scopes';
  await w.newProject(h);
  await w.importDirect(h, names.length);
  const initial = await w.snapshot(h);
  const ids = Object.fromEntries(initial.media.map(media => [media.displayName, media.id]));
  await w.folder(h, '随机父目录');
  await w.folder(h, '随机子目录', '随机父目录');
  await w.moveMedia(h, names[1], '随机父目录/随机子目录');
  await w.addCategory(h, '随机测试标签');
  const categoryId = (await w.snapshot(h)).categories.find(category => category.name === '随机测试标签').id;
  await h.selectMedia(names[2]);
  await labels(fileLabels, '文件类别', ['随机测试标签']);
  await w.expectDocument(h, d => d.media.find(m => m.id === ids[names[2]]).categoryIds.includes(categoryId), 'file classified by UI');
  await h.selectMedia(names[3]);
  await labels(channelLabels, '通道类别', ['随机测试标签']);
  await w.expectDocument(h, d => d.media.find(m => m.id === ids[names[3]]).channelCategoryIds[0].includes(categoryId), 'channel classified by UI');
  await h.selectMedia(names[4]);
  await h.drag(plot, [.2, .25], [.6, .65]);
  await h.until("document.querySelector('.is-temporary.is-selected')");
  await h.context(plot, [.4, .45]);
  await h.label('标注类型');
  await h.label('随机测试标签');
  await w.escape(h);
  await w.escape(h);
  await w.expectDocument(h, d => d.annotations.some(a => a.region.mediaId === ids[names[4]] && a.categoryIds.includes(categoryId)), 'region classified by UI');
  check('file/channel/region tags established through real controls');

  report.stage = 'collapsed nested folder without search';
  await h.input('搜索音频', '');
  await h.click('.media-items > .media-folder-row > .media-folder-select');
  await h.selectMedia(names[0]);
  for (const name of ['随机父目录', '随机子目录']) {
    if (await h.evaluate(`return !!document.querySelector(${JSON.stringify(`[aria-label="展开文件夹 · ${name}"]`)})`)) {
      await h.label(`展开文件夹 · ${name}`);
    }
  }
  // Keep the real device stream active across the R transition, without audible output.
  await h.label('监听增益');
  await (await h.element('[aria-label="输出音量"]')).sendKeys(Key.HOME);
  await w.escape(h);
  await h.label('循环播放');
  await h.click(row(names[0]));
  await key(Key.SPACE);
  const oldPlayback = await playing(ids[names[0]]);
  await h.label('折叠文件夹 · 随机子目录');
  await h.label('折叠文件夹 · 随机父目录');
  assert.equal(await h.evaluate(`return !!document.querySelector(${JSON.stringify(row(names[1]))})`), false);
  await h.click(row(names[0]));
  await key('r');
  await selected(names[1], true);
  assert.equal(await h.evaluate("return document.querySelector('[aria-label=搜索音频]').value"), '');
  for (const name of ['随机父目录', '随机子目录']) {
    assert.equal(await (await h.element(`[aria-label="折叠文件夹 · ${name}"]`)).getAttribute('aria-expanded'), 'true');
  }
  const visibility = await h.evaluate(`const e=document.querySelector(${JSON.stringify(row(names[1]))}),r=e.getBoundingClientRect(),p=e.closest('.media-items').getBoundingClientRect();return {visible:!!e.getClientRects().length,top:r.top,bottom:r.bottom,listTop:p.top,listBottom:p.bottom,height:innerHeight};`);
  assert.equal(visibility.visible, true);
  assert.ok(visibility.top >= visibility.listTop && visibility.bottom <= Math.min(visibility.listBottom, visibility.height), JSON.stringify(visibility));
  await h.driver.wait(async () => (await w.playback(h)).state !== 'playing', 60000, 'R stops previous native stream');
  assert.equal(await h.evaluate("return !!document.querySelector('[aria-label=\"播放 · 空格\"]')"), true);
  await h.screenshot('collapsed-folder-r-focus');
  check('R reveals both collapsed ancestors, selects and focuses visible B, stops A without autoplay', { oldPlayback, visibility, after: await w.playback(h) });

  report.stage = 'separate search range with two noncurrent unclassified files';
  await h.selectMedia(names[2]);
  await labels(fileLabels, '文件类别', ['清空标签']);
  await w.expectDocument(h, d => d.media.find(m => m.id === ids[names[2]]).categoryIds.length === 0, 'C unclassified by UI');
  await h.selectMedia(names[0]);
  await h.input('搜索音频', 'B-unique-search-target');
  await h.until(`document.querySelectorAll('.media-select').length===1&&document.querySelector(${JSON.stringify(row(names[1]))})`);
  await h.click(`${primary} h2`);
  assert.notEqual(await h.evaluate("return document.activeElement?.getAttribute('aria-label')"), '搜索音频');
  await key('r');
  await selected(names[1], true);
  assert.equal(await h.evaluate("return document.querySelector('[aria-label=搜索音频]').value"), 'B-unique-search-target');
  await h.screenshot('search-range-r-focus');
  check('search excludes unclassified C and R selects only matching B');

  report.stage = 'R then space, pause, UI classification then R';
  await key(Key.SPACE);
  const targetPlayback = await playing(ids[names[1]]);
  await key(Key.SPACE);
  await h.driver.wait(async () => (await w.playback(h)).state === 'paused', 60000, 'space pauses B');
  await h.input('搜索音频', '');
  await h.selectMedia(names[0]);
  await labels(fileLabels, '文件类别', ['随机测试标签']);
  await w.expectDocument(h, d => d.media.find(m => m.id === ids[names[0]]).categoryIds.includes(categoryId), 'A now classified');
  await h.selectMedia(names[1]);
  await labels(fileLabels, '文件类别', ['随机测试标签']);
  await w.expectDocument(h, d => d.media.find(m => m.id === ids[names[1]]).categoryIds.includes(categoryId), 'B now classified');
  await h.click(row(names[1]));
  await key('r');
  await selected(names[2], true);
  assert.equal(await h.evaluate("return !!document.querySelector('[aria-label=\"播放 · 空格\"]')"), true);
  check('space plays/pause B using native output; newly classified B excluded on next R', { targetPlayback });

  report.stage = 'current-only and empty preserve active playback';
  await key(Key.SPACE);
  const beforeCurrentOnly = await playing(ids[names[2]]);
  await key('r');
  await h.until("document.querySelector('.media-list-content [role=status]')?.textContent==='没有其他未分类音频'");
  await selected(names[2], true);
  const afterCurrentOnly = await unchangedPlayback(beforeCurrentOnly);
  await h.screenshot('current-only-playing');
  await labels(fileLabels, '文件类别', ['随机测试标签']);
  await w.expectDocument(h, d => d.media.find(m => m.id === ids[names[2]]).categoryIds.includes(categoryId), 'last candidate classified');
  await h.click(row(names[2]));
  const beforeEmpty = await w.playback(h);
  await key('r');
  await h.until("document.querySelector('.media-list-content [role=status]')?.textContent==='当前范围内没有未分类音频'");
  await selected(names[2], true);
  const afterEmpty = await unchangedPlayback(beforeEmpty);
  await h.screenshot('empty-playing');
  check('current-only and zero candidates show accessible notices without resetting playback', { beforeCurrentOnly, afterCurrentOnly, beforeEmpty, afterEmpty });

  report.stage = 'search input owns r';
  await h.input('搜索音频', '');
  await (await h.element('[aria-label="搜索音频"]')).click();
  const beforeInput = await w.playback(h);
  await key('r');
  assert.equal(await h.evaluate("return document.querySelector('[aria-label=搜索音频]').value"), 'r');
  assert.equal(await h.evaluate(`return document.querySelector('${primary} h2').textContent`), names[2]);
  assert.equal(await h.evaluate("return document.activeElement?.getAttribute('aria-label')"), '搜索音频');
  await unchangedPlayback(beforeInput);
  await h.screenshot('search-input-r');
  check('r types into search without changing selection or playback');
  await h.label('停止');
  await w.saved(h);
  report.passed = true;
} catch (error) {
  report.error = error.stack;
  process.exitCode = 1;
  console.error(error);
  if (h) {
    try { report.ui = await h.evaluate('return document.body.innerText'); await h.screenshot('failure'); }
    catch (diagnosticError) { report.diagnosticError = diagnosticError.stack; }
  }
} finally {
  if (h) {
    try { await h.quit(); }
    catch (cleanupError) { report.cleanupError = cleanupError.stack; report.passed = false; process.exitCode = 1; }
  }
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
