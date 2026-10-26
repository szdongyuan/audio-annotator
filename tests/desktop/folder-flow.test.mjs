import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { start, wait } from './harness.mjs';

const base = path.resolve(process.env.ANNOTATOR_SUITE_OUTPUT ?? '.test-output/default-collaboration-v040/task5/desktop-evidence/folder-flow'); await fs.mkdir(base, { recursive: true });
const output = await fs.realpath(await fs.mkdtemp(path.join(base, 'native-')));
// All fixtures belong to this unique evidence directory and are retained for inspection.
const [audio, retryAudio, endAudio, project, next, cancelledProject] = ['audio', 'retry-audio', 'end-audio', 'project', 'next', 'cancelled-project'].map(p => path.join(output, p));
for (const p of [audio, retryAudio, endAudio, project, next, cancelledProject, path.join(audio, 'nested','deeper')]) await fs.mkdir(p, { recursive: true });
function wav() {
  const frames = 960, channels = 2, data = Buffer.alloc(44 + frames * channels * 2);
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8); data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(channels, 22); data.writeUInt32LE(48000, 24); data.writeUInt32LE(48000 * channels * 2, 28); data.writeUInt16LE(channels * 2, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(data.length - 44, 40);
  for (let f = 0; f < frames; f++) for (let c = 0; c < channels; c++) data.writeInt16LE(Math.round(1000 * Math.sin(f * .1 + c)), 44 + (f * channels + c) * 2);
  return data;
}
const bytes = wav();
for (let i = 0; i < 257; i++) { const name = `${String(i).padStart(3, '0')}.${i % 2 ? 'wav' : 'WAV'}`; await fs.writeFile(path.join(audio, name), bytes); await fs.writeFile(path.join(retryAudio, name), bytes); }
await fs.writeFile(path.join(audio, 'nested','deeper', '000.WAV'), bytes); await fs.writeFile(path.join(audio, 'corrupt.wav'), 'not a WAV'); await fs.writeFile(path.join(audio, 'skip.txt'), 'unsupported'); await fs.writeFile(path.join(endAudio, 'end.wav'), bytes);
const movedAudio = path.join(endAudio, 'moved.wav');
const paths = { '新建项目 · 选择空文件夹': [project, cancelledProject, next], '选择音频文件夹': [audio, path.join(audio,'nested'), path.join(project,'media'), retryAudio, endAudio, audio, retryAudio], '': [[path.join(endAudio, 'end.wav')], movedAudio] };
const report = { method: 'Owned native e2e Tauri/WebView2, WebDriver menu/options/buttons; native folder scan/decode/command queue. Only picker return values injected. Explicitly labeled transport-failure and Channel-delay injections exercise recovery/cancellation deterministically; no store mutations.', output, checks: [], frames: [] };
let h, id, projectIndex = 0;
const check = name => { report.checks.push(name); console.log('PASS ' + name); };
const resultText = () => h.evaluate(`return document.querySelector('.source-import-progress')?.textContent`);
const snap = async () => (await h.snapshot(id)).document;
async function folder(recursive = false) {
  await h.menu('导入文件夹');
  await h.select('规则预设', '全部音频');
  assert.equal(await (await h.element('[role="dialog"] input[type="checkbox"]')).isSelected(), true);
  if (!recursive) await h.click('[role="dialog"] input[type="checkbox"]');
  await h.clickText('选择文件夹…');
  const heldScan=await h.evaluate('return window.__folderTest.holdScan');
  await h.until("Array.from(document.querySelectorAll('.dialog-actions button')).some(b=>b.textContent==='扫描预览'&&!b.disabled)",'source selection ready for scanning');await h.clickText('扫描预览');
  if(heldScan)return;
  await h.until("document.querySelector('.source-preview')");
  const count=await h.evaluate("return parseInt(document.querySelector('.source-preview strong').textContent)");
  if(count)await h.clickText('导入 '+count+' 个音频');
}
async function finished() { const started=Date.now();await h.until(`document.querySelector('.source-import-progress')?.textContent.includes('音频导入完成')`, 'folder completion', 900000);(report.completionWaitMs??=[]).push(Date.now()-started); }
async function closeResult() { await h.clickText('关闭结果'); await h.until(`!document.querySelector('.source-import-progress')`); assert.equal(await h.evaluate(`return document.querySelectorAll('.import-progress').length`), 0); }
async function create() { const expected = [project, cancelledProject, next][projectIndex++]; await h.menu('新建项目'); await h.until(`document.querySelector('.project-identity')?.title.endsWith(${JSON.stringify(expected)})&&document.querySelector('.project-identity')?.textContent.match(/已保存|已存本机/)`); id = JSON.parse(await fs.readFile(path.join(expected, 'collaboration.json'), 'utf8')).projectId; }
try {
  h = await start(paths, output, undefined, { exactOuter: true }); h.nativeRect({ width: 1280, height: 800 }); report.pid = h.nativePid;
  await create();
  await h.evaluate(`window.__folderTest={calls:[],held:[],failNext:false,holdNext:false,holdScan:false};const original=window.fetch;window.fetch=function(resource,options){const s=window.__folderTest,command=decodeURIComponent(String(resource).split('/').at(-1)),args=typeof options?.body==='string'?JSON.parse(options.body):{};s.calls.push({command,args});if((command==='import_source_batch'&&s.holdNext)||(command==='scan_import_sources'&&s.holdScan)){const scan=command==='scan_import_sources';s.holdNext=false;s.holdScan=false;s.holdScanActive=scan;const id=Number(args.onEvent.split(':')[1]),callbacks=window.__TAURI_INTERNALS__.callbacks,receive=callbacks.get(id);callbacks.set(id,envelope=>{const event=envelope.message;if('end' in envelope||(scan?event?.type==='result':event?.type==='finished'||event?.type==='ready'&&event.index>0))s.held.push(()=>receive(envelope));else receive(envelope);});}if(command==='apply_change'&&args.change?.type==='importMedia'&&s.failNext){s.failNext=false;return Promise.resolve(new Response(JSON.stringify({code:'SaveFailed',message:'Injected folder publication failure',retryable:true}),{headers:{'Content-Type':'application/json','Tauri-Response':'error'}}));}return original.call(this,resource,options);};`);
  await folder(); await finished();
  let doc = await snap(); assert.equal(doc.media.length, 257); assert.equal(new Set(doc.media.map(m => m.sourceRef.toLowerCase())).size, 257);
  assert.match(await resultText(), /成功 257 · 失败 1 · 跳过 1/);
  let calls = await h.evaluate('return window.__folderTest.calls');
  assert.deepEqual(calls.filter(c => c.command === 'import_source_batch').map(c => c.args.indices.length), [256, 2]); assert.equal(calls.find(c => c.command === 'scan_import_sources').args.config.rules.recursive, false);
  assert.equal(await h.evaluate(`return document.querySelectorAll('.import-progress').length`), 1);
  await h.clickText('查看详情'); assert.equal(await h.evaluate(`return document.querySelectorAll('.source-import-progress li').length`), 50); await h.clickText('下一页'); assert.match(await h.evaluate(`return document.querySelector('.source-import-progress li').textContent`), /^51\./);
  await h.screenshot('257-imported-paged'); check('Explicit nonrecursive scan imports all 257 distinct paths across 256+2 (one corrupt) with bounded result DOM and one aggregate panel');
  await closeResult(); await folder(true); await finished(); assert.equal((await snap()).media.length, 258); assert.match(await resultText(), /成功 1 · 失败 0 · 跳过 0/);
  calls=await h.evaluate('return window.__folderTest.calls');assert.equal(calls.filter(c=>c.command==='scan_import_sources').at(-1).args.config.rules.recursive,true);
  check('Recursive nested-folder scan imports its one same-name source as an independent UUID; same-byte inputs remain distinct');
  await closeResult(); await folder(true); assert.equal((await snap()).media.length, 258); assert.match(await h.evaluate("return document.querySelector('.source-preview').textContent"), /0 个音频跳过 258/); await h.clickText('取消'); check('Scanning copied canonical public sources skips every already-present media path'); await closeResult();

  await h.evaluate('window.__folderTest.failNext=true'); await folder(); await h.until(`document.querySelector('.source-import-progress')?.textContent.includes('导入已暂停')`, 'publication pause', 900000);
  assert.equal((await snap()).media.length, 513); // 258 + 255 committed, one retained prepared failure.
  calls = await h.evaluate('return window.__folderTest.calls'); assert.equal(calls.filter(c => c.command === 'import_source_batch' && c.args.token.taskId === calls.filter(c=>c.command==='import_source_batch').at(-1).args.token.taskId).length, 1);
  await h.screenshot('paused-owned-ledger'); await h.clickText('重试并继续导入'); await finished();
  assert.equal((await snap()).media.length, 515); assert.match(await resultText(), /成功 257 · 失败 0/); assert.equal(await h.evaluate(`return !!document.querySelector('.annotation-failure')`), false);
  check('Injected one publication failure pauses before batch 2; explicit retry reuses original prepared PCM, resumes final item and corrects aggregate success'); await closeResult();
  await h.evaluate('window.__folderTest.failNext=true'); await folder(); await h.until(`document.querySelector('.source-import-progress')?.textContent.includes('导入已暂停')`);
  await h.clickText('取消导入'); assert.ok(await h.evaluate(`return !!document.querySelector('.annotation-failure')`)); await h.clickText('结束并放弃失败项'); await h.until(`!document.querySelector('.annotation-failure')`);
  assert.equal((await snap()).media.length, 515); assert.ok(await h.evaluate(`return window.__folderTest.calls.some(c=>c.command==='release_media_import')`)); check('Cancel preserves failed edit; explicit End abandons only this failed import and releases native PCM'); await closeResult();

  await h.clickText('双文件对比'); await h.until(`document.querySelectorAll('.spectrogram-surface').length===4`);
  const frame = await h.evaluate(`const r=e=>e.getBoundingClientRect().toJSON();return {inner:[innerWidth,innerHeight],top:r(document.querySelector('.project-header')).height+r(document.querySelector('.workspace-toolbar')).height,bottom:r(document.querySelector('.playback-bar')).height,plots:[...document.querySelectorAll('.spectrogram-surface')].map(r),headers:[...document.querySelectorAll('.file-pane')].map(p=>r(p.querySelector('.file-heading')).height+r(p.querySelector('.file-controls')).height),feedback:r(document.querySelector('.workspace-feedback')).height};`);
  assert.equal(frame.top, 72); assert.equal(frame.bottom, 48); assert.ok(frame.headers.every(n => n === 54)); assert.ok(frame.plots.every(p => p.height === 236.5 && p.bottom <= frame.inner[1])); assert.equal(frame.feedback, 0); report.frames.push({ outer: h.nativeRect(), ...frame }); await h.screenshot('folder-results-dismissed-layout'); check('Dismissed folder results reserve no feedback height; exact 1280x800 outer window retains four 236.5px plots and 72/48/54 budgets');

  await create(); await h.evaluate('window.__folderTest.holdNext=true'); await folder(); await h.until(`window.__folderTest.held.length>=2&&document.querySelector('.source-import-progress')?.textContent.includes('成功 1')`, 'first accepted and late native results held');
  const before = Date.now(); await h.clickText('取消导入'); assert.match(await resultText(), /音频导入已取消/); report.cancelVisibleMs = Date.now() - before; assert.ok(report.cancelVisibleMs < 500);
  assert.equal((await snap()).media.length, 1); await create(); assert.equal((await snap()).media.length, 0);
  await h.evaluate('window.__folderTest.held.splice(0).forEach(deliver=>deliver())'); await wait(350); assert.equal((await snap()).media.length, 0);
  calls = await h.evaluate('return window.__folderTest.calls'); assert.ok(calls.some(c => c.command === 'cancel_media_import')); assert.ok(calls.filter(c => c.command === 'release_media_import').length > 1);
  check('Injected delayed native ready/finished: cancellation visible under 500ms retains accepted media; new project remains empty and old PCM releases');
  await h.evaluate('window.__folderTest.holdScan=true'); await folder(); await h.until('window.__folderTest.held.length>0', 'scan result held'); const importsBefore = await h.evaluate(`return window.__folderTest.calls.filter(c=>c.command==='import_source_batch').length`);
  await h.clickText('取消'); await h.evaluate('window.__folderTest.held.splice(0).forEach(deliver=>deliver());window.__folderTest.holdScanActive=false'); await wait(150); assert.equal(await h.evaluate(`return window.__folderTest.calls.filter(c=>c.command==='import_source_batch').length`), importsBefore); assert.equal((await snap()).media.length, 0); check('Injected delayed scan terminal: cancel calls scan cancellation/release and late result cannot start a decoder'); await closeResult();
  await h.clickText('导入音频'); await h.until(`document.querySelector('.import-progress')?.textContent.includes('导入完成')`); assert.equal((await snap()).media.length, 1); check('Direct multi-select audio import still works after folder cancellation');
  const originalMedia = (await snap()).media[0]; await h.clickText('关闭导入结果'); await fs.rename(path.join(endAudio, 'end.wav'), movedAudio);
  const copiedPath=path.join(next,originalMedia.sourceRef),missingCopy=copiedPath+'.owned-offline';await fs.rename(copiedPath,missingCopy);try{
  await h.until(`document.querySelector('.media-availability')?.textContent.includes('源文件缺失')`); await h.clickText('重新关联'); await h.clickText('选择文件…'); await h.until(`document.querySelector('.import-progress')?.textContent.includes('导入完成')`);
  const relinked = (await snap()).media[0]; assert.ok(relinked.sourceRef.endsWith('moved.wav')); assert.deepEqual({...relinked,sourceRef:originalMedia.sourceRef},originalMedia); check('Real relink picker verifies moved fixture and preserves descriptor identity/classification/notes');
  }finally{await fs.rename(missingCopy,copiedPath);}
  report.passed = true;
} catch (error) { report.error = error.stack; console.error(error); report.state = await h?.evaluate(`return {body:document.body.innerText,calls:window.__folderTest?.calls.slice(-20),held:window.__folderTest?.held.length}`).catch(() => null); await h?.screenshot('failure').catch(() => {}); process.exitCode = 1; }
finally { await h?.quit().catch(() => {}); await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ output, passed: report.passed, checks: report.checks, error: report.error }, null, 2)); }
