import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import fixture from '../../../tests/fixtures/document-v3.json';
import { parseProjectDocument } from '../../bridge/types';
import { ProjectStore } from '../../app/store';
import { CommandQueue, type ProjectCommands } from '../../app/commands';
import { ProjectLifecycle } from '../project/lifecycle';
import { useWorkspace } from '../spectrogram/useWorkspace';
import { defaultSettings, defaultView } from '../spectrogram/workspace';
import { usePlayback } from '../playback/usePlayback';
import { emptyPlayback } from '../../bridge/playback';
import { emptyLocalPreferences, LocalSettingsProvider, LocalSettingsStore, localSettingsKey, parseLocalPreferences } from './localSettings';
import { GlobalSettings } from './GlobalSettings';

function memory(){const data=new Map<string,string>();return {getItem:(k:string)=>data.get(k)??null,setItem:(k:string,v:string)=>{data.set(k,v);}};}
function owner(){
 const document=parseProjectDocument(structuredClone(fixture));document.viewState.media={};document.viewState.activeMediaId=document.media[0].id;document.viewState.compareMediaId=null;
 const second={...structuredClone(document.media[0]),id:'22222222-2222-4222-8222-222222222222',displayName:'Second.wav'};document.media.push(second);document.analysis[second.id]={...defaultSettings};
 const store=new ProjectStore({document,canUndo:false,canRedo:false});
 const apply=vi.fn<ProjectCommands['applyChange']>(async(_id,revision,change)=>({...store.snapshot,document:{...store.snapshot.document,revision:revision+1,...(change.type==='updateViewState'?{viewState:change.viewState}:change.type==='updateAnalysis'?{analysis:{...store.snapshot.document.analysis,[change.mediaId]:change.settings}}:{})}}));
 const queue=new CommandQueue(store,{applyChange:apply,getSnapshot:async()=>store.snapshot,undo:async()=>store.snapshot,redo:async()=>store.snapshot}),lifecycle=new ProjectLifecycle(store,queue,{save:async(_,r)=>r,close:async()=>{}});
 return {store,queue,lifecycle,path:'owned',apply};
}
const wrap=(store:LocalSettingsStore)=>({children}:{children:ReactNode})=><LocalSettingsProvider store={store}>{children}</LocalSettingsProvider>;
it('persists zero, +20 dB and mel; per-file exceptions do not leak across projects and applying globals clears relevant exceptions',()=>{
 const storage=memory(),store=new LocalSettingsStore(storage);
 expect(store.applyGlobal({display:{frequencyMix:0,spectrumKind:'mel'},playback:{monitorGainDb:20},analysis:defaultSettings})).toBe(true);
 store.patchMedia('project-a','file-a',{display:{frequencyMix:.3,palette:'ocean'},monitorGainDb:5});
 expect(store.override('project-b','file-a')).toEqual({});
 store.applyGlobal({display:{frequencyMix:0}});expect(store.override('project-a','file-a')).toEqual({display:{palette:'ocean'},monitorGainDb:5});
 const reopened=new LocalSettingsStore(storage);expect(reopened.value).toEqual(store.value);expect(reopened.value.display.frequencyMix).toBe(0);
 reopened.applyGlobal({playback:{monitorGainDb:20}});expect(reopened.override('project-a','file-a').monitorGainDb).toBeUndefined();
 reopened.follow('project-a','file-a',['display']);expect(reopened.value.overrides).toEqual({});
});
it('invalid persisted values and failed writes are reported without changing effective settings',()=>{
 const storage=memory();storage.setItem(localSettingsKey,JSON.stringify({...emptyLocalPreferences(),playback:{monitorGainDb:25}}));const store=new LocalSettingsStore(storage);expect(store.error).toBeTruthy();expect(store.value).toEqual(emptyLocalPreferences());
 expect(()=>parseLocalPreferences(JSON.stringify({...emptyLocalPreferences(),display:{frequencyMix:-1}}))).toThrow();
 expect(()=>parseLocalPreferences(JSON.stringify({...emptyLocalPreferences(),analysis:{...defaultSettings,fftSize:17}}))).toThrow();
 expect(store.applyGlobal({playback:{monitorGainDb:20}})).toBe(true);const before=store.value;
 vi.spyOn(storage,'setItem').mockImplementation(()=>{throw Error('disk full');});expect(store.applyGlobal({playback:{monitorGainDb:0}})).toBe(false);expect(store.value).toBe(before);expect(store.error).toContain('disk full');
});
it('global display wins over saved views, follows every file and new catalog entries, and leaves shared labels untouched',async()=>{
 const active=owner(),store=new LocalSettingsStore(memory()),[a,b]=active.store.snapshot.document.media,doc=active.store.snapshot.document;
 doc.viewState.media[a.id]={...defaultView(a),frequencyMix:.9,startSeconds:.1,endSeconds:.5};
 const before=structuredClone(doc);
 const hook=renderHook(()=>useWorkspace(active),{wrapper:wrap(store)});
 act(()=>{store.applyGlobal({display:{frequencyMix:0,spectrumKind:'mel'},analysis:{...defaultSettings,hopSize:256}});});
 expect(hook.result.current.view(a.id)).toMatchObject({frequencyMix:0,spectrumKind:'mel',startSeconds:.1,endSeconds:.5});expect(hook.result.current.view(b.id).frequencyMix).toBe(0);expect(active.store.snapshot.document).toEqual(before);
 act(()=>{hook.result.current.selectPane('primary',b.id);hook.result.current.patch(b.id,{frequencyMix:.2});});
 expect(hook.result.current.view(b.id).frequencyMix).toBe(.2);expect(hook.result.current.view(a.id).frequencyMix).toBe(0);
 act(()=>hook.result.current.followGlobal(b.id));expect(hook.result.current.view(b.id).frequencyMix).toBe(0);
 const c={...b,id:'33333333-3333-4333-8333-333333333333'};
 act(()=>active.store.accept({...active.store.snapshot,document:{...active.store.snapshot.document,media:[a,b,c]}}));expect(hook.result.current.view(c.id).spectrumKind).toBe('mel');expect(hook.result.current.analysis(c.id).hopSize).toBe(256);
 await act(()=>active.lifecycle.save());hook.unmount();active.lifecycle.dispose();
});
it('global monitoring follows files and owners; explicit per-file gain can return to follow without restarting playback',async()=>{
 const active=owner(),other=owner(),store=new LocalSettingsStore(memory()),[a,b]=active.store.snapshot.document.media;other.store.snapshot.document.projectId='33333333-3333-4333-8333-333333333333';
 store.applyGlobal({playback:{monitorGainDb:20,volume:.25,looping:true,source:'original'}});
 const api={available:()=>true,devices:async()=>[],listen:async()=>()=>{},control:vi.fn(async()=>emptyPlayback),configure:vi.fn(async(r:any)=>({...emptyPlayback,projectId:r.projectId,mediaId:r.mediaId,generation:1,state:'playing' as const})),monitorGain:vi.fn(async(r:any)=>({...emptyPlayback,...r,state:'playing' as const}))};
 const hook=renderHook(({owner:bound})=>usePlayback(bound,a.id,undefined,api),{initialProps:{owner:active},wrapper:wrap(store)});
 expect(hook.result.current.effectiveMonitorGainDb).toBe(20);expect(hook.result.current.options.volume).toBe(.25);expect(hook.result.current.workspaceSource).toBe('original');
 act(()=>hook.result.current.toggle());await waitFor(()=>expect(api.configure).toHaveBeenCalledOnce());expect(api.configure.mock.calls[0][0].monitorGainDb).toBe(20);
 act(()=>hook.result.current.setMediaMonitorGain(a.id,3));await waitFor(()=>expect(api.monitorGain).toHaveBeenLastCalledWith(expect.objectContaining({monitorGainDb:3})));
 expect(api.configure).toHaveBeenCalledOnce();act(()=>hook.result.current.setMediaMonitorGain(a.id,null));expect(hook.result.current.effectiveMonitorGainDb).toBe(20);
 act(()=>hook.result.current.selectSource(b.id));expect(hook.result.current.effectiveMonitorGainDb).toBe(20);hook.rerender({owner:other});expect(hook.result.current.effectiveMonitorGainDb).toBe(20);expect(hook.result.current.options.volume).toBe(.25);
 hook.unmount();active.lifecycle.dispose();other.lifecycle.dispose();
});
it('materializes analysis defaults lazily and renders accepted native settings until each acknowledgement',async()=>{
 const active=owner(),local=new LocalSettingsStore(memory()),[a,b]=active.store.snapshot.document.media;
 const apply=active.apply.getMockImplementation()!;let release!:()=>void;
 const gate=new Promise<void>(resolve=>{release=resolve;});active.apply.mockImplementationOnce(async(...args)=>{await gate;return apply(...args);});
 const hook=renderHook(()=>useWorkspace(active),{wrapper:wrap(local)});
 act(()=>{local.applyGlobal({analysis:{...defaultSettings,hopSize:256,melBands:64}});});
 await waitFor(()=>expect(active.apply).toHaveBeenCalledOnce());
 expect(hook.result.current.analysis(a.id).hopSize).toBe(256);expect(hook.result.current.renderAnalysis(a.id).hopSize).toBe(512);expect(active.store.snapshot.document.analysis[b.id].hopSize).toBe(512);
 await act(async()=>{release();await active.queue.flush();});expect(hook.result.current.renderAnalysis(a.id).hopSize).toBe(256);
 act(()=>hook.result.current.selectPane('primary',b.id));await waitFor(()=>expect(hook.result.current.renderAnalysis(b.id).hopSize).toBe(256));
 act(()=>hook.result.current.settings(b.id,{...defaultSettings,hopSize:128}));await waitFor(()=>expect(hook.result.current.renderAnalysis(b.id).hopSize).toBe(128));
 act(()=>hook.result.current.followGlobal(b.id));await waitFor(()=>expect(hook.result.current.renderAnalysis(b.id).hopSize).toBe(256));
 expect(active.store.snapshot.document.analysis[a.id].hopSize).toBe(256);await act(()=>active.lifecycle.save());hook.unmount();active.lifecycle.dispose();
});
it('global controls commit +20 dB, mel and linear zero together without requiring a project',()=>{
 const store=new LocalSettingsStore(memory());render(<GlobalSettings store={store} initialDisplay={defaultView(fixture.media[0] as never)} onClose={()=>{}}/>);
 fireEvent.change(screen.getByLabelText('全局监听增益（dB）'),{target:{value:'20'}});fireEvent.change(screen.getByLabelText('全局频谱类型'),{target:{value:'mel'}});fireEvent.change(screen.getByLabelText('全局线性对数混合'),{target:{value:'0'}});
 fireEvent.click(screen.getByText('应用到全部音频'));expect(store.value.display).toMatchObject({frequencyMix:0,spectrumKind:'mel'});expect(store.value.playback.monitorGainDb).toBe(20);expect(screen.getByRole('status')).toHaveTextContent('已保存');
});
