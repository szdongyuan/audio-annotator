import { expect,it,vi } from 'vitest';
import { act,fireEvent,render,renderHook,screen,waitFor } from '@testing-library/react';
import { audioSignature,actualSource,playbackShortcut } from './usePlayback';
import { ChannelMixer } from './ChannelMixer';
import { PlaybackModeControl } from './PlaybackMode';
import { usePlayback } from './usePlayback';
import {emptyPlayback,type PlaybackRequest,type PlaybackStatus} from '../../bridge/playback';
import fixture from '../../../tests/fixtures/document-v2.json';
import { parseProjectDocument,type Change } from '../../bridge/types';
import { ProjectStore } from '../../app/store';
import { CommandQueue } from '../../app/commands';
import { ProjectLifecycle } from '../project/lifecycle';
import { useMasks } from './useMasks';
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
it('selection controls send original and processed as distinct sources',()=>{
 const change=vi.fn();render(<PlaybackModeControl mode="selection" selectionSource="original" bypass={false} disabled={false} hasSelection onChange={change}/>);
 fireEvent.change(screen.getByLabelText('选区来源'),{target:{value:'processed'}});expect(change).toHaveBeenCalledWith({selectionSource:'processed'});
 expect(screen.getByLabelText('选区来源')).toHaveValue('original'); expect(screen.queryByText(/当前：/)).not.toBeInTheDocument();
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
