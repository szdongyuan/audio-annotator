import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { start } from './harness.mjs';
import * as w from './workspace-helpers.mjs';
const output=await fs.mkdtemp(path.resolve('.test-output/collaborative-workspace/task10/catalog-idle-'));
const project=path.join(process.env.ANNOTATOR_OWNED_PROJECT_ROOT??output,`.codex-workspace-078-owned-${randomUUID()}`);await fs.mkdir(project);await fs.mkdir(path.join(output,'b'));
const sources=[path.join(output,'one.wav'),path.join(output,'two.wav')];for(const s of sources)await fs.writeFile(s,w.wav({seconds:2,channels:1}));
let a,b;const report={output};
try{
 a=await start({'新建项目 · 选择空文件夹':[project],'':[[sources[0]]]},output,undefined,{ports:{driver:4505,native:4506,debug:9305}});
 await a.evaluate(`window.__catalogResults=[];const original=window.fetch;window.fetch=function(resource,...args){const command=decodeURIComponent(String(resource).split('/').at(-1));const result=original.call(this,resource,...args);if(command.startsWith('collaboration_'))result.then(response=>response.clone().json().then(value=>window.__catalogResults.push({command,value})));return result;};`);
 await w.newProject(a);await w.importDirect(a,1);await a.selectMedia('one.wav');await a.click('.file-heading h2');await a.input('音频备注','own current draft');
 b=await start({'打开项目':[path.join(project,'collaboration.json')],'':[[sources[1]]]},path.join(output,'b'),undefined,{ports:{driver:4515,native:4516,debug:9315}});await b.menu('打开项目');await w.importDirect(b,2);
 await w.expectDocument(a,d=>d.media.length===2,'idle automatic adoption');report.passed=true;
}catch(e){report.error=String(e);process.exitCode=1;}
finally{
 if(a){report.trace=await a.evaluate('return window.__catalogResults');report.owner=await a.evaluate(`let f=document.querySelector('.app-root');f=f[Object.keys(f).find(k=>k.startsWith('__reactFiber'))];while(f.return)f=f.return;const stack=[f.stateNode.current];while(stack.length){const f=stack.pop();if(f.child)stack.push(f.child);if(f.sibling)stack.push(f.sibling);const p=f.memoizedProps;if(p?.project?.active&&p.collaboration?.controller){const o=p.project.active;return {runtime:o.collaboration.runtimeNonce,catalog:p.collaboration.controller.status,guards:[...o.lifecycle.backgroundGuards].map(g=>g()),busy:p.project.busy};}}`);await a.screenshot('result');}
 await b?.quit();await a?.quit();await fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}
