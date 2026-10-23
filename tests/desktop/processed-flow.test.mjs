import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { canonicalEdits } from '../../src/features/spectrogram/analysisSource.ts';
import { processedUI } from './task5-ui.mjs';
import { start } from './harness.mjs';

const output = path.resolve(process.env.ANNOTATOR_PROCESSED_OUTPUT ?? '.test-output/fidelity-task5/processed');
await fs.mkdir(output, { recursive: true });
const rate = 48000, frames = rate * 2, channels = 2;
const wav = Buffer.alloc(44 + frames * channels * 2);
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20); wav.writeUInt16LE(channels, 22); wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * channels * 2, 28);
wav.writeUInt16LE(channels * 2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
for (let i = 0; i < frames; i++) for (let c = 0; c < channels; c++) {
  const x = .3 * Math.sin(2 * Math.PI * 1500 * i / rate) + .3 * Math.sin(2 * Math.PI * 6000 * i / rate);
  wav.writeInt16LE(Math.round(x * 32767), 44 + (i * channels + c) * 2);
}
const audio = path.join(output, 'dual-tone.wav'), other = path.join(output, 'other.wav');
await fs.writeFile(audio, wav); await fs.writeFile(other, wav);
const hashFile = async file => createHash('sha256').update(await fs.readFile(file)).digest('hex');
const beforeHash = await hashFile(audio), project = await fs.mkdtemp(path.join(output, 'project-'));
const report = { stage: 'Actual UI processed graphs, audition, save/reopen plus native IPC authority checks', checks: [], sourceSha256: beforeHash };
let h;
try {
  h = await start({ '新建项目 · 选择空文件夹': [project], '打开项目 · 选择 project.json':[path.join(project,'project.json')], '': [[audio, other]] }, output);
  await h.menu('新建项目'); await h.until(`document.querySelector('.project-identity')?.textContent.includes('已保存')`);
  await h.clickText('导入音频'); await h.until(`document.querySelector('.import-progress')?.textContent.includes('导入完成')`); await h.clickText('关闭导入结果');
  await h.until(`document.querySelector('canvas')&&!document.querySelector('.tile-status')`);
  await h.screenshot('original-default-ui');
  const projectId = JSON.parse(await fs.readFile(path.join(project, 'project.json'), 'utf8')).projectId;
  await processedUI(h,projectId,report);
  const rpc = async (command, args) => {
    const result = await h.driver.executeAsyncScript(`const [command,args,done]=arguments;window.__TAURI_INTERNALS__.invoke(command,args).then(value=>done({value}),error=>done({error}));`, command, args);
    if (result.error) throw result.error;
    return result.value;
  };
  let document = (await h.snapshot(projectId)).document;
  const media = document.media[0], settings = document.analysis[media.id];
  let viewId = await rpc('register_analysis_view', { projectId });
  const configHash = createHash('sha256').update(['analysis-v1', settings.window, settings.windowSize, settings.hopSize, settings.fftSize, settings.melBands].join('|')).digest('hex');
  const signature = () => createHash('sha256').update(canonicalEdits(media.id, document.edits)).digest('hex');
  const change = async change => { document = (await rpc('apply_change', { projectId, expectedRevision: document.revision, change })).document; };
  const history = async command => { document = (await rpc(command, { projectId, expectedRevision: document.revision })).document; };
  const request = async (analysisSource = 'processed', editSignature = signature(), patch = {}) => {
    const request = { requestId: randomUUID(), viewId, projectId, mediaId: media.id, generation: 1, analysisSource, processingVersion: 1, editSignature: analysisSource === 'original' ? '' : editSignature, configHash, settings, channelIndex: 0, kind: 'stft', startFrame: 40, frameCount: 8, timeLod: 0, frequencyStart: 0, frequencyCount: 1025, frequencyLod: 0, visible: true, ...patch };
    const result = await h.driver.executeAsyncScript(`const [request,done]=arguments;const api=window.__TAURI_INTERNALS__,callback=api.transformCallback(()=>{});api.invoke('request_tile',{request,onEvent:'__CHANNEL__:'+callback}).then(buffer=>{const view=new DataView(buffer),length=view.getUint32(4,true),offset=Math.ceil((8+length)/4)*4,header=JSON.parse(new TextDecoder().decode(new Uint8Array(buffer,8,length)));done({header,values:Array.from(new Float32Array(buffer,offset))});},error=>done({error})).finally(()=>api.unregisterCallback(callback));`, request);
    if (result.error) throw result.error;
    assert.deepEqual(result.header.request, request);
    return result.values;
  };
  const energy = (values, hz) => {
    const bin = Math.round(hz * settings.fftSize / rate);
    return 10 * Math.log10(Array.from({ length: 8 }, (_, row) => 10 ** (values[row * 1025 + bin] / 10)).reduce((a, b) => a + b) / 8);
  };
  const original = await request('original'), emptySignature = signature(), unedited = await request();
  for (const hz of [1500, 6000]) assert.ok(Math.abs(energy(unedited, hz) - energy(original, hz)) < .001);
  const edit = { id: randomUUID(), region: { mediaId: media.id, channelIndex: 0, startSeconds: 0, endSeconds: 2, lowHz: 1000, highHz: 2000 }, enabled: true, processingVersion: 1 };
  await change({ type: 'addEdit', edit });
  const editedSignature = signature(); assert.notEqual(editedSignature, emptySignature);
  await rpc('save_project', { projectId, expectedRevision: document.revision });
  const processed = await request();
  const rejectionDb = energy(processed, 1500) - energy(original, 1500), retainedDb = energy(processed, 6000) - energy(original, 6000);
  assert.ok(rejectionDb < -30); assert.ok(Math.abs(retainedDb) < 1);
  report.checks.push({ name: 'saved mask uses real processed PCM', rejectionDb, retainedDb, editedSignature });
  await assert.rejects(request('processed', emptySignature), error => error.code === 'Cancelled');
  await assert.rejects(request('processed', '0'.repeat(64)), error => error.code === 'Cancelled');
  await assert.rejects(request('processed', editedSignature, { processingVersion: 2 }), error => error.code === 'InvalidInput');
  await assert.rejects(request('processed', editedSignature, { extraAuthority: true }), error => !!error);
  assert.deepEqual(await request('original'), original);
  const right = await request('processed', editedSignature, { channelIndex: 1 });
  assert.ok(Math.abs(energy(right, 1500) - energy(original, 1500)) < .001);
  report.checks.push({ name: 'old/forged/unsupported/unknown identity rejected; raw cache and independent channel preserved' });
  await change({ type: 'setEditEnabled', id: edit.id, enabled: false }); assert.equal(signature(), emptySignature); assert.deepEqual(await request(), unedited);
  await change({ type: 'setEditEnabled', id: edit.id, enabled: true }); assert.equal(signature(), editedSignature); assert.deepEqual(await request(), processed);
  const moved = { ...edit, region: { ...edit.region, lowHz: 5500, highHz: 6500 } };
  await change({ type: 'updateEdit', edit: moved }); const movedSignature = signature(); const movedValues = await request();
  assert.ok(energy(movedValues, 6000) - energy(original, 6000) < -30); assert.ok(Math.abs(energy(movedValues, 1500) - energy(original, 1500)) < 1);
  await assert.rejects(request('processed', editedSignature), error => error.code === 'Cancelled');
  await history('undo'); assert.equal(signature(), editedSignature); assert.deepEqual(await request(), processed);
  await history('redo'); assert.equal(signature(), movedSignature); assert.deepEqual(await request(), movedValues);
  await change({ type: 'removeEdit', id: edit.id }); assert.deepEqual(await request(), unedited);
  await history('undo'); assert.deepEqual(await request(), movedValues);
  report.checks.push({ name: 'disable/enable/move/undo/redo/delete restore matching source and cached values', movedSignature });
  await change({ type: 'updateMediaNote', mediaId: media.id, note: 'unrelated note', mergeKey: null });
  await change({ type: 'addEdit', edit: { ...edit, id: randomUUID(), region: { ...edit.region, mediaId: document.media[1].id } } });
  assert.equal(signature(), movedSignature); assert.deepEqual(await request('processed', movedSignature), movedValues);
  await rpc('save_project', { projectId, expectedRevision: document.revision });
  const saved = JSON.parse(await fs.readFile(path.join(project, 'project.json'), 'utf8'));
  assert.equal(saved.formatVersion, 2); assert.deepEqual(saved.edits, document.edits);
  const oldView = viewId;
  await rpc('close_project', { projectId, expectedRevision: document.revision, discard: false });
  const reopened = await rpc('open_project', { path: project }); assert.equal(reopened.recovery, null); document = reopened.snapshot.document;
  await assert.rejects(request(), error => error.code === 'Cancelled');
  viewId = await rpc('register_analysis_view', { projectId }); assert.notEqual(viewId, oldView);
  assert.equal(signature(), movedSignature); assert.deepEqual(await request(), movedValues);
  await rpc('retire_analysis_view', { projectId, viewId });
  await assert.rejects(request(), error => error.code === 'Cancelled');
  assert.equal(await hashFile(audio), beforeHash); assert.equal(document.media[0].sha256, beforeHash);
  report.checks.push({ name: 'notes/other-file edits keep signature; normal v2 save/reopen reproduces source; old runtime/retired lease rejected; original WAV SHA256 unchanged' });
  report.passed = true;
} catch (error) {
  report.error = error.stack ?? error; process.exitCode = 1; await h?.screenshot('failure').catch(() => {});
} finally {
  await h?.quit(); await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
}
