import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { start } from './harness.mjs';

const parent=path.resolve(process.env.ANNOTATOR_SUITE_OUTPUT ?? '.test-output/default-collaboration-v040/task5/desktop-evidence/format');await fs.mkdir(parent,{recursive:true});
const output = await fs.mkdtemp(path.join(parent,'run-'));
const project = path.join(output, 'project'); await fs.mkdir(project);
const json = path.join(output, 'v2.annotations.json');
const sources = [];
for (const version of [1, 999]) {
  const local = path.join(output, `local-${version}`); await fs.mkdir(local);
  sources.push({ version, local: path.join(local, 'project.json'), portable: path.join(output, `share-${version}.json`) });
}
const paths = {
  '新建项目 · 选择空文件夹': [project],
  '打开项目': sources.flatMap(s => [s.local, path.join(project, 'collaboration.json')]),
  '': [[path.resolve('tests/fixtures/audio/stereo24.wav')]],
  '分享 · 保存到本机': [json],
  '导入标注文件或完整项目包': sources.map(s => s.portable),
  '选择新项目的存放位置 · 将创建独立子文件夹': [output, output],
};
const report = { output, method: 'Actual native v2 save and UI open/import rejection. Only picker results injected. Ordinary open saves/closes the old session before attempting the target; no rollback promise.', checks: [], sources: [] };
const hash = async file => createHash('sha256').update(await fs.readFile(file)).digest('hex');
let h;
try {
  h = await start(paths, output);
  await h.menu('新建项目'); await h.until(`document.querySelector('.project-identity')?.textContent.match(/已保存|已存本机/)`);
  await h.menu('导入音频'); await h.until(`document.querySelector('.import-progress')?.textContent.includes('导入完成')`); await h.clickText('关闭导入结果');
  await h.menu('保存'); await h.until(`document.querySelector('.project-identity')?.textContent.match(/已保存|已存本机/)`);
  const manifest = JSON.parse(await fs.readFile(path.join(project, 'collaboration.json'), 'utf8'));
  const saved=(await h.snapshot(manifest.projectId)).document;
  assert.equal(saved.formatVersion, 2); assert.equal(saved.media[0].categoryId, null); assert.deepEqual(saved.media[0].channelCategoryIds, [null, null]);
  assert.equal(saved.viewState.compareLayout, 'horizontal'); assert.equal(saved.viewState.compareSplit, .5);
  report.checks.push('native save writes complete format 2');
  await h.menu('导出我的标注 / 项目包'); await h.label('我的标注（不含音频）'); await h.clickText('选择保存位置…'); await h.until(`document.querySelector('.exchange-result')`); await h.clickText('关闭');
  const portable = JSON.parse(await fs.readFile(json, 'utf8')); assert.equal(portable.formatVersion, 2);
  for (const source of sources) {
    await fs.writeFile(source.local, JSON.stringify({ ...saved, formatVersion: source.version }));
    await fs.writeFile(source.portable, JSON.stringify({ ...portable, formatVersion: source.version }));
    const before = await hash(source.local);
    await h.menu('打开项目…'); await h.until(`document.querySelector('[role="alert"]')?.textContent.match(/version|版本/i)`);
    assert.equal(await hash(source.local), before); assert.equal((await fs.readdir(path.dirname(source.local))).some(n => /pre-v2|migration/.test(n)), false);
    report.checks.push(`local format ${source.version} rejected; source bytes unchanged`);
    await h.screenshot(`local-${source.version}-rejected`);
    await h.menu('打开项目…'); await h.until(`document.querySelector('.media-card') && !document.querySelector('.tile-status')`);
    const shareBefore = await hash(source.portable);
    await h.menu('导入分享文件'); await h.clickText('选择交换文件…'); await h.until(`document.querySelector('.exchange-dialog [role="alert"]')`);
    assert.match(await h.evaluate(`return document.querySelector('.exchange-dialog [role="alert"]').textContent`), /version|版本/i);
    assert.equal(await hash(source.portable), shareBefore);
    report.sources.push({version: source.version, local: {path: source.local, before, after: await hash(source.local)}, portable: {path: source.portable, before: shareBefore, after: await hash(source.portable)}});
    assert.equal((await h.snapshot(saved.projectId)).document.projectId, saved.projectId, 'exchange rejection retains current owner');
    report.checks.push(`portable format ${source.version} rejected; source bytes and current owner preserved`);
    await h.screenshot(`portable-${source.version}-rejected`); await h.clickText('关闭');
  }
  report.passed = true;
} catch (error) { report.error = error.stack; process.exitCode = 1; await h?.screenshot('failure').catch(() => {}); }
finally { await h?.quit(); await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); }
