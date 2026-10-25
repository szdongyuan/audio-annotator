import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { coordinates } from '../../src/features/spectrogram/coordinates.ts';
import { paletteLut } from '../../src/features/spectrogram/palette.ts';
import { start, wait } from './harness.mjs';
const baseline=process.argv.includes('--baseline');
const output=path.resolve(process.env.ANNOTATOR_FIDELITY_OUTPUT ?? '.test-output/fidelity-task1',baseline?'baseline':'native');await fs.mkdir(output,{recursive:true});
// Deterministic six-channel PCM: close tones, chirp and short broad-band pulse.
const rate=48000,seconds=4,channels=6,frames=rate*seconds;
const wave=Buffer.alloc(44+frames*channels*2);wave.write('RIFF');wave.writeUInt32LE(wave.length-8,4);wave.write('WAVEfmt ',8);wave.writeUInt32LE(16,16);wave.writeUInt16LE(1,20);wave.writeUInt16LE(channels,22);wave.writeUInt32LE(rate,24);wave.writeUInt32LE(rate*channels*2,28);wave.writeUInt16LE(channels*2,32);wave.writeUInt16LE(16,34);wave.write('data',36);wave.writeUInt32LE(wave.length-44,40);
for(let f=0;f<frames;f++){const t=f/rate;for(let c=0;c<channels;c++){const value=.12*Math.sin(2*Math.PI*(1000+c*180)*t)+.10*Math.sin(2*Math.PI*(1125+c*180)*t)+.08*Math.sin(2*Math.PI*(300*t+900*t*t/2))+(Math.abs(t-2)<.001?.3*Math.sin(2*Math.PI*8700*t):0);wave.writeInt16LE(Math.round(value*32767),44+(f*channels+c)*2);}}
const audio=path.join(output,'multitone-chirp-pulse.wav'),second=path.join(output,'second-six.wav');await fs.writeFile(audio,wave);await fs.writeFile(second,wave);
const project=await fs.mkdtemp(path.join(output,'project-'));const report={baseline,fixture:'Synthetic 48kHz, 4s, six channels; unchanged default analysis/palette/gain. Not user audio.',checks:[]};let h;
try{
 h=await start({'新建项目 · 选择空文件夹':[project],'':[[audio,second]]},output,undefined,{exactOuter:true});
 await h.menu('新建项目');await h.until(`document.querySelector('.project-identity')?.textContent.match(/已保存|已存本机/)`);
 await h.clickText('导入音频');await h.until(`document.querySelector('.import-progress')?.textContent.includes('导入完成')`);await h.clickText('关闭导入结果');await h.selectMedia('multitone-chirp-pulse.wav');await h.until(`document.querySelectorAll('canvas').length===2&&!document.querySelector('.tile-status')`);
 for(const [width,height] of [[1280,800],[1920,1080]]){h.nativeRect({width,height});await wait(500);await h.until(`!document.querySelector('.tile-status')`);const metrics=await h.evaluate(`return [...document.querySelectorAll('canvas')].map(c=>{const r=c.getBoundingClientRect();return {css:[r.width,r.height],backing:[c.width,c.height],dpr:devicePixelRatio}})`);report.checks.push({outer:h.nativeRect(),metrics});await h.screenshot(`outer${width}x${height}`);}

 if(!baseline){
  const projectId=JSON.parse(await fs.readFile(path.join(project,'collaboration.json'),'utf8')).projectId;
  const document=(await h.snapshot(projectId)).document,media=document.media.find(m=>m.displayName==='multitone-chirp-pulse.wav'),settings=document.analysis[media.id];
  const view={startSeconds:0,endSeconds:4,lowHz:0,highHz:24000,frequencyMix:.65,spectrumKind:'stft',palette:'ember',gainDb:0,dynamicRangeDb:100};
  report.analysis=settings;
  const targets=await(await fetch('http://127.0.0.1:9235/json/list')).json(),page=targets.find(t=>t.type==='page');const ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener('open',r,{once:true}));let sequence=0;
  const cdp=(method,params)=>new Promise((resolve,reject)=>{const id=++sequence;const listener=e=>{const m=JSON.parse(e.data);if(m.id===id){ws.removeEventListener('message',listener);m.error?reject(Error(JSON.stringify(m.error))):resolve(m.result);}};ws.addEventListener('message',listener);ws.send(JSON.stringify({id,method,params}));});
  const density=async(dpr,width,height)=>{await cdp('Emulation.clearDeviceMetricsOverride',{});h.nativeRect({width,height});const outer=h.nativeRect();assert.equal(outer.width,width);assert.equal(outer.height,height);await wait(200);const inner=await h.evaluate('return [innerWidth,innerHeight]');await cdp('Emulation.setDeviceMetricsOverride',{width:inner[0],height:inner[1],deviceScaleFactor:dpr,mobile:false});await wait(250);await h.until(`!document.querySelector('.tile-status')`);};
  const measure=async name=>{
   await h.until(`!document.querySelector('.tile-status')`);await wait(150);
   const m=await h.evaluate(`return {dpr:devicePixelRatio,inner:[innerWidth,innerHeight],plots:[...document.querySelectorAll('canvas')].map(c=>{const r=c.getBoundingClientRect(),clip=c.closest('.channel-scroll').getBoundingClientRect();let nonblack=0;if(c.width&&c.height){const a=c.getContext('2d').getImageData(0,0,c.width,c.height).data;for(let i=0;i<a.length;i+=4)if(a[i]||a[i+1]||a[i+2])nonblack++;}return {css:[r.width,r.height],backing:[c.width,c.height],visible:r.bottom>clip.top&&r.top<clip.bottom,nonblack};})}`);
   for(const p of m.plots){if(p.visible){assert.ok(Math.abs(p.backing[0]-p.css[0]*m.dpr)<=1,JSON.stringify(p));assert.ok(Math.abs(p.backing[1]-p.css[1]*m.dpr)<=1,JSON.stringify(p));assert.ok(p.nonblack>0,'visible plot is not black');}else assert.deepEqual(p.backing,[0,0],'offscreen backing released');}
   m.retainedBytes=m.plots.reduce((n,p)=>n+p.backing[0]*p.backing[1]*4,0);m.scratchUpperBound=Math.max(...m.plots.map(p=>Math.min(64,p.backing[0])*p.backing[1]*4));assert.ok(m.retainedBytes+m.scratchUpperBound<=32*1024*1024);
   report.checks.push({name,outer:h.nativeRect(),...m});console.log('PASS '+name);await h.screenshot(name);return m;
  };
  for(const [width,height] of [[1280,800],[1920,1080]])for(const dpr of [1,1.25,2]){await density(dpr,width,height);await measure(`stereo-${width}-dpr${dpr}`);}
  // The large ordinary single-channel case requires strip scratch: two full RGBA copies would exceed 32MiB.
  await h.label('显示通道 2');await h.label('收起属性面板');await h.label('收起音频列表');await density(2,1920,1080);const expanded=await measure('single-expanded-1920-dpr2');
  assert.ok(expanded.plots[0].css[0]>1700&&expanded.plots[0].css[1]>800);
  // Independently request unchanged native numeric tiles, then verify actual displayed colors at physical pixel centers.
  const dimensions=expanded.plots[0].backing,c=coordinates(view,24000,...dimensions);
  const points=[];for(const t of [.25,1.99,256*512/48000-.003,256*512/48000+.003,3.99])for(const hz of [250,1000,1125,8000]){const x=Math.floor(c.secondsToX(t)),y=Math.floor(c.hzToY(hz));points.push({x,y,seconds:c.xToSeconds(x+.5),hz:c.yToHz(y+.5)});}
  const reference=await h.driver.executeAsyncScript(`const [projectId,mediaId,settings,points,done]=arguments;
   (async()=>{const api=window.__TAURI_INTERNALS__,runtimeNonce=(await api.invoke('collaboration_status')).runtimeNonce,viewId=await api.invoke('register_analysis_view',{projectId,runtimeNonce}),callback=api.transformCallback(()=>{});try{
    const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(['analysis-v1',settings.window,settings.windowSize,settings.hopSize,settings.fftSize,settings.melBands].join('|')))),x=>x.toString(16).padStart(2,'0')).join('');
    const tiles=[];for(const startFrame of [0,256]){const request={requestId:crypto.randomUUID(),viewId,projectId,mediaId,generation:1,analysisSource:'original',processingVersion:1,editSignature:'',configHash:hash,settings,channelIndex:0,kind:'stft',startFrame,frameCount:Math.min(256,375-startFrame),timeLod:0,frequencyStart:0,frequencyCount:1025,frequencyLod:0,visible:true};const buffer=await api.invoke('request_tile',{runtimeNonce,request,onEvent:'__CHANNEL__:'+callback});const length=new DataView(buffer).getUint32(4,true),offset=Math.ceil((8+length)/4)*4;tiles.push(new Float32Array(buffer,offset));}
    const value=(frame,bin)=>10**(tiles[frame<256?0:1][(frame%256)*1025+bin]/10),canvas=document.querySelector('canvas'),ctx=canvas.getContext('2d');
    return points.map(p=>{const f=p.seconds*48000/settings.hopSize,b=p.hz*settings.fftSize/48000,f0=Math.min(374,Math.floor(f)),f1=Math.min(374,f0+1),b0=Math.floor(b),b1=Math.min(1024,b0+1),u=f0===f1?0:f-f0,v=b-b0;const power=(value(f0,b0)*(1-v)+value(f0,b1)*v)*(1-u)+(value(f1,b0)*(1-v)+value(f1,b1)*v)*u;return {...p,db:10*Math.log10(Math.max(1e-16,power)),rgba:Array.from(ctx.getImageData(p.x,p.y,1,1).data)};});
   }finally{await api.invoke('retire_analysis_view',{projectId,viewId,runtimeNonce});api.unregisterCallback(callback);}})().then(done,e=>done({error:String(e)}));`,projectId,media.id,settings,points);
  assert.ok(!reference.error,JSON.stringify(reference));const lut=paletteLut('ember');let maxColorError=0;for(const p of reference){const index=Math.round(Math.max(0,Math.min(1,(p.db+100)/100))*255)*4;maxColorError=Math.max(maxColorError,...p.rgba.map((v,k)=>Math.abs(v-lut[index+k])));}assert.equal(maxColorError,0);report.checks.push({name:'native numeric reference at physical centers, pulse, tile seam and tail',maxColorError,points:reference});
  await h.label('展开属性面板');
  // Real pointer annotation and ruler positions share the same seconds/Hz mapping.
  await h.drag('.annotation-overlay',[.2,.25],[.6,.7]);await h.context('.annotation-overlay',[.4,.45]);await h.label('标注类型');await h.clickText('未分类');await h.until(`document.querySelector('.annotation-inspector')`);
  const annotation=(await h.snapshot(projectId)).document.annotations[0];
  const alignment=await h.evaluate(`const p=document.querySelector('.annotation-overlay').getBoundingClientRect(),r=document.querySelector('[data-annotation-id="'+arguments[0]+'"]').getBoundingClientRect();return {width:p.width,height:p.height,left:r.left-p.left,top:r.top-p.top,rectWidth:r.width,rectHeight:r.height,ticks:[...document.querySelectorAll('.file-pane:first-child [data-tick]')].map(t=>({time:t.closest('.time-ruler')!==null,value:+t.dataset.value,pixel:parseFloat(t.style.left||t.style.top)}))}`,annotation.id);
  const map=coordinates(view,24000,alignment.width,alignment.height),region=annotation.region;const errors=[Math.abs(alignment.left-map.secondsToX(region.startSeconds)),Math.abs(alignment.top-map.hzToY(region.highHz)),Math.abs(alignment.rectWidth-(map.secondsToX(region.endSeconds)-map.secondsToX(region.startSeconds))),Math.abs(alignment.rectHeight-(map.hzToY(region.lowHz)-map.hzToY(region.highHz))),...alignment.ticks.map(t=>Math.abs(t.pixel-(t.time?map.secondsToX(t.value):map.hzToY(t.value))))];assert.ok(Math.max(...errors)<=.5);report.checks.push({name:'physical annotation and tick alignment',maxCssError:Math.max(...errors),annotation});
  await h.label('展开音频列表');await h.label('显示通道 2');await h.clickText('双文件对比');await h.until(`document.querySelectorAll('.file-pane').length===2&&!document.querySelector('.tile-status')`);
  for(const [width,height] of [[1280,800],[1920,1080]])for(const dpr of [1,1.25,2]){await density(dpr,width,height);await measure(`dual-${width}-dpr${dpr}`);}
  for(const pane of ['.file-pane:first-child','.file-pane:last-child'])await h.click(pane+' .channel-select button');await h.until(`document.querySelectorAll('canvas').length===12&&!document.querySelector('.tile-status')`);
  for(const [width,height] of [[1280,800],[1920,1080]]){await density(2,width,height);for(const top of [0,99999,0]){await h.evaluate(`for(const e of document.querySelectorAll('.channel-scroll'))e.scrollTop=arguments[0]`,top);await wait(300);await measure(`six-plus-six-${width}-${top?'bottom':'top'}-dpr2`);}}
  await cdp('Emulation.clearDeviceMetricsOverride',{});ws.close();report.dpi='DPR1/1.25/2 use isolated owned WebView CDP emulation; Windows system DPI unchanged and not claimed.';
 }
 report.passed=true;
}catch(error){report.error=error.stack;process.exitCode=1;await h?.screenshot('failure').catch(()=>{});}finally{await h?.quit();await fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
