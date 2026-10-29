import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Key } from './harness.mjs';
export async function spectralFlow(h, context) {
  await h.drag('.annotation-overlay', [.2,.25], [.6,.7]);
  await h.context('.annotation-overlay', [.4,.45]);
  await h.label('标注类型'); await h.clickText('清空标签');await h.driver.actions().sendKeys('\uE00C','\uE00C').perform();
  await h.until(`document.querySelector('.annotation-inspector')`);
  assert.equal((await h.snapshot(context.id)).document.annotations.length, 1);
  await h.input('区域备注', '区域独立备注');
  await h.clickText('类别'); await h.input('类别名称', '测试类别'); await h.clickText('添加类别');
  await h.until(`document.querySelector('.category-row')`);
  await h.clickText('区域'); await h.click('[aria-label=区域类别] input');
  await h.label('撤销 · Ctrl Z'); await h.label('重做 · Ctrl Y');
  await h.click('.file-heading h2'); await h.clickText('文件/通道'); await h.input('音频备注', '文件独立备注'); await h.click('.channel-pane:nth-child(2) .channel-caption strong'); await h.input('通道 2 备注', '通道独立备注');
  await h.label(`${context.primary.displayName} 分析设置`);
  const axis = await h.element('input[aria-label$="线性对数混合"]');
  await axis.sendKeys('\uE014', '\uE014'); await h.clickText('关闭');
  await h.clickText('全部'); await h.until(`document.querySelectorAll('.channel-pane').length===6 && !document.querySelector('.tile-status')`);
  await h.screenshot('six-channels-1280x800');
  // Explicit no-channel state, then restore all six.
  for (let i=1;i<=6;i++) await h.label(`显示通道 ${i}`);
  await h.until(`document.querySelector('.no-channels')`);
  await h.screenshot('no-channels'); await h.clickText('全部');
  await h.clickText('双文件对比');
  await h.until(`document.querySelectorAll('.file-pane').length===2 && !document.querySelector('.tile-status')`);
  await h.menu('联动时间轴', '视图');
  await h.screenshot('dual-1280x800');
  assert.equal(await h.evaluate('return document.documentElement.scrollWidth <= innerWidth'), true, 'no horizontal page overflow');
  await (await h.element('input[aria-label="播放音量"]')).sendKeys(Key.HOME,...Array(5).fill(Key.ARROW_RIGHT));
  await h.menu('输出设备…','音频');
  await h.label('循环播放'); await h.label('播放 · 空格');
  try {
    await h.until(`document.querySelector('.playback-counters')?.textContent.match(/已提交 [1-9]/)`, 'actual native output');
  } catch (error) {
    let diagnostic;
    try {
      const native = await h.driver.executeAsyncScript(`const done=arguments[arguments.length-1],api=window.__TAURI_INTERNALS__;api.invoke('collaboration_status').then(s=>api.invoke('playback_status',{runtimeNonce:s.runtimeNonce}).then(playback=>done({collaboration:{runtimeNonce:s.runtimeNonce,busy:s.busy,pending:s.pending,error:s.error},playback}))).catch(error=>done({error}));`);
      const ui = await h.evaluate(`return {counter:document.querySelector('.playback-counters')?.textContent,focus:document.hasFocus(),active:document.activeElement?.outerHTML.slice(0,2000),device:document.querySelector('[aria-label="输出设备"]')?.value,source:document.querySelector('[aria-label="声音版本"]')?.value,playbackSource:document.querySelector('.is-playback-source')?.dataset.pane,position:document.querySelector('.playback-position')?.textContent};`);
      diagnostic = { native, ui };
    } catch (diagnosticError) {
      diagnostic = { diagnosticError: String(diagnosticError) };
    }
    await fs.writeFile(path.join(context.output,'spectral-output-failure.json'),JSON.stringify(diagnostic,null,2)).catch(diagnosticError=>console.error('Could not save spectral output diagnostic:',diagnosticError));
    throw error;
  }
  assert.match(await h.evaluate('return document.querySelector(".playback-counters").textContent'), /欠载 0/);
  await h.label('停止');
  await h.clickText('保存');
  await h.until(`document.querySelector('.project-identity')?.innerText.match(/已保存|已存本机/)`);
  context.saved = (await h.snapshot(context.id)).document;
  assert.equal(context.saved.media.find(m=>m.id===context.primary.id).note, '文件独立备注');
  assert.equal(context.saved.media.find(m=>m.id===context.primary.id).channelNotes[1], '通道独立备注');
  assert.equal(context.saved.annotations[0].note, '区域独立备注');
  assert.equal(context.saved.categories.length, 1);
  await h.menu('关闭项目'); await h.until(`document.querySelector('.project-identity').textContent.includes('音频标注')`);
}
