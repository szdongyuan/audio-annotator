import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { start, Key, wait } from './harness.mjs';
import { coordinates } from '../../src/features/spectrogram/coordinates.ts';

const output = path.resolve(process.env.ANNOTATOR_SUITE_OUTPUT ?? '.test-output/task3-rulers', process.env.ANNOTATOR_SUITE_OUTPUT ? '' : `run-${Date.now()}-${process.pid}`);
await fs.mkdir(output, { recursive: true });
// Reject occupied native-driver as well as application/driver ports before spawning anything.
for (const port of [4445, 4446, 9235]) {
  const occupied = await new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.setTimeout(500); socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false)); socket.once('timeout', () => { socket.destroy(); resolve(false); });
  });
  assert.equal(occupied, false, `Port ${port} occupied; refusing to attach or kill`);
}
const project = await fs.mkdtemp(path.join(output, 'project-'));
const report = { method: 'Owned debug/e2e Tauri exe rebuilt from current UI. Official WebDriver pointer, keyboard and wheel input. Synthetic deltaMode supplements explicitly identified. IPC instrumentation only counts and forwards real requests.', project, checks: [] };
let h;
const closeTo = (a, b, epsilon = 1e-8) => assert.ok(Math.abs(a - b) <= epsilon, `${a} != ${b} within ${epsilon}`);
try {
  h = await start({ '新建项目 · 选择空文件夹': [project], '': [[path.resolve('tests/fixtures/audio/stereo.mp3'), path.resolve('tests/fixtures/audio/short.wav')]] }, output);
  report.nativePid = h.nativePid;
  await h.evaluate(`window.__rulerEvidence={requests:[],wheels:[]}; const original=window.fetch;
    window.fetch=function(resource,...args){if(String(resource).endsWith('/request_tile'))window.__rulerEvidence.requests.push({url:String(resource),time:performance.now()});return original.call(this,resource,...args)};
    document.addEventListener('wheel',e=>{const r=e.target.closest('.spectrogram-surface')?.getBoundingClientRect();window.__rulerEvidence.wheels.push({trusted:e.isTrusted,ctrl:e.ctrlKey,shift:e.shiftKey,deltaY:e.deltaY,deltaMode:e.deltaMode,prevented:e.defaultPrevented,x:r?(e.clientX-r.left)/r.width:null,y:r?(e.clientY-r.top)/r.height:null})});`);
  await h.menu('新建项目'); await h.until(`document.querySelector('.project-identity')?.innerText.includes('已保存')`);
  const id = JSON.parse(await fs.readFile(path.join(project, 'project.json'), 'utf8')).projectId;
  await h.clickText('导入音频'); await h.until(`document.querySelector('.import-progress')?.innerText.includes('导入完成')`); await h.clickText('关闭导入结果');
  await h.until(`document.querySelectorAll('canvas').length===2 && !document.querySelector('.tile-status')`);
  await h.drag('.annotation-overlay', [.2, .25], [.6, .7]); await h.context('.annotation-overlay', [.4, .45]); await h.label('标注类型'); await h.clickText('未分类');
  await h.until(`document.querySelector('.annotation-inspector')`);
  const original = (await h.snapshot(id)).document, media = original.media[0], annotation = original.annotations[0];
  const snapshot = async () => { await wait(350); return (await h.snapshot(id)).document; };
  const view = async () => (await snapshot()).viewState.media[media.id];
  // Make the initial default view explicit through a real ruler action before reading persisted state.
  await h.context('.time-ruler'); await h.label('重置时间轴');
  const initialView = await view(), nyquist = media.sampleRate / 2;
  const plot = '.file-pane:first-child .spectrogram-surface';
  const wheel = async (deltaY, modifiers = [], point = [.4, .35]) => {
    const r = await h.evaluate('return document.querySelector(arguments[0]).getBoundingClientRect().toJSON()', plot), x = Math.round(r.x + r.width * point[0]), y = Math.round(r.y + r.height * point[1]);
    let actions = h.driver.actions().move({ origin: 'viewport', x, y });
    for (const key of modifiers) actions = actions.keyDown(key);
    actions = actions.scroll(x, y, 0, deltaY, 'viewport', 120);
    for (const key of [...modifiers].reverse()) actions = actions.keyUp(key);
    await actions.perform(); return h.evaluate('return window.__rulerEvidence.wheels.at(-1)');
  };
  const count = () => h.evaluate('return window.__rulerEvidence.requests.length');
  const warmCount = await count(); assert.ok(warmCount >= 2, 'counter observes real initial native requests');
  const dimensions = await h.evaluate('return [innerWidth,innerHeight,devicePixelRatio,visualViewport.scale]');
  await wheel(120, [Key.CONTROL]); closeTo((await view()).frequencyMix, initialView.frequencyMix - .06);
  await wheel(-120, [Key.CONTROL, Key.SHIFT]); closeTo((await view()).frequencyMix, initialView.frequencyMix);
  await wheel(-10000, [Key.CONTROL]); assert.equal((await view()).frequencyMix, 1);
  await wheel(10000, [Key.CONTROL]); assert.equal((await view()).frequencyMix, 0);
  await wheel(-120, [Key.CONTROL]); closeTo((await view()).frequencyMix, .06);
  assert.equal(await count(), warmCount, 'axis mixing sends zero new native tile requests');
  assert.deepEqual(await h.evaluate('return [innerWidth,innerHeight,devicePixelRatio,visualViewport.scale]'), dimensions, 'Ctrl did not zoom WebView');
  report.checks.push({ name: 'native Ctrl direction, clamps, Ctrl+Shift priority, unchanged page scale and warmed tile requests', warmCount, after: await count(), dimensions });

  // Reuse the exact shared coordinate module and measure the actual rendered frame/ticks.
  const measure = async label => {
    const current = await view(), c = coordinates(current, nyquist, 800, 300);
    let roundTrip = 0;
    for (let p = 0; p <= 800; p += .73) roundTrip = Math.max(roundTrip, Math.abs(c.secondsToX(c.xToSeconds(p)) - p));
    for (let p = 0; p <= 300; p += .37) roundTrip = Math.max(roundTrip, Math.abs(c.hzToY(c.yToHz(p)) - p));
    const dom = await h.evaluate(`const plot=document.querySelector('.annotation-overlay').getBoundingClientRect(),frame=document.querySelector('[data-annotation-id="${annotation.id}"]').getBoundingClientRect();
      return {width:plot.width,height:plot.height,frame:{left:frame.left-plot.left,top:frame.top-plot.top,width:frame.width,height:frame.height},rulers:[...document.querySelectorAll('.file-pane:first-child .time-ruler,.file-pane:first-child .frequency-ruler')].map(e=>{const b=e.getBoundingClientRect();return {axis:e.className,width:b.width,height:b.height,labels:[...e.querySelectorAll('.axis-label')].map(l=>{const r=l.getBoundingClientRect();return {text:l.textContent,fontSize:parseFloat(getComputedStyle(l).fontSize),left:r.left-b.left,top:r.top-b.top,right:r.right-b.left,bottom:r.bottom-b.top}}),ticks:[...e.querySelectorAll('[data-tick]')].map(t=>({value:+t.dataset.value,major:t.dataset.tick==='major',pixel:parseFloat(t.style.left||t.style.top)}))}})}`);
    const mapping = coordinates(current, nyquist, dom.width, dom.height), r = annotation.region;
    const expected = { left: mapping.secondsToX(r.startSeconds), top: mapping.hzToY(r.highHz), width: mapping.secondsToX(r.endSeconds) - mapping.secondsToX(r.startSeconds), height: mapping.hzToY(r.lowHz) - mapping.hzToY(r.highHz) };
    const frameError = Math.max(...Object.keys(expected).map(key => Math.abs(expected[key] - dom.frame[key])));
    assert.ok(roundTrip <= .5); assert.ok(frameError <= .5, `frame coordinate error ${frameError}`);
    for (const ruler of dom.rulers) {
      const time = ruler.axis === 'time-ruler', map = coordinates(current, nyquist, ruler.width, ruler.height);
      for (const tick of ruler.ticks) closeTo(tick.pixel, time ? map.secondsToX(tick.value) : map.hzToY(tick.value), .5);
      for (const l of ruler.labels) { assert.ok(l.fontSize >= 9); assert.ok(l.left >= -.5 && l.top >= -.5 && l.right <= ruler.width + .5 && l.bottom <= ruler.height + .5, `label clipping ${JSON.stringify(l)}`); }
      for (let i = 1; i < ruler.labels.length; i++) {
        const a = ruler.labels[i - 1], b = ruler.labels[i];
        assert.ok(time ? b.left >= a.right : b.top >= a.bottom, 'no overlapping labels');
        assert.ok((time ? (b.left + b.right - a.left - a.right) / 2 : (b.top + b.bottom - a.top - a.bottom) / 2) >= (time ? 60 : 22) - .5);
      }
      for (let i = 1; i < ruler.ticks.length; i++) assert.ok(ruler.ticks[i].pixel - ruler.ticks[i - 1].pixel >= 4 - .01);
    }
    assert.deepEqual((await snapshot()).annotations[0], annotation, 'view changes preserve saved physical annotation and metadata');
    report.checks.push({ name: label, roundTrip, frameError, view: current, rulers: dom.rulers });
  };
  await measure('linear-near axis frame/tick alignment'); await h.screenshot('linear-near');
  await h.context('.frequency-ruler', [.5, .5]); await h.label('完全对数'); assert.equal((await view()).frequencyMix, 1);
  await measure('full-log frame/tick alignment'); await h.screenshot('full-log');
  const beforeTime = await view(), anchor = await wheel(-120), afterTime = await view();
  closeTo(beforeTime.startSeconds + anchor.x * (beforeTime.endSeconds - beforeTime.startSeconds), afterTime.startSeconds + anchor.x * (afterTime.endSeconds - afterTime.startSeconds));
  assert.equal(afterTime.lowHz, beforeTime.lowHz); assert.equal(afterTime.highHz, beforeTime.highHz);
  const beforeFrequency = await view(), fAnchor = await wheel(-120, [Key.SHIFT]), afterFrequency = await view();
  closeTo(coordinates(beforeFrequency, nyquist, 1, 1).yToHz(fAnchor.y), coordinates(afterFrequency, nyquist, 1, 1).yToHz(fAnchor.y), 1e-6);
  assert.equal(afterFrequency.startSeconds, beforeFrequency.startSeconds); assert.equal(afterFrequency.endSeconds, beforeFrequency.endSeconds);
  report.checks.push({ name: 'native ordinary/Shift wheel anchored axis-only zoom', beforeTime, afterTime, beforeFrequency, afterFrequency });
  const beforeDrag = await view(); await h.drag('.time-ruler', [.8, .5], [.2, .5]); const afterDrag = await view();
  assert.ok(afterDrag.startSeconds > beforeDrag.startSeconds && afterDrag.endSeconds < beforeDrag.endSeconds); assert.equal(afterDrag.lowHz, beforeDrag.lowHz); assert.equal(afterDrag.highHz, beforeDrag.highHz);
  await h.drag('.frequency-ruler', [.5, .2], [.5, .8]); const afterFrequencyDrag = await view();
  assert.ok(afterFrequencyDrag.lowHz > afterDrag.lowHz && afterFrequencyDrag.highHz < afterDrag.highHz); assert.equal(afterFrequencyDrag.startSeconds, afterDrag.startSeconds); assert.equal(afterFrequencyDrag.endSeconds, afterDrag.endSeconds);
  await h.context('.time-ruler', [.4,.5]); await h.label('重置时间轴'); const resetTime = await view(); closeTo(resetTime.endSeconds, media.frameCount / media.sampleRate); assert.equal(resetTime.lowHz, afterFrequencyDrag.lowHz);
  await h.context('.frequency-ruler'); await h.label('重置频率轴'); const resetFrequency = await view(); assert.equal(resetFrequency.lowHz, 0); assert.equal(resetFrequency.highHz, nyquist); assert.equal(resetFrequency.endSeconds, resetTime.endSeconds);
  report.checks.push({ name: 'native reverse time drag, frequency drag and separate axis resets', beforeDrag, afterDrag, afterFrequencyDrag, resetFrequency });
  await h.select(`${media.displayName} 频谱类型`, '梅尔频谱'); await h.until(`!document.querySelector('.tile-status')`);
  const mel = await view(), melCount = await count(); await wheel(-120, [Key.CONTROL, Key.SHIFT]); assert.deepEqual(await view(), mel); assert.equal(await count(), melCount);
  await h.context('.frequency-ruler'); assert.equal(await (await h.element('[aria-label="完全对数"]')).getAttribute('aria-disabled'), 'true'); assert.equal(await (await h.element('[aria-label="完全对数"]')).getAttribute('title'), '梅尔频谱使用固定梅尔映射');
  await h.screenshot('mel-disabled-menu'); await h.driver.actions().sendKeys(Key.ESCAPE).perform(); await measure('Mel frame/tick alignment and immutable physical annotation');
  await h.select(`${media.displayName} 频谱类型`, 'STFT 频谱'); await h.until(`!document.querySelector('.tile-status')`);
  // Page/line modes and fractional trackpad deltas are synthetic supplements, not claimed as OS hardware input.
  for (const [deltaMode, deltaY] of [[0,.25],[1,1],[2,.01]]) {
    const before = await view();
    const outcome = await h.evaluate(`const e=document.querySelector('.spectrogram-surface'),r=e.getBoundingClientRect(),event=new WheelEvent('wheel',{bubbles:true,cancelable:true,ctrlKey:true,deltaMode:arguments[0],deltaY:arguments[1],clientX:r.left+r.width/2,clientY:r.top+r.height/2});e.dispatchEvent(event);return {prevented:event.defaultPrevented,height:r.height}`, deltaMode, deltaY);
    closeTo((await view()).frequencyMix, Math.max(0, before.frequencyMix - deltaY * (deltaMode === 1 ? 16 : deltaMode === 2 ? outcome.height : 1) * .0005)); assert.equal(outcome.prevented, true);
    report.checks.push({ name: 'synthetic normalized deltaMode supplement', deltaMode, deltaY, ...outcome });
  }
  await h.context('.frequency-ruler'); await h.label('完全线性');
  for (let i = 0; i < 7; i++) { await h.drag('.frequency-ruler', [.5,.45], [.5,.55]); await wait(250); }
  const narrow = await view(); assert.ok(narrow.lowHz > 0 && narrow.highHz - narrow.lowHz < .01);
  const labels = await h.evaluate(`return [...document.querySelectorAll('.frequency-ruler')].map(e=>{const b=e.getBoundingClientRect();return {width:b.width,labels:[...e.querySelectorAll('.axis-label')].map(l=>{const r=l.getBoundingClientRect();return {text:l.textContent,font:parseFloat(getComputedStyle(l).fontSize),left:r.left-b.left,right:r.right-b.left}})}})`);
  assert.ok(labels.every(r => r.labels.length > 1 && r.labels.every(l => l.font === 10 && l.left >= 0 && l.right <= r.width)));
  report.checks.push({ name: 'native narrow nonzero-Hz window uses readable 10px labels without clipping', narrow, labels }); await h.screenshot('narrow-nonzero-frequency');
  await h.context('.frequency-ruler'); await h.label('重置频率轴'); await view();
  await h.clickText('双文件对比'); await h.until(`document.querySelectorAll('.file-pane').length===2 && !document.querySelector('.tile-status')`); await h.menu('联动时间轴', '视图');
  await h.context('.time-ruler'); await h.label('重置时间轴');
  let linked = await snapshot(); const short = linked.media[1]; assert.ok(short.frameCount / short.sampleRate < media.frameCount / media.sampleRate); closeTo(linked.viewState.media[short.id].endSeconds, linked.viewState.media[media.id].endSeconds);
  // Saved-region zoom goes through the existing target resolver and shared workspace patch.
  await h.context(`[data-annotation-id="${annotation.id}"]`); await h.label('放大到选区'); linked = await snapshot();
  for (const field of ['startSeconds','endSeconds','lowHz','highHz']) closeTo(linked.viewState.media[media.id][field], annotation.region[field], 1e-8);
  for (const field of ['startSeconds','endSeconds']) closeTo(linked.viewState.media[short.id][field], annotation.region[field], 1e-8);
  assert.equal(linked.viewState.media[short.id].highHz, short.sampleRate / 2); assert.deepEqual(linked.annotations[0], annotation);
  report.checks.push({ name: 'region zoom shares physical view patch and linked seconds, short media tail stays empty', views: linked.viewState.media, shortDuration: short.frameCount / short.sampleRate });
  await h.screenshot('linked-region-zoom');
  report.input = await h.evaluate('return window.__rulerEvidence'); assert.ok(report.input.wheels.some(w => w.trusted && w.ctrl && w.prevented)); assert.ok(report.input.wheels.some(w => w.trusted && w.shift && !w.ctrl && w.prevented));
  report.passed = true;
} catch (error) { report.error = error.stack; report.input = await h?.evaluate('return window.__rulerEvidence').catch(() => null); process.exitCode = 1; await h?.screenshot('failure').catch(() => {}); }
finally { await h?.quit(); await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ passed: report.passed, error: report.error, checks: report.checks.map(c => c.name), output }, null, 2)); }
