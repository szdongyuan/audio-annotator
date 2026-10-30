// Explicit candidate; uses only a fresh owned project and two isolated identities.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { start, By, Key, wait } from './harness.mjs';
import { createIdentity } from './identity-helpers.mjs';
import { observeInspection, inspectionStatus } from './inspection-helpers.mjs';
import * as w from './workspace-helpers.mjs';

assert.ok(process.env.ANNOTATOR_WORKSPACE_EXE, 'Explicit test executable required');
const base = path.resolve(process.env.ANNOTATOR_SUITE_OUTPUT ?? '.test-output/inspection-usability');
await fs.mkdir(base, { recursive: true });
const output = await fs.mkdtemp(path.join(base, 'desktop-'));
const project = path.join(output, 'owned-project'); await fs.mkdir(project);
const sources = ['reference.wav', 'reference-b.wav'].map(name => path.join(output, name));
for (const source of sources) await fs.writeFile(source, w.wav({ seconds: 12, channels: 2 }));
const options = name => ({ ports: { driver: 4505, native: 4506, debug: 9305 }, localDataEnv: path.join(output, `data-${name}`), webviewDirectory: path.join(output, `webview-${name}`) });
const report = { output, checks: [], limitations: ['Native consumption and underruns measured; no acoustic loopback.'] };
let h;
const check = (name, value) => { assert.ok(value, name); report.checks.push(name); console.log('PASS ' + name); };
const tab = async name => { await h.driver.findElement(By.xpath(`//div[contains(@class,"inspector-tabs")]//button[normalize-space(.)="${name}"]`)).click(); };
async function retained(name) {
 await h.until("!document.querySelector('.inspection-viewer')&&!document.querySelector('.tile-status')");
 await h.driver.executeAsyncScript('const done=arguments[arguments.length-1];requestAnimationFrame(()=>requestAnimationFrame(done));');
 assert.equal(await h.evaluate("return document.querySelector('[role=tab][aria-selected=true]')?.textContent"), name);
}
async function classify(selector, menu) {
 await h.click(selector); await h.label(menu); await h.label('NG');
 await h.driver.actions().sendKeys(Key.ESCAPE, Key.ESCAPE).perform();
}
async function authorFixtures(prefix) {
 for (const name of ['reference.wav', 'reference-b.wav']) {
  report.stage = `create ${prefix} labels for ${name}`;
  await h.selectMedia(name);
  await h.click('.file-heading h2'); await h.input('音频备注', `${prefix} file ${name}`);
  await classify('.file-heading .classification-control', '文件类别');
  await h.click('.channel-pane[aria-label="通道 2"] .channel-caption strong');
  await h.input('通道 2 备注', `${prefix} channel ${name}`);
  await classify('.channel-pane[aria-label="通道 2"] .classification-control', '通道类别');
  await h.drag('.channel-pane:first-child .annotation-overlay', prefix === 'self' ? [.65,.15] : [.2,.3], prefix === 'self' ? [.85,.4] : [.6,.7]);
  await h.label('标注'); await h.label('NG'); await w.escape(h);
  await h.until("document.querySelector('[aria-label=\"区域备注\"]')", 'native annotation creation opens inspector');
  await h.input('区域备注', `${prefix} region ${name}`);
 }
 await w.saved(h);
}
async function openAuthor(id, note) {
 report.stage = `open Author ${note}`;
 await tab('作者');
 await h.driver.findElement(By.xpath(`//section[@data-remote-author='${id}']//button[contains(@class,'remote-list-entry') and span[.='${note}']]`)).click();
 await h.until("document.querySelector('.inspection-viewer')&&!document.querySelector('.inspection-viewer .tile-status')");
 assert.equal(await h.evaluate("return document.querySelector('[role=tab][aria-selected=true]').textContent"), '作者');
}
async function jumpAuthor(id, prefix, kind, name, pane = 'primary') {
 await openAuthor(id, `${prefix} ${kind} ${name}`); await h.label('跳转到音频');
 await h.until(`document.querySelector('.file-pane[data-pane="${pane}"] h2')?.textContent===${JSON.stringify(name)}&&!document.querySelector('.inspection-viewer')`);
 await retained('作者');
 check(`${prefix} ${kind} jump to ${name} retains Author in ${pane}`, true);
}
try {
 h = await start({ '新建项目 · 选择空文件夹': [project], '': [sources] }, output, undefined, options('author'));
 await createIdentity(h, '参考作者'); await w.newProject(h); await w.importDirect(h, 2); await w.addCategory(h, 'NG');
 await h.until("document.querySelector('.file-pane canvas')&&!document.querySelector('.tile-status')");
 await authorFixtures('foreign'); await h.selectMedia('reference.wav');
 await w.expectDocument(h, d => d.annotations.some(a => a.categoryIds.length), 'annotated source'); await w.saved(h);
 await h.menu('保存并同步', '协作'); await h.driver.wait(async () => !(await w.status(h)).pending, 30000);
 const actor = (await w.status(h)).actor.authorId;
 await w.cleanOwnedShutdown(h); h = null;

 h = await start({ '打开项目': [path.join(project, 'collaboration.json')] }, output, undefined, options('reviewer'));
 await createIdentity(h, '查看者'); await h.menu('打开项目'); await h.until("document.querySelector('.file-pane canvas')&&!document.querySelector('.tile-status')");
 await observeInspection(h); await tab('作者');
 const author = `[data-remote-author="${actor}"]`;
 await h.until(`document.querySelector('${author} .remote-list-entry')`);
 check('one compact author control', await h.evaluate("return document.querySelectorAll('.author-filter select').length===1&&!document.querySelector('.author-filter input[type=radio]')"));
 await h.click(`${author} .remote-author-toggle`); await tab('区域'); await tab('作者');
 check('collapse survives tab change', await h.evaluate(`return document.querySelector('${author} .remote-author-toggle').getAttribute('aria-expanded')==='false'`));
 await h.click(`${author} .remote-author-toggle`); await h.click(`${author} .remote-list-entry`);
 await h.until("document.querySelector('.inspection-region')&&!document.querySelector('.inspection-viewer .tile-status')");
 check('review has no private processed selector', !(await h.evaluate("return !!document.querySelector('[aria-label=查看试听来源]')")));
 await h.label('最大化查看窗口'); await h.label('重置视图');
 await h.until("!document.querySelector('.inspection-viewer .tile-status')");
 check('target stays visible after full reset', await h.evaluate("const r=document.querySelector('.inspection-region').getBoundingClientRect(),p=document.querySelector('.inspection-spectrum .spectrogram-surface').getBoundingClientRect();return r.width>1&&r.height>1&&r.left>=p.left-1&&r.right<=p.right+1"));
 await h.label('定位标注'); await h.until("!document.querySelector('.inspection-viewer .tile-status')");
 await h.click('.inspection-spectrum .spectrogram-surface');
 await h.driver.actions().keyDown(Key.CONTROL).sendKeys('0').keyUp(Key.CONTROL).perform();
 await h.until("!document.querySelector('.inspection-viewer .tile-status')");
 check('Ctrl+0 restores full time range', await h.evaluate("return document.querySelector('.inspection-region').getBoundingClientRect().width<document.querySelector('.inspection-spectrum .spectrogram-surface').getBoundingClientRect().width*.9"));
 await h.label('分析与显示设置'); await h.click('.inspection-spectrum .spectrogram-surface');
 check('settings dismiss on outside click', await h.evaluate("return !document.querySelector('.inspection-settings').open"));
 const surface = await h.element('.inspection-spectrum .spectrogram-surface'), rect = await surface.getRect();
 await h.driver.actions().move({ x: Math.round(rect.x + rect.width*.3), y: Math.round(rect.y+rect.height*.4), origin: 'viewport' }).contextClick().perform();
 await h.label('从此处播放');
 await h.driver.wait(async () => { const s = await inspectionStatus(h); return s.state==='playing'&&s.positionSeconds>3.6; }, 30000);
 const before = await inspectionStatus(h); await wait(1200); const after = await inspectionStatus(h);
 check('right-click cue plus native playback advances without underrun', after.consumedFrames>before.consumedFrames&&after.underrunFrames===0);
 check('cue is a white dashed line', await h.evaluate("return getComputedStyle(document.querySelector('.inspection-cue')).borderLeftStyle==='dashed'"));
 report.playback = { before, after };
 await h.click('.inspection-transport [aria-label=停止]'); await h.label('还原查看窗口');
 const geometry = await h.evaluate("const d=document.querySelector('.inspection-dialog'),s=document.querySelector('.inspection-spectrum');return {dialog:d.getBoundingClientRect().toJSON(),plot:s.getBoundingClientRect().toJSON(),resize:getComputedStyle(d).resize}");
 check('resizable review devotes most height to spectrum', geometry.resize==='both'&&geometry.plot.height>geometry.dialog.height*.65);
 report.geometry=geometry;
 const d=geometry.dialog;
 await h.driver.actions().move({x:Math.round(d.right-3),y:Math.round(d.bottom-3),origin:'viewport'}).press().move({x:Math.round(d.right-140),y:Math.round(d.bottom-100),origin:'viewport',duration:400}).release().perform();
 await wait(300);
 const resized=await h.evaluate("return document.querySelector('.inspection-dialog').getBoundingClientRect().toJSON()");
 check('native pointer resize changes review dimensions',resized.width<d.width-50&&resized.height<d.height-30);report.resized=resized;
 await h.label('最大化查看窗口');check('maximize still works after manual resize',await h.evaluate("return document.querySelector('.inspection-dialog').getBoundingClientRect().width>innerWidth*.95"));
 await h.label('还原查看窗口');check('restore preserves manually resized dimensions',await h.evaluate("return Math.abs(document.querySelector('.inspection-dialog').getBoundingClientRect().width-arguments[0])<2",resized.width));
 await h.screenshot('compact-review'); await h.label('关闭查看');
 await h.drag('.channel-pane:first-child .annotation-overlay',[.25,.3],[.5,.7]);await h.menu('放大到选区','视图');
 await w.expectDocument(h,d=>d.viewState.media[d.viewState.activeMediaId]?.endSeconds-d.viewState.media[d.viewState.activeMediaId]?.startSeconds<4,'main view zoomed');
 await h.driver.actions().keyDown(Key.CONTROL).sendKeys('0').keyUp(Key.CONTROL).perform();
 await w.expectDocument(h,d=>d.viewState.media[d.viewState.activeMediaId]?.startSeconds===0&&d.viewState.media[d.viewState.activeMediaId]?.endSeconds===12,'main Ctrl+0 reset');
 check('Ctrl+0 also resets the main workspace',true);
 await tab('类别');
 const eyes = await h.driver.findElements(By.css('.shared-category-row .visibility-toggle'));
 check('category eye is in the existing shared category row', eyes.length===1&&!(await h.evaluate("return !!document.querySelector('.category-visibility-rows')")));
 await eyes[0].click(); check('category can be hidden in place', await eyes[0].getAttribute('aria-pressed')==='false');
 await eyes[0].click();
 await w.addCategory(h, 'NG'); await authorFixtures('self');
 const self = (await w.status(h)).actor.authorId;
 const content = doc => ({ annotations: doc.annotations, categories: doc.categories, edits: doc.edits, media: doc.media });
 await h.selectMedia('reference.wav'); await w.saved(h); const beforeAuthor = content(await w.snapshot(h));
 await openAuthor(actor, 'foreign region reference-b.wav'); await h.label('关闭查看'); await retained('作者');
 check('ordinary Author close retains tab and primary media', await h.evaluate("return document.querySelector('.file-pane h2').textContent==='reference.wav'"));
 for (const [id, prefix] of [[actor, 'foreign'], [self, 'self']]) {
  for (const kind of ['file', 'channel', 'region']) {
   for (const name of ['reference-b.wav', 'reference.wav']) await jumpAuthor(id, prefix, kind, name);
  }
  await jumpAuthor(id, prefix, 'region', 'reference.wav');
 }
 const syncLabel = await h.evaluate("return document.querySelector('[aria-label=\"协作同步状态\"]')?.textContent");
 report.syncObservation = { label: syncLabel, errors: [] };
 if (syncLabel === '同步异常') {
  await h.click('.collaboration-status'); await h.until("document.querySelector('.collaboration-dialog')");
  report.syncObservation.errors = await h.evaluate("return [...document.querySelectorAll('.collaboration-dialog [role=alert]')].map(e=>e.textContent)");
  await h.clickText('关闭');
 }
 await w.saved(h); await retained('作者'); await h.screenshot('author-cross-file-retained');
 await h.clickText('双文件对比'); await h.select('对比面板音频', 'reference-b.wav');
 for (const [id, prefix] of [[actor, 'foreign'], [self, 'self']]) await jumpAuthor(id, prefix, 'region', 'reference-b.wav', 'compare');
 check('Author compare jump preserves primary', await h.evaluate("return document.querySelector('.file-pane[data-pane=primary] h2').textContent==='reference.wav'"));
 await h.screenshot('author-compare-retained'); await h.clickText('单文件');
 await w.saved(h); assert.deepEqual(content(await w.snapshot(h)), beforeAuthor, 'Author navigation leaves content unchanged');
 await h.click('.file-heading h2'); await retained('文件/通道');
 check('file title after Author navigation restores normal tab', true);
 for (const [name, kind] of [['reference.wav', 'mask'], ['reference-b.wav', 'gain']]) {
  await h.selectMedia(name); await h.menu('重置当前视图', '视图');
  if (!(await h.evaluate("return !!document.querySelector('.channel-pane[aria-label=\"通道 2\"]')"))) await h.label('显示通道 2');
  await h.drag('.channel-pane[aria-label="通道 2"] .annotation-overlay', [.25,.3], [.5,.7]);
  if (kind === 'mask') {
   await h.menu('屏蔽选区', '音频'); await w.waitMasked(h);
   // A saved annotation inside the located range exercises normal spectrum selection later.
   await h.drag('.channel-pane[aria-label="通道 2"] .annotation-overlay', [.3,.4], [.4,.5]);
   await h.label('标注'); await h.label('NG'); await w.escape(h);
   await h.until("document.querySelector('[aria-label=\"区域备注\"]')");
   await h.input('区域备注', 'processing selection control');
  }
  else {
   await h.context('.channel-pane[aria-label="通道 2"] .annotation-overlay', [.4,.5]); await h.label('区域增益…');
   await h.input('区域增益（dB）', '-6'); await h.clickText('应用增益');
   await w.expectDocument(h, doc => doc.edits.some(e => e.operation.type === 'gain'), 'native gain accepted');
  }
 }
 await w.saved(h); const beforeProcessing = content(await w.snapshot(h));
 for (const [label, name] of [['定位屏蔽 1','reference.wav'], ['定位增益 -6.0 dB 2','reference-b.wav'], ['定位屏蔽 1','reference.wav']]) {
  await tab('处理'); await h.label(label);
  await h.until(`document.querySelector('.file-pane h2')?.textContent===${JSON.stringify(name)}`); await retained('处理');
  check(`${label} cross-file retains Processing without editable frame`, await h.evaluate("return !document.querySelector('[data-edit-id]')&&!document.querySelector('[aria-label=\"选区操作\"]')"));
  const doc = await w.snapshot(h), edit = doc.edits.find(e => doc.media.find(m => m.id === e.region.mediaId)?.displayName === name);
  await w.expectDocument(h, d => { const v = d.viewState.media[edit.region.mediaId]; return v?.visibleChannels.includes(edit.region.channelIndex) && v.startSeconds <= edit.region.startSeconds && v.endSeconds >= edit.region.endSeconds && v.lowHz <= edit.region.lowHz && v.highHz >= edit.region.highHz; }, 'processing target range and channel visible');
 }
 await h.screenshot('processing-cross-file-retained');
 await w.saved(h); assert.deepEqual(content(await w.snapshot(h)), beforeProcessing, 'processing navigation leaves content unchanged');
 check('navigation does not start playback', (await w.playback(h)).state === 'stopped');
 await h.click('.file-heading h2'); await retained('文件/通道');
 await tab('处理'); await h.label('定位屏蔽 1'); await retained('处理');
 const selectionControl = beforeProcessing.annotations.find(a => a.note === 'processing selection control');
 assert.ok(selectionControl);
 await h.click(`[data-annotation-id="${selectionControl.id}"]`); await retained('区域');
 check('title and spectrum after Processing restore normal tabs', true);
 await h.screenshot('normal-tabs-after-navigation');
 report.passed=true;
} catch (error) { report.error=error.stack; report.body=await h?.evaluate('return document.body.innerText').catch(()=>null); await h?.screenshot('failure').catch(()=>{}); process.exitCode=1; }
finally { await h?.quit().catch(()=>{}); await fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2)); console.log(JSON.stringify({output,passed:report.passed,error:report.error})); }
