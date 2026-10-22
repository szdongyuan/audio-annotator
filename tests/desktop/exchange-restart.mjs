// Run only after terminating and freshly restarting the native application.
import fs from 'node:fs/promises';
const saved=JSON.parse(await fs.readFile('.test-output/task10-restart-target.json','utf8'));
const report={checks:[],method:'Fresh Tauri process; real project open, lazy decode/analysis, persisted exchange semantics. Picker return only is injected.'};
const target=(await(await fetch('http://127.0.0.1:9223/json/list')).json()).find(t=>t.type==='page'&&t.url.includes('1420'));
const socket=new WebSocket(target.webSocketDebuggerUrl);await new Promise((r,j)=>{socket.onopen=r;socket.onerror=j;});let seq=0;const pending=new Map();socket.onmessage=({data})=>{const m=JSON.parse(data);if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(m.error):p.resolve(m.result);}};
const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});
const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
const check=(name,pass)=>{report.checks.push({name,passed:!!pass});console.log(name,!!pass);if(!pass)throw new Error(name);};
try{
 check('fresh process begins without a project',await evaluate(`document.querySelector('.project-identity').textContent.includes('尚未打开项目')`));
 await evaluate(`(async()=>{const {localProjects}=await import('/src/bridge/projects.ts');localProjects.choose=async()=>${JSON.stringify(saved.bundleRoot)};[...document.querySelectorAll('button')].find(b=>b.textContent==='打开项目').click();})()`);
 let ready=false;for(let i=0;i<300;i++){ready=await evaluate(`document.querySelectorAll('canvas').length>=2&&!document.querySelector('.tile-status')`);if(ready)break;await new Promise(r=>setTimeout(r,100));}check('restart rehydrates bundled relative media and renders both spectra',ready);
 const actual=(await evaluate(`window.__TAURI_INTERNALS__.invoke('get_project_snapshot',{projectId:${JSON.stringify(saved.projectId)}})`)).document;delete actual.projectId;delete actual.revision;delete actual.updatedAt;for(const m of actual.media)delete m.sourceRef;
 check('restart preserves all notes categories regions edits analysis mix and view',JSON.stringify(actual)===JSON.stringify(saved.semantics));
 check('restart opens ready relative media resources',(await evaluate(`window.__TAURI_INTERNALS__.invoke('media_status',{projectId:${JSON.stringify(saved.projectId)}})`)).every(s=>s.status==='ready'));
 const image=await send('Page.captureScreenshot',{format:'png'});await fs.writeFile('.test-output/task10-fresh-restart.png',Buffer.from(image.data,'base64'));
 await evaluate(`document.querySelector('.project-menu').open=true;[...document.querySelectorAll('button')].find(b=>b.textContent==='关闭项目').click()`);
 report.passed=true;
}catch(e){report.error=String(e);console.error(e);process.exitCode=1;}finally{await fs.writeFile('.test-output/task10-restart-report.json',JSON.stringify(report,null,2));socket.close();}
