import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {start,Key} from './harness.mjs';
import {snapshot,saved,escape} from './workspace-helpers.mjs';
const root=path.resolve('.test-output/update-0.7.2'),old=JSON.parse(await fs.readFile(path.join(root,'baseline.json'))),output=await fs.mkdtemp(path.join(root,'analysis-'));
const exe=path.resolve(process.env.ANNOTATOR_WORKSPACE_EXE??'C:/Users/DY/AppData/Local/Temp/annotator-071-production-20261027/release/annotator-desktop.exe');
const report={output,checks:[]};let h;
try{
 h=await start({'打开项目':[path.join(old.project,'collaboration.json')]},output,exe,{localDataEnv:old.local,webviewDirectory:old.webview});await h.menu('打开项目');await h.until('document.querySelector(".file-pane")');const before=await snapshot(h);
 await h.label('全局播放与显示设置');await h.input('全局显示增益（dB）','6');await h.select('全局色表','灰度');await h.click('.global-analysis-details summary');await h.input('全局窗长','1024');await h.input('全局步长','256');await h.input('全局FFT 长度','2048');await h.input('全局梅尔频带','64');await h.clickText('应用到全部音频');await h.until('document.querySelector(".global-settings-dialog [role=status]")?.textContent.includes("已保存")');await h.screenshot('global-settings-advanced');await escape(h);
 await h.clickText('单文件');for(const name of ['alpha.wav','beta.wav']){
  await h.selectMedia(name);await h.label(`${name} 分析设置`);
  for(const [label,value] of [['窗长','1024'],['步长','256'],['FFT 长度','2048'],['梅尔频带','64'],['显示增益','6']])assert.equal(await(await h.element(`[aria-label="${label}"]`)).getAttribute('value'),value,`${name} ${label}`);
  await escape(h);await h.until('!document.querySelector(".tile-status")');
 }
 report.checks.push({name:'global display gain/palette and STFT/mel compute settings propagate to both audio files and native tiles settle',passed:true});
 await h.label('beta.wav 分析设置');await h.input('步长','128');await h.clickText('应用分析参数');await escape(h);await h.label('beta.wav 分析设置');assert.equal(await(await h.element('[aria-label="步长"]')).getAttribute('value'),'128');await h.clickText('恢复跟随全局显示与分析');assert.equal(await(await h.element('[aria-label="步长"]')).getAttribute('value'),'256');await escape(h);
 const after=await snapshot(h);assert.deepEqual(after.annotations,before.annotations);assert.deepEqual(after.categories,before.categories);await saved(h);report.checks.push({name:'single-file compute override and restore-follow preserve labels',passed:true});report.passed=true;
}catch(e){report.passed=false;report.error=String(e.stack??e);if(h)await h.screenshot('failure').catch(()=>{});throw e;}
finally{if(h)await h.quit();await fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
