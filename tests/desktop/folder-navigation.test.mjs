import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { start, Key } from './harness.mjs';
import { newProject, importDirect, folder, snapshot, organization, status, wav, hash } from './workspace-helpers.mjs';
import { read } from './identity-helpers.mjs';

const exe = process.env.ANNOTATOR_WORKSPACE_EXE;
assert.ok(exe, 'Set ANNOTATOR_WORKSPACE_EXE to the current E2E executable');
const root = path.resolve(process.env.ANNOTATOR_SUITE_OUTPUT ?? '.test-output/folder-navigation');
await fs.mkdir(root, { recursive: true });
const output = await fs.mkdtemp(path.join(root, 'desktop-'));
const project = path.join(output, 'project');
await fs.mkdir(project);
const sources = [];
for (const [i, name] of ['first.wav', 'second.wav', 'depth-one.wav', 'depth-three-with-a-long-name.wav'].entries()) {
  const source = path.join(output, name);
  await fs.writeFile(source, wav({ seconds: 2, channels: 1, rate: [8000, 11025, 16000, 22050][i] }));
  sources.push(source);
}
let h;
const report = { output, checks: [], method: 'Isolated local project; real Selenium folder, audio, menu clicks and arrow keys; read-only native assertions.' };
const check = name => { report.checks.push(name); console.log('PASS', name); };
const key = value => h.driver.actions().sendKeys(value).perform();
const clickFolder = title => h.click(`.media-folder-select[title=${JSON.stringify(title)}]`);
const row = name => `.media-select[aria-label=${JSON.stringify(name)}]`;
const selected = async name => {
  await h.until(`document.querySelector('.file-pane h2')?.textContent===${JSON.stringify(name)}&&!document.querySelector('.tile-status')`, 'main pane selects target');
  await h.until(`document.activeElement?.matches(${JSON.stringify(row(name))})&&document.activeElement?.getAttribute('aria-pressed')==='true'`, 'target row receives keyboard focus');
  const bounds = await h.evaluate("const r=document.activeElement.getBoundingClientRect(),p=document.activeElement.closest('.media-items').getBoundingClientRect();return {top:r.top,bottom:r.bottom,parentTop:p.top,parentBottom:p.bottom};");
  assert.ok(bounds.top >= bounds.parentTop - 1 && bounds.bottom <= bounds.parentBottom + 1, 'selected audio is within the list viewport');
};

try {
  h = await start({ '新建项目 · 选择空文件夹': [project], '': sources.map(source => [source]) }, output, exe);
  await newProject(h);
  await folder(h, 'A');
  await clickFolder('A');
  await folder(h, 'A leaf', 'A');
  await clickFolder('A/A leaf');
  await importDirect(h, 1);
  await folder(h, 'B');
  await clickFolder('B');
  await folder(h, 'B leaf', 'B');
  await clickFolder('B/B leaf');
  await importDirect(h, 2);
  const before = await snapshot(h), layout = await organization(h);
  const audioHashes = new Map(await Promise.all(before.media.map(async media => [media.id, hash(await fs.readFile(path.join(project, media.sourceRef)))])));

  await clickFolder('A/A leaf');
  await h.click(row('first.wav'));
  await selected('first.wav');
  await h.label('折叠文件夹 · B');
  assert.equal(await h.evaluate("return document.querySelectorAll('.media-select').length"), 1, 'selected leaf contains exactly one displayed file');
  await h.label('展开文件夹 · B');
  await h.until(`document.querySelector(${JSON.stringify(row('second.wav'))})`, 'disclosing sibling reveals audio immediately');
  assert.equal(await h.evaluate("return document.querySelector('.media-folder-select[title=\"A/A leaf\"]')?.getAttribute('aria-pressed')"), 'true');
  assert.equal(await h.evaluate("return document.querySelector('.file-pane h2')?.textContent"), 'first.wav');
  check('Sibling disclosure reveals its audio without right-clicking or changing the import target and selected audio');
  await h.label('折叠文件夹 · B');
  await key(Key.ARROW_DOWN);
  await selected('second.wav');
  assert.equal(await h.evaluate("return document.querySelector('.media-folder-select[title=\"A/A leaf\"]')?.getAttribute('aria-pressed')"), 'true');
  for (const name of ['B', 'B leaf']) assert.equal(await (await h.element(`[aria-label="折叠文件夹 · ${name}"]`)).getAttribute('aria-expanded'), 'true');
  await key(Key.ARROW_UP);
  await selected('first.wav');
  check('ArrowDown leaves a one-file selected leaf, opens sibling ancestors, selects the main audio and focuses/scrolls its row; ArrowUp returns');
  await h.screenshot('cross-folder-navigation');

  const beforeGain = await snapshot(h);
  await h.evaluate(`const probe={frames:0,pointers:0,keys:0};window.__folderGainProbe=probe;
    probe.frame=()=>{probe.frames++;probe.raf=requestAnimationFrame(probe.frame);};
    probe.pointer=()=>probe.pointers++;probe.key=()=>probe.keys++;
    window.addEventListener('pointerdown',probe.pointer,true);window.addEventListener('keydown',probe.key,true);probe.raf=requestAnimationFrame(probe.frame);`);
  report.responsiveness = [];
  for (let round = 0; round < 6; round++) {
    const dismissal = round % 2 ? 'outside' : 'escape', name = round % 2 ? 'second.wav' : 'first.wav';
    const previous = await h.evaluate('const p=window.__folderGainProbe;return {frames:p.frames,pointers:p.pointers,keys:p.keys};');
    await clickFolder(round % 2 ? 'B/B leaf' : 'A/A leaf');
    await h.selectMedia(name);
    assert.equal(await (await h.element('[aria-label="快捷区域增益（dB）"]')).isEnabled(), false);
    assert.equal(await (await h.element('[aria-label="应用区域增益"]')).isEnabled(), false);
    for (let click = 0; click < 3; click++) {
      await h.label('快捷区域增益（dB）');
      await h.label('应用区域增益');
    }
    await h.label('更多播放操作');
    const gain = await h.element('[role="menuitem"][aria-label="区域增益…"]');
    assert.equal(await gain.getAttribute('aria-disabled'), 'true');
    await gain.click();
    assert.equal(await h.evaluate("return !!document.querySelector('[role=dialog]') || document.querySelector('.app-root').inert"), false);
    if (dismissal === 'escape') await key(Key.ESCAPE);
    else await h.driver.actions().move({x: 4, y: 300, origin: 'viewport'}).press().release().perform();
    await h.until('!document.querySelector("[data-app-menu]")', 'disabled gain menu dismisses');
    const looping = await (await h.element('[aria-label="循环播放"]')).getAttribute('aria-pressed');
    await h.label('循环播放');
    assert.notEqual(await (await h.element('[aria-label="循环播放"]')).getAttribute('aria-pressed'), looping);
    await h.label('循环播放');
    await h.label('监听增益');
    await h.select('监听目标', `此音频 · ${name}`);
    await h.select('监听目标', '全局');
    await key(Key.ESCAPE);
    await h.until('!document.querySelector(".monitor-popover")', 'monitor popup dismisses with Escape');
    await h.label('监听增益');
    await clickFolder(round % 2 ? 'B/B leaf' : 'A/A leaf');
    await h.until('!document.querySelector(".monitor-popover")', 'monitor popup dismisses outside');
    await h.drag('.annotation-overlay', [.2,.25], [.6,.7]);
    await h.until(`!document.querySelector('[aria-label="快捷区域增益（dB）"]').disabled`, 'temporary selection enables gain');
    await key(Key.ESCAPE);
    await h.until(`document.querySelector('[aria-label="快捷区域增益（dB）"]').disabled`, 'Escape clears selection');
    assert.equal(await h.evaluate("return !!document.querySelector('[role=dialog]') || document.querySelector('.app-root').inert"), false);
    await h.until(`window.__folderGainProbe.frames>${previous.frames}`, 'animation frame heartbeat continues', 10000);
    const current = await h.evaluate('const p=window.__folderGainProbe;return {frames:p.frames,pointers:p.pointers,keys:p.keys};');
    assert.ok(current.pointers > previous.pointers && current.keys > previous.keys, 'trusted input continues reaching the WebView');
    report.responsiveness.push({round, dismissal, media:name, frameDelta:current.frames-previous.frames, pointerDelta:current.pointers-previous.pointers, keyDelta:current.keys-previous.keys});
  }
  await h.evaluate(`const p=window.__folderGainProbe;cancelAnimationFrame(p.raf);window.removeEventListener('pointerdown',p.pointer,true);window.removeEventListener('keydown',p.key,true);delete window.__folderGainProbe;`);
  await clickFolder('A/A leaf');
  await h.selectMedia('first.wav');
  assert.deepEqual((await snapshot(h)).edits, beforeGain.edits);
  check('Six mixed interaction cycles keep input/rAF heartbeats progressing: disabled gain clicks, menu dismissals, audio/folder switches, monitor dropdowns, selection creation/clear; no stuck inert root or edits');

  await h.input('搜索音频', 'first');
  await h.click('[aria-label="搜索音频"]');
  await key(Key.ARROW_DOWN);
  assert.equal(await h.evaluate("return document.querySelector('.file-pane h2')?.textContent"), 'first.wav');
  assert.equal(await h.evaluate("return document.activeElement?.getAttribute('aria-label')"), '搜索音频');
  await h.input('搜索音频', '');
  check('Arrow keys in search editing leave the selected main audio unchanged');

  await h.click(row('first.wav'));
  await h.context(row('first.wav'));
  await h.label('移入共享回收站…');
  await h.click('[role="dialog"] .dialog-actions .button-accent');
  await h.until('!document.querySelector("[role=dialog]")', 'recycle completes');
  await h.until("document.querySelector('.media-folder-select[title=\"A/A leaf\"] .count')?.textContent==='0'", 'leaf now has zero visible audio');
  await h.label('文件夹操作 · A leaf');
  const remove = await h.element('[role="menuitem"][aria-label="删除文件夹…"]');
  assert.notEqual(await remove.getAttribute('aria-disabled'), 'true');
  await remove.click();
  await h.until("document.querySelector('[role=dialog] h2')?.textContent==='删除文件夹'");
  const explanation = await h.evaluate("return document.querySelector('[role=dialog]').textContent");
  assert.match(explanation, /1 个已在共享回收站/);
  assert.match(explanation, /目录归属移至「A」/);
  await h.screenshot('zero-visible-folder-confirmation');
  await h.clickText('取消');
  await h.until("!document.querySelector('[role=dialog]')");

  const current = await status(h);
  const recycled = await read(h, 'recycle_get', { binding: { projectId: current.projectId, runtimeNonce: current.runtimeNonce } });
  assert.deepEqual(recycled.recycle.trashed.map(item => item.mediaId), [before.media.find(media => media.displayName === 'first.wav').id]);
  assert.deepEqual((await organization(h)).folders, layout.folders);
  assert.deepEqual((await organization(h)).media, layout.media);
  for (const media of before.media) assert.equal(hash(await fs.readFile(path.join(project, media.sourceRef))), audioHashes.get(media.id));
  check('Zero-visible recycled folder offers explained subtree removal; cancelling preserves folder associations and physical audio');

  await clickFolder('B');
  await importDirect(h, 3);
  await folder(h, 'B deep', 'B leaf');
  await clickFolder('B/B leaf/B deep');
  await importDirect(h, 4);
  report.treeGeometry = [];
  const previousPanelStyle = await h.evaluate("return document.querySelector('.media-panel').getAttribute('style');");
  for (const width of [280, 220]) {
    await h.evaluate(`const panel=document.querySelector('.media-panel');panel.style.width='${width + 1}px';panel.style.maxWidth='none';`);
    const measured = await h.evaluate(`
      const list=document.querySelector('.media-list-content');
      const rect=e=>e.getBoundingClientRect().toJSON();
      return {width:rect(list).width,rows:${JSON.stringify(['depth-one.wav', 'second.wav', 'depth-three-with-a-long-name.wav'])}.map(name=>{
        const row=[...list.querySelectorAll('.media-select')].find(e=>e.getAttribute('aria-label')===name);
        const folder=row.closest('.media-folder-content').parentElement.querySelector(':scope > .media-folder-row .media-folder-select');
        const text=document.createRange();text.selectNodeContents(folder.firstChild);
        return {name,row:rect(row),icon:rect(row.querySelector('svg')),label:rect(row.querySelector('strong')),parentText:text.getBoundingClientRect().toJSON(),scrollWidth:row.scrollWidth,clientWidth:row.clientWidth};
      })};`);
    assert.ok(Math.abs(measured.width - width) <= 1, 'fixture uses the requested narrow list width');
    for (const [index, geometry] of measured.rows.entries()) {
      assert.ok(geometry.icon.left >= geometry.parentText.left + 4, `depth ${index + 1}: file icon starts clearly after its containing folder label`);
      assert.ok(geometry.label.left >= geometry.icon.right + 4, `depth ${index + 1}: filename follows its icon`);
      assert.ok(geometry.label.left - geometry.parentText.left <= 52, `depth ${index + 1}: one compact disclosure gutter without double depth`);
      assert.ok(Math.abs(geometry.row.height - 28) <= 1, `depth ${index + 1}: compact 28px row`);
      assert.ok(geometry.scrollWidth <= geometry.clientWidth + 1, `depth ${index + 1}: truncated content does not overflow its row`);
    }
    report.treeGeometry.push(measured);
    await h.screenshot(`tree-depths-1-3-width-${width}`);
  }
  await h.evaluate(`document.querySelector('.media-panel').setAttribute('style',${JSON.stringify(previousPanelStyle ?? '')});`);
  check('Actual WebView geometry at depths 1–3 and narrow list widths keeps child file icons right of parent folder labels with compact rows and truncation');

  // Task 5 scenario, executed with the combined candidate in Task 10.
  const beforeDisplay = await snapshot(h), beforeOrganization = await organization(h);
  const displayHashes = new Map(await Promise.all(beforeDisplay.media.map(async media => [media.id, hash(await fs.readFile(path.join(project, media.sourceRef)))])));
  const expansion = await h.evaluate("return [...document.querySelectorAll('.media-folder-disclosure')].map(e=>[e.getAttribute('aria-label'),e.getAttribute('aria-expanded')]);");
  const deepFolder = beforeOrganization.folders.find(f => f.name === 'B deep').id;
  await h.select('音频显示方式', '平铺');
  assert.equal(await (await h.element('[aria-label="平铺显示范围"]')).getAttribute('value'), deepFolder);
  assert.deepEqual(await h.evaluate("return [...document.querySelectorAll('.media-select')].map(e=>e.getAttribute('aria-label'));"), ['depth-three-with-a-long-name.wav']);
  await h.click(row('depth-three-with-a-long-name.wav'));
  await key(Key.ARROW_DOWN);
  await selected('second.wav');
  assert.equal(await (await h.element('[aria-label="平铺显示范围"]')).getAttribute('value'), '');
  await key(Key.ARROW_UP);
  await selected('depth-three-with-a-long-name.wav');
  const flatGeometry = await h.evaluate("return [...document.querySelectorAll('.media-select')].map(e=>({name:e.getAttribute('aria-label'),left:e.getBoundingClientRect().left,height:e.getBoundingClientRect().height,scroll:e.scrollWidth,width:e.clientWidth}));");
  assert.equal(flatGeometry.length, 3);
  assert.ok(flatGeometry.every(r => Math.abs(r.left-flatGeometry[0].left) <= 1 && Math.abs(r.height-28) <= 1 && r.scroll <= r.width+1));
  await h.select('平铺显示范围', 'B/B leaf/B deep（含子目录）');
  await h.label('多选音频'); await h.label('全选筛选结果');
  assert.match(await h.evaluate("return document.querySelector('.media-batch-actions').textContent"), /已选 1/);
  await h.select('音频显示方式', '目录树');
  assert.equal(await h.evaluate(`return document.querySelector('.media-folder-select[title="B/B leaf/B deep"]').getAttribute('aria-pressed');`), 'true', 'flat reveal preserves the import destination');
  assert.deepEqual(await h.evaluate("return [...document.querySelectorAll('.media-folder-disclosure')].map(e=>[e.getAttribute('aria-label'),e.getAttribute('aria-expanded')]);"), expansion);
  assert.match(await h.evaluate("return document.querySelector('.media-batch-actions').textContent"), /已选 1/);
  await h.select('音频显示方式', '平铺');
  assert.match(await h.evaluate("return document.querySelector('.media-batch-actions').textContent"), /已选 1/);
  await h.label('多选音频');
  assert.deepEqual(await organization(h), beforeOrganization);
  const afterDisplay = await snapshot(h);
  for (const field of ['media', 'annotations', 'categories', 'edits']) assert.deepEqual(afterDisplay[field], beforeDisplay[field]);
  for (const media of afterDisplay.media) assert.equal(hash(await fs.readFile(path.join(project, media.sourceRef))), displayHashes.get(media.id));
  await h.screenshot('flat-scope-focus-geometry');
  check('Tree/flat scope, global arrows, focus/scroll, flat geometry and multiselect preserve import selection, tree expansion, organization and audio bytes');
  report.passed = true;
} catch (error) {
  report.error = error.stack;
  console.error(error);
  await h?.screenshot('failure').catch(() => {});
  process.exitCode = 1;
} finally {
  await h?.quit().catch(() => {});
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
