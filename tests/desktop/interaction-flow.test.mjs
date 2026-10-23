import { toolbarUI } from './task6-ui.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { cueUI } from './task5-ui.mjs';
import { start, Key, wait } from './harness.mjs';

const output = path.resolve(process.env.ANNOTATOR_INTERACTION_OUTPUT ?? '.test-output/fidelity-task6/interaction');
await fs.mkdir(output, { recursive: true });
const project = await fs.mkdtemp(path.join(output, 'project-'));
const names = ['stereo24.wav', 'stereo.mp3', 'float32.wav'];
const longAudio=path.join(output,'cue-long.wav'), rate=48000, samples=rate*4, wave=Buffer.alloc(44+samples*4);
wave.write('RIFF');wave.writeUInt32LE(wave.length-8,4);wave.write('WAVEfmt ',8);wave.writeUInt32LE(16,16);wave.writeUInt16LE(1,20);wave.writeUInt16LE(2,22);wave.writeUInt32LE(rate,24);wave.writeUInt32LE(rate*4,28);wave.writeUInt16LE(4,32);wave.writeUInt16LE(16,34);wave.write('data',36);wave.writeUInt32LE(samples*4,40);
for(let i=0;i<samples;i++)for(let c=0;c<2;c++)wave.writeInt16LE(Math.round(5000*Math.sin(2*Math.PI*500*i/rate)),44+i*4+c*2);await fs.writeFile(longAudio,wave);
const paths = { '新建项目 · 选择空文件夹': [project], '打开项目 · 选择 project.json': [path.join(project, 'project.json')], '': [[...names.map(n => path.resolve('tests/fixtures/audio', n)),longAudio,path.resolve('tests/fixtures/audio/six32.wav')]] };
const report = { method: 'Fresh debug/e2e executable, owned WebView2, trusted WebDriver pointer/keyboard; real 1280x800 outer window, unchanged Windows DPI/audio settings.', project, checks: [] };
let h, id;
const check = (name, details = {}) => { report.checks.push({ name, passed: true, ...details }); console.log('PASS ' + name); };
const pane = side => `.file-pane[data-pane="${side}"]`;
async function pair(a, b) {
  await h.until(`document.querySelector('select[aria-label="主面板音频"]')?.selectedOptions[0]?.textContent === ${JSON.stringify(a)} && document.querySelector('select[aria-label="对比面板音频"]')?.selectedOptions[0]?.textContent === ${JSON.stringify(b)}`);
}
async function state() {
  return h.evaluate(`return {pair:[...document.querySelectorAll('.pane-file-select')].map(e=>e.value),source:document.querySelector('.is-playback-source')?.getAttribute('aria-label'),selection:document.querySelector('.is-temporary')?.outerHTML??null};`);
}
async function duplicate(action, side, screenshot) {
  await wait(250); const before = await state(), saved = await h.snapshot(id);
  await action();
  await h.until(`document.querySelector('${pane(side)}')?.classList.contains('is-duplicate-target')`);
  assert.equal(await h.evaluate(`return document.querySelector('${pane(side)} [role=status]')?.textContent`), '该音频已在这一侧显示');
  assert.deepEqual(await state(), before);
  assert.equal((await h.snapshot(id)).document.revision, saved.document.revision);
  await h.screenshot(screenshot);
  await wait(1250); assert.equal(await h.evaluate(`return !!document.querySelector('.is-duplicate-target')`), false);
  check(screenshot);
}
const escape = async () => h.driver.actions().keyDown(Key.ESCAPE).keyUp(Key.ESCAPE).perform();
try {
  h = await start(paths, output, undefined, { exactOuter: true }); report.nativePid = h.nativePid;
  await h.menu('新建项目'); await h.until(`document.querySelector('.project-identity')?.textContent.includes('已保存')`);
  id = JSON.parse(await fs.readFile(path.join(project, 'project.json'), 'utf8')).projectId;
  await h.clickText('导入音频'); await h.until(`document.querySelector('.import-progress')?.textContent.includes('导入完成')`); await h.clickText('关闭导入结果');
  await h.clickText('双文件对比'); await pair(names[0], names[1]);
  await h.until(`document.querySelectorAll('canvas').length===4&&!document.querySelector('.tile-status')`);
  h.nativeRect({ width: 1280, height: 800 }); await wait(250);
  const frame = await h.evaluate(`return {dpr:devicePixelRatio,inner:[innerWidth,innerHeight],plots:[...document.querySelectorAll('.spectrogram-surface')].map(e=>e.getBoundingClientRect().toJSON()),headers:[...document.querySelectorAll('.file-pane')].map(e=>e.querySelector('.file-heading').getBoundingClientRect().height+e.querySelector('.file-controls').getBoundingClientRect().height),backing:[...document.querySelectorAll('canvas')].map(e=>({width:e.width,height:e.height,css:e.getBoundingClientRect().toJSON()}))};`);
  assert.equal(frame.plots.length, 4); assert.ok(frame.plots.every(r => r.height >= 180 && r.bottom <= frame.inner[1])); assert.ok(frame.headers.every(v => v <= 56));
  report.layout = { outer: h.nativeRect(), ...frame }; await h.screenshot('four-plots-1280'); check('four plots >=180px and headers <=56px at real 1280x800');

  await h.drag(`${pane('compare')} .annotation-overlay`, [.2, .25], [.5, .65]);
  const selection = (await state()).selection; assert.ok(selection);
  await duplicate(() => h.click('.media-card:nth-child(2) .media-select'), 'compare', 'sidebar-duplicate-compare-highlight');
  await duplicate(() => h.select('对比面板音频', names[0]), 'primary', 'header-duplicate-primary-highlight');
  await duplicate(async () => { await h.menu('双文件对比', '视图'); await h.label(names[0]); }, 'primary', 'menu-duplicate-primary-highlight');
  await duplicate(() => h.select('主面板音频', names[1]), 'compare', 'header-duplicate-compare-highlight');
  await h.click('.media-card:nth-child(3) .media-select'); await pair(names[2], names[1]);
  assert.equal((await state()).selection, selection); check('sidebar A/B to C/B retains comparison selection');
  await h.select('主面板音频', names[0]); await pair(names[0], names[1]);
  await h.select('对比面板音频', names[2]); await pair(names[0], names[2]);
  assert.equal((await state()).selection, null); check('comparison title A/B to A/C clears only replaced selection');
  await h.menu('双文件对比', '视图'); await h.label(names[1]); await pair(names[0], names[1]);
  check('top comparison menu changes only comparison identity');

  await h.label(`${names[0]} 分析设置`);
  await h.input('步长', '777');
  const beforeDisplaySave = await h.snapshot(id), settingsMediaId = beforeDisplaySave.document.viewState.activeMediaId;
  // Real range input gesture begins inside and releases beyond the popover.
  await h.drag('.analysis-popover [aria-label="显示增益"]', [.5, .5], [2, .5]);
  assert.equal(await h.evaluate(`return !!document.querySelector('.analysis-popover')`), true);
  const gain = await h.evaluate(`return +document.querySelector('[aria-label="显示增益"]').value`);
  await h.driver.wait(async () => {
    const accepted = await h.snapshot(id);
    return accepted.document.revision > beforeDisplaySave.document.revision && accepted.document.viewState.media[settingsMediaId]?.gainDb === gain;
  }, 30000, 'native view save must settle before checking pending compute draft');
  assert.equal(await h.evaluate(`return document.querySelector('[aria-label="步长"]').value`), '777');
  check('unapplied compute draft survives an accepted native display save');
  const windowSelect = await h.element('.analysis-popover fieldset select');
  await windowSelect.click(); await windowSelect.sendKeys(Key.ARROW_DOWN, Key.ENTER);
  assert.equal(await h.evaluate(`return !!document.querySelector('.analysis-popover')`), true); check('internal slider release outside and native select stay open');
  await escape(); await h.until(`!document.querySelector('.analysis-popover')`);
  assert.equal(await h.evaluate(`return document.activeElement.getAttribute('aria-label')`), `${names[0]} 分析设置`);
  await h.label(`${names[0]} 分析设置`);
  assert.equal(await h.evaluate(`return document.querySelector('[aria-label="步长"]').value`), '512');
  assert.equal(await h.evaluate(`return +document.querySelector('[aria-label="显示增益"]').value`), gain); check('Escape restores trigger, discards compute draft, retains immediate display');
  await h.label(`${names[1]} 分析设置`);
  assert.equal(await h.evaluate(`return document.querySelector('.analysis-popover').getAttribute('aria-label')`), `${names[1]} 分析设置`);
  await h.label(`${names[1]} 分析设置`); await h.until(`!document.querySelector('.analysis-popover')`); check('different file settings switches directly; same trigger toggles closed');
  await h.label(`${names[0]} 分析设置`);
  const beforeOutside = await state();
  await h.drag(`${pane('compare')} .annotation-overlay`, [.12, .2], [.55, .65]);
  await h.until(`!document.querySelector('.analysis-popover')`);
  assert.deepEqual(await state(), beforeOutside); check('outside closing pointer drag cannot draw or change playback source');
  await h.label(`${names[0]} 分析设置`); await h.label('播放 · 空格');
  assert.equal(await h.evaluate(`return !!document.querySelector('.analysis-popover')`), false);
  assert.equal(await h.evaluate(`return document.querySelector('.playback-position span').textContent`), '已停止'); check('outside closing play-button click is consumed');
  await h.label(`${names[1]} 分析设置`); await escape();
  await h.select('对比面板音频', names[2]); await pair(names[0], names[2]);
  await h.select('对比面板音频', names[1]); await pair(names[0], names[1]);
  assert.equal(await h.evaluate(`return !!document.querySelector('.analysis-popover')`), false);

  await h.menu('联动时间轴', '视图'); await h.select('主面板音频', names[2]); await pair(names[2], names[1]);
  await h.clickText('保存'); await h.until(`document.querySelector('.project-identity')?.textContent.includes('已保存')`);
  const saved = await h.snapshot(id); assert.equal(saved.document.viewState.linkedTime, true);
  assert.equal(saved.document.viewState.media[saved.document.viewState.activeMediaId].endSeconds, saved.document.viewState.media[saved.document.viewState.compareMediaId].endSeconds);
  await h.menu('关闭项目'); await h.until(`!document.querySelector('.file-pane')`); await h.menu('打开项目…');
  await pair(names[2], names[1]); assert.equal((await h.snapshot(id)).document.viewState.linkedTime, true); check('linked time preserves identities through save/reopen');
  await h.menu('分析 / 显示设置…', '视图'); await escape();
  assert.equal(await h.evaluate(`return document.activeElement.textContent`), '视图'); check('Escape from menu-opened analysis returns focus to View trigger');
  await h.menu('上下对比', '视图');
  await h.label(`${names[2]} 分析设置`); await h.label(`${names[1]} 分析设置`);
  assert.equal(await h.evaluate(`return document.querySelector('.analysis-popover').getAttribute('aria-label')`), `${names[1]} 分析设置`);
  await h.screenshot('vertical-settings-switch'); await escape(); await h.menu('左右对比', '视图'); check('vertical layout also keeps both settings triggers reachable');
  await h.menu('使用说明', '帮助');
  await h.driver.actions().move({ origin: 'viewport', x: 8, y: 180 }).press().release().perform();
  await h.until(`!document.querySelector('dialog.help-dialog')`); check('help backdrop pointer dismisses without clickthrough');
  await h.screenshot('final-independent-panes');
  await cueUI(h,id,report); await toolbarUI(h,id,report);
} catch (error) {
  report.error = error.stack; console.error(error); await h?.screenshot('failure').catch(() => {}); process.exitCode = 1;
} finally {
  await h?.quit().catch(() => {}); await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
}
