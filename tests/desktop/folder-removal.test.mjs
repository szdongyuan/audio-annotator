import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { start, Key, wait } from './harness.mjs';
import { newProject, importDirect, snapshot, organization, status, saved, addCategory, wav, hash, expectDocument, escape } from './workspace-helpers.mjs';
import { read } from './identity-helpers.mjs';

const exe = process.env.ANNOTATOR_WORKSPACE_EXE;
assert.ok(exe, 'Set ANNOTATOR_WORKSPACE_EXE to the candidate E2E executable');
const root = path.resolve(process.env.ANNOTATOR_SUITE_OUTPUT ?? '.test-output/folder-removal');
await fs.mkdir(root, { recursive: true });
const output = await fs.mkdtemp(path.join(root, 'desktop-'));
const projectParent = process.env.ANNOTATOR_FOLDER_REMOVAL_PROJECT_PARENT;
if (projectParent) assert.ok((await fs.stat(projectParent)).isDirectory(), 'Explicit project parent must already exist');
const project = projectParent ? path.join(path.resolve(projectParent), `.codex-folder-removal-owned-${randomUUID()}`) : path.join(output, 'project');
await fs.mkdir(project);
const sources = [];
for (const name of ['first.wav', 'second.wav', 'live.wav']) {
  const source = path.join(output, name);
  await fs.writeFile(source, wav({ seconds: 2, channels: 1, rate: 8000 }));
  sources.push(source);
}
const options = { ports: { driver: 4485, native: 4486, debug: 9275 }, localDataEnv: path.join(output, 'local'), webviewDirectory: path.join(output, 'webview') };
const report = { output, project, checks: [], fixtureSetup: [], method: 'Owned project and native processes. Real WebDriver menus, confirmations, filtering, restoration and keyboard actions. Fixture-only ordinary organization_apply/recycle_apply IPC is explicitly recorded; no store mutation or test seed hook.' };
let h;
const check = name => { report.checks.push(name); console.log('PASS', name); };
const row = name => `.media-select[aria-label=${JSON.stringify(name)}]`;
const folderSelector = title => `.media-folder-select[title=${JSON.stringify(title)}]`;
const clickFolder = title => h.click(folderSelector(title));
const binding = async () => { const s = await status(h); return { projectId: s.projectId, runtimeNonce: s.runtimeNonce }; };
const recycled = async () => { const r = await read(h, 'recycle_get', { binding: await binding() }); assert.ok(r.recycle, JSON.stringify(r)); return r.recycle; };
async function fixtureOperation(operation) {
  const deadline = performance.now() + 30000;
  let busyRetries = 0;
  for (;;) {
    const head = await organization(h);
    const result = await read(h, 'organization_apply', { binding: await binding(), expectedRevision: head.revision, operation });
    if (result.error?.code === 'ResourceLimit' && result.error?.details?.operationBusy && performance.now() < deadline) {
      busyRetries++; await wait(150); continue;
    }
    assert.ok(result.organization, JSON.stringify(result));
    report.fixtureSetup.push({ command: 'organization_apply', operation, busyRetries });
    return result.organization;
  }
}
async function createFolder(name, parentId = null) {
  const id = randomUUID(); await fixtureOperation({ type: 'createFolder', id, name, parentId }); return id;
}
async function openRemoval(name) {
  await h.label(`文件夹操作 · ${name}`); await h.label('删除文件夹…');
  await h.until("document.querySelector('[role=dialog] h2')?.textContent==='删除文件夹'");
  return h.evaluate("return document.querySelector('[role=dialog]').textContent");
}
async function dismissRemoval(action) {
  await h.clickText(action); await h.until("!document.querySelector('[role=dialog]')");
}
async function invariantFiles() {
  const result = {};
  async function collect(relative) {
    for (const entry of await fs.readdir(path.join(project, relative), { withFileTypes: true })) {
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) await collect(child);
      else if (!entry.name.endsWith('.lock')) result[child.replaceAll('\\', '/')] = hash(await fs.readFile(path.join(project, child)));
    }
  }
  for (const dir of ['media', 'authors', 'annotations', 'catalog']) await collect(dir);
  result['recycle.json'] = hash(await fs.readFile(path.join(project, 'recycle.json')));
  return result;
}
async function selected(name) {
  await h.until(`document.querySelector('.file-pane h2')?.textContent===${JSON.stringify(name)}&&!document.querySelector('.tile-status')`);
  await h.until(`document.activeElement?.matches(${JSON.stringify(row(name))})&&document.activeElement?.getAttribute('aria-pressed')==='true'`);
  const bounds = await h.evaluate("const r=document.activeElement.getBoundingClientRect(),p=document.activeElement.closest('.media-items').getBoundingClientRect();return {top:r.top,bottom:r.bottom,parentTop:p.top,parentBottom:p.bottom};");
  assert.ok(bounds.top >= bounds.parentTop - 1 && bounds.bottom <= bounds.parentBottom + 1);
}
try {
  h = await start({ '新建项目 · 选择空文件夹': [project], '': [sources] }, output, exe, options);
  await newProject(h); await importDirect(h, 3);
  const doc = await snapshot(h), byName = Object.fromEntries(doc.media.map(m => [m.displayName, m]));
  await h.selectMedia('first.wav'); await h.input('搜索音频', '');
  await addCategory(h, '保留标签');
  await h.drag('.annotation-overlay', [.1,.2], [.3,.5]); await h.label('标注'); await h.label('保留标签'); await escape(h);
  await h.input('区域备注', '删除目录后仍保留的备注'); await h.click('.file-heading h2'); await escape(h); await saved(h);
  await expectDocument(h, d => d.annotations.some(a => a.note === '删除目录后仍保留的备注'), 'saved annotation note');
  const ids = { P: await createFolder('P') };
  ids.Empty = await createFolder('Empty', ids.P); ids.EmptyChild = await createFolder('EmptyChild', ids.Empty);
  ids.Exhausted = await createFolder('Exhausted', ids.P); ids.Deep = await createFolder('Deep', ids.Exhausted);
  ids.Blocked = await createFolder('Blocked', ids.P); ids.HiddenChild = await createFolder('HiddenChild', ids.Blocked);
  for (const [name, folderId] of [['first.wav', ids.Exhausted], ['second.wav', ids.Deep], ['live.wav', ids.HiddenChild]]) await fixtureOperation({ type: 'moveMedia', mediaId: byName[name].id, folderId });
  const trashOperation = { operationId: randomUUID(), mediaIds: [byName['first.wav'].id, byName['second.wav'].id], trash: true };
  const recycleDeadline = performance.now() + 30000;
  let recycleBusyRetries = 0;
  for (;;) {
    const trash = await recycled();
    const result = await read(h, 'recycle_apply', { binding: await binding(), expectedRevision: trash.revision, operation: trashOperation });
    if (result.error?.code === 'ResourceLimit' && result.error?.details?.operationBusy && performance.now() < recycleDeadline) {
      recycleBusyRetries++; await wait(150); continue;
    }
    assert.ok(result.recycle, JSON.stringify(result)); break;
  }
  report.fixtureSetup.push({ command: 'recycle_apply', purpose: 'Place first/second fixture media in shared recycle before testing folder UI', busyRetries: recycleBusyRetries });
  // Reopen the saved fixture so both renderer controllers start from the completed native setup.
  await h.quit(); h = null;
  await fs.mkdir(path.join(output, 'reopen'), { recursive: true });
  h = await start({ '打开项目': [path.join(project, 'collaboration.json')] }, path.join(output, 'reopen'), exe, { ...options, webviewDirectory: path.join(output, 'webview-reopen') });
  await h.clickText('打开项目…'); await h.until(`document.querySelector(${JSON.stringify(folderSelector('P'))})`);
  report.fixtureSetup.push({ command: 'owned process reopen', purpose: 'Load completed native organization/recycle fixture into renderer controllers' });
  await clickFolder('P'); await clickFolder('P/Blocked'); await clickFolder('P/Blocked/HiddenChild');
  await h.selectMedia('live.wav');
  await h.context(row('live.wav')); await h.label('从我的列表隐藏');
  await h.driver.wait(async () => (await status(h)).hiddenMediaIds.includes(byName['live.wav'].id), 60000);
  await clickFolder('P/Blocked');
  await h.until(`document.querySelector(${JSON.stringify(folderSelector('P/Blocked'))})?.querySelector('.count')?.textContent==='0'`);
  for (const filtered of [false, true]) {
    if (filtered) { await h.label('筛选音频'); await h.select('标注状态筛选', '已标注'); }
    await h.label('文件夹操作 · Blocked');
    const remove = await h.element('[role="menuitem"][aria-label^="删除文件夹…"]');
    assert.equal(await remove.getAttribute('aria-disabled'), 'true');
    assert.match(await remove.getAttribute('title'), /1 个未进入共享回收站/);
    await remove.click(); assert.equal(await h.evaluate("return !!document.querySelector('[role=dialog]')"), false); await escape(h);
    if (filtered) { await h.select('标注状态筛选', '全部'); await h.label('筛选音频'); }
  }
  check('Zero-visible parent with hidden live descendant refuses removal, including annotation filtering');
  await clickFolder('P/Empty');
  await clickFolder('P/Empty/EmptyChild');
  await clickFolder('P/Exhausted');
  await clickFolder('P/Exhausted/Deep');
  await h.select('音频列表视图', '共享回收站（2）');
  await clickFolder('P/Exhausted');
  await h.until(`document.querySelector(${JSON.stringify(folderSelector('P/Exhausted'))})?.querySelector('.count')?.textContent==='2'`);
  await h.select('音频列表视图', '正常音频');
  await h.until(`document.querySelector(${JSON.stringify(folderSelector('P/Exhausted'))})?.querySelector('.count')?.textContent==='0'`);
  await saved(h); await wait(400);
  const baseline = await snapshot(h), originalOrganization = await organization(h), originalRecycle = await recycled(), immutable = await invariantFiles(), privateHidden = (await status(h)).hiddenMediaIds;
  await clickFolder('P/Empty');
  assert.match(await openRemoval('Empty'), /共 2 个文件夹/); await dismissRemoval('取消');
  assert.deepEqual(await organization(h), originalOrganization);
  await openRemoval('Empty'); await dismissRemoval('确认');
  let current = await organization(h);
  assert.ok(current.folders.every(f => ![ids.Empty, ids.EmptyChild].includes(f.id)));
  await h.until("document.activeElement?.isConnected&&document.activeElement?.getAttribute('aria-label')==='根目录操作'");
  assert.equal(await h.evaluate("return document.querySelector('.media-items>.media-folder-row>.media-folder-select').getAttribute('aria-pressed')"), 'true');
  check('Cancel preserves empty subtree; confirm removes both levels and recovers selection/root focus');
  await clickFolder('P/Exhausted');
  const text = await openRemoval('Exhausted');
  assert.match(text, /共 2 个文件夹/); assert.match(text, /2 个已在共享回收站/); assert.match(text, /目录归属移至「P」/);
  await h.screenshot('recycled-subtree-confirmation'); await dismissRemoval('取消');
  assert.deepEqual((await organization(h)).media, originalOrganization.media);
  await openRemoval('Exhausted'); await dismissRemoval('确认');
  current = await organization(h);
  assert.ok(current.folders.every(f => ![ids.Exhausted, ids.Deep].includes(f.id)));
  for (const name of ['first.wav', 'second.wav']) {
    const member = current.media.find(m => m.mediaId === byName[name].id), original = originalOrganization.media.find(m => m.mediaId === byName[name].id);
    assert.equal(member.folderId, ids.P); assert.equal(member.originalFilename, original.originalFilename);
  }
  assert.deepEqual(await recycled(), originalRecycle);
  assert.deepEqual(await invariantFiles(), immutable);
  const afterRemoval = await snapshot(h);
  for (const key of ['media', 'annotations', 'categories', 'edits']) assert.deepEqual(afterRemoval[key], baseline[key], key);
  assert.deepEqual((await status(h)).hiddenMediaIds, privateHidden);
  report.immutableHashes = immutable;
  check('Recycled subtree cancel/confirm reparents both memberships to P; audio, catalog, author heads, annotations, notes, hidden settings and recycle bytes unchanged');
  await h.select('音频列表视图', '共享回收站（2）'); await clickFolder('P');
  await h.label('多选音频'); await h.label('全选筛选结果');
  await h.clickText('恢复'); await h.clickText('恢复音频'); await h.until("!document.querySelector('[role=dialog]')");
  assert.equal((await recycled()).trashed.length, 0);
  await h.select('音频列表视图', '正常音频');
  for (const name of ['first.wav', 'second.wav']) assert.equal(await h.evaluate(`return document.querySelector(${JSON.stringify(row(name))})?.closest('.media-folder-content')?.parentElement.querySelector(':scope>.media-folder-row>.media-folder-select')?.title`), 'P');
  await h.clickText('完成');
  await h.select('音频列表视图', '我的隐藏（1）'); await clickFolder('P/Blocked/HiddenChild');
  await h.context(row('live.wav')); await h.label('取消隐藏');
  await h.driver.wait(async () => (await status(h)).hiddenMediaIds.length === 0, 60000);
  await h.select('音频列表视图', '正常音频'); await clickFolder('P');
  const restoredOrder = await h.evaluate("return [...document.querySelectorAll('.media-select')].filter(e=>['first.wav','second.wav'].includes(e.getAttribute('aria-label'))).map(e=>e.getAttribute('aria-label'))");
  assert.equal(restoredOrder.length, 2); assert.equal(new Set(restoredOrder).size, 2);
  report.restoredNavigationOrder = restoredOrder;
  await h.click(row(restoredOrder[0])); await selected(restoredOrder[0]);
  await h.driver.actions().sendKeys(Key.ARROW_DOWN).perform(); await selected(restoredOrder[1]);
  await h.driver.actions().sendKeys(Key.ARROW_UP).perform(); await selected(restoredOrder[0]);
  await h.click(row('first.wav')); await selected('first.wav');
  await h.input('搜索音频', 'first'); await h.click('[aria-label="搜索音频"]'); await h.driver.actions().sendKeys(Key.ARROW_DOWN).perform();
  assert.equal(await h.evaluate("return document.activeElement?.getAttribute('aria-label')"), '搜索音频');
  assert.equal(await h.evaluate("return document.querySelector('.file-pane h2')?.textContent"), 'first.wav'); await h.input('搜索音频', '');
  check('Actual multiselect restore displays both audio directly in P; unhide and ArrowDown/Up restore main selection, row focus/scroll; search retains arrow keys');
  h.nativeRect({ width: 1000, height: 680 }); await wait(300); await clickFolder('P/Blocked/HiddenChild');
  report.geometry = await h.evaluate("const r=e=>e.getBoundingClientRect().toJSON();return {inner:[innerWidth,innerHeight],overflow:document.documentElement.scrollWidth>innerWidth,folders:[...document.querySelectorAll('.media-folder-select[title]')].map(e=>({path:e.title,rect:r(e)})),audio:[...document.querySelectorAll('.media-select')].map(e=>({name:e.getAttribute('aria-label'),rect:r(e)}))};");
  assert.equal(report.geometry.overflow, false);
  assert.ok(report.geometry.folders.some(f => f.path === 'P/Blocked/HiddenChild'));
  await h.screenshot('depth-three-narrow'); check('Depth-three directory/audio layout fits the 1000x680 owned window');
  const final = await snapshot(h); await saved(h); await h.quit(); h = null;
  const previous = process.env.ANNOTATOR_PREVIOUS_EXE;
  if (previous) {
    await fs.mkdir(path.join(output, 'previous'), { recursive: true });
    h = await start({ '打开项目': [path.join(project, 'collaboration.json')] }, path.join(output, 'previous'), previous, { ...options, webviewDirectory: path.join(output, 'webview-previous') });
    await h.clickText('打开项目…'); await h.until("document.querySelector('.file-pane')&&!document.querySelector('.tile-status')");
    const reopened = await snapshot(h);
    for (const key of ['media', 'annotations', 'categories', 'edits']) assert.deepEqual(reopened[key], final[key], key);
    assert.deepEqual((await organization(h)).folders, current.folders);
    assert.deepEqual((await organization(h)).media, current.media);
    for (const media of final.media) assert.equal(hash(await fs.readFile(path.join(project, media.sourceRef))), immutable[media.sourceRef]);
    check('Preserved 0.7.5 E2E reader reopens candidate project/profile with all media, annotations and resulting organization unchanged');
  }
  report.passed = true;
} catch (error) {
  report.error = error.stack; report.state = await h?.evaluate('return document.body.innerText').catch(() => null);
  console.error(error); await h?.screenshot('failure').catch(() => {}); process.exitCode = 1;
} finally {
  await h?.quit().catch(() => {});
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
}
