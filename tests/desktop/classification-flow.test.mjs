import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { start, Key, wait } from './harness.mjs';
const output = path.resolve('.test-output/task5-classification'); await fs.mkdir(output, { recursive: true });
const project = await fs.mkdtemp(path.join(output, 'project-'));
const run = path.basename(project);
const longName = 'very-long-stereo-filename-for-compact-classification-and-truncation-check.wav';
const audio = path.join(output, longName); await fs.copyFile(path.resolve('tests/fixtures/audio/stereo24.wav'), audio);
const json = path.join(output, `${run}.json`), zip = path.join(output, `${run}.zip`);
const paths = { '新建项目 · 选择空文件夹': [project], '打开项目 · 选择 project.json': [path.join(project, 'project.json')], '': [[audio, path.resolve('tests/fixtures/audio/stereo.mp3')]], '分享 · 保存到本机': [json, zip], '导入标注文件或完整项目包': [json, zip], '选择新项目的存放位置 · 将创建独立子文件夹': [output, output] };
const report = { method: 'Owned native e2e WebView2 process, trusted WebDriver pointer/keyboard; only file picker return values injected. Win32 outer dimensions on owned PID.', project, checks: [], frames: [] };
let h, id, saved;
const check = name => { report.checks.push({ name, passed: true }); console.log('PASS ' + name); };
const snap = async () => (await h.snapshot(id)).document;
const save = async () => { await h.clickText('保存'); await h.until(`document.querySelector('.project-identity')?.textContent.includes('已保存')`); };
async function category(selector, scope, value = '分类甲', right = false) { if (right) await h.context(selector); else await h.click(selector); await h.label(scope); await h.label(value); await wait(120); }
const semantics = doc => { const d = structuredClone(doc); delete d.projectId; delete d.revision; delete d.updatedAt; for (const m of d.media) delete m.sourceRef; return d; };
async function measure(name, width, height, complete) {
 h.nativeRect({ width, height }); await wait(250);
 const frame = await h.evaluate(`const r=e=>e.getBoundingClientRect().toJSON();return {inner:[innerWidth,innerHeight],top:r(document.querySelector('.project-header')).height+r(document.querySelector('.workspace-toolbar')).height,bottom:r(document.querySelector('.playback-bar')).height,plots:[...document.querySelectorAll('.spectrogram-surface')].map(r),headers:[...document.querySelectorAll('.file-pane')].map(p=>r(p.querySelector('.file-heading')).height+r(p.querySelector('.file-controls')).height),panes:[...document.querySelectorAll('.file-pane')].map(r),controls:[...document.querySelectorAll('.file-pane .classification-control')].map(e=>({rect:r(e),parent:r(e.closest('.file-heading,.channel-caption')),title:e.title})),overflow:document.documentElement.scrollWidth>innerWidth};`);
 assert.ok(frame.top <= 76 && frame.bottom <= 52); assert.ok(frame.headers.every(n => n <= 56)); assert.ok(frame.plots.every(r => r.height >= 180)); assert.equal(frame.overflow, false);
 assert.ok(frame.controls.every(({rect:r,parent:p}) => r.width >= 20 && r.left >= p.left && r.right <= p.right && r.top >= p.top && r.bottom <= p.bottom), JSON.stringify(frame.controls));
 if (complete) { assert.equal(frame.plots.length,4); assert.ok(frame.plots.every(r => r.top>=0 && r.bottom<=frame.inner[1] && r.left>=0 && r.right<=frame.inner[0])); }
 report.frames.push({name,outer:h.nativeRect(),...frame}); await h.screenshot(name); check(name);
}
try {
 h = await start(paths, output, undefined, {exactOuter:true}); report.firstPid=h.nativePid;
 await h.menu('新建项目'); await h.until(`document.querySelector('.project-identity')?.textContent.includes('已保存')`); id=JSON.parse(await fs.readFile(path.join(project,'project.json'),'utf8')).projectId;
 await h.clickText('导入音频'); await h.until(`document.querySelector('.import-progress')?.textContent.includes('导入完成')`); await h.clickText('关闭导入结果'); await h.clickText('双文件对比'); await h.until(`document.querySelectorAll('canvas').length===4&&!document.querySelector('.tile-status')`);
 await h.menu('类别管理','标注'); await h.input('类别名称','分类甲'); await h.clickText('添加类别'); await h.until(`document.querySelector('.category-row')`);
 const initial=await snap(), a=initial.media[0], b=initial.media[1], cat=initial.categories[0].id;
 await h.click('.file-pane:first-child .file-heading h2'); await h.until(`document.querySelector('[aria-label="音频备注"]')`);
 const fileNote=await h.element('[aria-label="音频备注"]'); await fileNote.sendKeys('file note before category/save');
 await category('.file-pane:first-child .file-heading .classification-control','文件类别'); await save();
 let d=await snap(); assert.equal(d.media[0].categoryId,cat);assert.deepEqual(d.media[0].channelCategoryIds,[null,null]);assert.equal(d.annotations.length,0);assert.equal(d.media[0].note,'file note before category/save');check('file category and note remain independent from channels/regions after immediate save');
 await category('.file-pane:first-child .file-heading h2','文件类别','分类甲',true); check('filename right click exposes the same file category submenu');
 await h.click('.file-pane:last-child .channel-pane:nth-child(2) .channel-caption strong'); await h.until(`document.querySelector('[aria-label="通道 2 备注"]')`);
 assert.ok((await h.evaluate(`return document.querySelector('.notes-editor .object-caption').textContent`)).includes(b.displayName));
 const channelNote=await h.element('[aria-label="通道 2 备注"]'); await channelNote.sendKeys('comparison channel note');
 await h.menu('当前通道分类','标注'); await h.label('分类甲'); await save();
 d=await snap();assert.equal(d.media[1].channelCategoryIds[1],cat);assert.equal(d.media[1].categoryId,null);assert.equal(d.media[1].channelNotes[1],'comparison channel note');assert.equal(d.annotations.length,0);assert.equal(await h.evaluate(`return document.querySelector('.media-select[aria-pressed="true"] strong').textContent`),a.displayName);check('main menu and exact properties target comparison channel without changing sidebar or creating a region');
 await category('.file-pane:last-child .channel-pane:nth-child(2) .classification-control','通道类别','未分类',true);assert.equal((await snap()).media[1].channelCategoryIds[1],null);
 await category('.file-pane:last-child .channel-pane:nth-child(2) .channel-caption strong','通道类别','分类甲',true);check('right click channel submenu supports classified/unclassified independently');
 await h.drag('.file-pane:last-child .channel-pane:first-child .annotation-overlay',[.2,.2],[.6,.65]); await h.menu('标注类型','标注'); await h.label('分类甲'); await h.until(`document.querySelector('.annotation-inspector')`); await h.input('区域备注','independent region note');
 d=await snap();assert.equal(d.annotations.length,1);assert.equal(d.annotations[0].categoryId,cat);assert.equal(d.annotations[0].region.mediaId,b.id);check('three real scopes classify independently');
 await h.menu('标注列表','标注');await h.select('筛选类别','分类甲');assert.equal(await h.evaluate(`return document.querySelectorAll('.annotation-row').length`),3);await h.screenshot('scope-results');
 await h.click('.annotation-row:nth-child(2)');await h.until(`document.querySelector('[aria-label="通道 2 备注"]')`);assert.ok(await h.evaluate(`return !!document.querySelector('[aria-label="播放 · 空格"]')&&!document.querySelector('.annotation-rect.is-selected')`));assert.equal((await snap()).annotations.length,1);check('channel result locates exact comparison channel without region or playback');
 await h.menu('标注列表','标注');await h.select('筛选类别','分类甲');await h.click('.annotation-row:first-child');await h.until(`document.querySelector('[aria-label="音频备注"]')`);assert.ok((await h.evaluate(`return document.querySelector('.notes-editor .object-caption').textContent`)).includes(a.displayName));check('file result locates whole-file properties');
 await h.click('.file-pane:last-child .channel-pane:nth-child(2) .channel-caption strong');await h.click('.file-pane:last-child input[aria-label="显示通道 2"]');await h.menu('当前通道分类','标注');await h.label('分类甲');await wait(120);assert.equal((await snap()).media[1].channelCategoryIds[0],cat);await h.menu('撤销','编辑');await wait(100);check('hidden current channel falls back to first visible comparison channel');
 await h.click('.file-pane:last-child input[aria-label="显示通道 1"]');await h.click('.main-menu > button:nth-child(4)');assert.equal(await (await h.element('[role="menuitem"][aria-label="当前通道分类"]')).getAttribute('aria-disabled'),'true');await h.driver.actions().keyDown(Key.ESCAPE).keyUp(Key.ESCAPE).perform();await h.click('.file-pane:last-child .channel-select button');check('no visible channels disables current channel classification');
 await h.click('.file-pane:last-child .channel-pane:nth-child(2) .channel-caption strong');await h.clickText('单文件');await h.click('.main-menu > button:nth-child(4)');await h.label('当前通道分类');await h.label('分类甲');await wait(120);d=await snap();assert.equal(d.media[0].channelCategoryIds[0],cat);await h.menu('撤销','编辑');await wait(100);await h.clickText('双文件对比');check('removed comparison context falls back to visible primary channel');
 await h.menu('类别管理','标注');await h.label('删除类别 分类甲');assert.match(await h.evaluate(`return document.querySelector('[role="alertdialog"]').textContent`),/1 个文件、1 个通道、1 个区域/);const before=await snap();await h.clickText('确认删除类别');await wait(150);d=await snap();assert.equal(d.categories.length,0);assert.ok(d.media.every(m=>m.categoryId===null&&m.channelCategoryIds.every(c=>c===null)));assert.equal(d.annotations[0].categoryId,null);await h.menu('撤销','编辑');await wait(150);d=await snap();for(const f of ['media','categories','annotations'])assert.deepEqual(d[f],before[f]);check('one category deletion clears all three scopes; one undo restores every reference and note');
 await measure('classification-outer1280x800',1280,800,true);await measure('classification-outer1920x1080',1920,1080,true);await measure('classification-min-pane-long-name',1000,680,false);
 await save();saved=await snap();await h.menu('关闭项目');await h.quit();h=null;
 h=await start(paths,output,undefined,{exactOuter:true});report.secondPid=h.nativePid;assert.notEqual(report.firstPid,report.secondPid);await h.menu('打开项目…');await h.until(`document.querySelectorAll('canvas').length===4&&!document.querySelector('.tile-status')`);assert.deepEqual(semantics(await snap()),semantics(saved));check('fresh native process restores all classification notes and project semantics');
 for(const kind of ['仅标注（不含音频）','完整项目包（含音频）']){await h.menu('分享项目');await h.label(kind);await h.clickText('选择保存位置…');await h.until(`document.querySelector('.exchange-result')&&!document.querySelector('.exchange-progress')`);await h.clickText('关闭');}
 for(const extension of ['json','zip']){await h.menu('导入分享文件');await h.clickText('选择交换文件…');await h.until(`document.querySelector('.exchange-result')&&!document.querySelector('.exchange-progress')`);await h.clickText('关闭');const importedRoot=await h.evaluate(`return document.querySelector('.project-identity').title`);const imported=JSON.parse(await fs.readFile(path.join(importedRoot,'project.json'),'utf8'));assert.deepEqual(semantics(imported),semantics(saved));await h.screenshot(`classification-${extension}-roundtrip`);check(`${extension} full semantic roundtrip preserves categories, notes, regions, analysis, mix, view and media metadata`);}
 await h.menu('关闭项目');report.passed=true;
}catch(error){report.error=error.stack;console.error(error);await h?.screenshot('classification-failure').catch(()=>{});process.exitCode=1;}finally{await h?.quit().catch(()=>{});await fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));}
