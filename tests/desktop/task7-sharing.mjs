import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { start, Key, wait } from './harness.mjs';
import { coordinates } from '../../src/features/spectrogram/coordinates.ts';
import { canonicalEdits } from '../../src/features/spectrogram/analysisSource.ts';
import { outputAfter, playbackStatus, rpc } from './task5-ui.mjs';

const hashFile = async file => createHash('sha256').update(await fs.readFile(file)).digest('hex');
const semantics = document => {
  const d = structuredClone(document);
  for (const key of ['projectId', 'revision', 'updatedAt','createdAt']) delete d[key];
  for (const m of d.media) delete m.sourceRef;
  return d;
};
async function bitmap(h) {
  await h.until(`document.querySelector('canvas')&&!document.querySelector('.tile-status')`);
  await wait(200);
  return h.evaluate(`return [...document.querySelectorAll('canvas')].map(c=>{const data=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let hash=2166136261;for(const v of data)hash=Math.imul(hash^v,16777619);return {hash:hash>>>0,width:c.width,height:c.height};})`);
}
async function save(h) {
  await h.clickText('保存');
  await h.until(`document.querySelector('.project-identity')?.textContent.match(/已保存|已存本机/)`);
}
async function exportFile(h, annotations = false) {
  await h.menu('导出我的标注 / 项目包');
  assert.equal(await (await h.element('[aria-label="我的项目包（含音频）"]')).isSelected(), true);
  const labels = await h.evaluate(`return [...document.querySelectorAll('input[name="exchange-format"]')].map(e=>e.getAttribute('aria-label'))`);
  assert.deepEqual(labels, ['我的项目包（含音频）', '我的标注（不含音频）']);
  if (annotations) await h.label('我的标注（不含音频）');
  await h.clickText('选择保存位置…');
  await h.until(`document.querySelector('.exchange-result')&&!document.querySelector('.exchange-progress')`);
  await h.screenshot(annotations ? 'export-annotations' : 'export-default-bundle');
  await h.clickText('关闭');
}
async function importFile(h, bindings) {
  await h.menu('导入分享文件');
  await h.clickText('选择交换文件…');
  if(bindings)await h.bindSources(bindings);
  await h.until(`document.querySelector('.exchange-result')&&!document.querySelector('.exchange-progress')`);
  await h.clickText('关闭');
  const root = (await h.evaluate(`return document.querySelector('.project-identity').title`)).replace(/^\\\\\?\\/, '');
  const manifest=JSON.parse(await fs.readFile(path.join(root,'collaboration.json'),'utf8'));return {root,document:(await h.snapshot(manifest.projectId)).document};
}
async function actualTileEnergy(h, document, masked=true) {
  const media = document.media.find(m=>m.displayName==='dual-tone.wav'), settings = document.analysis[media.id], projectId = document.projectId;
  const viewId = await rpc(h, 'register_analysis_view', { projectId });
  const configHash = createHash('sha256').update(['analysis-v1', settings.window, settings.windowSize, settings.hopSize, settings.fftSize, settings.melBands].join('|')).digest('hex');
  const editSignature = createHash('sha256').update(canonicalEdits(media.id, document.edits)).digest('hex');
  const values = {};
  try {
    for (const analysisSource of ['original', 'processed']) {
      const request = { requestId: randomUUID(), viewId, projectId, mediaId: media.id, generation: 1, analysisSource, processingVersion: 1, editSignature: analysisSource === 'original' ? '' : editSignature, configHash, settings, channelIndex: 0, kind: 'stft', startFrame: Math.round(3 * media.sampleRate / settings.hopSize), frameCount: 8, timeLod: 0, frequencyStart: 0, frequencyCount: settings.fftSize / 2 + 1, frequencyLod: 0, visible: true };
      const result = await h.driver.executeAsyncScript(`const [request,done]=arguments,api=window.__TAURI_INTERNALS__,callback=api.transformCallback(()=>{});api.invoke('collaboration_status').then(s=>api.invoke('request_tile',{runtimeNonce:s.runtimeNonce,request,onEvent:'__CHANNEL__:'+callback})).then(buffer=>{const v=new DataView(buffer),length=v.getUint32(4,true),offset=Math.ceil((8+length)/4)*4,header=JSON.parse(new TextDecoder().decode(new Uint8Array(buffer,8,length)));done({header,values:Array.from(new Float32Array(buffer,offset))});},error=>done({error})).finally(()=>api.unregisterCallback(callback));`, request);
      assert.equal(result.error, undefined, JSON.stringify(result.error));
      assert.deepEqual(result.header.request, request);
      values[analysisSource] = Object.fromEntries([1500, 6000].map(hz => {
        const bin = Math.round(hz * settings.fftSize / media.sampleRate);
        return [hz, 10 * Math.log10(Array.from({ length: 8 }, (_, row) => 10 ** (result.values[row * result.header.tile.columns + bin] / 10)).reduce((a, b) => a + b) / 8)];
      }));
    }
  } finally { await rpc(h, 'retire_analysis_view', { projectId, viewId }); }
  const rejectionDb = values.processed[1500] - values.original[1500], retainedDb = values.processed[6000] - values.original[6000];
  assert.ok(masked?rejectionDb < -30:Math.abs(rejectionDb)<.01, JSON.stringify(values));
  assert.ok(Math.abs(retainedDb) < 1, JSON.stringify(values));
  return { values, rejectionDb, retainedDb, editSignature };
}

export async function standaloneSharing() {
  const parent = path.resolve(process.env.ANNOTATOR_SHARING_OUTPUT ?? '.test-output/fidelity-task7');
  await fs.mkdir(parent, { recursive: true });
  const output = await fs.mkdtemp(path.join(parent, 'native-'));
  const project = path.join(output, 'project'), copy = path.join(output, 'local-copy'), originals = path.join(output, 'owned-originals'), unavailable = path.join(output, 'owned-originals-unavailable'), recipient = path.join(output, 'recipient');
  for (const dir of [project, copy, originals, recipient]) await fs.mkdir(dir);
  const wav = Buffer.alloc(44 + 48000 * 8 * 2 * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22); wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(192000, 28); wav.writeUInt16LE(4, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  for (let i = 0; i < 48000 * 8; i++) for (let c = 0; c < 2; c++) wav.writeInt16LE(Math.round(32767 * (.3 * Math.sin(2 * Math.PI * 1500 * i / 48000) + .3 * Math.sin(2 * Math.PI * 6000 * i / 48000))), 44 + (i * 2 + c) * 2);
  const sources = ['dual-tone.wav', 'second-original.wav'].map(name => path.join(originals, name));
  await fs.writeFile(sources[0], wav);
  const otherWav = Buffer.from(wav);
  for (let i = 0; i < 48000 * 8; i++) for (let c = 0; c < 2; c++) otherWav.writeInt16LE(Math.round(32767 * .25 * Math.sin(2 * Math.PI * 3000 * i / 48000)), 44 + (i * 2 + c) * 2);
  await fs.writeFile(sources[1], otherWav);
  const hashes = await Promise.all(sources.map(hashFile));
  const zip = path.join(output, 'portable.audioproj.zip'), json = path.join(output, 'annotations.annotations.json');
  const paths = { '新建项目 · 选择空文件夹': [project], '另存我的项目副本 · 选择空文件夹': [copy], '': [sources,...sources.map(file=>path.join(unavailable,path.basename(file)))], '分享 · 保存到本机': [zip, json], '导入标注文件或完整项目包': [zip, json], '选择新项目的存放位置 · 将创建独立子文件夹': [recipient, recipient] };
  const report = { output, method: 'Fresh debug/e2e EXE; owned Selenium/WebView2 pointer and keyboard. Only native picker return paths are injected. UI creates notes/categories/region/mask, saves, exports, imports and plays; read-only native snapshots/tiles/output frames measure results.', checks: [] };
  const check = (name, detail = {}) => { report.checks.push({ name, ...detail }); console.log(`PASS ${name}`); };
  let h, moved = false;
  const owned = candidate => { const resolved = path.resolve(candidate), relative = path.relative(output, resolved); assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), `Not owned: ${resolved}`); return resolved; };
  try {
    h = await start(paths, output);
    await h.menu('新建项目'); await h.until(`document.querySelector('.project-identity')?.textContent.match(/已保存|已存本机/)`);
    let id = JSON.parse(await fs.readFile(path.join(project, 'collaboration.json'), 'utf8')).projectId;
    await h.clickText('导入音频'); await h.until(`document.querySelector('.import-progress')?.textContent.includes('导入完成')`); await h.clickText('关闭导入结果');await h.selectMedia('dual-tone.wav'); await bitmap(h);
    await h.menu('类别管理', '标注'); await h.input('类别名称', '分享分类'); await h.clickText('添加类别'); await h.until(`document.querySelector('.category-row')`);
    await h.click('.file-heading h2'); await h.input('音频备注', '文件备注：完整分享');
    await h.click('.file-heading .classification-control'); await h.label('文件类别'); await h.label('分享分类');
    await h.click('.channel-pane:nth-child(2) .channel-caption strong'); await h.input('通道 2 备注', '通道备注：独立保留');
    await h.click('.channel-pane:nth-child(2) .classification-control'); await h.label('通道类别'); await h.label('分享分类');
    const initial = (await h.snapshot(id)).document, media = initial.media.find(m=>m.displayName==='dual-tone.wav');
    const view = initial.viewState.media[media.id] ?? { startSeconds: 0, endSeconds: 8, lowHz: 0, highHz: 24000, frequencyMix: .65, spectrumKind: 'stft' };
    const c = coordinates(view, 24000, 1, 1);
    await h.drag('.channel-pane:first-child .annotation-overlay', [.2, c.hzToY(2100)], [.8, c.hzToY(900)]);
    await h.click('.selection-toolbar button[aria-label="标注"]'); await h.label('分享分类'); await h.until(`document.querySelector('.annotation-inspector')`);
    await h.input('区域备注', '区域备注：屏蔽可恢复');
    await h.click('.annotation-rect.is-selected'); await h.driver.actions().sendKeys(Key.DELETE).perform(); await h.until(`document.querySelector('.mask-rect')`);
    await save(h);
    const saved = (await h.snapshot(id)).document, categoryId = saved.categories[0].id;
    assert.equal(saved.media.find(m=>m.displayName==='dual-tone.wav').categoryId, categoryId); assert.equal(saved.media.find(m=>m.displayName==='dual-tone.wav').channelCategoryIds[1], categoryId); assert.equal(saved.annotations[0].categoryId, categoryId);
    assert.equal(saved.media.find(m=>m.displayName==='dual-tone.wav').note, '文件备注：完整分享'); assert.equal(saved.media.find(m=>m.displayName==='dual-tone.wav').channelNotes[1], '通道备注：独立保留'); assert.equal(saved.annotations[0].note, '区域备注：屏蔽可恢复'); assert.equal(saved.edits.length, 1);
    const beforePixels = await bitmap(h), beforeEnergy = await actualTileEnergy(h, saved);
    check('actual UI creates and saves three independent classifications/notes plus processed mask', { beforeEnergy, beforePixels });
    await h.menu('另存我的项目副本'); await h.until(`document.querySelector('.project-identity')?.title.endsWith('local-copy')`);
    let idCopy=JSON.parse(await fs.readFile(path.join(copy,'collaboration.json'),'utf8')).projectId;let copied=(await h.snapshot(idCopy)).document;id=copied.projectId;
    // Default Save As creates a new identity and independent verified audio copies.
    assert.notEqual(id, saved.projectId); assert.deepEqual(semantics(copied), semantics(saved));
    for(const m of copied.media)assert.equal(await hashFile(path.resolve(copy,m.sourceRef)),m.sha256);assert.deepEqual(await actualTileEnergy(h,copied),beforeEnergy);
    assert.equal(await fs.stat(path.join(copy, 'media')).then(() => true, () => false), true);
    await h.click('.file-heading h2'); await h.input('音频备注', '文件备注：副本独立编辑'); await save(h);
    copied = (await h.snapshot(id)).document;
    assert.equal(copied.media.find(m=>m.displayName==='dual-tone.wav').note, '文件备注：副本独立编辑');
    assert.equal(saved.media.find(m=>m.displayName==='dual-tone.wav').note,'文件备注：完整分享');
    check('renamed local-copy action switches to independent project, retaining private masks and independent verified audio copies', { originalId: saved.projectId, copyId: id, copy, sources: copied.media.map(m => m.sourceRef) });
    await exportFile(h); await exportFile(h, true);
    assert.ok((await fs.stat(zip)).size > wav.length); assert.ok((await fs.stat(json)).size > 100);
    await h.menu('关闭项目');
    await fs.rename(owned(originals), owned(unavailable)); moved = true;
    for (const file of sources) await assert.rejects(fs.access(file));
    const imported = await importFile(h);
    assert.notEqual(imported.document.projectId, id);for(const key of ['annotations','categories'])assert.deepEqual(imported.document[key],copied[key]);assert.deepEqual(imported.document.edits,[]);await h.selectMedia('dual-tone.wav');
    assert.ok(path.relative(recipient, imported.root) && !path.relative(recipient, imported.root).startsWith('..'));
    const importedSources = [];
    for (const [index, m] of imported.document.media.entries()) {
      const file = path.resolve(imported.root, m.sourceRef), relative = path.relative(imported.root, file);
      assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative)); assert.equal(await hashFile(file),m.sha256);
      importedSources.push({ file, sha256: await hashFile(file) });
    }
    assert.equal(await h.evaluate(`return document.querySelector('[aria-label="声音版本"]').value`), 'processed');
    const recipientPixels = await bitmap(h), recipientEnergy = await actualTileEnergy(h, imported.document,false);
    assert.notDeepEqual(recipientPixels,beforePixels);assert.ok(Math.abs(recipientEnergy.rejectionDb)<.01);
    await h.select('声音版本', '原音'); const originalPixels = await bitmap(h); assert.equal(originalPixels[0].hash, recipientPixels[0].hash); assert.deepEqual(originalPixels.slice(1), recipientPixels.slice(1));
    await h.select('声音版本', '暂存编辑'); assert.deepEqual(await bitmap(h), recipientPixels);
    await h.menu('播放整段', '音频'); const playing = await outputAfter(h, 0); assert.ok(playing.consumedFrames > 2400); await h.label('停止');
    await h.screenshot('portable-import-originals-unavailable');
    check('independent bundle import with unavailable original paths preserves own labels and original audio while excluding private masks from processed tiles/canvas, consuming real native output frames', { importedRoot: imported.root, importedSources, recipientEnergy, recipientPixels, originalPixels, playing, stopped: await playbackStatus(h) });
    const annotations = await importFile(h,['dual-tone.wav','second-original.wav']);
    for(const key of ['annotations','categories'])assert.deepEqual(annotations.document[key],copied[key]);assert.deepEqual(annotations.document.edits,[]);
    await h.screenshot('annotations-requires-original-audio');
    check('annotations-only export verifies relocated originals before publishing a default project', { root: annotations.root });
    await h.menu('关闭项目'); report.passed = true;
  } catch (error) {
    report.error = error.stack ?? String(error); process.exitCode = 1; await h?.screenshot('failure').catch(() => {}); console.error(error);
  } finally {
    await h?.quit().catch(() => {});
    if (moved) await fs.rename(owned(unavailable), owned(originals));
    report.restoredHashes = await Promise.all(sources.map(hashFile)); assert.deepEqual(report.restoredHashes, hashes);
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
  }
}
