import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
export async function sharingFlow(h, context) {
  for (const kind of ['仅标注文件', '完整项目包']) {
    await h.menu('分享项目'); await h.label(kind); await h.clickText('选择保存位置…');
    await h.until(`document.querySelector('.exchange-result') && !document.querySelector('.exchange-progress')`); await h.clickText('关闭');
  }
  for (const extension of ['json', 'zip']) {
    assert.ok((await fs.stat(path.join(context.output, `share.${extension}`))).size > 100);
    await h.menu('导入分享文件'); await h.clickText('选择交换文件…');
    await h.until(`document.querySelector('.exchange-result') && !document.querySelector('.exchange-progress')`);
    await h.clickText('关闭');
    const title = await h.evaluate('return document.querySelector(".project-identity").title');
    const imported = JSON.parse(await fs.readFile(path.join(title, 'project.json')));
    assert.notEqual(imported.projectId, context.id);
    assert.equal(imported.annotations[0].note, context.saved.annotations[0].note);
    assert.equal(imported.media[0].channelNotes[1], '通道独立备注');
    assert.equal(imported.categories[0].name, '测试类别');
    if (extension === 'json') {
      await h.until(`document.body.innerText.includes('缺失')`);
      await h.screenshot('json-missing-media');
      await h.menu('关闭项目'); await h.clickText('打开项目');
      await h.until(`document.querySelectorAll('.file-pane').length===2`);
    } else await h.screenshot('bundle-roundtrip');
  }
  await h.menu('关闭项目');
}
