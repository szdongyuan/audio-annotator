import { createContext,useContext,useEffect,useRef,useState } from 'react';
import { emptyPlayback,playbackClient,type PlaybackOptions,type PlaybackStatus,type OutputDevice } from '../../bridge/playback';
import type { ProjectDocument,Region,PlaybackMix,AppError } from '../../bridge/types';
import { normalizeError } from '../../bridge/client';
import type { ActiveProject } from '../project/useProjectLifecycle';
import { menuIsOpen } from '../../components/menu/menuModel';
import { resolveIntent, type PlaybackIntent, type WorkspaceSoundVersion } from './playbackIntent';
import { validRegion } from '../selection/state';
export function audioSignature(doc:ProjectDocument|undefined,id:string|null){const m=doc?.media.find(m=>m.id===id);return JSON.stringify(m&&[m.id,m.sha256,m.sourceRef,m.sampleRate,m.frameCount,m.channelCount,doc?.edits.filter(e=>e.region.mediaId===id),doc?.playbackMix[m.id]]);}
export function actualSource(mode:PlaybackOptions['mode'],source:PlaybackOptions['selectionSource'],bypass:boolean){return mode==='selection'?(source==='original'||bypass?'原始选区':'处理后选区'):mode==='original'||bypass?'原音':'处理后';}
export function playbackShortcut(e:{key:string;target:EventTarget|null;ctrlKey?:boolean;metaKey?:boolean;altKey?:boolean}){return !menuIsOpen()&&e.key===' '&&!e.ctrlKey&&!e.metaKey&&!e.altKey&&!(e.target instanceof Element&&e.target.closest('input,textarea,select,button,[role="dialog"],[role="alertdialog"],[contenteditable]:not([contenteditable="false"])'));}
export function usePlayback(active:ActiveProject|null,selectedMediaId:string|null,selection:Region|undefined,api=playbackClient){
 const [sourceId,setSourceId]=useState(selectedMediaId),[options,setOptions]=useState<PlaybackOptions>({mode:'processed',selectionSource:'processed',bypass:false,looping:false,volume:.75,deviceId:null});
 const [status,setStatus]=useState<PlaybackStatus>(emptyPlayback),[devices,setDevices]=useState<OutputDevice[]>([]),[error,setError]=useState<AppError|null>(null);
 const [playing,setPlaying]=useState(false);
 const [workspaceSource,setWorkspaceSource]=useState<WorkspaceSoundVersion>('processed');
 const [cues,setCues]=useState<Record<string,number>>({});
 const intent=useRef<PlaybackIntent>({kind:'automatic'}),resumable=useRef(false);
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
   acceptedGeneration.current=s.generation;setStatus(s);
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
   const now=current.current,r=resolved();if(!now.active||!r.mediaId||now.active.store.editingDisabled)return;
   const doc=now.active.store.snapshot.document,media=doc.media.find(m=>m.id===r.mediaId);
   if(!media||r.region&&!validRegion(doc,r.region))return;
   if(now.sourceId!==r.mediaId){current.current={...now,sourceId:r.mediaId};setSourceId(r.mediaId);}
   const serial=++sequence.current;pendingIntent.current={serial,event:null};activated.current=true;resumable.current=true;setError(null);
   configuredKey.current=configurationKey();
   const request={projectId:doc.projectId,mediaId:r.mediaId,mode:r.region?{mode:'selection' as const,region:r.region,selectionSource:r.source}:{mode:r.source},bypass:false,looping:now.options.looping,volume:now.options.volume,deviceId:now.options.deviceId,seekSeconds,play:desired.current};
   tail.current=tail.current.catch(()=>{}).then(async()=>{if(serial!==sequence.current)return;acknowledge(serial,await api.configure(request),true);}).catch(e=>rejectIntent(serial,e));
 };
 const control=(action:'pause'|'stop'|'reset')=>{setDesired(false);const serial=++sequence.current;pendingIntent.current={serial,event:null};if(action!=='pause')clearIntent();tail.current=tail.current.catch(()=>{}).then(()=>api.control(action)).then(s=>acknowledge(serial,s,false)).catch(e=>rejectIntent(serial,e));};
 const selectSource=(id:string)=>{if(id===current.current.sourceId)return;control('reset');current.current={...current.current,sourceId:id};setSourceId(id);setStatus(emptyPlayback);};
 const startIntent=(next:PlaybackIntent)=>{if(activated.current)control('stop');intent.current=next;setDesired(true);configure(resolved().start);};
 const playSelection=(region:Region,sourceOverride?:WorkspaceSoundVersion)=>{
   const owner=current.current.active;if(!owner||owner.store.editingDisabled||!validRegion(owner.store.snapshot.document,region))return;
   startIntent({kind:'explicit-selection',region:{...region},sourceOverride});
 };
 const playFile=()=>{const id=current.current.sourceId;if(id)startIntent({kind:'explicit-file',mediaId:id});};
 const validCue=(owner:ActiveProject,id:string,seconds:number)=>{const m=owner.store.snapshot.document.media.find(m=>m.id===id);return owner===current.current.active&&!owner.store.editingDisabled&&!!m&&Number.isFinite(seconds)&&seconds>=0&&seconds*m.sampleRate<m.frameCount;};
 const playFrom=(owner:ActiveProject,id:string,seconds:number)=>{if(validCue(owner,id,seconds))startIntent({kind:'explicit-cue',mediaId:id,seconds});};
 const setCue=(owner:ActiveProject,id:string,seconds:number)=>{if(owner===current.current.active&&Number.isFinite(seconds))setCues(c=>({...c,[id]:seconds}));};
 useEffect(()=>{clearIntent();setWorkspaceSource('processed');current.current.workspaceSource='processed';setCues({});setSourceId(selectedMediaId);current.current.sourceId=selectedMediaId;setDesired(false);setStatus(emptyPlayback);setError(null);if(api.available())control('reset');else{++sequence.current;pendingIntent.current=null;}},[active,api]);
 useEffect(()=>{if(selectedMediaId&&selectedMediaId!==current.current.sourceId)selectSource(selectedMediaId);},[selectedMediaId]);
 const selectionSignature=JSON.stringify(selection);
 useEffect(()=>{if(activated.current)control('stop');else clearIntent();},[selectionSignature]);
 useEffect(()=>{if(!api.available())return;refreshDevices();let disposed=false,unlisten:(()=>void)|undefined;void api.listen(s=>{if(!disposed)progress(s);}).then(f=>{if(disposed)f();else unlisten=f;});return()=>{disposed=true;unlisten?.();};},[api]);
 // A failed Save As retains the owner, so active identity alone cannot reset its UI intent.
 const transitioning=active?.store.editingDisabled??false;
 useEffect(()=>{if(transitioning&&activated.current)control('reset');},[transitioning]);
 const doc=active?.store.snapshot.document,media=doc?.media.find(m=>m.id===sourceId);
 const signature=audioSignature(doc,sourceId);
 useEffect(()=>{if(!media){if(activated.current)control('reset');return;}if(activated.current&&configuredKey.current!==configurationKey())configure();},[signature,JSON.stringify(options),workspaceSource]);
 const toggle=()=>{if(!active||!media||active.store.editingDisabled)return;if(desired.current)control('pause');else{const resume=resumable.current;const r=resolved();setDesired(true);configure(resume?null:r.region?r.start:(r.mediaId&&validCue(active,r.mediaId,cues[r.mediaId])?cues[r.mediaId]:status.mediaId===r.mediaId&&status.state==='stopped'?status.positionSeconds:r.start));}};
 useEffect(()=>{const handler=(e:KeyboardEvent)=>{if(!e.defaultPrevented&&playbackShortcut(e)&&active&&!active.store.editingDisabled&&media){e.preventDefault();toggle();}};window.addEventListener('keydown',handler);return()=>window.removeEventListener('keydown',handler);});
 const update=(patch:Partial<PlaybackOptions>)=>{setOptions(o=>({...o,...patch}));};
 const updateWorkspaceSource=(source:WorkspaceSoundVersion)=>{if(source===current.current.workspaceSource)return;control('stop');current.current.workspaceSource=source;setWorkspaceSource(source);};
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
 return{playing,active,media,sourceId,selectSource,playSelection,playFile,playFrom,setCue,cues,validCue,workspaceSource,updateWorkspaceSource,options,update,status,devices,error,refreshDevices,toggle,stop:()=>control('stop'),seek:(seconds:number)=>configure(seconds),retry:()=>{setDesired(true);configure();},mix:media?doc?.playbackMix[media.id]??{soloChannels:[],mutedChannels:[]}: {soloChannels:[],mutedChannels:[]},updateMix,selection:resolved().region};
}
export type PlaybackUI=ReturnType<typeof usePlayback>;
export const PlaybackContext=createContext<PlaybackUI|null>(null);
export const usePlaybackContext=()=>useContext(PlaybackContext);
