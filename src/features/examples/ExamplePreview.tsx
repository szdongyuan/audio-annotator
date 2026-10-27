import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { exampleClient, type ExampleBinding, type ExampleEntry, type PreviewResult } from '../../bridge/examples';
import { playbackClient } from '../../bridge/playback';
import type { MediaView } from '../../bridge/types';
import { ProjectStore } from '../../app/store';
import { CommandQueue, type ProjectCommands } from '../../app/commands';
import type { RuntimeCommands } from '../../bridge/runtime';
import { ProjectLifecycle } from '../project/lifecycle';
import type { ActiveProject } from '../project/useProjectLifecycle';
import type { PlaybackUI } from '../playback/usePlayback';
import { MediaDialog } from '../media/MediaDialog';
import { SelectionContext } from '../selection/useSelection';
import { SpectrogramCanvas } from '../spectrogram/SpectrogramCanvas';
import { AxisRulers } from '../spectrogram/AxisRulers';
import { ColorScale } from '../spectrogram/ColorScale';
import { frequencyRulerWidth } from '../spectrogram/ticks';
import { defaultSettings, defaultView, duration } from '../spectrogram/workspace';
import { zoomViewport } from '../spectrogram/viewport';
import { useLocalSettings } from '../settings/localSettings';
import { ExamplePreviewSession } from './preview';

const readonlyError={code:'InvalidInput' as const,message:'示例预览只读',retryable:false};
/** Only Canvas uses this adapter. No ordinary project/media commands are reachable. */
export function previewProject(result:PreviewResult,binding:ExampleBinding):ActiveProject {
 const store=new ProjectStore(result.snapshot);
 const deny=async()=>{throw readonlyError;};
 const queue=new CommandQueue(store,{applyChange:deny,getSnapshot:deny,undo:deny,redo:deny} satisfies ProjectCommands);
 const lifecycle=new ProjectLifecycle(store,queue,{save:deny,close:deny});
 const forbidden=<T extends object>():T=>new Proxy({} as T,{get:(target,key)=>Reflect.get(target,key)??deny});
 const commands:RuntimeCommands={project:forbidden(),projects:forbidden(),folders:forbidden(),sources:forbidden(),playback:forbidden(),
  tiles:exampleClient.tiles(binding,result.previewId),media:Object.assign(forbidden<RuntimeCommands['media']>(),{status:()=>exampleClient.status(binding,result.previewId)})};
 return{store,queue,lifecycle,path:'',commands};
}
export function ExamplePreview({binding,entry,autoplay=false,playback,returnFocus,onClose}:{binding:ExampleBinding;entry:ExampleEntry;autoplay?:boolean;playback:PlaybackUI;returnFocus?:HTMLElement|null;onClose:()=>void}){
 const local=useLocalSettings();
 const [session]=useState(()=>new ExamplePreviewSession(binding));useSyncExternalStore(session.subscribe,session.getVersion);
 const latest=useRef(playback);latest.current=playback;
 const settings=useRef(local?.value.analysis??defaultSettings);
 const playSettings=()=>({monitorGainDb:local?.value.playback.monitorGainDb??latest.current.monitor.monitorGainDb,volume:latest.current.options.volume,deviceId:latest.current.options.deviceId,looping:latest.current.options.looping});
 const settingsRef=useRef(playSettings);settingsRef.current=playSettings;
 useEffect(()=>{session.start();void session.open(entry,settings.current,()=>latest.current.stopAndWait()).then(result=>{if(autoplay&&result&&session.result===result)void session.play(settingsRef.current(),0);});return()=>session.dispose();},[session]);
 useEffect(()=>{if(!playbackClient.available())return;let disposed=false,unlisten:(()=>void)|undefined;void playbackClient.listen(s=>{if(!disposed)session.progress(s);}).then(fn=>{if(disposed)fn();else unlisten=fn;}).catch(()=>{if(!disposed)session.reportError('无法接收播放进度');});return()=>{disposed=true;unlisten?.();};},[session]);
 const result=session.result;
 return <MediaDialog title={`示例频谱：${entry.name}`} returnFocus={returnFocus} onClose={onClose}>
  <div className="example-preview"><header><h2 title={entry.name}>{entry.name}</h2><span>只读 · 原音</span><button className="button" onClick={onClose}>关闭示例</button></header>
   {session.loading&&<p role="status">正在打开示例…</p>}
   {session.error&&<p role="alert" className="example-error">{session.error}{!result&&<button className="button" onClick={()=>void session.open(entry,settings.current,()=>latest.current.stopAndWait())}>重试打开示例</button>}</p>}
   {result&&<PreviewSpectrum key={result.previewId} result={result} binding={binding} display={local?.value.display??{}} position={session.status.positionSeconds}/>}
   {result&&<div className="example-audition" role="toolbar" aria-label="示例播放控制">
    <button className="button" aria-label={session.wantsPlayback?'暂停示例':'播放示例原音'} onClick={()=>void (session.wantsPlayback?session.pause():session.play(playSettings()))}>{session.wantsPlayback?'暂停':'播放原音'}</button>
    <button className="button" onClick={()=>void session.stop()}>停止示例</button>
    <input type="range" aria-label="示例播放位置" min={0} max={duration(result.snapshot.document.media[0])} step=".001" value={session.status.positionSeconds} onChange={e=>void session.seek(playSettings(),Number(e.target.value))}/>
    <span>{session.status.positionSeconds.toFixed(2)} / {duration(result.snapshot.document.media[0]).toFixed(2)} 秒</span>
    <small role="status">{({stopped:'已停止',buffering:'准备音频…',playing:'播放中',paused:'已暂停',ended:'播放结束',error:'输出失败'} as const)[session.status.state]}</small>
   </div>}
  </div>
 </MediaDialog>;
}
function PreviewSpectrum({result,binding,display,position}:{result:PreviewResult;binding:ExampleBinding;display:Partial<MediaView>;position:number}){
 const [active,setActive]=useState<ActiveProject|null>(null);
 useEffect(()=>{
  const owner=previewProject(result,binding);setActive(owner);
  return()=>owner.lifecycle.dispose();
 },[result,binding.runtimeNonce,binding.projectId]);
 const media=result.snapshot.document.media[0],settings=result.snapshot.document.analysis[media.id]??defaultSettings;
 const [channel,setChannel]=useState(0),[view,setView]=useState<MediaView>(()=>({...defaultView(media),...display}));
 const patch=(p:Partial<MediaView>)=>setView(v=>({...v,...p}));const limit=duration(media);
 const ratio=(position-view.startSeconds)/(view.endSeconds-view.startSeconds);
 if(!active)return <p role="status">正在准备频谱…</p>;
 return <SelectionContext.Provider value={null}><div className="example-view-tools"><label>通道<select aria-label="示例通道" value={channel} onChange={e=>setChannel(Number(e.target.value))}>{Array.from({length:Math.min(6,media.channelCount)},(_,i)=><option key={i} value={i}>通道 {i+1}</option>)}</select></label><button className="button" onClick={()=>patch(zoomViewport(view,limit,media.sampleRate/2,'time',.5,.5))}>放大时间</button><button className="button" onClick={()=>patch(zoomViewport(view,limit,media.sampleRate/2,'time',.5,2))}>缩小时间</button><button className="button" onClick={()=>patch({startSeconds:0,endSeconds:limit,lowHz:0,highHz:media.sampleRate/2})}>重置示例视图</button></div>
  <section className="channel-pane example-spectrum" style={{'--frequency-ruler-width':`${frequencyRulerWidth(view)}px`} as CSSProperties} aria-label="示例频谱视图"><div className="channel-graph"><AxisRulers owner={active} view={view} nyquist={media.sampleRate/2} timeLimit={limit} onView={patch}/><SpectrogramCanvas active={active} media={media} settings={settings} view={view} channel={channel} status="unverified" timeLimit={limit} onView={patch} analysisSource="original">{ratio>=0&&ratio<=1&&<span className="example-playhead" style={{left:`${ratio*100}%`}}/>}</SpectrogramCanvas><ColorScale view={view}/></div></section>
 </SelectionContext.Provider>;
}
