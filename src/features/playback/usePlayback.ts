import { createContext,useContext,useEffect,useRef,useState } from 'react';
import { emptyPlayback,playbackClient,type PlaybackOptions,type PlaybackStatus,type OutputDevice } from '../../bridge/playback';
import type { ProjectDocument,Region,PlaybackMix,AppError } from '../../bridge/types';
import { normalizeError } from '../../bridge/client';
import type { ActiveProject } from '../project/useProjectLifecycle';
import { menuIsOpen } from '../../components/menu/menuModel';
import { validRegion } from '../selection/state';
export function audioSignature(doc:ProjectDocument|undefined,id:string|null){const m=doc?.media.find(m=>m.id===id);return JSON.stringify(m&&[m.id,m.sha256,m.sourceRef,m.sampleRate,m.frameCount,m.channelCount,doc?.edits.filter(e=>e.region.mediaId===id),doc?.playbackMix[m.id]]);}
export function actualSource(mode:PlaybackOptions['mode'],source:PlaybackOptions['selectionSource'],bypass:boolean){return mode==='selection'?(source==='original'||bypass?'原始选区':'处理后选区'):mode==='original'||bypass?'原音':'处理后';}
export function playbackShortcut(e:{key:string;target:EventTarget|null;ctrlKey?:boolean;metaKey?:boolean;altKey?:boolean}){return !menuIsOpen()&&e.key===' '&&!e.ctrlKey&&!e.metaKey&&!e.altKey&&!(e.target instanceof Element&&e.target.closest('input,textarea,select,button,[role="dialog"],[role="alertdialog"],[contenteditable]:not([contenteditable="false"])'));}
export function usePlayback(active:ActiveProject|null,selectedMediaId:string|null,selection:Region|undefined,api=playbackClient){
 const [sourceId,setSourceId]=useState(selectedMediaId),[options,setOptions]=useState<PlaybackOptions>({mode:'original',selectionSource:'original',bypass:false,looping:false,volume:.75,deviceId:null});
 const [status,setStatus]=useState<PlaybackStatus>(emptyPlayback),[devices,setDevices]=useState<OutputDevice[]>([]),[error,setError]=useState<AppError|null>(null);
 const [playing,setPlaying]=useState(false);
 const acceptedGeneration=useRef(0);
 const pendingIntent=useRef<{serial:number;event:PlaybackStatus|null}|null>(null);
 const explicitSelection=useRef<{base:Region|undefined;region:Region}|null>(null),configuredKey=useRef('');
 const effectiveSelection=explicitSelection.current?.base===selection?explicitSelection.current?.region:selection;
 const desired=useRef(false),activated=useRef(false),sequence=useRef(0),tail=useRef<Promise<unknown>>(Promise.resolve()),current=useRef({active,sourceId,selection:effectiveSelection,options});current.current={active,sourceId,selection:effectiveSelection,options};
 const configurationKey=()=>{const n=current.current;return JSON.stringify([audioSignature(n.active?.store.snapshot.document,n.sourceId),n.options,n.options.mode==='selection'?n.selection:null]);};
 const setDesired=(value:boolean)=>{desired.current=value;setPlaying(value);};
 const matchesSource=(s:PlaybackStatus)=>s.generation>=acceptedGeneration.current&&(!s.projectId||s.projectId===current.current.active?.store.snapshot.document.projectId)&&(!s.mediaId||s.mediaId===current.current.sourceId);
 const accept=(s:PlaybackStatus)=>{
   if(!matchesSource(s))return;
   acceptedGeneration.current=s.generation;setStatus(s);
   if(s.state==='ended'||s.state==='error')setDesired(false);
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
   const now=current.current;if(!now.active||!now.sourceId||now.active.store.editingDisabled)return;
   if(now.options.mode==='selection'&&(!now.selection||now.selection.mediaId!==now.sourceId)){control('stop');setError({code:'InvalidInput',message:'请先框选当前播放源的区域。',retryable:true});return;}
   const serial=++sequence.current;pendingIntent.current={serial,event:null};activated.current=true;setError(null);
   configuredKey.current=configurationKey();
   const request={projectId:now.active.store.snapshot.document.projectId,mediaId:now.sourceId,mode:now.options.mode==='selection'?{mode:'selection' as const,region:now.selection!,selectionSource:now.options.selectionSource}:{mode:now.options.mode},bypass:now.options.bypass,looping:now.options.looping,volume:now.options.volume,deviceId:now.options.deviceId,seekSeconds,play:desired.current};
   tail.current=tail.current.catch(()=>{}).then(async()=>{if(serial!==sequence.current)return;acknowledge(serial,await api.configure(request),true);}).catch(e=>rejectIntent(serial,e));
 };
 const control=(action:'pause'|'stop'|'reset')=>{setDesired(false);const serial=++sequence.current;pendingIntent.current={serial,event:null};if(action==='reset')activated.current=false;tail.current=tail.current.catch(()=>{}).then(()=>api.control(action)).then(s=>acknowledge(serial,s,false)).catch(e=>rejectIntent(serial,e));};
 const selectSource=(id:string)=>{if(id===current.current.sourceId)return;control('reset');current.current={...current.current,sourceId:id};setSourceId(id);setStatus(emptyPlayback);};
 const playSelection=(region:Region,source:'original'|'processed')=>{
   const owner=current.current.active;if(!owner||owner.store.editingDisabled||!validRegion(owner.store.snapshot.document,region))return;
   selectSource(region.mediaId);
   const captured={...region},next={...current.current.options,mode:'selection' as const,selectionSource:source};
   explicitSelection.current={base:selection,region:captured};current.current={...current.current,selection:captured,options:next};setOptions(next);setDesired(true);configure();
 };
 useEffect(()=>{explicitSelection.current=null;configuredKey.current='';setSourceId(selectedMediaId);setDesired(false);activated.current=false;setStatus(emptyPlayback);setError(null);if(api.available())control('reset');else{++sequence.current;pendingIntent.current=null;}},[active,selectedMediaId,api]);
 useEffect(()=>{if(!api.available())return;refreshDevices();let disposed=false,unlisten:(()=>void)|undefined;void api.listen(s=>{if(!disposed)progress(s);}).then(f=>{if(disposed)f();else unlisten=f;});return()=>{disposed=true;unlisten?.();};},[api]);
 // A failed Save As retains the owner, so active identity alone cannot reset its UI intent.
 const transitioning=active?.store.editingDisabled??false;
 useEffect(()=>{if(transitioning&&activated.current)control('reset');},[transitioning]);
 const doc=active?.store.snapshot.document,media=doc?.media.find(m=>m.id===sourceId);
 const signature=audioSignature(doc,sourceId),selectionSignature=options.mode==='selection'?JSON.stringify(effectiveSelection):'';
 useEffect(()=>{if(!media){if(activated.current)control('reset');return;}if(activated.current&&configuredKey.current!==configurationKey())configure();},[signature,JSON.stringify(options),selectionSignature]);
 const toggle=()=>{if(!active||!media||active.store.editingDisabled)return;if(desired.current)control('pause');else{setDesired(true);configure();}};
 useEffect(()=>{const handler=(e:KeyboardEvent)=>{if(!e.defaultPrevented&&playbackShortcut(e)&&active&&!active.store.editingDisabled&&media){e.preventDefault();toggle();}};window.addEventListener('keydown',handler);return()=>window.removeEventListener('keydown',handler);});
 const update=(patch:Partial<PlaybackOptions>)=>{if(patch.mode==='selection'&&selection?.mediaId!==sourceId&&selection)selectSource(selection.mediaId);setOptions(o=>({...o,...patch}));};
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
 return{playing,active,media,sourceId,selectSource,playSelection,options,update,status,devices,error,refreshDevices,toggle,stop:()=>control('stop'),seek:(seconds:number)=>configure(seconds),retry:()=>{setDesired(true);configure();},mix:media?doc?.playbackMix[media.id]??{soloChannels:[],mutedChannels:[]}: {soloChannels:[],mutedChannels:[]},updateMix,selection:effectiveSelection};
}
export type PlaybackUI=ReturnType<typeof usePlayback>;
export const PlaybackContext=createContext<PlaybackUI|null>(null);
export const usePlaybackContext=()=>useContext(PlaybackContext);
