// Task 6 native IPC contract test. Task 7 adds the user-facing import workflow.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { start } from './harness.mjs';

const output = await fs.mkdtemp(path.resolve('.test-output/task6-folders/native-'));
const audio = path.join(output, 'audio');
await fs.mkdir(audio);
await fs.mkdir(path.join(audio, 'nested'));
await Promise.all(Array.from({ length: 260 }, (_, i) => fs.writeFile(path.join(audio, `${String(i).padStart(3, '0')}.WAV`), 'discovery only')));
await fs.writeFile(path.join(audio, 'nested', '260.MP3'), 'discovery only');
await fs.writeFile(path.join(audio, 'skip.txt'), 'skip');
const project = path.join(output, 'project'), saved = path.join(output, 'saved'), next = path.join(output, 'next');
for (const p of [project, saved, next]) await fs.mkdir(p);
const report = { method: 'Real Tauri e2e binary via owned Selenium/WebView2 IPC; no UI/controller claimed', checks: [], output };
let h;
try {
  h = await start({}, output);
  const invoke = async (command, args) => {
    const result = await h.driver.executeAsyncScript(`const done=arguments[arguments.length-1];window.__TAURI_INTERNALS__.invoke(arguments[0],arguments[1]).then(value=>done({ok:true,value}),error=>done({ok:false,error}));`, command, args);
    if (!result.ok) throw Object.assign(new Error(JSON.stringify(result.error)), result.error);
    return result.value;
  };
  const scan = async (projectId, recursive = false, scanPath = audio) => {
    await h.evaluate(`window.__folderEvents=[];window.__folderChannel=window.__TAURI_INTERNALS__.transformCallback(envelope=>{if(envelope.message)window.__folderEvents.push(envelope.message);});`);
    const channel = await h.evaluate('return "__CHANNEL__:"+window.__folderChannel');
    return invoke('scan_folder', { projectId, path: scanPath, recursive, onEvent: channel });
  };
  const terminal = async () => {
    await h.until('window.__folderEvents.some(e=>e.type!=="progress")', 'native scan terminal');
    return h.evaluate('return window.__folderEvents.find(e=>e.type!=="progress")');
  };
  const page = token => invoke('folder_scan_page', { token, kind: 'candidates', offset: 0, limit: 256 });
  const opened = await invoke('create_project', { path: project, name: 'folder-native' });
  const id = opened.snapshot.document.projectId;
  let token = await scan(id); let result = await terminal();
  assert.equal(result.type, 'result'); assert.equal(result.counts.candidates, 260); assert.equal(result.counts.skipped, 1);
  assert.equal((await page(token)).candidates.length, 256);
  assert.equal((await invoke('folder_scan_page', { token, kind: 'candidates', offset: 256, limit: 256 })).candidates.length, 4);
  assert.equal((await invoke('get_project_snapshot', { projectId: id })).document.media.length, 0);
  await assert.rejects(page({ ...token, ownerId: '11111111-1111-4111-8111-111111111111' }));
  await assert.rejects(invoke('folder_scan_page', { token, kind: 'candidates', offset: 0, limit: 257 }));
  await invoke('release_folder_scan', { token }); await assert.rejects(page(token));
  report.checks.push('nonrecursive discovery; 256+4 pages; strict owner/size; no document import; release');
  token = await scan(id, true); result = await terminal(); assert.equal(result.counts.candidates, 261);
  await invoke('save_project_as', { path: saved, projectId: id, expectedRevision: 0 }); await assert.rejects(page(token));
  const savedToken = await scan(id); await terminal(); assert.notEqual(savedToken.ownerId, token.ownerId);
  await assert.rejects(invoke('cancel_folder_scan', { token })); assert.equal((await page(savedToken)).total, 260);
  report.checks.push('recursive scan; save-as resets owner; old cancel cannot affect next result');
  await invoke('close_project', { projectId: id, expectedRevision: 0, discard: true }); await assert.rejects(page(savedToken));
  const reopened = await invoke('open_project', { path: path.join(saved, 'project.json') });
  token = await scan(reopened.snapshot.document.projectId); await terminal();
  await invoke('close_project', { projectId: id, expectedRevision: 0, discard: true });
  const created = await invoke('create_project', { path: next, name: 'new-owner' });
  await assert.rejects(page(token));
  const nextId = created.snapshot.document.projectId;
  token = await scan(nextId, true, path.join(output, 'missing')); result = await terminal(); assert.equal(result.type, 'failed');
  await assert.rejects(page(token)); await invoke('release_folder_scan', { token });
  report.checks.push('close/open/create owner isolation; inaccessible root terminal failure with no page');
  token = await scan(nextId, true); await invoke('cancel_folder_scan', { token });
  await assert.rejects(page(token)); await invoke('release_folder_scan', { token });
  report.checks.push('cancel clears unpublished results and release frees active slot');
  // Successful exchange replacement also invalidates a completed scan; failure preserves it.
  token = await scan(nextId); await terminal();
  const exchange = async (command, args) => {
    await h.evaluate(`window.__exchangeEvents=[];window.__exchangeChannel=window.__TAURI_INTERNALS__.transformCallback(e=>{if(e.message)window.__exchangeEvents.push(e.message);});`);
    const channel = await h.evaluate('return "__CHANNEL__:"+window.__exchangeChannel');
    await invoke(command, { ...args, onEvent: channel });
    await h.until('window.__exchangeEvents.some(e=>e.type!=="progress")', 'exchange terminal');
    return h.evaluate('return window.__exchangeEvents.find(e=>e.type!=="progress")');
  };
  const expected = { projectId: nextId, expectedRevision: 0 };
  const exported = path.join(output, 'exchange.json');
  assert.equal((await exchange('export_annotations', { expected, path: exported })).type, 'completed');
  assert.equal((await exchange('import_exchange', { expected, source: path.join(output, 'absent.json'), parent: output })).type, 'failed');
  assert.equal((await page(token)).total, 260);
  const imported = await exchange('import_exchange', { expected, source: exported, parent: output });
  assert.equal(imported.type, 'completed'); await assert.rejects(page(token));
  report.checks.push('failed exchange preserves scan; successful exchange replacement invalidates scan');
} catch (error) { report.error = error.stack; process.exitCode = 1; }
finally { await h?.quit(); await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); }
