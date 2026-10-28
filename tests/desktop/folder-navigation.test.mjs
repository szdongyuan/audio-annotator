import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { start, Key } from './harness.mjs';
import { newProject, importDirect, folder, snapshot, organization, status, wav, hash } from './workspace-helpers.mjs';
import { read } from './identity-helpers.mjs';

const exe = process.env.ANNOTATOR_WORKSPACE_EXE;
assert.ok(exe, 'Set ANNOTATOR_WORKSPACE_EXE to the current E2E executable');
const root = path.resolve(process.env.ANNOTATOR_SUITE_OUTPUT ?? '.test-output/folder-navigation');
await fs.mkdir(root, { recursive: true });
const output = await fs.mkdtemp(path.join(root, 'desktop-'));
const project = path.join(output, 'project');
await fs.mkdir(project);
const sources = [];
for (const [i, name] of ['first.wav', 'second.wav'].entries()) {
  const source = path.join(output, name);
  await fs.writeFile(source, wav({ seconds: 2, channels: 1, rate: i === 0 ? 8000 : 11025 }));
  sources.push(source);
}
let h;
const report = { output, checks: [], method: 'Isolated local project; real Selenium folder, audio, menu clicks and arrow keys; read-only native assertions.' };
const check = name => { report.checks.push(name); console.log('PASS', name); };
const key = value => h.driver.actions().sendKeys(value).perform();
const clickFolder = title => h.click(`.media-folder-select[title=${JSON.stringify(title)}]`);
const row = name => `.media-select[aria-label=${JSON.stringify(name)}]`;
const selected = async name => {
  await h.until(`document.querySelector('.file-pane h2')?.textContent===${JSON.stringify(name)}&&!document.querySelector('.tile-status')`, 'main pane selects target');
  await h.until(`document.activeElement?.matches(${JSON.stringify(row(name))})&&document.activeElement?.getAttribute('aria-pressed')==='true'`, 'target row receives keyboard focus');
  const bounds = await h.evaluate("const r=document.activeElement.getBoundingClientRect(),p=document.activeElement.closest('.media-items').getBoundingClientRect();return {top:r.top,bottom:r.bottom,parentTop:p.top,parentBottom:p.bottom};");
  assert.ok(bounds.top >= bounds.parentTop - 1 && bounds.bottom <= bounds.parentBottom + 1, 'selected audio is within the list viewport');
};

try {
  h = await start({ '新建项目 · 选择空文件夹': [project], '': [[sources[0]], [sources[1]]] }, output, exe);
  await newProject(h);
  await folder(h, 'A');
  await clickFolder('A');
  await folder(h, 'A leaf', 'A');
  await clickFolder('A/A leaf');
  await importDirect(h, 1);
  await folder(h, 'B');
  await clickFolder('B');
  await folder(h, 'B leaf', 'B');
  await clickFolder('B/B leaf');
  await importDirect(h, 2);
  const before = await snapshot(h), layout = await organization(h);
  const audioHashes = new Map(await Promise.all(before.media.map(async media => [media.id, hash(await fs.readFile(path.join(project, media.sourceRef)))])));

  await clickFolder('A/A leaf');
  await h.click(row('first.wav'));
  await selected('first.wav');
  assert.equal(await h.evaluate("return document.querySelectorAll('.media-select').length"), 1, 'selected leaf contains exactly one displayed file');
  await h.label('折叠文件夹 · B');
  await key(Key.ARROW_DOWN);
  await selected('second.wav');
  assert.equal(await h.evaluate("return document.querySelector('.media-folder-select:not([title])')?.getAttribute('aria-pressed')"), 'true');
  for (const name of ['B', 'B leaf']) assert.equal(await (await h.element(`[aria-label="折叠文件夹 · ${name}"]`)).getAttribute('aria-expanded'), 'true');
  await key(Key.ARROW_UP);
  await selected('first.wav');
  check('ArrowDown leaves a one-file selected leaf, opens sibling ancestors, selects the main audio and focuses/scrolls its row; ArrowUp returns');
  await h.screenshot('cross-folder-navigation');

  await h.input('搜索音频', 'first');
  await h.click('[aria-label="搜索音频"]');
  await key(Key.ARROW_DOWN);
  assert.equal(await h.evaluate("return document.querySelector('.file-pane h2')?.textContent"), 'first.wav');
  assert.equal(await h.evaluate("return document.activeElement?.getAttribute('aria-label')"), '搜索音频');
  await h.input('搜索音频', '');
  check('Arrow keys in search editing leave the selected main audio unchanged');

  await h.click(row('first.wav'));
  await h.context(row('first.wav'));
  await h.label('移入共享回收站…');
  await h.click('[role="dialog"] .dialog-actions .button-accent');
  await h.until('!document.querySelector("[role=dialog]")', 'recycle completes');
  await h.until("document.querySelector('.media-folder-select[title=\"A/A leaf\"] .count')?.textContent==='0'", 'leaf now has zero visible audio');
  await h.label('文件夹操作 · A leaf');
  const remove = await h.element('[role="menuitem"][aria-label="删除空文件夹…（仍有关联音频）"]');
  assert.equal(await remove.getAttribute('aria-disabled'), 'true');
  assert.match(await remove.getAttribute('title'), /其中 1 个在共享回收站/);
  assert.match(await remove.getAttribute('title'), /当前列表视图/);
  await remove.click();
  assert.equal(await h.evaluate('return !!document.querySelector("[role=dialog]")'), false, 'disabled delete cannot open confirmation');
  await h.screenshot('zero-visible-folder-reason');
  await key(Key.ESCAPE);

  const current = await status(h);
  const recycled = await read(h, 'recycle_get', { binding: { projectId: current.projectId, runtimeNonce: current.runtimeNonce } });
  assert.deepEqual(recycled.recycle.trashed.map(item => item.mediaId), [before.media.find(media => media.displayName === 'first.wav').id]);
  assert.deepEqual((await organization(h)).folders, layout.folders);
  assert.deepEqual((await organization(h)).media, layout.media);
  for (const media of before.media) assert.equal(hash(await fs.readFile(path.join(project, media.sourceRef))), audioHashes.get(media.id));
  check('Zero-visible recycled folder explains the disabled delete; folder associations and physical audio remain intact');
  report.passed = true;
} catch (error) {
  report.error = error.stack;
  console.error(error);
  await h?.screenshot('failure').catch(() => {});
  process.exitCode = 1;
} finally {
  await h?.quit().catch(() => {});
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
