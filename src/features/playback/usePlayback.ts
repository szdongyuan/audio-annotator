import { createContext,useContext,useEffect,useRef,useState } from 'react';
import { emptyPlayback,playbackClient,validMonitorGain,type PlaybackOptions,type PlaybackStatus,type OutputDevice } from '../../bridge/playback';
import type { ProjectDocument,Region,PlaybackMix,AppError } from '../../bridge/types';
import { normalizeError } from '../../bridge/client';
import type { ActiveProject } from '../project/useProjectLifecycle';
import { menuIsOpen } from '../../components/menu/menuModel';
import { resolveIntent, type PlaybackIntent, type WorkspaceSoundVersion } from './playbackIntent';
import { validRegion } from '../selection/state';
import { useLocalSettings } from '../settings/localSettings';
export function audioSignature(doc:ProjectDocument|undefined,id:string|null){const m=doc?.media.find(m=>m.id===id);return JSON.stringify(m&&[m.id,m.sha256,m.sourceRef,m.sampleRate,m.frameCount,m.channelCount,doc?.edits.filter(e=>e.region.mediaId===id),doc?.playbackMix[m.id]]);}
export function actualSource(mode:PlaybackOptions['mode'],source:PlaybackOptions['selectionSource'],bypass:boolean){return mode==='selection'?(source==='original'||bypass?'原始选区':'处理后选区'):mode==='original'||bypass?'原音':'处理后';}
export function playbackShortcut(e:{key:string;target:EventTarget|null;ctrlKey?:boolean;metaKey?:boolean;altKey?:boolean}){return !menuIsOpen()&&e.key===' '&&!e.ctrlKey&&!e.metaKey&&!e.altKey&&!(e.target instanceof Element&&(e.target.closest('input,textarea,select,[role="dialog"],[role="alertdialog"],[contenteditable]:not([contenteditable="false"])') || e.target.closest('button') && !e.target.closest('button.media-select[data-media-id]')));}
type MonitorState={monitorGainDb:number;mediaMonitorGainDb:Record<string,number|null>};
type PlaybackApi=Omit<typeof playbackClient,'monitorGain'> & Partial<Pick<typeof playbackClient,'monitorGain'>>;
export function usePlayback(active:ActiveProject|null,selectedMediaId:string|null,selection:Region|undefined,injectedApi:PlaybackApi=playbackClient){
 const local=useLocalSettings(),localRef=useRef(local);localRef.current=local;
 const api=active?.commands?.playback??injectedApi;
 const [sourceId,setSourceId]=useState(selectedMediaId),[options,setOptions]=useState<PlaybackOptions>({mode:'processed',selectionSource:'processed',bypass:false,looping:false,volume:.75,deviceId:null});
 const [status,setStatus]=useState<PlaybackStatus>(emptyPlayback),[devices,setDevices]=useState<OutputDevice[]>([]),[error,setError]=useState<AppError|null>(null);
 const [playing,setPlaying]=useState(false);
 const [monitor,setMonitor]=useState<MonitorState>({monitorGainDb:0,mediaMonitorGainDb:{}});
 const [monitorError,setMonitorError]=useState<AppError|null>(null);
 const monitorRef=useRef(monitor),statusRef=useRef(status);
 const effectiveMonitor=(id:string|null)=>{const settings=localRef.current,global=settings?.value.playback.monitorGainDb,projectId=active?.store.snapshot.document.projectId;if(global!==undefined)return id&&projectId?settings!.override(projectId,id).monitorGainDb??global:global;return id?(monitorRef.current.mediaMonitorGainDb[id]??monitorRef.current.monitorGainDb):monitorRef.current.monitorGainDb;};
 const [workspaceSource,setWorkspaceSource]=useState<WorkspaceSoundVersion>('processed');
 const [cues,setCues]=useState<Record<string,number>>({});
 const intent=useRef<PlaybackIntent>({kind:'automatic'}),resumable=useRef(false);
 const cueDeactivation=useRef(false);
 const acceptedGeneration=useRef(0);
 const pendingIntent=useRef<{serial:number;event:PlaybackStatus|null}|null>(null);
 const configuredKey=useRef('');
 const desired=useRef(false),activated=useRef(false),sequence=useRef(0),tail=useRef<Promise<unknown>>(Promise.resolve()),current=useRef({active,sourceId,selection,options,workspaceSource});current.current={active,sourceId,selection,options,workspaceSource};
 const resolved=()=>{const n=current.current;return resolveIntent(intent.current,n.sourceId,n.selection,n.workspaceSource);};
 const configurationKey=()=>{const n=current.current;return JSON.stringify([audioSignature(n.active?.store.snapshot.document,resolved().mediaId),n.options,resolved()]);};
 const clearIntent=()=>{intent.current={kind:'automatic'};resumable.current=false;activated.current=false;configuredKey.current='';};
 const setDesired=(value:boolean)=>{desired.current=value;setPlaying(value);};
 const matchesSource=(s:PlaybackStatus)=>s.generation>=acceptedGeneration.current&&(!s.projectId||s.projectId===current.current.active?.store.snapshot.document.projectId)&&(!s.mediaId||s.mediaId===current.current.sourceId);
 const accept=(s:PlaybackStatus)=>{
   if(!matchesSource(s))return;
   acceptedGeneration.current=s.generation;statusRef.current=s;setStatus(s);
   if(s.state==='ended'||s.state==='error'){setDesired(false);clearIntent();}
   if(s.error)setError(s.error);
 };
 // Until a command acknowledges its generation, events cannot identify which
 // control intent they belong to. Keep only the latest event, without changing intent.
 const progress=(s:PlaybackStatus)=>{
   if(!matchesSource(s))return;
   const pending=pendingIntent.current;
   if(pending){if(!pending.event||s.generation>=pending.event.generation)pending.event=s;return;}
   accept(s);
 };
 const acknowledge=(serial:number,s:PlaybackStatus,replayProgress:boolean)=>{
   if(serial!==sequence.current)return;
   const event=pendingIntent.current?.serial===serial?pendingIntent.current.event:null;pendingIntent.current=null;
   accept(s);
   // A configure returns its initial buffering snapshot. Its worker may already
   // have emitted playing/end/error; replay only events for that new generation.
   // A pause/stop response instead acknowledges the user's latest control state.
   if(replayProgress&&event&&event.generation>=s.generation)accept(event);
 };
 const rejectIntent=(serial:number,cause:unknown)=>{
   if(serial!==sequence.current)return;
   pendingIntent.current=null;setDesired(false);
   const failure=normalizeError(cause);setError(failure);setStatus(s=>({...s,state:'error',error:failure}));
 };
 const refreshDevices=()=>{if(api.available())void api.devices().then(setDevices).catch(e=>setError(normalizeError(e)));};
 const configure=(seekSeconds:number|null=null)=>{
   const now=current.current,r=resolved();if(now.active!==active||!now.active||!r.mediaId||now.active.store.editingDisabled)return;
   const doc=now.active.store.snapshot.document,media=doc.media.find(m=>m.id===r.mediaId);
   if(!media||r.region&&!validRegion(doc,r.region))return;
   if(now.sourceId!==r.mediaId){current.current={...now,sourceId:r.mediaId};setSourceId(r.mediaId);}
   const serial=++sequence.current;pendingIntent.current={serial,event:null};activated.current=true;resumable.current=true;setError(null);
   configuredKey.current=configurationKey();
   const request={projectId:doc.projectId,mediaId:r.mediaId,mode:r.region?{mode:'selection' as const,region:r.region,selectionSource:r.source}:{mode:r.source},bypass:false,looping:now.options.looping,volume:now.options.volume,deviceId:now.options.deviceId,seekSeconds,play:desired.current,monitorGainDb:effectiveMonitor(r.mediaId)};
   const owner=now.active,capturedApi=api;
   tail.current=tail.current.catch(()=>{}).then(async()=>{if(serial!==sequence.current||current.current.active!==owner)return;const result=await capturedApi.configure({...request,monitorGainDb:effectiveMonitor(request.mediaId)});if(current.current.active===owner)acknowledge(serial,result,true);}).catch(e=>{if(current.current.active===owner)rejectIntent(serial,e);});
 };
 const control=(action:'pause'|'stop'|'reset')=>{const capturedApi=api,owner=active;if(current.current.active!==owner)return;setDesired(false);const serial=++sequence.current;pendingIntent.current={serial,event:null};if(action!=='pause')clearIntent();tail.current=tail.current.catch(()=>{}).then(async()=>{if(current.current.active!==owner)return;const result=await capturedApi.control(action);if(current.current.active===owner)acknowledge(serial,result,false);}).catch(e=>{if(current.current.active===owner)rejectIntent(serial,e);});};
 const selectSource=(id:string|null)=>{if(current.current.active!==active||id===current.current.sourceId)return;control('reset');current.current={...current.current,sourceId:id};setSourceId(id);setStatus(emptyPlayback);};
 const startIntent=(next:PlaybackIntent)=>{if(current.current.active!==active)return;if(activated.current)control('stop');intent.current=next;setDesired(true);configure(resolved().start);};
 const playSelection=(region:Region,sourceOverride?:WorkspaceSoundVersion)=>{
   const owner=current.current.active;if(!owner||owner.store.editingDisabled||!validRegion(owner.store.snapshot.document,region))return;
   startIntent({kind:'explicit-selection',region:{...region},sourceOverride});
 };
 const playFile=()=>{const id=current.current.sourceId;if(id)startIntent({kind:'explicit-file',mediaId:id});};
 const validCue=(owner:ActiveProject,id:string,seconds:number)=>{const m=owner.store.snapshot.document.media.find(m=>m.id===id);return owner===current.current.active&&!owner.store.editingDisabled&&!!m&&Number.isFinite(seconds)&&seconds>=0&&seconds*m.sampleRate<m.frameCount;};
 const playFrom=(owner:ActiveProject,id:string,seconds:number)=>{if(validCue(owner,id,seconds))startIntent({kind:'explicit-cue',mediaId:id,seconds});};
 const setCue=(owner:ActiveProject,id:string,seconds:number)=>{if(owner===current.current.active&&!owner.store.editingDisabled&&owner.store.snapshot.document.media.some(m=>m.id===id)&&Number.isFinite(seconds)&&seconds>=0){setCues(c=>({...c,[id]:seconds}));resumable.current=false;if(desired.current&&current.current.selection)cueDeactivation.current=true;if(!desired.current)intent.current={kind:'automatic'};}};
 useEffect(()=>{clearIntent();const prefs=active?.collaboration?.preferences;
 const restoredMonitor={monitorGainDb:prefs?.monitorGainDb??0,mediaMonitorGainDb:{...prefs?.mediaMonitorGainDb}};monitorRef.current=restoredMonitor;setMonitor(restoredMonitor);setMonitorError(null);statusRef.current=emptyPlayback;const source=prefs?.source??'processed';const restored={mode:'processed' as const,selectionSource:'processed' as const,bypass:false,volume:prefs?.volume??.75,deviceId:prefs?.deviceId??null,looping:prefs?.loopEnabled??false};setOptions(restored);current.current.options=restored;setWorkspaceSource(source);current.current.workspaceSource=source;setCues({});setSourceId(selectedMediaId);current.current.sourceId=selectedMediaId;setDesired(false);setStatus(emptyPlayback);setError(null);if(api.available())control('reset');else{++sequence.current;pendingIntent.current=null;}},[active,api]);
 useEffect(()=>{if(selectedMediaId&&(!current.current.sourceId||!active?.store.snapshot.document.media.some(m=>m.id===current.current.sourceId)))selectSource(selectedMediaId);},[selectedMediaId,active?.store.snapshot.document.media]);
 const selectionSignature=JSON.stringify(selection);
 const previousSelection=useRef({owner:active,region:selection});
 useEffect(()=>{
   const previous=previousSelection.current;previousSelection.current={owner:active,region:selection};
   const resolvedMediaId=resolved().mediaId;
   // Trusted retirement clears A's selection without changing an explicit B stream.
   // Ordinary selection changes and retirement of the actual stream still stop it.
   if(previous.owner===active&&previous.region&&!selection&&active?.store.isRetired(previous.region.mediaId)&&resolvedMediaId&&!active.store.isRetired(resolvedMediaId))return;
   if(cueDeactivation.current&&!selection){cueDeactivation.current=false;return;}cueDeactivation.current=false;if(activated.current)control('stop');else clearIntent();
 },[selectionSignature,active]);
 useEffect(()=>{if(!api.available())return;refreshDevices();let disposed=false,unlisten:(()=>void)|undefined;const owner=active;void api.listen(s=>{if(!disposed&&current.current.active===owner)progress(s);}).then(f=>{if(disposed)f();else unlisten=f;});return()=>{disposed=true;unlisten?.();};},[api,active]);
 // A failed Save As retains the owner, so active identity alone cannot reset its UI intent.
 const transitioning=active?.store.editingDisabled??false;
 useEffect(()=>{if(transitioning&&activated.current)control('reset');},[transitioning]);
 const doc=active?.store.snapshot.document,media=doc?.media.find(m=>m.id===sourceId);
 const signature=audioSignature(doc,sourceId);
 useEffect(()=>{if(!media){if(activated.current)control('reset');return;}if(activated.current&&configuredKey.current!==configurationKey())configure();},[signature,JSON.stringify(options),workspaceSource]);
 // A cue invalidates resumption, but the current stream keeps its explicit
 // range/source until the next start. A normal pause retains both unchanged.
 const toggle=()=>{if(current.current.active!==active||!active||!media||active.store.editingDisabled)return;if(desired.current)control('pause');else{const resume=resumable.current;if(!resume&&activated.current)control('stop');if(!resume)intent.current={kind:'automatic'};const r=resolved();setDesired(true);configure(resume?null:r.region?r.start:(r.mediaId&&validCue(active,r.mediaId,cues[r.mediaId])?cues[r.mediaId]:status.mediaId===r.mediaId&&status.state==='stopped'?status.positionSeconds:r.start));}};
 useEffect(()=>{const handler=(e:KeyboardEvent)=>{if(!e.defaultPrevented&&playbackShortcut(e)&&active&&!active.store.editingDisabled&&media){e.preventDefault();toggle();}};window.addEventListener('keydown',handler);return()=>window.removeEventListener('keydown',handler);});
 const persistOptions=()=>{const n=current.current;if(n.active?.store.editingDisabled)return;n.active?.preferences?.update({volume:n.options.volume,deviceId:n.options.deviceId,loopEnabled:n.options.looping,source:n.workspaceSource,...monitorRef.current});};
 // Realtime requests share the command tail. Read the latest desired gain only
 // after any configure acknowledgement, so buffering changes reach its new generation.
 const applyMonitor=()=>{
   const owner=active,id=current.current.sourceId,capturedApi=api;
   tail.current=tail.current.catch(()=>{}).then(async()=>{
     if(!owner||!id||current.current.active!==owner||current.current.sourceId!==id||owner.store.editingDisabled)return;
     const stream=statusRef.current;
     if(stream.mediaId!==id||stream.projectId!==owner.store.snapshot.document.projectId||!['buffering','playing','paused'].includes(stream.state))return;
     if(!capturedApi.monitorGain)throw new Error('Realtime monitor unavailable');
     await capturedApi.monitorGain({projectId:stream.projectId,mediaId:stream.mediaId,generation:stream.generation,monitorGainDb:effectiveMonitor(id)});
     if(current.current.active===owner&&current.current.sourceId===id)setMonitorError(null);
   }).catch(cause=>{if(current.current.active===owner&&current.current.sourceId===id)setMonitorError(normalizeError(cause));});
 };
 const setGlobalMonitorGain=(db:number)=>{
   if(current.current.active!==active||!active||active.store.editingDisabled||!validMonitorGain(db))return;
   if(local&&!local.applyGlobal({playback:{monitorGainDb:db}})){setMonitorError({code:'SaveFailed',message:local.error!,retryable:true});return;}
   const next={...monitorRef.current,monitorGainDb:db};monitorRef.current=next;setMonitor(next);persistOptions();applyMonitor();
 };
 const setMediaMonitorGain=(id:string,db:number|null)=>{
   if(current.current.active!==active||!active||active.store.editingDisabled||db!==null&&!validMonitorGain(db)||!active.store.snapshot.document.media.some(m=>m.id===id))return;
   if(local?.value.playback.monitorGainDb!==undefined){const projectId=active.store.snapshot.document.projectId;const ok=db===null?local.follow(projectId,id,['monitorGainDb']):local.patchMedia(projectId,id,{monitorGainDb:db});if(!ok){setMonitorError({code:'SaveFailed',message:local.error!,retryable:true});return;}}
   const next={...monitorRef.current,mediaMonitorGainDb:{...monitorRef.current.mediaMonitorGainDb,[id]:db}};monitorRef.current=next;setMonitor(next);persistOptions();if(id===current.current.sourceId)applyMonitor();
 };
 const update=(patch:Partial<PlaybackOptions>)=>{if(current.current.active!==active||current.current.active?.store.editingDisabled)return;const global={...('volume'in patch?{volume:patch.volume}:{}),...('looping'in patch?{looping:patch.looping}:{})};if(local&&Object.keys(global).length&&!local.applyGlobal({playback:global}))return;const next={...current.current.options,...patch};current.current.options=next;setOptions(next);persistOptions();};
 const updateWorkspaceSource=(source:WorkspaceSoundVersion)=>{if(current.current.active!==active||current.current.active?.store.editingDisabled||source===current.current.workspaceSource)return;if(local&&!local.applyGlobal({playback:{source}}))return;control('stop');current.current.workspaceSource=source;setWorkspaceSource(source);persistOptions();};
 const globalPlaybackKey=JSON.stringify(local?.value.playback),globalMonitorValue=effectiveMonitor(sourceId);
 useEffect(()=>{
   const global=localRef.current?.value.playback;if(!global||!active||current.current.active!==active||active.store.editingDisabled)return;
   const patch={...(global.volume!==undefined?{volume:global.volume}:{}),...(global.looping!==undefined?{looping:global.looping}:{})};
   if(Object.entries(patch).some(([key,value])=>current.current.options[key as keyof PlaybackOptions]!==value)){const next={...current.current.options,...patch};current.current.options=next;setOptions(next);}
   if(global.source!==undefined&&global.source!==current.current.workspaceSource){control('stop');current.current.workspaceSource=global.source;setWorkspaceSource(global.source);}
   applyMonitor();
 },[active,globalPlaybackKey,globalMonitorValue]);
 useEffect(()=>{const before=monitorRef.current.mediaMonitorGainDb;const next=Object.fromEntries(Object.entries(before).filter(([id])=>doc?.media.some(m=>m.id===id)));if(Object.keys(next).length!==Object.keys(before).length){monitorRef.current={...monitorRef.current,mediaMonitorGainDb:next};setMonitor(monitorRef.current);persistOptions();}},[doc?.media]);
 useEffect(()=>{setCues(previous=>{const next=Object.fromEntries(Object.entries(previous).filter(([id])=>doc?.media.some(m=>m.id===id)));return Object.keys(next).length===Object.keys(previous).length?previous:next;});},[doc?.media]);
 const updateMix=(mix:PlaybackMix)=>{
   if(!active||!media||active.store.editingDisabled)return;
   const owner=active,id=media.id,before=owner.store.snapshot.document.playbackMix[id]??{soloChannels:[],mutedChannels:[]};
   const fields=['soloChannels','mutedChannels'] as const;
   const delta=fields.map(field=>({field,add:mix[field].filter(c=>!before[field].includes(c)),remove:before[field].filter(c=>!mix[field].includes(c))}));
   void owner.lifecycle.enqueueEdit(async()=>{
     await owner.lifecycle.submitDrafts();if(!owner.store.snapshot.document.media.some(m=>m.id===id))return;
     const latest=owner.store.snapshot.document.playbackMix[id]??{soloChannels:[],mutedChannels:[]},next={...latest};
     for(const {field,add,remove} of delta)next[field]=[...new Set([...latest[field].filter(c=>!remove.includes(c)),...add])].sort((a,b)=>a-b);
     await owner.queue.enqueue({type:'updatePlaybackMix',mediaId:id,mix:next},{owner:'playback'});
   }).catch(e=>owner.store.setError(normalizeError(e)));
 };
 const visibleMonitor=local?.value.playback.monitorGainDb!==undefined?{monitorGainDb:local.value.playback.monitorGainDb,mediaMonitorGainDb:Object.fromEntries((doc?.media??[]).map(m=>[m.id,local.override(doc!.projectId,m.id).monitorGainDb??null]))}:monitor;
 return{playing,active,monitor:visibleMonitor,monitorError,effectiveMonitorGainDb:effectiveMonitor(sourceId),setGlobalMonitorGain,setMediaMonitorGain,retryMonitor:applyMonitor,media,sourceId,selectSource,playSelection,playFile,playFrom,setCue,cues,validCue,workspaceSource,updateWorkspaceSource,options,update,status,devices,error,refreshDevices,toggle,stop:()=>control('stop'),seek:(seconds:number)=>configure(seconds),retry:()=>{if(current.current.active!==active)return;setDesired(true);configure();},mix:media?doc?.playbackMix[media.id]??{soloChannels:[],mutedChannels:[]}: {soloChannels:[],mutedChannels:[]},updateMix,selection:resolved().region};
}
export type PlaybackUI=ReturnType<typeof usePlayback>;
export const PlaybackContext=createContext<PlaybackUI|null>(null);
export const usePlaybackContext=()=>useContext(PlaybackContext);
