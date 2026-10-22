// Task 10 handoff: real Tauri commands and UI; only picker return values are injected.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
const root=await fs.mkdtemp(path.resolve('.test-output/task10-exchange-'));
const original=path.join(root,'source-project');await fs.mkdir(original);
const report={root,checks:[],runtimeErrors:[],method:'Fresh native Tauri/WebView2. Source semantics are prepared through actual native commands; sharing/import/relink/retry use real UI buttons with picker-return injection. No fake exchange, decoder, persistence, playback or store mutation.'};
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const check=(name,pass,detail)=>{report.checks.push({name,passed:!!pass,detail});console.log(name,!!pass);if(!pass)throw new Error(name);};
const target=(await(await fetch('http://127.0.0.1:9223/json/list')).json()).find(t=>t.type==='page'&&t.url.includes('1420'));
const socket=new WebSocket(target.webSocketDebuggerUrl);await new Promise((r,j)=>{socket.onopen=r;socket.onerror=j;});
let seq=0;const pending=new Map();socket.onmessage=({data})=>{const m=JSON.parse(data);if(m.method==='Runtime.exceptionThrown')report.runtimeErrors.push(m.params);if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(m.error):p.resolve(m.result);}};
const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});
const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
const until=async(exp,label)=>{for(let i=0;i<300;i++){if(await evaluate(`!!(${exp})`))return;await wait(100);}throw new Error(label+': '+await evaluate('document.body.innerText'));};
const click=async text=>{await evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)}).click()`);await wait(80);};
const menu=async text=>{await evaluate(`document.querySelector('.project-menu').open=true;[...document.querySelectorAll('.project-menu button')].find(b=>b.textContent.startsWith(${JSON.stringify(text)})).click()`);await wait(80);};
const invoke=(name,args)=>evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(name)},${JSON.stringify(args)})`);
const setValue=(selector,value)=>evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(e.tagName==='SELECT'?HTMLSelectElement.prototype:e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
const screenshot=async name=>{const r=await send('Page.captureScreenshot',{format:'png'});await fs.writeFile(`.test-output/${name}.png`,Buffer.from(r.data,'base64'));};
const semantic=d=>{const v=structuredClone(d);delete v.projectId;delete v.revision;delete v.updatedAt;for(const m of v.media)delete m.sourceRef;return v;};
const hash=async p=>createHash('sha256').update(await fs.readFile(p)).digest('hex');
let currentId;
const snapshot=()=>invoke('get_project_snapshot',{projectId:currentId});
const openedPath=()=>evaluate(`document.querySelector('.project-identity').title`);
const dialogDone=()=>until(`document.querySelector('.exchange-result') && !document.querySelector('.exchange-progress')`,'exchange completion');
const exportUI=async(kind,file)=>{await menu('分享项目');await evaluate(`(async()=>{const {exchangeDialogs}=await import('/src/bridge/exchange.ts');exchangeDialogs.save=async()=>${JSON.stringify(file)};document.querySelector('input[aria-label="${kind==='bundle'?'完整项目包':'仅标注文件'}"]').click();})()`);await click('选择保存位置…');await dialogDone();await click('关闭');};
const importUI=async(file,parent=root)=>{await menu('导入分享文件');await evaluate(`(async()=>{const {exchangeDialogs}=await import('/src/bridge/exchange.ts');exchangeDialogs.source=async()=>${JSON.stringify(file)};exchangeDialogs.parent=async()=>${JSON.stringify(parent)};})()`);await click('选择交换文件…');};
try{
 await send('Runtime.enable');check('fresh native window',await evaluate('!!window.__TAURI_INTERNALS__ && innerWidth===1280 && innerHeight===800'));
 const created=await invoke('create_project',{path:original,name:'双文件交换验证'});currentId=created.snapshot.document.projectId;
 const files=['stereo24.wav','six.flac'].map(n=>path.resolve('tests/fixtures/audio',n));const hashes=await Promise.all(files.map(hash));
 for(const file of files){const descriptor=await evaluate(`(async()=>{const {mediaClient}=await import('/src/bridge/media.ts');return new Promise((resolve,reject)=>{mediaClient.start(${JSON.stringify(currentId)},[${JSON.stringify(file)}],e=>{if(e.type==='ready')resolve(e.media);if(e.type==='failed')reject(e.error);}).catch(reject);});})()`);const d=(await snapshot()).document;await invoke('apply_change',{projectId:currentId,expectedRevision:d.revision,change:{type:'importMedia',media:descriptor}});}
 let doc=(await snapshot()).document;const [a,b]=doc.media;const category={id:randomUUID(),name:'交接类别',color:'#eba66a'};const now='2026-10-22T00:00:00Z';
 const changes=[{type:'addCategory',category}];
 for(const [i,m] of doc.media.entries()){
  changes.push({type:'updateMediaNote',mediaId:m.id,note:`音频备注 ${i}`,mergeKey:null});
  for(let c=0;c<m.channelCount;c++)changes.push({type:'updateChannelNote',mediaId:m.id,channelIndex:c,note:`声道备注 ${i}/${c}`,mergeKey:null});
  const region={mediaId:m.id,channelIndex:m.channelCount-1,startSeconds:.02,endSeconds:.08,lowHz:200,highHz:2000};
  changes.push({type:'addAnnotation',annotation:{id:randomUUID(),region,categoryId:category.id,note:`区域备注 ${i}`,createdAt:now,updatedAt:now}},{type:'addEdit',edit:{id:randomUUID(),region,enabled:i===0,processingVersion:1}},{type:'updateAnalysis',mediaId:m.id,settings:{window:'hamming',windowSize:1024,hopSize:256,fftSize:2048,melBands:64}},{type:'updatePlaybackMix',mediaId:m.id,mix:{soloChannels:[m.channelCount-1],mutedChannels:[0]}});
 }
 const view=(m,i)=>({visibleChannels:[m.channelCount-1],startSeconds:.01,endSeconds:.09,lowHz:100,highHz:10000,frequencyMix:.65,spectrumKind:i?'mel':'stft',gainDb:3,dynamicRangeDb:70,palette:'magma'});
 changes.push({type:'updateViewState',viewState:{media:{[a.id]:view(a,0),[b.id]:view(b,1)},activeMediaId:a.id,compareMediaId:b.id,linkedTime:true}});
 for(const change of changes){doc=(await snapshot()).document;await invoke('apply_change',{projectId:currentId,expectedRevision:doc.revision,change});}
 doc=(await snapshot()).document;await invoke('save_project',{projectId:currentId,expectedRevision:doc.revision});await invoke('close_project',{projectId:currentId,expectedRevision:doc.revision,discard:false});
 await evaluate(`(async()=>{const {localProjects}=await import('/src/bridge/projects.ts');localProjects.choose=async()=>${JSON.stringify(original)};[...document.querySelectorAll('button')].find(b=>b.textContent==='打开项目').click();})()`);
 await until(`document.querySelectorAll('canvas').length>=2 && !document.querySelector('.tile-status')`,'source spectrum');
 // Block the actual recovery replacement, then recover through export on the SAME runtime.
 const recovery=path.join(original,'recovery.json'),heldRecovery=path.join(original,'held-recovery.json');
 const blockSave=async()=>{await fs.rename(recovery,heldRecovery);await fs.mkdir(recovery);};
 const restoreSave=async()=>{await fs.rmdir(recovery);await fs.rename(heldRecovery,recovery);};
 await blockSave();await click('保存Ctrl S');await until(`document.querySelector('.save-failed') && document.querySelector('.project-notice')`,'normal save failure');
 check('native normal Save failure is visible',await evaluate(`!!document.querySelector('.save-failed')`));await restoreSave();
 await exportUI('annotations',path.join(root,'after-save-failure.annotations.json'));
 check('successful export clears normal Save error and status without replacing project',(await snapshot()).document.projectId===currentId&&await evaluate(`!!document.querySelector('.save-saved')&&!document.querySelector('.project-notice')`));
 await blockSave();const retryExport=path.join(root,'retry.annotations.json');await menu('分享项目');await evaluate(`(async()=>{const {exchangeDialogs}=await import('/src/bridge/exchange.ts');exchangeDialogs.save=async()=>${JSON.stringify(retryExport)};})()`);await click('选择保存位置…');await until(`document.querySelector('.exchange-dialog [role="alert"]')`,'export save failure');
 check('export waits for a successful native save',!(await fs.stat(retryExport).catch(()=>null)));await restoreSave();await click('重试 · 选择保存位置…');await dialogDone();await click('关闭');
 check('successful export retry clears lifecycle failure on same project',(await snapshot()).document.projectId===currentId&&await evaluate(`!!document.querySelector('.save-saved')&&!document.querySelector('.project-notice')`));
 await click('备注');await setValue('textarea[aria-label="音频备注"]','尚未失焦的分享草稿');
 const json=path.join(root,'handoff.annotations.json'),zip=path.join(root,'handoff.audioproj.zip');
 await exportUI('annotations',json);doc=(await snapshot()).document;const manifest=JSON.parse(await fs.readFile(json,'utf8'));
 check('export flushes the pending note draft',manifest.media[0].note==='尚未失焦的分享草稿');
 check('portable JSON omits all local source paths',manifest.media.every(m=>m.mediaPath===null&&!('sourceRef' in m))&&!JSON.stringify(manifest).includes(path.resolve('.test-output')));
 check('single exported revision matches saved project',manifest.revision===doc.revision&&JSON.parse(await fs.readFile(path.join(original,'project.json'),'utf8')).revision===doc.revision);
 await exportUI('bundle',zip);check('complete local package exists',(await fs.stat(zip)).size>1000);
 // JSON import switches to an independent project, with all media intentionally missing.
 await importUI(json);await dialogDone();const jsonRoot=await openedPath();currentId=JSON.parse(await fs.readFile(path.join(jsonRoot,'project.json'),'utf8')).projectId;
 const jsonDoc=(await snapshot()).document;check('JSON import creates independent project identity',currentId!==doc.projectId&&jsonRoot!==original);
 check('JSON roundtrip preserves every semantic field',JSON.stringify(semantic(jsonDoc))===JSON.stringify(semantic(doc)));
 await screenshot('task10-import-result');await click('关闭');await until(`document.querySelector('.media-association')?.textContent.includes('2 个音频')`,'missing media association');
 check('JSON missing media is explicit and recoverable',(await invoke('media_status',{projectId:currentId})).every(m=>m.status==='missing'));
 // Mismatching original bytes are rejected by the actual decoder/fingerprint workflow.
 await click(`关联 ${a.displayName}`);await evaluate(`(async()=>{const {mediaDialogs}=await import('/src/bridge/media.ts');mediaDialogs.choose=async()=>${JSON.stringify(files[1])};})()`);await click('选择文件…');await until(`document.querySelector('.import-progress')?.textContent.includes('指纹')`,'mismatch');
 check('wrong fingerprint cannot bind annotations',(await snapshot()).document.media[0].sourceRef===jsonDoc.media[0].sourceRef);
 await click('关闭导入结果');
 for(let i=0;i<files.length;i++){const m=doc.media[i];await click(`关联 ${m.displayName}`);await evaluate(`(async()=>{const {mediaDialogs}=await import('/src/bridge/media.ts');mediaDialogs.choose=async()=>${JSON.stringify(files[i])};})()`);await click('选择文件…');await until(`document.querySelector('.import-progress')?.innerText.includes('导入完成 · 1 成功')`,'relink');await click('关闭导入结果');}
 await until(`!document.querySelector('.media-association')`,'relinked');check('relink retains notes and all annotation semantics',JSON.stringify(semantic((await snapshot()).document))===JSON.stringify(semantic(doc)));
 // Preserve runtime on a destination I/O failure, then retry from the same dialog.
 const configured=await invoke('playback_configure',{request:{projectId:currentId,mediaId:a.id,mode:{mode:'original'},bypass:false,looping:false,volume:.08,deviceId:null,seekSeconds:0,play:false}});await wait(300);
 const beforeStatus=await invoke('playback_status',{});const invalidParent=path.join(root,'not-a-directory');await fs.writeFile(invalidParent,'keep');
 await importUI(zip,invalidParent);await until(`document.querySelector('.exchange-dialog [role="alert"]')`,'failed import');
 check('disk error preserves current native project and playback generation',(await snapshot()).document.projectId===currentId&&(await invoke('playback_status',{})).generation===beforeStatus.generation);
 check('failed import does not alter other destination files',await fs.readFile(invalidParent,'utf8')==='keep');
 await evaluate(`(async()=>{const {exchangeDialogs}=await import('/src/bridge/exchange.ts');exchangeDialogs.parent=async()=>${JSON.stringify(root)};})()`);await click('重试 · 选择交换文件…');await dialogDone();
 const bundleRoot=await openedPath();const bundleDoc=JSON.parse(await fs.readFile(path.join(bundleRoot,'project.json'),'utf8'));currentId=bundleDoc.projectId;
 check('ZIP import creates a third independent identity',bundleDoc.projectId!==doc.projectId&&bundleDoc.projectId!==jsonDoc.projectId);
 check('ZIP roundtrip preserves all semantic data',JSON.stringify(semantic(bundleDoc))===JSON.stringify(semantic(doc)));
 check('successful project handoff resets native playback',(await invoke('playback_status',{})).mediaId===null);
 check('bundle uses ID-named relative paths',bundleDoc.media.every(m=>m.sourceRef===`media/${m.id}`));
 check('copied media bytes are identical',JSON.stringify(await Promise.all(bundleDoc.media.map(m=>hash(path.join(bundleRoot,m.sourceRef)))))===JSON.stringify(hashes));
 check('published project excludes caches backup and recovery',JSON.stringify((await fs.readdir(bundleRoot)).filter(n=>n!=='.project.lock').sort())===JSON.stringify(['media','project.json']));
 await click('关闭');await until(`document.querySelectorAll('canvas').length>=2 && !document.querySelector('.tile-status')`,'bundle spectrum');
 check('bundle relative media rehydrates for real analysis',(await invoke('media_status',{projectId:currentId})).every(s=>s.status==='ready'));
 await screenshot('task10-bundle-1280x800');check('five-zone layout has no horizontal overflow',await evaluate('document.documentElement.scrollWidth<=innerWidth'));
 await click('保存Ctrl S');await menu('关闭项目');await until(`document.querySelector('.project-identity')?.innerText.includes('尚未打开项目')`,'close bundle');
 await evaluate(`(async()=>{const {localProjects}=await import('/src/bridge/projects.ts');localProjects.choose=async()=>${JSON.stringify(bundleRoot)};[...document.querySelectorAll('button')].find(b=>b.textContent==='打开项目').click();})()`);await until(`document.querySelectorAll('canvas').length>=2 && !document.querySelector('.tile-status')`,'reopen bundle');
 check('saved imported project reopens with identical semantics',JSON.stringify(semantic((await snapshot()).document))===JSON.stringify(semantic(doc)));
 const rebound=path.join(root,'reexport.audioproj.zip');await exportUI('bundle',rebound);check('bundle can be reexported from relative sources',(await fs.stat(rebound)).size>1000);
 const saveAs=path.join(root,'save-as');await fs.mkdir(saveAs);await evaluate(`(async()=>{const {localProjects}=await import('/src/bridge/projects.ts');localProjects.choose=async()=>${JSON.stringify(saveAs)};})()`);await menu('项目另存为');await until(`document.querySelector('.project-identity')?.title.endsWith('save-as')`,'save as');
 const rebased=(await snapshot()).document;check('Save As rebases imported relative paths to their original project',rebased.media.every((m,i)=>path.isAbsolute(m.sourceRef)&&m.sourceRef.endsWith(bundleDoc.media[i].id)&&m.sourceRef.includes(path.basename(bundleRoot))));
 check('rebasing retains every semantic field',JSON.stringify(semantic(rebased))===JSON.stringify(semantic(doc)));
 const rebasedZip=path.join(root,'rebased.audioproj.zip');await exportUI('bundle',rebasedZip);check('rebased imported media can be shared again',(await fs.stat(rebasedZip)).size>1000);
 check('original source fingerprints unchanged',JSON.stringify(await Promise.all(files.map(hash)))===JSON.stringify(hashes));
 check('no owned staging directories remain',!(await fs.readdir(root)).some(n=>n.startsWith('.exchange-')));
 check('no uncaught WebView runtime errors',report.runtimeErrors.length===0,report.runtimeErrors);
 report.passed=true;report.bundleRoot=bundleRoot;report.sourceSemantics=semantic(doc);await fs.writeFile('.test-output/task10-restart-target.json',JSON.stringify({bundleRoot,projectId:currentId,semantics:semantic(doc)}));
 await menu('关闭项目');await until(`document.querySelector('.project-identity')?.innerText.includes('尚未打开项目')`,'final close');
}catch(error){report.error=String(error);console.error(error);process.exitCode=1;await screenshot('task10-failure').catch(()=>{});}finally{await fs.writeFile('.test-output/task10-native-report.json',JSON.stringify(report,null,2));socket.close();}
