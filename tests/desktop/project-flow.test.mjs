import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
export async function projectFlow(h, context) {
  await h.menu('新建项目');
  await h.until(`document.querySelector('.project-identity')?.innerText.match(/已保存|已存本机/)`);
  context.id = JSON.parse(await fs.readFile(path.join(context.project, 'collaboration.json'))).projectId;
  await h.clickText('导入音频');
  await h.until(`document.querySelector('.import-progress')?.innerText.includes('导入完成')`, 'real WAV/FLAC/MP3 import');
  await h.clickText('关闭导入结果');
  await h.until(`document.querySelectorAll('canvas').length>=1 && !document.querySelector('.tile-status')`);
  const d = (await h.snapshot(context.id)).document;
  assert.deepEqual(d.media.map(m => m.channelCount).sort(), [1, 2, 6]);
  await h.selectMedia('six.flac');
  context.primary = d.media.find(m=>m.displayName==='six.flac');
  await h.screenshot('import-1280x800');
}
export async function restartFlow(h, context) {
  await h.menu('打开项目…');
  await h.until(`document.querySelectorAll('.file-pane').length===2 && !document.querySelector('.tile-status')`);
  const after = (await h.snapshot(context.id)).document;
  for (const field of ['annotations', 'categories', 'media', 'edits', 'viewState']) assert.deepEqual(after[field], context.saved[field], `restart restores ${field}`);
  await h.screenshot('restart-1280x800');
}
export async function recoveryFlow(h, context) {
  const recovery=path.join(context.output,'recovery-project');
  await fs.mkdir(recovery);await fs.cp(path.join(context.project,'media'),path.join(recovery,'media'),{recursive:true});
  // Explicit legacy ordinary recovery fixture: current default documents remain private.
  const payload=JSON.stringify(context.saved);
  await fs.writeFile(path.join(recovery,'project.json.bak'),JSON.stringify({formatVersion:1,projectId:context.saved.projectId,revision:context.saved.revision,checksum:createHash('sha256').update(payload).digest('hex'),payload}));
  await fs.writeFile(path.join(recovery,'project.json'),'{ interrupted write');
  await h.menu('打开项目…');await h.until(`document.querySelector('[aria-label="发现可恢复的项目版本"]')`);
  assert.equal(await h.evaluate('return document.activeElement.getAttribute("role")'), 'dialog');
  await h.screenshot('recovery-dialog');await h.clickText('取消打开');
  await h.until(`!document.querySelector('[aria-label="发现可恢复的项目版本"]')`);
  await h.menu('打开项目…');await h.until(`document.querySelector('.recovery-version')`);
  await h.click('.recovery-version');await h.until(`document.querySelectorAll('.file-pane').length===2`);
  const recovered=JSON.parse(await fs.readFile(path.join(recovery,'project.json')));
  assert.deepEqual(recovered.annotations,context.saved.annotations);
  await h.screenshot('recovered-project');await h.menu('关闭项目');
}
