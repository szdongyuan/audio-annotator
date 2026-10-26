import { expect,it,vi } from 'vitest';
import { act,fireEvent,render,renderHook,screen,waitFor } from '@testing-library/react';
import { audioSignature,actualSource,playbackShortcut } from './usePlayback';
import { ChannelMixer } from './ChannelMixer';
import { PlaybackModeControl } from './PlaybackMode';
import { usePlayback } from './usePlayback';
import {emptyPlayback,type PlaybackRequest,type PlaybackStatus,type MonitorGainRequest} from '../../bridge/playback';
import fixture from '../../../tests/fixtures/document-v3.json';
import { parseProjectDocument,type Change } from '../../bridge/types';
import { ProjectStore } from '../../app/store';
import { CommandQueue } from '../../app/commands';
import { ProjectLifecycle } from '../project/lifecycle';
import { useMasks } from './useMasks';
import { PreferenceDraft } from '../collaboration/controller';
import type { ActiveProject } from '../project/useProjectLifecycle';
it('restores private options only when adopting a runtime and clears ephemeral cues',()=>{
 const a:ActiveProject=activeProject().active,b:ActiveProject=activeProject().active;
 Object.assign(a,{collaboration:{runtimeNonce:'a',actor:null,preferences:{monitorGainDb:6,mediaMonitorGainDb:{[fixture.media[0].id]:3},volume:.2,deviceId:'speaker-a',loopEnabled:true,source:'original'}}});
 Object.assign(b,{collaboration:{runtimeNonce:'b',actor:null,preferences:{monitorGainDb:0,mediaMonitorGainDb:{},volume:.75,deviceId:null,loopEnabled:false,source:'processed'}}});
 const api={available:()=>false,devices:async()=>[],listen:async()=>()=>{},control:async()=>emptyPlayback,configure:async()=>emptyPlayback};
 const hook=renderHook(({owner})=>usePlayback(owner,fixture.media[0].id,undefined,api),{initialProps:{owner:a}});
 expect(hook.result.current.options).toMatchObject({volume:.2,deviceId:'speaker-a',looping:true});expect(hook.result.current.workspaceSource).toBe('original');expect(hook.result.current.effectiveMonitorGainDb).toBe(3);
 act(()=>{hook.result.current.update({volume:.4});hook.result.current.setCue(a,fixture.media[0].id,1);});hook.rerender({owner:a});expect(hook.result.current.options.volume).toBe(.4);
 hook.rerender({owner:b});expect(hook.result.current.options).toMatchObject({volume:.75,deviceId:null,looping:false});expect(hook.result.current.cues).toEqual({});expect(hook.result.current.workspaceSource).toBe('processed');hook.unmount();a.lifecycle.dispose();b.lifecycle.dispose();
});
it('retired playback callbacks cannot issue commands or clear the new owner intent',async()=>{
 const a=activeProject().active,b=activeProject().active;let generation=0;
 const api={available:()=>true,devices:async()=>[],listen:async()=>()=>{},control:vi.fn(async()=>({...emptyPlayback,generation:++generation})),configure:vi.fn(async(r:PlaybackRequest)=>({...emptyPlayback,generation:++generation,projectId:r.projectId,mediaId:r.mediaId,state:'playing' as const}))};
 const hook=renderHook(({owner})=>usePlayback(owner,fixture.media[0].id,undefined,api),{initialProps:{owner:a}}),old=hook.result.current;
 hook.rerender({owner:b});act(()=>hook.result.current.toggle());await waitFor(()=>expect(hook.result.current.playing).toBe(true));await waitFor(()=>expect(api.configure).toHaveBeenCalledTimes(1));const controls=api.control.mock.calls.length;
 act(()=>{old.stop();old.seek(.01);});await act(async()=>{});expect(api.control).toHaveBeenCalledTimes(controls);expect(api.configure).toHaveBeenCalledTimes(1);expect(hook.result.current.playing).toBe(true);hook.unmount();a.lifecycle.dispose();b.lifecycle.dispose();
});
it('audio signature ignores notes, categories, analysis, saves and revisions, but includes edits and persistent mix',()=>{
 const doc=parseProjectDocument(structuredClone(fixture)),id=doc.media[0].id, original=audioSignature(doc,id);
 doc.revision++;doc.media[0].note='new';doc.categories[0].name='other';doc.analysis[id].fftSize=4096;
 expect(audioSignature(doc,id)).toBe(original);
 doc.playbackMix[id]={soloChannels:[0],mutedChannels:[]};expect(audioSignature(doc,id)).not.toBe(original);
 const mixed=audioSignature(doc,id);doc.edits[0].enabled=!doc.edits[0].enabled;expect(audioSignature(doc,id)).not.toBe(mixed);
});
it('selection source and bypass describe the actual output explicitly',()=>{
 expect(actualSource('selection','original',false)).toBe('原始选区');
 expect(actualSource('selection','processed',false)).toBe('处理后选区');
 expect(actualSource('selection','processed',true)).toBe('原始选区');
 expect(actualSource('processed','processed',true)).toBe('原音');
});
it('Space does not hijack text fields, selects or editable content',()=>{
 for(const tag of ['input','textarea','select']){expect(playbackShortcut({key:' ',target:document.createElement(tag)})).toBe(false);}
 const editable=document.createElement('div');editable.contentEditable='true';editable.setAttribute('contenteditable','true');expect(playbackShortcut({key:' ',target:editable})).toBe(false);
 expect(playbackShortcut({key:' ',target:document.body})).toBe(true);
});
it('channel controls preserve source channel identity and report silent mixing',()=>{
 const change=vi.fn(),media=parseProjectDocument(structuredClone(fixture)).media[0];
 render(<ChannelMixer media={media} mix={{soloChannels:[],mutedChannels:[]}} disabled={false} onChange={change}/>);
 fireEvent.click(screen.getByLabelText('独听通道 2'));expect(change).toHaveBeenCalledWith({soloChannels:[1],mutedChannels:[]});
 fireEvent.click(screen.getByLabelText('静音通道 1'));expect(change).toHaveBeenCalledWith({soloChannels:[],mutedChannels:[0]});
});
it('workspace source control is separate from automatic range and has no bypass',()=>{
 const change=vi.fn();render(<PlaybackModeControl source="processed" disabled={false} onChange={change}/>);
 fireEvent.change(screen.getByLabelText('声音版本'),{target:{value:'original'}});expect(change).toHaveBeenCalledWith('original');
 expect(screen.queryByLabelText('试听模式')).not.toBeInTheDocument();expect(screen.queryByLabelText('旁路全部屏蔽')).not.toBeInTheDocument();
});
it('plays a captured temporary region on another source without waiting for React selection state', async () => {
 const s=activeProject(),first=s.active.store.snapshot.document.media[0],other={...first,id:'other'};s.active.store.snapshot.document.media.push(other);
 let generation=0;const api={available:()=>true,devices:async()=>[],listen:async()=>()=>{},control:vi.fn(async()=>({...emptyPlayback,generation:++generation})),configure:vi.fn(async(r:PlaybackRequest)=>({...emptyPlayback,generation:++generation,projectId:r.projectId,mediaId:r.mediaId,state:'playing' as const}))};
 const hook=renderHook(()=>usePlayback(s.active,first.id,undefined,api));
 const region={...s.active.store.snapshot.document.annotations[0].region,mediaId:other.id};
 act(()=>hook.result.current.playSelection(region,'processed'));
 await waitFor(()=>expect(api.configure).toHaveBeenCalledOnce());
 expect(api.configure.mock.calls[0][0]).toMatchObject({mediaId:other.id,mode:{mode:'selection',region,selectionSource:'processed'},play:true});
 expect(hook.result.current.sourceId).toBe(other.id);expect(hook.result.current.status.state).toBe('playing');hook.unmount();s.active.lifecycle.dispose();
});
it('play during a paused seek prebuffer requests playback rather than pausing it',async()=>{
 const doc=parseProjectDocument(structuredClone(fixture)),active={store:{snapshot:{document:doc},editingDisabled:false}};
 let generation=0;const api={available:()=>true,devices:vi.fn(async()=>[]),listen:vi.fn(async()=>()=>{}),control:vi.fn(async()=>({...emptyPlayback,generation:++generation})),configure:vi.fn(async(r:PlaybackRequest)=>({...emptyPlayback,generation:++generation,projectId:r.projectId,mediaId:r.mediaId,state:'buffering' as const}))};
 const hook=renderHook(()=>usePlayback(active as never,doc.media[0].id,undefined,api));
 act(()=>hook.result.current.seek(.5));await waitFor(()=>expect(api.configure).toHaveBeenCalledOnce());
 expect(api.configure.mock.calls[0][0].play).toBe(false);
 act(()=>hook.result.current.toggle());await waitFor(()=>expect(api.configure).toHaveBeenCalledTimes(2));expect(api.configure.mock.calls[1][0].play).toBe(true);hook.unmount();
});
function activeProject(){
 const store=new ProjectStore({document:parseProjectDocument(structuredClone(fixture)),canUndo:true,canRedo:false});
 const applyChange=vi.fn(async(_id:string,revision:number,change:Change)=>{const doc=structuredClone(store.snapshot.document);doc.revision=revision+1;if(change.type==='updatePlaybackMix')doc.playbackMix[change.mediaId]=change.mix;if(change.type==='addEdit')doc.edits.push(change.edit);if(change.type==='updateEdit')doc.edits=doc.edits.map(e=>e.id===change.edit.id?change.edit:e);return{...store.snapshot,document:doc};});
 const queue=new CommandQueue(store,{applyChange,getSnapshot:async()=>store.snapshot,undo:async()=>store.snapshot,redo:async()=>store.snapshot});
 const save=vi.fn(async(_id:string,r:number)=>r),lifecycle=new ProjectLifecycle(store,queue,{save,close:async()=>{}});return{active:{store,queue,lifecycle,path:''},applyChange,save};
}
it('rapid persistent channel toggles merge against latest authority and save waits for both',async()=>{
 const s=activeProject(),id=s.active.store.snapshot.document.media[0].id;s.active.store.snapshot.document.playbackMix[id]={soloChannels:[],mutedChannels:[]};
 const api={available:()=>false,devices:async()=>[],listen:async()=>()=>{},control:async()=>emptyPlayback,configure:async()=>emptyPlayback};
 const hook=renderHook(()=>usePlayback(s.active,id,undefined,api));
 act(()=>{hook.result.current.updateMix({soloChannels:[0],mutedChannels:[]});hook.result.current.updateMix({soloChannels:[],mutedChannels:[1]});});
 await s.active.lifecycle.save();expect(s.active.store.snapshot.document.playbackMix[id]).toEqual({soloChannels:[0],mutedChannels:[1]});expect(s.applyChange).toHaveBeenCalledTimes(2);hook.unmount();s.active.lifecycle.dispose();
});
it('mask edits admitted before close survive and latest enable state is preserved',async()=>{
 const s=activeProject(),hook=renderHook(()=>useMasks(s.active)),edit=s.active.store.snapshot.document.edits[0];
 let release!:()=>void;const original=s.active.lifecycle.submitDrafts.bind(s.active.lifecycle);vi.spyOn(s.active.lifecycle,'submitDrafts').mockImplementationOnce(async()=>{await new Promise<void>(r=>{release=r;});await original();});
 act(()=>hook.result.current.mutate(edit.id,{...edit.region,lowHz:edit.region.lowHz+1}));await waitFor(()=>expect(release).toBeDefined());
 s.active.store.snapshot.document.edits[0].enabled=false;const close=s.active.lifecycle.close();release();await close;
 expect(s.active.store.snapshot.document.edits[0]).toMatchObject({enabled:false,region:{lowHz:edit.region.lowHz+1}});expect(s.applyChange).toHaveBeenCalledOnce();hook.unmount();
});
it('late errors from superseded generations cannot pause the current stream or show stale errors',async()=>{
 const s=activeProject(),id=s.active.store.snapshot.document.media[0].id;let listener!:(s:PlaybackStatus)=>void;
 const api={available:()=>true,devices:async()=>[],listen:async(fn:typeof listener)=>{listener=fn;return()=>{};},control:async()=>emptyPlayback,configure:async(r:PlaybackRequest)=>({...emptyPlayback,generation:10,mediaId:id,projectId:r.projectId,state:'playing' as const})};
 const hook=renderHook(()=>usePlayback(s.active,id,undefined,api));act(()=>hook.result.current.toggle());await waitFor(()=>expect(hook.result.current.status.state).toBe('playing'));
 act(()=>listener({...hook.result.current.status,generation:9,state:'error',error:{code:'DeviceFailed',message:'old error',retryable:true}}));
 expect(hook.result.current.playing).toBe(true);expect(hook.result.current.error).toBeNull();hook.unmount();s.active.lifecycle.dispose();
});
it('a project transition clears playback intent even if Save As later fails and retains the same runtime owner',async()=>{
 const s=activeProject(),id=s.active.store.snapshot.document.media[0].id;let generation=0;
 const api={available:()=>true,devices:async()=>[],listen:async()=>()=>{},control:vi.fn(async()=>({...emptyPlayback,generation:++generation})),configure:async(r:PlaybackRequest)=>({...emptyPlayback,generation:++generation,mediaId:id,projectId:r.projectId,state:'playing' as const})};
 const hook=renderHook(()=>usePlayback(s.active,id,undefined,api));act(()=>hook.result.current.toggle());await waitFor(()=>expect(hook.result.current.status.state).toBe('playing'));
 let release!:()=>void;act(()=>{release=s.active.store.beginTransition();hook.rerender();});
 expect(hook.result.current.playing).toBe(false);await waitFor(()=>expect(hook.result.current.status.state).toBe('stopped'));act(()=>{release();hook.rerender();});expect(hook.result.current.playing).toBe(false);hook.unmount();s.active.lifecycle.dispose();
});
it.each(['ended','error'] as const)('a %s from the previous generation cannot override a pending configure intent',async terminal=>{
 const s=activeProject(),id=s.active.store.snapshot.document.media[0].id;let listener!:(s:PlaybackStatus)=>void,resolve!:(s:PlaybackStatus)=>void;
 const make=(generation:number,state:PlaybackStatus['state']):PlaybackStatus=>({...emptyPlayback,generation,projectId:s.active.store.snapshot.document.projectId,mediaId:id,state});
 const api={available:()=>true,devices:async()=>[],listen:async(fn:typeof listener)=>{listener=fn;return()=>{};},control:async()=>emptyPlayback,configure:vi.fn(async(_r:PlaybackRequest)=>make(2,'playing'))};
 const hook=renderHook(()=>usePlayback(s.active,id,undefined,api));act(()=>hook.result.current.toggle());await waitFor(()=>expect(hook.result.current.status.state).toBe('playing'));
 api.configure.mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));act(()=>hook.result.current.update({volume:.5}));await waitFor(()=>expect(api.configure).toHaveBeenCalledTimes(2));expect(api.configure.mock.calls[1][0].play).toBe(true);
 act(()=>listener({...make(2,terminal),error:terminal==='error'?{code:'DeviceFailed',message:'obsolete error',retryable:true}:null}));
 expect(hook.result.current.playing).toBe(true);expect(hook.result.current.error).toBeNull();
 await act(async()=>resolve(make(3,'buffering')));act(()=>listener(make(3,'playing')));expect(hook.result.current.playing).toBe(true);
 act(()=>hook.result.current.seek(.5));await waitFor(()=>expect(api.configure).toHaveBeenCalledTimes(3));expect(api.configure.mock.calls[2][0].play).toBe(true);hook.unmount();s.active.lifecycle.dispose();
});
it.each(['ended','error'] as const)('a pending configure failure after old %s reports its own error and releases the intent barrier',async terminal=>{
 const s=activeProject(),id=s.active.store.snapshot.document.media[0].id;let listener!:(s:PlaybackStatus)=>void,reject!:(e:unknown)=>void;
 const make=(generation:number,state:PlaybackStatus['state']):PlaybackStatus=>({...emptyPlayback,generation,projectId:s.active.store.snapshot.document.projectId,mediaId:id,state});
 const api={available:()=>true,devices:async()=>[],listen:async(fn:typeof listener)=>{listener=fn;return()=>{};},control:async()=>emptyPlayback,configure:vi.fn(async(_r:PlaybackRequest)=>make(2,'playing'))};
 const hook=renderHook(()=>usePlayback(s.active,id,undefined,api));act(()=>hook.result.current.toggle());await waitFor(()=>expect(hook.result.current.status.state).toBe('playing'));
 api.configure.mockImplementationOnce(()=>new Promise((_,r)=>{reject=r;}));act(()=>hook.result.current.update({volume:.5}));await waitFor(()=>expect(api.configure).toHaveBeenCalledTimes(2));
 act(()=>listener({...make(2,terminal),error:terminal==='error'?{code:'DeviceFailed',message:'obsolete error',retryable:true}:null}));expect(hook.result.current.playing).toBe(true);expect(hook.result.current.error).toBeNull();
 await act(async()=>reject({code:'DeviceFailed',message:'configure rejected',retryable:true}));expect(hook.result.current.playing).toBe(false);expect(hook.result.current.error?.message).toBe('configure rejected');
 api.configure.mockResolvedValueOnce(make(3,'playing'));act(()=>hook.result.current.toggle());await waitFor(()=>expect(api.configure).toHaveBeenCalledTimes(3));expect(api.configure.mock.calls[2][0].play).toBe(true);
 act(()=>listener(make(3,'ended')));expect(hook.result.current.playing).toBe(false);hook.unmount();s.active.lifecycle.dispose();
});
it('a new generation terminal arriving before its configure acknowledgement is retained',async()=>{
 const s=activeProject(),id=s.active.store.snapshot.document.media[0].id;let listener!:(s:PlaybackStatus)=>void,resolve!:(s:PlaybackStatus)=>void;
 const make=(generation:number,state:PlaybackStatus['state']):PlaybackStatus=>({...emptyPlayback,generation,projectId:s.active.store.snapshot.document.projectId,mediaId:id,state});
 const api={available:()=>true,devices:async()=>[],listen:async(fn:typeof listener)=>{listener=fn;return()=>{};},control:async()=>emptyPlayback,configure:vi.fn(async(_r:PlaybackRequest)=>make(2,'playing'))};
 const hook=renderHook(()=>usePlayback(s.active,id,undefined,api));act(()=>hook.result.current.toggle());await waitFor(()=>expect(hook.result.current.status.state).toBe('playing'));
 api.configure.mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));act(()=>hook.result.current.update({volume:.5}));await waitFor(()=>expect(api.configure).toHaveBeenCalledTimes(2));
 act(()=>listener(make(3,'ended')));await act(async()=>resolve(make(3,'buffering')));expect(hook.result.current.playing).toBe(false);expect(hook.result.current.status.state).toBe('ended');hook.unmount();s.active.lifecycle.dispose();
});
it('user pause supersedes a deferred configure without being undone by playback events',async()=>{
 const s=activeProject(),id=s.active.store.snapshot.document.media[0].id;let listener!:(s:PlaybackStatus)=>void,resolve!:(s:PlaybackStatus)=>void;
 const make=(generation:number,state:PlaybackStatus['state']):PlaybackStatus=>({...emptyPlayback,generation,projectId:s.active.store.snapshot.document.projectId,mediaId:id,state});
 const api={available:()=>true,devices:async()=>[],listen:async(fn:typeof listener)=>{listener=fn;return()=>{};},control:vi.fn(async(action:string)=>action==='pause'?make(3,'paused'):emptyPlayback),configure:vi.fn(async(_r:PlaybackRequest)=>make(2,'playing'))};
 const hook=renderHook(()=>usePlayback(s.active,id,undefined,api));act(()=>hook.result.current.toggle());await waitFor(()=>expect(hook.result.current.status.state).toBe('playing'));
 api.configure.mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));act(()=>hook.result.current.update({volume:.5}));await waitFor(()=>expect(api.configure).toHaveBeenCalledTimes(2));
 act(()=>hook.result.current.toggle());expect(hook.result.current.playing).toBe(false);act(()=>listener(make(3,'playing')));await act(async()=>resolve(make(3,'buffering')));await waitFor(()=>expect(hook.result.current.status.state).toBe('paused'));expect(hook.result.current.playing).toBe(false);
 act(()=>hook.result.current.seek(.5));await waitFor(()=>expect(api.configure).toHaveBeenCalledTimes(3));expect(api.configure.mock.calls[2][0].play).toBe(false);hook.unmount();s.active.lifecycle.dispose();
});
it('defaults to processed active selection, preserves explicit overrides through pause, and restores automatic on stop',async()=>{
 const s=activeProject(),region=s.active.store.snapshot.document.annotations[0].region;let generation=0;
 const api={available:()=>true,devices:async()=>[],listen:async()=>()=>{},control:vi.fn(async(action:string)=>({...emptyPlayback,generation:++generation,state:action==='pause'?'paused' as const:'stopped' as const})),configure:vi.fn(async(r:PlaybackRequest)=>({...emptyPlayback,generation:++generation,projectId:r.projectId,mediaId:r.mediaId,state:'playing' as const}))};
 const hook=renderHook(()=>usePlayback(s.active,region.mediaId,region,api));
 fireEvent.keyDown(window,{key:' '});await waitFor(()=>expect(api.configure).toHaveBeenCalledTimes(1));
 expect(api.configure.mock.calls[0][0]).toMatchObject({mode:{mode:'selection',region,selectionSource:'processed'},seekSeconds:region.startSeconds});
 expect(hook.result.current.workspaceSource).toBe('processed');
 act(()=>hook.result.current.playSelection(region,'original'));await waitFor(()=>expect(api.configure).toHaveBeenCalledTimes(2));
 expect(hook.result.current.workspaceSource).toBe('processed');expect(api.configure.mock.calls[1][0].mode).toMatchObject({selectionSource:'original'});
 act(()=>hook.result.current.toggle());await waitFor(()=>expect(hook.result.current.status.state).toBe('paused'));
 act(()=>hook.result.current.toggle());await waitFor(()=>expect(api.configure).toHaveBeenCalledTimes(3));expect(api.configure.mock.calls[2][0]).toMatchObject({seekSeconds:null,mode:{selectionSource:'original'}});
 act(()=>hook.result.current.stop());await waitFor(()=>expect(hook.result.current.status.state).toBe('stopped'));
 act(()=>hook.result.current.toggle());await waitFor(()=>expect(api.configure).toHaveBeenCalledTimes(4));expect(api.configure.mock.calls[3][0]).toMatchObject({mode:{selectionSource:'processed'},seekSeconds:region.startSeconds});
 hook.unmount();s.active.lifecycle.dispose();
});
it('new explicit file and cue intents bypass selection; selection changes stop without autoplay',async()=>{
 const s=activeProject(),region=s.active.store.snapshot.document.annotations[0].region;let generation=0;
 const api={available:()=>true,devices:async()=>[],listen:async()=>()=>{},control:vi.fn(async()=>({...emptyPlayback,generation:++generation})),configure:vi.fn(async(r:PlaybackRequest)=>({...emptyPlayback,generation:++generation,projectId:r.projectId,mediaId:r.mediaId,state:'playing' as const}))};
 const hook=renderHook(({selection})=>usePlayback(s.active,region.mediaId,selection,api),{initialProps:{selection:region}});
 act(()=>hook.result.current.playFile());await waitFor(()=>expect(api.configure).toHaveBeenCalledTimes(1));expect(api.configure.mock.calls[0][0]).toMatchObject({mode:{mode:'processed'},seekSeconds:0});
 act(()=>hook.result.current.playFrom(s.active,region.mediaId,.5));await waitFor(()=>expect(api.configure).toHaveBeenCalledTimes(2));expect(api.configure.mock.calls[1][0]).toMatchObject({mode:{mode:'processed'},seekSeconds:.5});
 act(()=>hook.rerender({selection:{...region,startSeconds:region.startSeconds+.01}}));await waitFor(()=>expect(hook.result.current.playing).toBe(false));expect(api.configure).toHaveBeenCalledTimes(2);
 hook.unmount();s.active.lifecycle.dispose();
});
it('cue capture does not control output and refuses stale owners, blank tails and nonfinite seconds',async()=>{
 const s=activeProject(),id=s.active.store.snapshot.document.media[0].id;let generation=0;
 const api={available:()=>true,devices:async()=>[],listen:async()=>()=>{},control:vi.fn(async()=>({...emptyPlayback,generation:++generation})),configure:vi.fn(async(r:PlaybackRequest)=>({...emptyPlayback,generation:++generation,projectId:r.projectId,mediaId:r.mediaId,state:'playing' as const}))};
 const hook=renderHook(({owner})=>usePlayback(owner,id,undefined,api),{initialProps:{owner:s.active}});
 await waitFor(()=>expect(api.control).toHaveBeenCalledOnce());
 act(()=>hook.result.current.toggle());await waitFor(()=>expect(api.configure).toHaveBeenCalledOnce());
 act(()=>hook.result.current.setCue(s.active,id,.7));expect(api.control).toHaveBeenCalledOnce();expect(api.configure).toHaveBeenCalledOnce();expect(hook.result.current.playing).toBe(true);
 for(const seconds of [-1,2,99,NaN,Infinity])act(()=>hook.result.current.playFrom(s.active,id,seconds));expect(api.configure).toHaveBeenCalledOnce();
 act(()=>hook.result.current.stop());await waitFor(()=>expect(api.control).toHaveBeenCalledTimes(2));
 act(()=>hook.result.current.toggle());await waitFor(()=>expect(api.configure).toHaveBeenCalledTimes(2));expect(api.configure.mock.calls[1][0].seekSeconds).toBe(.7);
 const oldPlay=hook.result.current.playFrom;
 act(()=>hook.rerender({owner:{...s.active}}));act(()=>oldPlay(s.active,id,.5));await waitFor(()=>expect(api.control).toHaveBeenCalledTimes(3));expect(api.configure).toHaveBeenCalledTimes(2);expect(hook.result.current.cues).toEqual({});
 hook.unmount();s.active.lifecycle.dispose();
});
it('ended clears explicit source and range, workspace source changes stop, and an inactive selection is excluded',async()=>{
 const s=activeProject(),r=s.active.store.snapshot.document.annotations[0].region;let generation=0,listener!:(s:PlaybackStatus)=>void;
 const api={available:()=>true,devices:async()=>[],listen:async(fn:typeof listener)=>{listener=fn;return()=>{};},control:vi.fn(async()=>({...emptyPlayback,generation:++generation})),configure:vi.fn(async(r:PlaybackRequest)=>({...emptyPlayback,generation:++generation,projectId:r.projectId,mediaId:r.mediaId,state:'playing' as const}))};
 const hook=renderHook(({selection})=>usePlayback(s.active,r.mediaId,selection,api),{initialProps:{selection:r as typeof r|undefined}});
 act(()=>hook.result.current.playSelection(r,'original'));await waitFor(()=>expect(api.configure).toHaveBeenCalledOnce());
 act(()=>listener({...hook.result.current.status,state:'ended'}));act(()=>hook.result.current.toggle());await waitFor(()=>expect(api.configure).toHaveBeenCalledTimes(2));expect(api.configure.mock.calls[1][0].mode).toMatchObject({selectionSource:'processed'});
 act(()=>hook.result.current.updateWorkspaceSource('original'));await waitFor(()=>expect(hook.result.current.status.state).toBe('stopped'));expect(api.configure).toHaveBeenCalledTimes(2);
 act(()=>hook.rerender({selection:undefined}));act(()=>hook.result.current.toggle());await waitFor(()=>expect(api.configure).toHaveBeenCalledTimes(3));expect(api.configure.mock.calls[2][0]).toMatchObject({mode:{mode:'original'},seekSeconds:0});
 hook.unmount();s.active.lifecycle.dispose();
});
it('a blank-tail cue remains a marker but cannot become an ordinary playback seek',async()=>{
 const s=activeProject(),id=s.active.store.snapshot.document.media[0].id;let generation=0;
 const api={available:()=>true,devices:async()=>[],listen:async()=>()=>{},control:async()=>({...emptyPlayback,generation:++generation}),configure:vi.fn(async(r:PlaybackRequest)=>({...emptyPlayback,generation:++generation,projectId:r.projectId,mediaId:r.mediaId,state:'playing' as const}))};
 const hook=renderHook(()=>usePlayback(s.active,id,undefined,api));act(()=>hook.result.current.setCue(s.active,id,99));expect(hook.result.current.cues[id]).toBe(99);
 act(()=>hook.result.current.toggle());await waitFor(()=>expect(api.configure).toHaveBeenCalledOnce());expect(api.configure.mock.calls[0][0].seekSeconds).toBe(0);
 hook.unmount();s.active.lifecycle.dispose();
});
it('rapid source/runtime replacement drops an old configure and starts only the latest owner intent',async()=>{
 const s=activeProject(),doc=s.active.store.snapshot.document,id=doc.media[0].id,other={...doc.media[0],id:'other'};doc.media.push(other);let release!:(s:PlaybackStatus)=>void,generation=0;
 const api={available:()=>true,devices:async()=>[],listen:async()=>()=>{},control:vi.fn(async()=>({...emptyPlayback,generation:++generation})),configure:vi.fn(async(r:PlaybackRequest):Promise<PlaybackStatus>=>({...emptyPlayback,generation:++generation,mediaId:r.mediaId,projectId:r.projectId,state:'playing' as const}))};
 api.configure.mockImplementationOnce(()=>new Promise(r=>{release=r;}));
 const hook=renderHook(({owner})=>usePlayback(owner,id,undefined,api),{initialProps:{owner:s.active}});
 act(()=>hook.result.current.playFile());await waitFor(()=>expect(api.configure).toHaveBeenCalledOnce());
 act(()=>hook.result.current.selectSource(other.id));const replacement={...s.active};act(()=>hook.rerender({owner:replacement}));
 act(()=>hook.result.current.playFrom(replacement,other.id,.4));
 await act(async()=>release({...emptyPlayback,generation:++generation,mediaId:id,projectId:doc.projectId,state:'error',error:{code:'DeviceFailed',message:'obsolete',retryable:true}}));
 await waitFor(()=>expect(api.configure).toHaveBeenCalledTimes(2));expect(api.configure.mock.calls[1][0]).toMatchObject({mediaId:other.id,seekSeconds:.4,mode:{mode:'processed'}});expect(hook.result.current.error).toBeNull();expect(hook.result.current.playing).toBe(true);expect(hook.result.current.status.mediaId).toBe(other.id);
 hook.unmount();s.active.lifecycle.dispose();
});
it('ordinary stopped playback without a cue retains its current file position',async()=>{
 const s=activeProject(),id=s.active.store.snapshot.document.media[0].id;let generation=0;
 const api={available:()=>true,devices:async()=>[],listen:async()=>()=>{},control:vi.fn(async(action:string)=>({...emptyPlayback,generation:++generation,mediaId:action==='stop'?id:null,positionSeconds:action==='stop'?.5:0})),configure:vi.fn(async(r:PlaybackRequest)=>({...emptyPlayback,generation:++generation,projectId:r.projectId,mediaId:r.mediaId,state:'playing' as const}))};
 const hook=renderHook(()=>usePlayback(s.active,id,undefined,api));act(()=>hook.result.current.seek(.5));await waitFor(()=>expect(api.configure).toHaveBeenCalledOnce());
 act(()=>hook.result.current.stop());await waitFor(()=>expect(hook.result.current.status.positionSeconds).toBe(.5));act(()=>hook.result.current.toggle());await waitFor(()=>expect(api.configure).toHaveBeenCalledTimes(2));expect(api.configure.mock.calls[1][0].seekSeconds).toBe(.5);
 hook.unmount();s.active.lifecycle.dispose();
});

it('monitor gain uses private absolute overrides and realtime updates without configuring or history',async()=>{
 const s=activeProject(),doc=s.active.store.snapshot.document,id=doc.media[0].id;
 const other={...doc.media[0],id:'00000000-0000-4000-8000-000000000090'};doc.media.push(other);
 const preferences=vi.fn();Object.assign(s.active,{preferences:{update:preferences}});
 let generation=0;
 const api={available:()=>true,devices:async()=>[],listen:async()=>()=>{},control:vi.fn(async()=>({...emptyPlayback,generation:++generation})),configure:vi.fn(async(r:PlaybackRequest)=>({...emptyPlayback,generation:++generation,projectId:r.projectId,mediaId:r.mediaId,state:'playing' as const})),monitorGain:vi.fn(async(r:MonitorGainRequest)=>({...emptyPlayback,...r,state:'playing' as const}))};
 const hook=renderHook(()=>usePlayback(s.active,id,undefined,api));
 act(()=>hook.result.current.setGlobalMonitorGain(6));
 expect(hook.result.current.effectiveMonitorGainDb).toBe(6);expect(api.configure).not.toHaveBeenCalled();
 act(()=>hook.result.current.setMediaMonitorGain(id,3));expect(hook.result.current.effectiveMonitorGainDb).toBe(3);
 act(()=>hook.result.current.toggle());await waitFor(()=>expect(api.configure).toHaveBeenCalledOnce());
 expect(api.configure.mock.calls[0][0]).toMatchObject({monitorGainDb:3,volume:.75});
 act(()=>hook.result.current.setGlobalMonitorGain(-6));await act(async()=>{});
 expect(hook.result.current.effectiveMonitorGainDb).toBe(3);
 act(()=>hook.result.current.setMediaMonitorGain(id,-6));
 await waitFor(()=>expect(api.monitorGain).toHaveBeenCalled());
 expect(hook.result.current.monitor.mediaMonitorGainDb[id]).toBe(-6);
 act(()=>hook.result.current.setMediaMonitorGain(id,null));await act(async()=>{});
 expect(hook.result.current.monitor.mediaMonitorGainDb[id]).toBeNull();expect(hook.result.current.effectiveMonitorGainDb).toBe(-6);
 act(()=>hook.result.current.setGlobalMonitorGain(12));await waitFor(()=>expect(api.monitorGain).toHaveBeenLastCalledWith(expect.objectContaining({monitorGainDb:12,mediaId:id})));
 expect(api.configure).toHaveBeenCalledOnce();expect(s.applyChange).not.toHaveBeenCalled();
 expect(preferences).toHaveBeenLastCalledWith(expect.objectContaining({monitorGainDb:12,mediaMonitorGainDb:{[id]:null},volume:.75}));
 act(()=>hook.result.current.selectSource(other.id));act(()=>hook.result.current.toggle());await waitFor(()=>expect(api.configure).toHaveBeenCalledTimes(2));expect(api.configure.mock.calls[1][0].monitorGainDb).toBe(12);
 hook.unmount();s.active.lifecycle.dispose();
});

it('buffering configure and rapid monitor updates apply latest gain to only the new stream',async()=>{
 const s=activeProject(),doc=s.active.store.snapshot.document,id=doc.media[0].id;
 let release!:(s:PlaybackStatus)=>void,generation=0,releaseGain!:()=>void;
 const api={available:()=>true,devices:async()=>[],listen:async()=>()=>{},control:async()=>({...emptyPlayback,generation:++generation}),configure:vi.fn(async(_r:PlaybackRequest):Promise<PlaybackStatus>=>new Promise(r=>{release=r;})),monitorGain:vi.fn(async(r:MonitorGainRequest)=>({...emptyPlayback,...r,state:'playing' as const}))};
 const hook=renderHook(()=>usePlayback(s.active,id,undefined,api));
 act(()=>hook.result.current.toggle());await waitFor(()=>expect(api.configure).toHaveBeenCalledOnce());
 act(()=>{hook.result.current.setGlobalMonitorGain(6);hook.result.current.setGlobalMonitorGain(12);});
 await act(async()=>release({...emptyPlayback,generation:++generation,projectId:doc.projectId,mediaId:id,state:'buffering'}));
 await waitFor(()=>expect(api.monitorGain).toHaveBeenCalled());
 expect(api.monitorGain.mock.calls.every(([r])=>r.monitorGainDb===12)).toBe(true);
 api.monitorGain.mockImplementationOnce(async r=>{await new Promise<void>(resolve=>{releaseGain=resolve;});return {...emptyPlayback,...r,state:'playing'};});
 act(()=>hook.result.current.setGlobalMonitorGain(3));await waitFor(()=>expect(releaseGain).toBeTypeOf('function'));
 act(()=>{hook.result.current.setGlobalMonitorGain(-3);hook.result.current.setGlobalMonitorGain(-9);});
 await act(async()=>releaseGain());
 await waitFor(()=>expect(api.monitorGain).toHaveBeenLastCalledWith(expect.objectContaining({monitorGainDb:-9,generation:2})));
 expect(api.configure).toHaveBeenCalledOnce();expect(hook.result.current.effectiveMonitorGainDb).toBe(-9);
 hook.unmount();s.active.lifecycle.dispose();
});
it('monitor failures retry independently while retired owner and source updates cannot reach replacement streams',async()=>{
 const a=activeProject(),b=activeProject(),id=fixture.media[0].id;let generation=0;
 const api={available:()=>true,devices:async()=>[],listen:async()=>()=>{},control:async()=>({...emptyPlayback,generation:++generation}),configure:vi.fn(async(r:PlaybackRequest)=>({...emptyPlayback,generation:++generation,projectId:r.projectId,mediaId:r.mediaId,state:'playing' as const})),monitorGain:vi.fn(async(r:MonitorGainRequest)=>({...emptyPlayback,...r,state:'playing' as const}))};
 const hook=renderHook(({owner})=>usePlayback(owner,id,undefined,api),{initialProps:{owner:a.active}});
 act(()=>hook.result.current.toggle());await waitFor(()=>expect(api.configure).toHaveBeenCalledOnce());
 api.monitorGain.mockRejectedValueOnce({code:'DeviceFailed',message:'retry',retryable:true});
 act(()=>hook.result.current.setGlobalMonitorGain(6));await waitFor(()=>expect(hook.result.current.monitorError?.message).toBe('retry'));
 expect(hook.result.current.effectiveMonitorGainDb).toBe(6);expect(hook.result.current.playing).toBe(true);
 act(()=>hook.result.current.retryMonitor());await waitFor(()=>expect(hook.result.current.monitorError).toBeNull());
 const old=hook.result.current;hook.rerender({owner:b.active});act(()=>hook.result.current.toggle());await waitFor(()=>expect(api.configure).toHaveBeenCalledTimes(2));
 const calls=api.monitorGain.mock.calls.length;act(()=>{old.setGlobalMonitorGain(24);old.setMediaMonitorGain(id,24);});await act(async()=>{});
 expect(api.monitorGain).toHaveBeenCalledTimes(calls);expect(hook.result.current.effectiveMonitorGainDb).toBe(0);expect(api.configure.mock.calls[1][0].monitorGainDb).toBe(0);
 hook.unmount();a.active.lifecycle.dispose();b.active.lifecycle.dispose();
});

it('monitor remains effective after preference save failure and retry preserves both private and output state',async()=>{
 const s=activeProject(),id=fixture.media[0].id;Object.assign(s.active,{collaboration:{runtimeNonce:'11111111-1111-4111-8111-111111111111'}});
 const saving=vi.fn().mockRejectedValueOnce({code:'SaveFailed',message:'prefs disk',retryable:true}).mockResolvedValue({});
 const draft=new PreferenceDraft(s.active,{preferences:saving} as never);Object.assign(s.active,{preferences:draft});let generation=0;
 const api={available:()=>true,devices:async()=>[],listen:async()=>()=>{},control:async()=>({...emptyPlayback,generation:++generation}),configure:vi.fn(async(r:PlaybackRequest)=>({...emptyPlayback,generation:++generation,projectId:r.projectId,mediaId:r.mediaId,state:'playing' as const})),monitorGain:vi.fn(async(r:MonitorGainRequest)=>({...emptyPlayback,...r,state:'playing' as const}))};
 const hook=renderHook(()=>usePlayback(s.active,id,undefined,api));act(()=>hook.result.current.toggle());await waitFor(()=>expect(api.configure).toHaveBeenCalledOnce());
 act(()=>hook.result.current.setGlobalMonitorGain(6));await waitFor(()=>expect(api.monitorGain).toHaveBeenCalledOnce());
 await expect(s.active.lifecycle.submitDrafts()).rejects.toMatchObject({code:'SaveFailed'});
 expect(hook.result.current.effectiveMonitorGainDb).toBe(6);expect(hook.result.current.monitorError).toBeNull();expect(s.active.store.drafts.size).toBe(1);
 await s.active.lifecycle.submitDrafts();expect(saving).toHaveBeenLastCalledWith(expect.anything(),expect.objectContaining({monitorGainDb:6}));expect(s.active.store.drafts.size).toBe(0);expect(api.configure).toHaveBeenCalledOnce();
 hook.unmount();draft.dispose();s.active.lifecycle.dispose();
});
it('file and selection configure both sound sources with current scalar product and prune only removed media overrides',async()=>{
 const s=activeProject(),id=fixture.media[0].id,region=fixture.annotations[0].region;let generation=0;
 const api={available:()=>true,devices:async()=>[],listen:async()=>()=>{},control:async()=>({...emptyPlayback,generation:++generation}),configure:vi.fn(async(r:PlaybackRequest)=>({...emptyPlayback,generation:++generation,projectId:r.projectId,mediaId:r.mediaId,state:'playing' as const})),monitorGain:vi.fn(async(r:MonitorGainRequest)=>({...emptyPlayback,...r,state:'playing' as const}))};
 const hook=renderHook(()=>usePlayback(s.active,id,undefined,api));
 act(()=>{hook.result.current.setGlobalMonitorGain(6);hook.result.current.update({volume:.5});});
 for(const source of ['original','processed'] as const){
  act(()=>hook.result.current.updateWorkspaceSource(source));act(()=>hook.result.current.playFile());await waitFor(()=>expect(api.configure.mock.calls.at(-1)?.[0].mode).toEqual({mode:source}));
  expect(api.configure.mock.calls.at(-1)?.[0]).toMatchObject({monitorGainDb:6,volume:.5});
  act(()=>hook.result.current.playSelection(region,source));await waitFor(()=>expect(api.configure.mock.calls.at(-1)?.[0].mode).toMatchObject({mode:'selection',selectionSource:source}));expect(api.configure.mock.calls.at(-1)?.[0]).toMatchObject({monitorGainDb:6,volume:.5});
 }
 act(()=>hook.result.current.setMediaMonitorGain(id,6));expect(hook.result.current.monitor.mediaMonitorGainDb[id]).toBe(6);
 const other='00000000-0000-4000-8000-000000000090';s.active.store.snapshot.document.media.push({...fixture.media[0],id:other});
 act(()=>hook.result.current.setMediaMonitorGain(other,-3));
 s.active.store.snapshot.document.media=s.active.store.snapshot.document.media.filter(m=>m.id!==id);hook.rerender();
 expect(hook.result.current.monitor.mediaMonitorGainDb).toEqual({[other]:-3});
 hook.unmount();s.active.lifecycle.dispose();
});
it('a new cue replaces a paused resumable intent and a playing cue waits for the next start',async()=>{
 const s=activeProject(),id=s.active.store.snapshot.document.media[0].id;let generation=0;
 const api={available:()=>true,devices:async()=>[],listen:async()=>()=>{},control:vi.fn(async()=>({...emptyPlayback,generation:++generation,state:'paused' as const})),configure:vi.fn(async(r:PlaybackRequest)=>({...emptyPlayback,generation:++generation,projectId:r.projectId,mediaId:r.mediaId,state:'playing' as const}))};
 const hook=renderHook(()=>usePlayback(s.active,id,undefined,api));
 act(()=>hook.result.current.playFrom(s.active,id,.2));await waitFor(()=>expect(api.configure).toHaveBeenCalledTimes(1));
 act(()=>hook.result.current.toggle());await waitFor(()=>expect(hook.result.current.playing).toBe(false));
 act(()=>hook.result.current.setCue(s.active,id,1.2));act(()=>hook.result.current.toggle());await waitFor(()=>expect(api.configure).toHaveBeenCalledTimes(2));expect(api.configure.mock.calls[1][0].seekSeconds).toBe(1.2);
 act(()=>hook.result.current.setCue(s.active,id,1.7));await act(async()=>{});expect(api.configure).toHaveBeenCalledTimes(2);expect(hook.result.current.playing).toBe(true);
 act(()=>hook.result.current.stop());await act(async()=>{});act(()=>hook.result.current.toggle());await waitFor(()=>expect(api.configure).toHaveBeenCalledTimes(3));expect(api.configure.mock.calls[2][0].seekSeconds).toBe(1.7);hook.unmount();s.active.lifecycle.dispose();
});
it('retires a paused stream only on fresh cue Play so the new session start and Stop return use that cue',async()=>{
 const s=activeProject(),id=s.active.store.snapshot.document.media[0].id;let stream={...emptyPlayback},generation=0;
 const api={available:()=>true,devices:async()=>[],listen:async()=>()=>{},control:vi.fn(async(action:string)=>{stream={...stream,generation:++generation,state:action==='pause'?'paused':'stopped',positionSeconds:action==='stop'?stream.startSeconds:stream.positionSeconds};return stream;}),configure:vi.fn(async(q:PlaybackRequest)=>{const position=q.seekSeconds??stream.positionSeconds;stream={...stream,projectId:q.projectId,mediaId:q.mediaId,generation:++generation,state:'playing',positionSeconds:position,startSeconds:stream.state==='paused'?stream.startSeconds:position};return stream;})};
 const hook=renderHook(()=>usePlayback(s.active,id,undefined,api));act(()=>hook.result.current.setCue(s.active,id,.2));act(()=>hook.result.current.toggle());await waitFor(()=>expect(hook.result.current.status.state).toBe('playing'));act(()=>hook.result.current.toggle());await waitFor(()=>expect(hook.result.current.status.state).toBe('paused'));
 const controls=api.control.mock.calls.length;act(()=>hook.result.current.setCue(s.active,id,1.2));await act(async()=>{});expect(api.control).toHaveBeenCalledTimes(controls);expect(api.configure).toHaveBeenCalledOnce();
 act(()=>hook.result.current.toggle());await waitFor(()=>expect(api.configure).toHaveBeenCalledTimes(2));expect(hook.result.current.status.startSeconds).toBe(1.2);act(()=>hook.result.current.stop());await waitFor(()=>expect(hook.result.current.status.state).toBe('stopped'));expect(hook.result.current.status.positionSeconds).toBe(1.2);hook.unmount();s.active.lifecycle.dispose();
});
it('queues fresh cue retirement when Play follows Pause before its acknowledgement',async()=>{
 const s=activeProject(),id=s.active.store.snapshot.document.media[0].id;let stream={...emptyPlayback},generation=0,releasePause!:()=>void;
 const api={available:()=>true,devices:async()=>[],listen:async()=>()=>{},control:vi.fn(async(action:string)=>{if(action==='pause')await new Promise<void>(resolve=>releasePause=resolve);stream={...stream,generation:++generation,state:action==='pause'?'paused':'stopped',positionSeconds:action==='stop'?stream.startSeconds:stream.positionSeconds};return stream;}),configure:vi.fn(async(q:PlaybackRequest)=>{const position=q.seekSeconds??stream.positionSeconds;stream={...stream,projectId:q.projectId,mediaId:q.mediaId,generation:++generation,state:'playing',positionSeconds:position,startSeconds:stream.state==='paused'?stream.startSeconds:position};return stream;})};
 const hook=renderHook(()=>usePlayback(s.active,id,undefined,api));act(()=>hook.result.current.setCue(s.active,id,.2));act(()=>hook.result.current.toggle());await waitFor(()=>expect(hook.result.current.status.state).toBe('playing'));
 const controls=api.control.mock.calls.length;act(()=>hook.result.current.setCue(s.active,id,1.2));expect(api.control).toHaveBeenCalledTimes(controls);act(()=>{hook.result.current.toggle();hook.result.current.toggle();});await waitFor(()=>expect(releasePause).toBeTypeOf('function'));await act(async()=>releasePause());await waitFor(()=>expect(api.configure).toHaveBeenCalledTimes(2));expect(hook.result.current.status.startSeconds).toBe(1.2);act(()=>hook.result.current.stop());await waitFor(()=>expect(hook.result.current.status.state).toBe('stopped'));expect(hook.result.current.status.positionSeconds).toBe(1.2);hook.unmount();s.active.lifecycle.dispose();
});
it('blank cue plus selection deactivation during playback does not interrupt the current stream',async()=>{
 const s=activeProject(),r=s.active.store.snapshot.document.annotations[0].region;let generation=0;
 const api={available:()=>true,devices:async()=>[],listen:async()=>()=>{},control:vi.fn(async()=>({...emptyPlayback,generation:++generation})),configure:vi.fn(async(q:PlaybackRequest)=>({...emptyPlayback,generation:++generation,projectId:q.projectId,mediaId:q.mediaId,state:'playing' as const}))};
 const hook=renderHook(({selection})=>usePlayback(s.active,r.mediaId,selection,api),{initialProps:{selection:r as typeof r|undefined}});act(()=>hook.result.current.toggle());await waitFor(()=>expect(api.configure).toHaveBeenCalledOnce());const controls=api.control.mock.calls.length;
 act(()=>{hook.result.current.setCue(s.active,r.mediaId,1.7);hook.rerender({selection:undefined});});await act(async()=>{});expect(hook.result.current.playing).toBe(true);expect(api.control).toHaveBeenCalledTimes(controls);expect(api.configure).toHaveBeenCalledOnce();
 hook.unmount();s.active.lifecycle.dispose();
});
it('a retained reset-mask command cannot cross a runtime replacement',async()=>{
 const first=activeProject(),second=activeProject(),hook=renderHook(({owner})=>useMasks(owner),{initialProps:{owner:first.active}}),command=hook.result.current.command;hook.rerender({owner:second.active});act(()=>command({type:'resetMediaMasks',mediaId:first.active.store.snapshot.document.media[0].id}));await act(async()=>{});expect(first.applyChange).not.toHaveBeenCalled();expect(second.applyChange).not.toHaveBeenCalled();hook.unmount();first.active.lifecycle.dispose();second.active.lifecycle.dispose();
});
