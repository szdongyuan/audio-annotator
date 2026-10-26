import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
export async function sharingFlow(h, context) {
  // The integrated runner queues JSON first, then ZIP. Only JSON needs selection.
  for (const kind of ['我的标注（不含音频）', null]) {
    await h.menu('导出我的标注 / 项目包');
    assert.equal(await (await h.element('[aria-label="我的项目包（含音频）"]')).isSelected(), true);
    if (kind) await h.label(kind);
    await h.clickText('预览导出路径'); await h.until("document.querySelector('[aria-label=导出路径预览]')"); await h.clickText('选择保存位置…');
    await h.until(`document.querySelector('.exchange-result') && !document.querySelector('.exchange-progress')`); await h.clickText('关闭');
  }
  for (const extension of ['json', 'zip']) {
    assert.ok((await fs.stat(path.join(context.output, `share.${extension}`))).size > 100);
    await h.menu('导入分享文件'); await h.clickText('选择交换文件…');
    if(extension==='json'){await h.bindSources(['six.flac','mono16.wav','stereo.mp3']);}
    await h.until(`document.querySelector('.exchange-result') && !document.querySelector('.exchange-progress')`);
    await h.clickText('关闭');
    const title = await h.evaluate('return document.querySelector(".project-identity").title');
    const manifest = JSON.parse(await fs.readFile(path.join(title, 'collaboration.json')));
    const imported=(await h.snapshot(manifest.projectId)).document;
    assert.notEqual(imported.projectId, context.id);
    assert.equal(imported.annotations[0].note, context.saved.annotations[0].note);
    assert.equal(imported.media.find(m=>m.id===context.primary.id).channelNotes[1], '通道独立备注');
    assert.equal(imported.categories[0].name, '测试类别');
    await h.screenshot(`${extension}-default-roundtrip`);
  }
  await h.menu('关闭项目');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { standaloneSharing } = await import('./task7-sharing.mjs');
  await standaloneSharing();
}
