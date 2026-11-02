import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { start, Key, wait } from './harness.mjs';
import * as w from './workspace-helpers.mjs';

const base = path.resolve(process.env.ANNOTATOR_SUITE_OUTPUT ?? '.test-output/keyboard-seek');
await fs.mkdir(base, { recursive: true });
const output = await fs.mkdtemp(path.join(base, 'actual-'));
const project = path.join(output, 'project');
await fs.mkdir(project);
const name = 'keyboard-seek-30s-mono.wav';
const audio = path.join(output, name);
await fs.writeFile(audio, w.wav({ seconds: 30, channels: 1 }));
const executable = process.env.ANNOTATOR_WORKSPACE_EXE ?? path.resolve('target/debug/annotator-desktop.exe');
const report = {
  output, executable, passed: false,
  method: 'Owned Tauri/WebView2 process, isolated project/local data/profile; real WebDriver pointer and keyboard only. Read-only native snapshot/status. Fetch instrumentation records and forwards actual configure requests and responses without modifying them. No store mutation or synthetic events. No subjective listening claim.',
  checks: [],
};
let h, mediaId;
const plot = '.file-pane[data-pane="primary"] .annotation-overlay';
const ruler = '.file-pane[data-pane="primary"] .time-ruler';
const row = `.media-select[aria-label=${JSON.stringify(name)}]`;
const key = value => h.driver.actions().sendKeys(value).perform();
const close = (actual, expected, epsilon = 1 / 48000) => assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected} within ${epsilon}`);
const check = (name, details = {}) => { report.checks.push({ name, passed: true, ...details }); console.log(`PASS ${name}`); };
const wire = () => h.evaluate('return window.__keyboardSeekWire');
const view = async () => (await w.snapshot(h)).viewState.media[mediaId];
async function state(expected) {
  return h.driver.wait(async () => { const s = await w.playback(h); return s.state === expected ? s : false; }, 10000, `native state ${expected}`, 50);
}
async function point(selector, x = .4, y = .5) {
  const r = await (await h.element(selector)).getRect();
  await h.driver.actions().move({ origin: 'viewport', x: Math.round(r.x + r.width * x), y: Math.round(r.y + r.height * y) }).click().perform();
}
async function reset() {
  await h.context(ruler); await h.label('重置时间轴');
  await w.expectDocument(h, d => d.viewState.media[mediaId]?.startSeconds === 0 && d.viewState.media[mediaId]?.endSeconds === 30, 'full time range via ruler menu');
}
async function zoom() {
  await reset(); await h.drag(ruler, [.25, .5], [.65, .5]);
  await w.expectDocument(h, d => { const v = d.viewState.media[mediaId]; return v.startSeconds > 0 && v.endSeconds < 30; }, 'internal time range via real ruler drag');
  return view();
}
async function arrow(direction, expectedPosition, play, pan = false) {
  const before = await w.playback(h), beforeView = await view(), count = (await wire()).length;
  await key(direction === 1 ? Key.ARROW_RIGHT : Key.ARROW_LEFT);
  await h.until(`window.__keyboardSeekWire.length>${count} && window.__keyboardSeekWire[${count}].result`, 'real configure completion after arrow', 10000);
  const observed = (await wire())[count];
  close(observed.request.seekSeconds, expectedPosition, play ? .35 : 1 / 48000);
  assert.equal(observed.request.play, play);
  assert.equal(observed.request.mediaId, mediaId);
  assert.ok(observed.result.generation > before.generation, 'real native generation advances');
  assert.equal(observed.result.mediaId, mediaId);
  const shift = pan ? direction * (beforeView.endSeconds - beforeView.startSeconds) * .1 : 0;
  await w.expectDocument(h, d => Math.abs(d.viewState.media[mediaId].startSeconds - beforeView.startSeconds - shift) < 1e-8, 'existing viewport pan is exactly 10% or full-range boundary');
  // Observe beyond completion/render settling so a viewport effect cannot hide a duplicate configure.
  await wait(300);
  assert.equal((await wire()).length, count + 1, 'one accepted key sends exactly one configure');
  const after = await w.playback(h), afterView = await view();
  close(afterView.endSeconds - beforeView.endSeconds, shift, 1e-8);
  if (!play) { assert.notEqual(after.state, 'playing'); close(after.positionSeconds, expectedPosition); }
  return { before, beforeView, request: observed.request, response: observed.result, after, afterView, configureCount: 1 };
}
async function pauseFromPlot() {
  // Establish cue and focus BEFORE play/pause; clicking blank after pause would reset the baseline.
  await point(plot);
  await key(Key.SPACE); await state('playing');
  await key(Key.SPACE); return state('paused');
}
async function resize(width, height) {
  const outer = h.nativeRect({ width, height });
  await wait(300);
  const inner = await h.evaluate('return {width:innerWidth,height:innerHeight,sliderVisible:!!document.querySelector("[aria-label=播放位置]")?.getClientRects().length,barWidth:document.querySelector(".playback-bar").getBoundingClientRect().width}');
  return { outer, ...inner };
}

try {
  h = await start({ '新建项目 · 选择空文件夹': [project], '': [[audio]] }, output, executable, {
    localDataEnv: path.join(output, 'local-data'), webviewDirectory: path.join(output, 'webview'),
  });
  report.nativePid = h.nativePid;
  report.stage = 'isolated UI import and transparent native configure instrumentation';
  await w.newProject(h); await w.importDirect(h, 1); await h.selectMedia(name);
  mediaId = (await w.snapshot(h)).media[0].id;
  await h.label('监听增益');
  await (await h.element('[aria-label="输出音量"]')).sendKeys(Key.HOME);
  await w.escape(h);
  await h.evaluate(`window.__keyboardSeekWire=[];const original=window.fetch;
    window.fetch=function(resource,options){
      if(!String(resource).endsWith('/playback_configure'))return original.apply(this,arguments);
      const entry={request:JSON.parse(options.body).request,at:performance.now()};window.__keyboardSeekWire.push(entry);
      const pending=original.apply(this,arguments);
      pending.then(response=>response.clone().json().then(result=>{entry.result=result;},error=>{entry.error=String(error);}));
      return pending;
    };`);

  report.stage = 'wide full range stopped';
  const wide = await resize(1440, 900); await reset(); await h.click(row);
  await state('stopped');
  const stoppedRight = await arrow(1, 2, false), stoppedLeft = await arrow(-1, 0, false);
  assert.ok((await wire()).length >= 2, 'probe observes initial real native configure requests');
  await h.screenshot('wide-full-stopped');
  check('wide full-range stopped arrows seek ±2s exactly once without autoplay', { dimensions: wide, stoppedRight, stoppedLeft });

  report.stage = 'wide internal range paused simultaneous response';
  await zoom();
  const paused = await pauseFromPlot();
  assert.ok((await wire()).some(entry => entry.request.play === true && entry.result?.generation === paused.generation && entry.result.mediaId === mediaId), 'probe observes the initial real play request and native acknowledgement for the stream actually played/paused');
  const pausedRight = await arrow(1, paused.positionSeconds + 2, false, true);
  const pausedLeft = await arrow(-1, pausedRight.after.positionSeconds - 2, false, true);
  await h.screenshot('wide-internal-paused');
  check('wide paused focused plot seeks ±2s and pans ±10% on each single key', { paused, pausedRight, pausedLeft });

  report.stage = 'narrow internal and full range';
  const narrow = await resize(1000, 680);
  assert.ok(narrow.width < wide.width);
  assert.equal(narrow.sliderVisible, false, 'narrow layout hides playback-position slider');
  const narrowPaused = await w.playback(h);
  const narrowRight = await arrow(1, narrowPaused.positionSeconds + 2, false, true);
  const narrowLeft = await arrow(-1, narrowRight.after.positionSeconds - 2, false, true);
  await reset();
  const fullBefore = await pauseFromPlot();
  const fullRight = await arrow(1, fullBefore.positionSeconds + 2, false);
  const fullLeft = await arrow(-1, fullRight.after.positionSeconds - 2, false);
  await h.screenshot('narrow-full-paused');
  check('narrow hidden-slider layout retains internal pan and full-range seek', { dimensions: narrow, narrowRight, narrowLeft, fullRight, fullLeft });

  report.stage = 'narrow playing latest native position';
  await zoom(); await point(plot); await key(Key.SPACE);
  await state('playing');
  const nativeBefore = await w.playback(h);
  const playingRight = await arrow(1, nativeBefore.positionSeconds + 2, true, true);
  await h.driver.wait(async () => (await w.playback(h)).consumedFrames > playingRight.after.consumedFrames, 5000, 'native output continues consuming after seek', 50);
  const continued = await w.playback(h);
  assert.equal(continued.state, 'playing');
  await h.screenshot('narrow-internal-playing');
  check('narrow playing arrow uses recent native progress +2s and keeps real output running', { nativeBefore, playingRight, continued, requestToleranceSeconds: .35 });
  await key(Key.SPACE); await state('paused');

  report.stage = 'input and menu own arrow keys';
  await h.input('搜索音频', 'keyboard');
  await h.click('[aria-label="搜索音频"]'); await key(Key.END);
  const protectedBefore = await w.playback(h), protectedCount = (await wire()).length;
  await key(Key.ARROW_LEFT);
  assert.equal(await h.evaluate('return document.querySelector("[aria-label=搜索音频]").selectionStart'), 7);
  await key(Key.ARROW_RIGHT);
  assert.equal(await h.evaluate('return document.querySelector("[aria-label=搜索音频]").selectionStart'), 8);
  assert.equal(await h.evaluate('return document.querySelector("[aria-label=搜索音频]").value'), 'keyboard');
  await h.click('nav[role="menubar"] > button');
  await h.until('document.querySelector("[role=menu]")');
  const menuBefore = await h.evaluate('return document.activeElement?.textContent');
  await key(Key.ARROW_RIGHT);
  await h.until('document.querySelector("[role=menu]")');
  const menuAfter = await h.evaluate('return document.activeElement?.textContent');
  assert.notEqual(menuAfter, menuBefore, 'right arrow navigates top-level menu');
  await key(Key.ARROW_LEFT); await w.escape(h); await wait(300);
  assert.equal((await wire()).length, protectedCount);
  assert.equal((await w.playback(h)).generation, protectedBefore.generation);
  await h.screenshot('input-menu-protection');
  check('search arrows edit cursor and menu arrows navigate without configuring playback', { protectedBefore, menuBefore, menuAfter });

  report.stage = 'loop boundary request clamp and natural native continuation';
  await h.input('搜索音频', ''); await reset();
  const beforeLoopCount = (await wire()).length;
  await h.label('循环播放');
  await h.until(`window.__keyboardSeekWire.length>${beforeLoopCount} && window.__keyboardSeekWire.at(-1).request.looping && window.__keyboardSeekWire.at(-1).result`, 'UI loop option acknowledged by native configure');
  await h.click(row);
  // Paused repetition reaches the boundary without starting playback.
  let repeat = await w.playback(h);
  for (let i = 0; i < 16 && repeat.positionSeconds < 30; i++) repeat = (await arrow(1, Math.min(30, repeat.positionSeconds + 2), false)).after;
  close(repeat.positionSeconds, 30);
  const nearEnd = await arrow(-1, 28, false);
  await key(Key.SPACE); await state('playing');
  const boundary = await arrow(1, 30, true);
  assert.equal(boundary.request.looping, true); close(boundary.request.seekSeconds, 30);
  assert.equal(boundary.after.state, 'playing');
  assert.ok(boundary.after.positionSeconds < 2, 'native loop resumes near the range start after bounded end request');
  await h.driver.wait(async () => (await w.playback(h)).consumedFrames > boundary.after.consumedFrames, 5000, 'native loop continues consuming frames', 50);
  await key(Key.SPACE); const loopPaused = await state('paused');
  const repeatPaused1 = await arrow(1, Math.min(30, loopPaused.positionSeconds + 2), false);
  const repeatPaused2 = await arrow(1, Math.min(30, repeatPaused1.after.positionSeconds + 2), false);
  await h.screenshot('loop-end-paused');
  check('repeat arrows clamp at 30s; playing loops naturally; paused repeat never autoplays', { repeat, nearEnd, boundary, loopPaused, repeatPaused1, repeatPaused2 });
  await h.label('停止'); await w.saved(h);
  report.passed = true;
} catch (error) {
  report.error = error.stack; process.exitCode = 1; console.error(error);
  if (h) {
    try { report.wire = await wire(); report.playback = await w.playback(h); report.ui = await h.evaluate('return document.body.innerText'); await h.screenshot('failure'); }
    catch (diagnosticError) { report.diagnosticError = diagnosticError.stack; }
  }
} finally {
  if (h) {
    try { await h.quit(); }
    catch (cleanupError) { report.cleanupError = cleanupError.stack; report.passed = false; process.exitCode = 1; }
  }
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output, passed: report.passed, stage: report.stage, error: report.error, checks: report.checks.map(c => c.name) }, null, 2));
}
