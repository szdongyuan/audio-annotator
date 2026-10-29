import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { start, By, Key, wait } from './harness.mjs';
import * as w from './workspace-helpers.mjs';
import { read, createIdentity } from './identity-helpers.mjs';

const base = path.resolve(process.env.ANNOTATOR_SUITE_OUTPUT ?? '.test-output/purge/task12');
await fs.mkdir(base, { recursive: true });
const output = await fs.realpath(await fs.mkdtemp(path.join(base, 'desktop-')));
assert.ok(process.env.ANNOTATOR_WORKSPACE_EXE, 'ANNOTATOR_WORKSPACE_EXE must identify the current e2e executable');
const exe = path.resolve(process.env.ANNOTATOR_WORKSPACE_EXE);
assert.ok(process.env.ANNOTATOR_PREVIOUS_EXE, 'ANNOTATOR_PREVIOUS_EXE must identify the preserved format-5 executable');
const previousExe = path.resolve(process.env.ANNOTATOR_PREVIOUS_EXE);
const previousExeHash = w.hash(await fs.readFile(previousExe)), exeHash = w.hash(await fs.readFile(exe));
const independent = path.join(output, 'independent-copy');
const project = path.join(output, 'project'), switched = path.join(output, 'switched'), source = path.join(output, 'originals');
const localA = path.join(output, 'local-a'), localB = path.join(output, 'local-b');
for (const dir of [project, switched, source, independent, localA, localB]) await fs.mkdir(dir);
const names = ['plain', 'self-file', 'self-channel', 'self-region', 'foreign-file', 'foreign-channel', 'foreign-region', 'foreign-frame', 'notes', 'held'];
const bytes = w.wav({ seconds: 2, channels: 1, rate: 16000 });
for (const name of names) await fs.writeFile(path.join(source, `${name}.wav`), bytes);
const archive = path.join(output, 'duplicate.zip'); await w.zipFolder(source, archive);
const originalHashes = Object.fromEntries(await Promise.all([archive, ...names.map(n => path.join(source, `${n}.wav`))].map(async p => [p, w.hash(await fs.readFile(p))])));
const normal = path.join(output, 'survivor.wav'), remote = path.join(output, 'unadopted.wav');
await fs.writeFile(normal, bytes); await fs.writeFile(remote, bytes);
const entry = path.join(project, 'collaboration.json');
const pathsA = { '新建项目 · 选择空文件夹': [project, switched], '选择 ZIP 音频': [[archive], [archive]], '': [[normal], [normal]], '打开项目': [entry, entry, entry], '另存我的项目副本 · 选择空文件夹': [independent] };
const report = { output, exe, exeHash, previousExe, previousExeHash, method: 'Actual Windows Tauri e2e clients, Selenium pointer/keyboard, separate local identities, native read-only assertions, filesystem hashes. One labeled transport gate delays delivery of one genuine cleanup-page result. Owned PowerShell FileStream denies deletion. No renderer/store mutation or fake purge results.', checks: [], gaps: ['No physical NAS disconnect or separate-machine test environment; local Windows evidence only. Rust deterministic transaction tests cover native races/crash boundaries.'] };
let a, b, v, old, holder, independentBefore;
const check = (name, details = {}) => { report.checks.push({ name, ...details }); console.log('PASS', name); };
const view = async (h, value) => (await h.element('[aria-label="音频列表视图"]')).findElement(By.css(`option[value="${value}"]`)).click();
const selectId = async (h, id) => { await h.click(`[data-media-id="${id}"]`); await h.until('document.querySelector("canvas")&&!document.querySelector(".tile-status")'); };
const recycle = async h => { const s = await w.status(h); return (await read(h, 'recycle_get', { binding: { projectId: s.projectId, runtimeNonce: s.runtimeNonce } })).recycle; };
const sync = async h => { await h.menu('保存并同步', '协作'); await h.driver.wait(async () => { const s = await w.status(h); return !s.busy && !s.pending && !s.error; }, 60000); };
const dialogText = h => h.evaluate('return document.querySelector("[role=dialog]")?.textContent');
const waitDialog = (h, name) => h.until(`document.querySelector('[role="dialog"][aria-label="${name}"]')`);
const previewReady = h => h.until('document.querySelector("[aria-label=永久删除预览]")');
const closeResult = async h => { await h.clickText('关闭'); await h.until('!document.querySelector("[role=dialog]")'); };
async function zipImport(h, total) {
  await h.menu('导入 ZIP 音频'); await h.select('导入方案', '通用·平铺'); await h.clickText('选择 ZIP…');
  await h.until('[...document.querySelectorAll("button")].some(b=>b.textContent==="扫描预览"&&!b.disabled)');
  await h.clickText('扫描预览'); await h.until('document.querySelector(".source-preview strong")?.textContent==="10 个音频"');
  await h.clickText('导入 10 个音频'); await h.until('document.querySelector(".source-import-progress")?.textContent.includes("音频导入完成")');
  await h.clickText('关闭结果'); await w.expectDocument(h, d => d.media.length === total, 'ZIP import count');
}
async function region(h, id, tagged, note = '') {
  await selectId(h, id); await h.drag('.channel-pane:first-child .annotation-overlay', [.15, .25], [.5, .65]);
  await h.label('标注'); await h.label(tagged ? 'test-label' : '清空标签'); await w.escape(h);
  const created = (await w.snapshot(h)).annotations.filter(a => a.region.mediaId === id).at(-1); assert.ok(created);
  await h.click(`[data-annotation-id="${created.id}"]`);
  await h.driver.findElement(By.xpath('//button[@role="tab" and .="区域"]')).click();
  await h.until('document.querySelector(".annotation-inspector")'); if (note) await h.input('区域备注', note); await sync(h);
}
async function tag(h, id, scope) {
  await selectId(h, id); await h.context(scope === '文件类别' ? '.file-heading h2' : '.channel-caption strong');
  await h.label(scope); await h.label('test-label'); await w.escape(h); await w.escape(h); await sync(h);
}
async function batchTrash(h, ids) {
  await h.input('搜索音频', ''); await h.click('.media-items>.media-folder-row>.media-folder-select');
  if (await h.evaluate('return document.querySelector("[aria-label=多选音频]").getAttribute("aria-pressed")!=="true"')) await h.label('多选音频');
  while ((await h.driver.findElements(By.css('[aria-label^="展开文件夹"]'))).length) await (await h.driver.findElements(By.css('[aria-label^="展开文件夹"]')))[0].click();
  for (const id of ids) { const e = await h.element(`[data-media-id="${id}"]`); await (await e.findElement(By.xpath('../input[@type="checkbox"]'))).click(); }
  await h.clickText('移入回收站'); await waitDialog(h, '移入共享回收站');
  await h.click('[role="dialog"] .button-accent'); await h.until('!document.querySelector("[role=dialog]")');
  await h.clickText('完成');
}
async function purgeOne(h, id) {
  await h.context(`[data-media-id="${id}"]`); await h.label('永久删除…'); await previewReady(h);
}
async function commit(h) { await h.clickText('确认永久删除'); await waitDialog(h, '永久删除结果'); await h.until('document.querySelector("[role=dialog]")?.textContent.includes("永久删除已提交")'); }
async function inventory(root) {
  const entries = [];
  async function walk(dir) { for (const e of await fs.readdir(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) await walk(p); else if (e.isFile()) { if (['.writer.lock', '.commit.lock', '.registration.lock'].includes(e.name)) { entries.push({ path: path.relative(root, p), bytes: (await fs.stat(p)).size, activeLease: true, note: 'Stable ownership lock listed; active exclusive lease is not read for hashing.' }); continue; } const b = await fs.readFile(p); entries.push({ path: path.relative(root, p), bytes: b.length, sha256: w.hash(b) }); } } }
  await walk(root); return entries.sort((a, b) => a.path.localeCompare(b.path));
}
async function catalogIds() {
  const entryValue = JSON.parse(await fs.readFile(entry, 'utf8'));
  const metadata = entryValue.formatVersion === 6 ? path.join(project, 'state', entryValue.metadataGeneration) : project;
  const records = await fs.readdir(path.join(metadata, 'catalog'));
  return (await Promise.all(records.filter(n => /^[0-9a-f-]+\.json$/.test(n)).map(async n => JSON.parse(await fs.readFile(path.join(metadata, 'catalog', n), 'utf8')).media.id))).sort();
}
async function stage(name, h, expectedIds) {
  const document = await w.snapshot(h), actual = document.media.map(m => m.id).sort();
  assert.deepEqual(actual, [...expectedIds].sort(), `${name}: exact adopted media IDs`);
  const catalog = await catalogIds(); assert.deepEqual(catalog, actual, `${name}: exact shared catalog IDs`);
  report.mediaStages ??= []; report.mediaStages.push({ name, revision: document.revision, adoptedIds: actual, catalogIds: catalog });
}
async function occupy(file) {
  const script = '$taskStream=[IO.File]::Open($env:PURGE_HELD_FILE,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);try{[Console]::Out.WriteLine("READY");[Console]::Out.Flush();[Console]::In.ReadLine()|Out-Null}finally{$taskStream.Dispose()}';
  const p = spawn('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, env: { ...process.env, PURGE_HELD_FILE: file }, stdio: ['pipe', 'pipe', 'pipe'] });
  let logs = ''; p.stdout.on('data', b => { logs += b; }); p.stderr.on('data', b => { logs += b; });
  const deadline = Date.now() + 15000; while (!logs.includes('READY') && p.exitCode === null && Date.now() < deadline) await wait(50);
  assert.match(logs, /READY/, `owned FileStream ready: ${logs}`);
  return { process: p, async release() { if (p.exitCode === null) { const done = once(p, 'exit'); p.stdin.end('release\n'); await Promise.race([done, wait(5000)]); if (p.exitCode === null) { logs += '\nOwned helper required termination after release deadline.\n'; p.kill(); } await done; } await fs.writeFile(path.join(output, 'held-file-helper.log'), logs); } };
}
try {
  a = await start(pathsA, output, exe, { localDataEnv: localA });
  // Functional RED before help implementation: the actual shipped help must explain the irreversible action.
  await a.menu('使用说明', '帮助'); assert.match(await a.evaluate('return document.querySelector(".help-dialog").textContent'), /永久删除不可撤销/); await a.clickText('关闭');
  await createIdentity(a, 'Purge Alice'); await w.newProject(a);
  const entry5 = await fs.readFile(entry); assert.equal(JSON.parse(entry5).formatVersion, 5);
  await view(a, 'trash'); assert.equal(await (await a.driver.findElement(By.xpath('//button[.="清空回收站…"]'))).isEnabled(), false); await view(a, 'normal');
  console.log('STAGE import independent ZIP copies');
  await zipImport(a, 10); const first = (await w.snapshot(a)).media;
  await zipImport(a, 20); await w.importDirect(a, 21);
  const full = await w.snapshot(a), duplicateIds = full.media.filter(m => !first.some(f => f.id === m.id) && m.displayName !== 'survivor.wav').map(m => m.id);
  const ids = Object.fromEntries(names.map(n => [n, first.find(m => m.displayName.endsWith(`${n}.wav`)).id]));
  const survivor = full.media.find(m => m.displayName === 'survivor.wav');
  await stage('initial duplicate imports', a, full.media.map(m => m.id));
  assert.equal(new Set(full.media.map(m => m.id)).size, 21); assert.equal(duplicateIds.length, 10);
  assert.ok(full.media.every(m => m.sha256 === w.hash(bytes)));
  await w.addCategory(a, 'test-label');
  await tag(a, ids['self-file'], '文件类别'); await tag(a, ids['self-channel'], '通道类别'); await region(a, ids['self-region'], true);
  const purgeFolder = await w.folder(a, 'purge-folder');
  for (const name of ['self-file', 'self-channel', 'self-region']) { await selectId(a, ids[name]); await a.context(`[data-media-id="${ids[name]}"]`); await a.label('移动到文件夹…'); await a.select('移动目标文件夹', 'purge-folder'); await w.acceptFolderDialog(a); await a.input('搜索音频', ''); await a.click('.media-items>.media-folder-row>.media-folder-select'); }
  await sync(a);
  const stable5 = await fs.readFile(entry), nonce5 = (await w.status(a)).runtimeNonce;
  await a.menu('打开项目'); await a.driver.wait(async () => (await w.status(a)).runtimeNonce !== nonce5, 30000);
  await w.saved(a); assert.deepEqual(await fs.readFile(entry), stable5);
  console.log('STAGE second author permission matrix');
  b = await start({ '打开项目': [entry], '': [[remote]] }, path.join(output, 'bob'), exe, { localDataEnv: localB, ports: { driver: 4455, native: 4456, debug: 9245 } });
  await createIdentity(b, 'Purge Bob'); await b.menu('打开项目'); await b.until('document.querySelector("canvas")&&!document.querySelector(".tile-status")');
  const actorA = (await w.status(a)).actor, actorB = (await w.status(b)).actor; assert.notEqual(actorA.authorId, actorB.authorId);
  await w.addCategory(b, 'test-label');
  await tag(b, ids['foreign-file'], '文件类别'); await tag(b, ids['foreign-channel'], '通道类别');
  await region(b, ids['foreign-region'], true); await region(b, ids['foreign-frame'], false);
  await selectId(b, ids.notes); await b.click('.file-heading h2'); await b.input('音频备注', 'Bob note does not block'); await sync(b);
  await selectId(b, survivor.id); await region(b, survivor.id, true, 'B continues before retirement');
  const before = await w.snapshot(a), hashes = Object.fromEntries(await Promise.all(before.media.map(async m => [m.id, w.hash(await fs.readFile(path.join(project, m.sourceRef)))])));
  await fs.writeFile(path.join(output, 'before-files.json'), JSON.stringify(await inventory(project), null, 2));
  check('duplicate ZIP imports have independent UUIDs and identical bytes; two authors create all three label scopes, untagged frame and notes', { ids, duplicateIds, authors: [actorA, actorB] });
  // Spectrum Delete remains its existing mask action.
  await selectId(a, survivor.id); await a.drag('.annotation-overlay', [.1, .2], [.3, .5]); await a.driver.actions().sendKeys(Key.DELETE).perform(); await w.waitMasked(a);
  assert.equal(await a.evaluate('return !!document.querySelector("[aria-label=永久删除音频]")'), false);
  await sync(a);
  await a.menu('另存我的项目副本…', '协作'); await a.until('document.querySelector(".project-identity")?.title.endsWith("independent-copy")');
  const copied = await w.snapshot(a); assert.notEqual(copied.projectId, before.projectId); assert.ok(copied.media.some(m => m.id === ids.held));
  await a.menu('打开项目'); await a.until('document.querySelector(".project-identity")?.title.endsWith("project")');
  await stage('ordinary reopen after independent UI Save As', a, full.media.map(m => m.id));
  independentBefore = await inventory(independent); report.independentCopy = { projectId: copied.projectId, filesBefore: independentBefore };
  await batchTrash(a, Object.values(ids)); await view(a, 'trash');
  await a.input('搜索音频', 'plain'); await a.until(`document.querySelector('[data-media-id="${ids.plain}"]')`);
  const row = await a.element(`[data-media-id="${ids.plain}"]`); await row.click(); await row.sendKeys(Key.DELETE); await previewReady(a);
  assert.match(await dialogText(a), /首次实际永久删除将升级项目格式/); await a.driver.actions().sendKeys(Key.DELETE).perform(); assert.ok(await a.element('[aria-label="永久删除音频"]'));
  await a.clickText('取消'); assert.equal((await recycle(a)).trashed.length, 10); assert.equal(w.hash(await fs.readFile(path.join(project, first.find(m => m.id === ids.plain).sourceRef))), hashes[ids.plain]);
  await a.input('搜索音频', 'plainX'); const search = await a.element('[aria-label="搜索音频"]'); await search.click(); await search.sendKeys(Key.END, Key.ARROW_LEFT, Key.DELETE); assert.equal(await search.getAttribute('value'), 'plain');
  assert.equal(await a.evaluate('return !!document.querySelector("[role=dialog]")'), false);
  await a.context(`[data-media-id="${ids.plain}"]`); await a.driver.actions().sendKeys(Key.DELETE).perform(); assert.ok(await a.element('[role="menu"]')); await w.escape(a);
  await sync(a); const beforePreview = await fs.readFile(entry); await purgeOne(a, ids.plain); await a.clickText('取消'); assert.deepEqual(await fs.readFile(entry), beforePreview); assert.deepEqual(beforePreview, entry5);
  check('real spectrum Delete masks; recycle row Delete previews only; cancel, input Delete and menu/dialog keys preserve audio and format-5 entry bytes');
  // First effective purge has a real Windows deletion-denying handle.
  await a.input('搜索音频', 'held'); const heldMedia = first.find(m => m.id === ids.held), heldPath = path.join(project, heldMedia.sourceRef);
  holder = await occupy(heldPath); await purgeOne(a, ids.held); await commit(a);
  assert.match(await dialogText(a), /已从项目移除：1/); assert.match(await dialogText(a), /已删除音频字节：0/);
  assert.equal(JSON.parse(await fs.readFile(entry, 'utf8')).formatVersion, 6);
  assert.equal(w.hash(await fs.readFile(heldPath)), hashes[ids.held]);
  await a.clickText('查看待清理项'); await a.until('document.querySelector("[aria-label=待清理项]")?.textContent.includes("held.wav")');
  const cleanupText = await dialogText(a); assert.match(cleanupText, /失败/); assert.match(cleanupText, /Io|Permission|denied|拒绝|另一个进程|os error/i);
  const pendingStatus = await w.status(a); const operation = pendingStatus.purgeMaintenance.items.find(i => i.committed); assert.ok(operation);
  assert.ok(operation.cleanupFailedCount >= 1); assert.ok(operation.cleanupPendingCount >= operation.cleanupFailedCount); assert.equal(operation.deletedAudioBytes, 0);
  const heldRow = await a.driver.findElement(By.xpath('//ul[@aria-label="待清理项"]/li[contains(.,"held.wav")]'));
  assert.match(await heldRow.getText(), /失败/); assert.ok(await (await heldRow.findElement(By.css('small'))).getText());
  const diagnostics = await heldRow.findElements(By.css('summary')); if (diagnostics.length) await diagnostics[0].click();
  await stage('held purge committed', a, full.media.filter(m => m.id !== ids.held).map(m => m.id));
  report.held = { operationId: operation.operationId, file: heldPath, bytes: heldMedia.byteLength, text: cleanupText, maintenance: pendingStatus.purgeMaintenance };
  await a.screenshot('held-cleanup-result');
  await w.expectDocument(b, d => !d.media.some(m => m.id === ids.held), 'automatic trusted retirement without catalog adoption');
  await b.input('区域备注', 'B continues after retirement'); await sync(b); assert.equal((await w.snapshot(b)).annotations.find(x => x.region.mediaId === survivor.id).note, 'B continues after retirement');
  check('real held file remains with zero deleted bytes, named failed cleanup and diagnostics; format 6 commits and Bob continues normal annotation automatically');
  await closeResult(a); await b.quit(); b = null;
  // Real same-identity writer refusal then standard readonly open.
  v = await start({ '打开项目': [entry, entry] }, path.join(output, 'readonly'), exe, { localDataEnv: localA, ports: { driver: 4455, native: 4456, debug: 9245 } });
  await v.menu('打开项目'); await v.until('document.querySelector("[role=alert]")'); assert.match(await v.evaluate('return document.body.innerText'), /writable session|locked|占用/i);
  await v.menu('只读打开项目'); await v.until('document.querySelector(".collaboration-status")?.textContent.includes("只读查看")'); assert.equal((await w.status(v)).identityMode, 'viewOnly');
  await view(v, 'trash'); await v.input('搜索音频', 'foreign-file'); await v.context(`[data-media-id="${ids['foreign-file']}"]`);
  for (const label of ['从回收站恢复', '永久删除…']) assert.equal(await (await v.element(`[role="menu"] [aria-label="${label}"]`)).getAttribute('aria-disabled'), 'true');
  await w.escape(v); assert.equal(await (await v.driver.findElement(By.xpath('//button[.="清空回收站…"]'))).isEnabled(), false);
  await v.label('查看待清理操作 1'); await v.clickText('查看待清理项'); await v.until('document.querySelector("[aria-label=待清理项]")?.textContent.includes("held.wav")');
  assert.equal(await (await v.driver.findElement(By.xpath('//button[.="重试清理"]'))).isEnabled(), false); await v.screenshot('readonly-pending'); await closeResult(v); await v.menu('关闭项目'); await v.quit(); v = null;
  check('actual writer lease refusal and explicit viewOnly lifecycle disable restore/purge/clear/retry while showing persisted pending cleanup');
  // Delay only delivery of one genuine read response; normal close/menu lifecycle must remain available.
  await a.label('查看待清理操作 1');
  // Tauri 2.12 defines invoke as non-writable/non-configurable. Its mutable fetch
  // transport is the equivalent seam: delay delivery of one genuine Response.
  await a.evaluate(`const original=window.fetch;const gate={original,hits:0,nativeDispatches:0,ready:false,released:false};window.__purgePageGate=gate;window.fetch=function(resource,options){const real=original.call(this,resource,options);const command=decodeURIComponent(String(resource).split('/').at(-1));if(command!=='purge_cleanup_page'||gate.hits)return real;gate.hits++;gate.nativeDispatches++;gate.args=JSON.parse(options.body);return real.then(async response=>{gate.result=await response.clone().json();return new Promise(resolve=>{gate.release=()=>{if(gate.released)return;gate.released=true;clearTimeout(gate.timer);resolve(response);};gate.timer=setTimeout(()=>{gate.expired=true;gate.release();},120000);gate.ready=true;});});};`);
  await a.clickText('查看待清理项'); await a.until('window.__purgePageGate.ready'); await closeResult(a);
  await a.menu('新建项目'); await a.until('document.querySelector(".project-identity")?.title.endsWith("switched")'); await view(a, 'normal'); await w.importDirect(a, 1); await a.selectMedia('survivor.wav');
  await region(a, (await w.snapshot(a)).media[0].id, false, 'new project draft');
  const field = await a.element('[aria-label="区域备注"]'); await field.click(); await field.sendKeys(Key.CONTROL, 'a', Key.NULL, 'new live draft');
  const switchedBefore = await w.snapshot(a), uiBefore = await a.evaluate('return {draft:document.querySelector("[aria-label=区域备注]").value,selection:document.querySelector(".annotation-rect.is-selected")?.dataset.annotationId,focus:document.activeElement?.getAttribute("aria-label")}');
  const gate = await a.evaluate('const g=window.__purgePageGate;window.fetch=g.original;g.release();return {hits:g.hits,nativeDispatches:g.nativeDispatches,args:g.args,result:g.result,expired:!!g.expired};'); await wait(350);
  assert.equal(gate.hits, 1); assert.equal(gate.nativeDispatches, 1); assert.equal(gate.expired, false); assert.equal(gate.result.operationId, operation.operationId); assert.deepEqual(await w.snapshot(a), switchedBefore);
  assert.deepEqual(await a.evaluate('return {draft:document.querySelector("[aria-label=区域备注]").value,selection:document.querySelector(".annotation-rect.is-selected")?.dataset.annotationId,focus:document.activeElement?.getAttribute("aria-label")}'), uiBefore);
  assert.ok((await fs.readdir(path.join(project, 'maintenance'))).includes(operation.operationId));
  report.transportTiming = { seam: 'fetch response delivery; invoke frozen by Tauri', hits: gate.hits, nativeDispatches: gate.nativeDispatches, args: gate.args, genuineResult: gate.result, before: uiBefore, oldJournalRetained: true }; await a.screenshot('late-response-new-project');
  check('one genuine cleanup-page response delayed across normal close/project menu switch leaves new project document, live draft, selection and focus unchanged; journal retained');
  await a.menu('打开项目'); await a.until('document.querySelector(".project-identity")?.title.endsWith("project")'); await view(a, 'trash'); await a.label('查看待清理操作 1');
  await holder.release(); holder = null; await a.clickText('重试清理'); await a.until('document.querySelector("[role=dialog]")?.textContent.includes("待清理：0 · 其中失败：0")');
  await a.clickText('查看待清理项'); await a.until('document.querySelector("[aria-label=待清理项]")?.children.length===0'); assert.equal(await fs.stat(heldPath).then(() => true, () => false), false);
  assert.match(await dialogText(a), new RegExp(`已删除音频字节：${heldMedia.byteLength}`)); await a.screenshot('retry-cleanup-zero'); await closeResult(a);
  check('reopened original operation retries after releasing owned handle: cleanup zero and physical held audio absent');
  // New and preserved old clients reopen with distinct identities; old error must be format support, never lease.
  old = await start({ '打开项目': [entry] }, path.join(output, 'previous'), previousExe, { localDataEnv: path.join(output, 'old-local'), ports: { driver: 4455, native: 4456, debug: 9245 } });
  await old.menu('打开项目'); await old.until('document.querySelector("[role=alert]")'); const oldText = await old.evaluate('return document.body.innerText'); assert.equal(JSON.parse(await fs.readFile(entry, 'utf8')).formatVersion, 6); assert.match(oldText, /Unsupported collaboration.*version|不支持.*格式/i); assert.doesNotMatch(oldText, /writable session|locked/i); assert.equal((await w.status(old)).projectId, null); report.previousRejection = oldText; await old.screenshot('old-rejects-format6'); await old.quit(); old = null;
  b = await start({ '打开项目': [entry], '': [[remote]] }, path.join(output, 'bob-reopen'), exe, { localDataEnv: localB, ports: { driver: 4455, native: 4456, debug: 9245 } });
  await b.menu('打开项目'); await b.until('document.querySelector("canvas")&&!document.querySelector(".tile-status")'); await selectId(b, survivor.id);
  await b.menu('标注列表', '标注'); await b.driver.findElement(By.xpath('//button[contains(@class,"annotation-row") and .//span[.="B continues after retirement"]]')).click(); await b.driver.findElement(By.xpath('//button[@role="tab" and .="区域"]')).click(); await b.input('区域备注', 'B reopened format 6 continues'); await sync(b);
  await b.until(`document.querySelector('.media-folder-select[title="purge-folder"]')`, 'Bob observes the folder before its later remote deletion');
  // Multi-selection mixed permission: self labels/regions/notes delete; foreign annotations retain.
  await a.input('搜索音频', ''); await a.click('.media-items>.media-folder-row>.media-folder-select');
  if (await a.evaluate('return document.querySelector("[aria-label=多选音频]").getAttribute("aria-pressed")!=="true"')) await a.label('多选音频');
  const mixed = names.filter(n => !['held', 'plain'].includes(n));
  // Search changes clear selection; use one common filter and exact data IDs.
  await a.input('搜索音频', ''); if ((await a.driver.findElements(By.css('[aria-label="展开文件夹 · purge-folder"]'))).length) await a.label('展开文件夹 · purge-folder');
  for (const name of mixed) await a.click(`[data-media-id="${ids[name]}"]`);
  await a.clickText('永久删除…'); await previewReady(a); assert.match(await dialogText(a), /请求 8 · 可删除 4 · 保留 4/); assert.match(await dialogText(a), /他人有标注，保留：4/); await commit(a); assert.match(await dialogText(a), /已从项目移除：4/); assert.match(await dialogText(a), /他人有标注，保留：4/); await a.screenshot('mixed-permissions'); await closeResult(a);
  await a.driver.wait(async () => !(await w.organization(a)).media.some(m => m.folderId === purgeFolder.id), 30000); assert.ok((await w.organization(a)).folders.some(f => f.id === purgeFolder.id));
  await w.folderAction(a, 'purge-folder', '删除空文件夹…'); await a.clickText('确认'); await a.until('!document.querySelector("[role=dialog]")');
  assert.ok(!(await w.organization(a)).folders.some(f => f.id === purgeFolder.id));
  check('mixed batch deletes only self three scopes and notes-only media, retains all foreign scopes including untagged frame; nodes remain until explicit empty-folder deletion');
  // Wait for Bob's normal automatic retirement before admitting another mutation.
  const removedSoFar = new Set(['held', 'self-file', 'self-channel', 'self-region', 'notes'].map(n => ids[n]));
  const afterMixedIds = full.media.filter(m => !removedSoFar.has(m.id)).map(m => m.id);
  await stage('mixed purge committed', a, afterMixedIds);
  await w.expectDocument(b, d => d.media.length === afterMixedIds.length && d.media.every(m => afterMixedIds.includes(m.id)), 'Bob receives mixed purge retirement');
  await sync(b); await stage('Bob converged before normal import', b, afterMixedIds);
  // Bob's directory polling is independent of media retirement and sync.
  // Observe the remote folder deletion before capturing a guarded import placement.
  await b.until(`!document.querySelector('.media-folder-select[title="purge-folder"]')`, 'Bob naturally observes deleted folder before new import');
  // Bob imports and trashes a new ID while Alice has not adopted its catalog.
  await b.menu('导入音频'); await b.until('document.querySelector(".import-progress")?.textContent.includes("导入完成")');
  report.unadoptedImport = await b.evaluate('return document.querySelector(".import-progress").textContent');
  if (!report.unadoptedImport.includes('1 成功，0 失败')) { await b.clickText('查看详情'); report.unadoptedImport = await b.evaluate('return document.querySelector(".import-progress").textContent'); }
  assert.match(report.unadoptedImport, /1 成功，0 失败/);
  await b.clickText('关闭导入结果'); const unadopted = (await w.expectDocument(b, d => d.media.some(m => m.displayName === 'unadopted.wav'), 'unadopted native import accepted')).media.find(m => m.displayName === 'unadopted.wav'); assert.ok(unadopted);
  await batchTrash(b, [unadopted.id]); await a.driver.wait(async () => (await recycle(a)).trashed.some(m => m.mediaId === unadopted.id), 30000);
  assert.ok(!(await w.snapshot(a)).media.some(m => m.id === unadopted.id));
  const retainedFolder = await w.folder(a, 'retained-empty'); await a.click(`.media-folder-select[title="retained-empty"]`); await a.input('搜索音频', 'no-match');
  await a.clickText('清空回收站…'); await previewReady(a); assert.match(await dialogText(a), /整个项目回收站/); assert.match(await dialogText(a), /请求 6 · 可删除 2 · 保留 4/); await commit(a); assert.match(await dialogText(a), /已从项目移除：2/); await closeResult(a);
  await w.expectDocument(b, d => !d.media.some(m => m.id === ids.plain || m.id === unadopted.id), 'Bob automatically receives whole-project retirement');
  const final = await w.snapshot(a); assert.equal(final.media.length, 15); await stage('final whole-project clear', a, afterMixedIds.filter(id => id !== ids.plain)); for (const id of duplicateIds) { const m = final.media.find(m => m.id === id); assert.ok(m); assert.equal(w.hash(await fs.readFile(path.join(project, m.sourceRef))), hashes[id]); }
  for (const name of ['plain', 'held', 'self-file', 'self-channel', 'self-region', 'notes']) assert.equal(await fs.stat(path.join(project, first.find(m => m.id === ids[name]).sourceRef)).then(() => true, () => false), false);
  assert.equal(await fs.stat(path.join(project, unadopted.sourceRef)).then(() => true, () => false), false);
  assert.deepEqual(await inventory(independent), independentBefore, 'Independent UI-saved project audio and metadata remain byte-identical');
  for (const [file, expected] of Object.entries(originalHashes)) assert.equal(w.hash(await fs.readFile(file)), expected);
  assert.ok((await w.organization(a)).folders.some(f => f.id === retainedFolder.id));
  await fs.writeFile(path.join(output, 'after-files.json'), JSON.stringify(await inventory(project), null, 2)); await a.screenshot('whole-project-filtered');
  report.physical = { originalHashes, mediaHashesBefore: hashes, survivingDuplicateIds: duplicateIds, finalMediaIds: final.media.map(m => m.id) };
  check('whole-project clear ignores folder/search/adopted scope, deletes real unadopted audio, preserves duplicate UUID copies/original WAV/ZIP and independent saved-project bytes and directory nodes');
  assert.equal(w.hash(await fs.readFile(exe)), exeHash, 'Current executable unchanged during acceptance');
  assert.equal(w.hash(await fs.readFile(previousExe)), previousExeHash, 'Preserved previous executable bytes unchanged');
  report.passed = true;
} catch (error) {
  report.error = error.stack; report.state = await a?.evaluate('return document.body.innerText').catch(() => null); report.bState = await b?.evaluate('return document.body.innerText').catch(() => null); await a?.screenshot('failure').catch(() => {}); console.error(error); process.exitCode = 1;
} finally {
  await a?.evaluate('const g=window.__purgePageGate;if(g){window.fetch=g.original;g.release?.();}').catch(() => {});
  await holder?.release(); await old?.quit().catch(() => {}); await v?.quit().catch(() => {}); await b?.quit().catch(() => {}); await a?.quit().catch(() => {});
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ output, passed: report.passed, checks: report.checks, error: report.error }, null, 2));
}
