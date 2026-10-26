import { StrictMode, useSyncExternalStore } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import fixture from '../../../tests/fixtures/document-v3.json';
import { parseProjectDocument, type Change } from '../../bridge/types';
import { ProjectStore } from '../../app/store';
import { CommandQueue } from '../../app/commands';
import { ProjectLifecycle } from '../project/lifecycle';
import { SelectionContext, useSelection, type SelectionUI } from '../selection/useSelection';
import { RegionGainDialog } from './RegionGainDialog';
import { MonitorGainControl } from './MonitorGainControl';
import { usePlayback, type PlaybackUI } from './usePlayback';
import { emptyPlayback, type PlaybackRequest } from '../../bridge/playback';
import { PreferenceDraft } from '../collaboration/controller';
import type { ActiveProject } from '../project/useProjectLifecycle';

beforeEach(()=>vi.stubGlobal('ResizeObserver',class {observe(){} disconnect(){}}));
function rig(){
 const document=parseProjectDocument(structuredClone(fixture)),store=new ProjectStore({document,canUndo:false,canRedo:false});
 const apply=vi.fn(async(_id:string,revision:number,change:Change)=>{const doc=structuredClone(store.snapshot.document);doc.revision=revision+1;if(change.type==='addEdit')doc.edits.push(change.edit);return{...store.snapshot,document:doc};});
 const queue=new CommandQueue(store,{applyChange:apply,getSnapshot:async()=>store.snapshot,undo:async()=>store.snapshot,redo:async()=>store.snapshot});
 const lifecycle=new ProjectLifecycle(store,queue,{save:async(_,r)=>r,close:async()=>{}});const owner:ActiveProject={store,queue,lifecycle,path:''};
 return{owner,apply,media:document.media[0],finish:()=>{owner.preferences?.dispose();lifecycle.dispose();}};
}
function gainRig(strict=false){
 const s=rig();let ui!:SelectionUI,owner=s.owner;
 function App(){useSyncExternalStore(owner.store.subscribe,()=>owner.store.snapshot);ui=useSelection(owner,s.media.id);return <div className="app-root"><SelectionContext.Provider value={ui}><button onClick={e=>ui.openGain(ui.selection!,e.currentTarget)}>区域增益</button><RegionGainDialog ui={ui}/></SelectionContext.Provider></div>;}
 const app=()=>strict?<StrictMode><App/></StrictMode>:<App/>;const view=render(app());const target={region:s.owner.store.snapshot.document.annotations[0].region,object:null};act(()=>ui.state.select(target));
 return{...s,ui:()=>ui,target,view,replace:()=>{owner={...s.owner};view.rerender(app());},finish:()=>{view.unmount();s.finish();}};
}
it('gain dialog validates values, applies only explicitly, keeps zero out of history, restores focus outside and on Escape',async()=>{
 const s=gainRig(),trigger=screen.getByRole('button',{name:'区域增益'});trigger.focus();fireEvent.click(trigger);expect(screen.getByRole('dialog')).toHaveFocus();expect(document.querySelector<HTMLElement>('.app-root')?.inert).toBe(true);
 fireEvent.change(screen.getByLabelText('区域增益（dB）'),{target:{value:'25'}});expect(screen.getByRole('button',{name:'应用增益'})).toBeDisabled();expect(s.apply).not.toHaveBeenCalled();
 fireEvent.keyDown(screen.getByRole('dialog'),{key:'Escape'});expect(trigger).toHaveFocus();fireEvent.click(trigger);fireEvent.pointerDown(document.querySelector('.dialog-backdrop')!);expect(trigger).toHaveFocus();
 fireEvent.click(trigger);fireEvent.click(screen.getByRole('button',{name:'应用增益'}));await waitFor(()=>expect(screen.queryByRole('dialog')).toBeNull());expect(s.apply).not.toHaveBeenCalled();expect(s.ui().selection).toBe(s.target);s.finish();
});
it('failed gain retains selection and input, retries the rejected command once and clears on acknowledgement',async()=>{
 const s=gainRig();s.apply.mockRejectedValueOnce({code:'InvalidInput',message:'gain failed',retryable:true});fireEvent.click(screen.getByRole('button',{name:'区域增益'}));fireEvent.change(screen.getByLabelText('区域增益（dB）'),{target:{value:'-6'}});fireEvent.click(screen.getByRole('button',{name:'应用增益'}));await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent('gain failed'));
 expect(s.ui().selection).toBe(s.target);expect(screen.getByLabelText('区域增益（dB）')).toHaveValue(-6);fireEvent.click(screen.getByRole('button',{name:'重试应用'}));await waitFor(()=>expect(screen.queryByRole('dialog')).toBeNull());expect(s.apply).toHaveBeenCalledTimes(2);expect(s.owner.store.snapshot.document.edits.filter(e=>e.operation.type==='gain')).toHaveLength(1);expect(s.ui().selection).toBeNull();s.finish();
});
it.each([false,true])('pending gain completion cannot clear a new selection, close its dialog or restore obsolete focus (StrictMode=%s)',async strict=>{
 const s=gainRig(strict);let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});const hold=s.owner.lifecycle.enqueueEdit(()=>gate);
 fireEvent.click(screen.getByRole('button',{name:'区域增益'}));fireEvent.change(screen.getByLabelText('区域增益（dB）'),{target:{value:'6'}});fireEvent.click(screen.getByRole('button',{name:'应用增益'}));
 const next={region:{...s.target.region,lowHz:2},object:null};act(()=>s.ui().state.select(next));expect(screen.queryByRole('dialog')).toBeNull();fireEvent.click(screen.getByRole('button',{name:'区域增益'}));const dialog=screen.getByRole('dialog');await act(async()=>{release();await hold;await s.owner.lifecycle.submitDrafts();});expect(screen.getByRole('dialog')).toBe(dialog);expect(s.ui().selection).toBe(next);s.finish();
});
it('monitor UI keeps equal numeric media values as explicit override and restores follow without reconfiguring audio',async()=>{
 const s=rig();let ui!:PlaybackUI;const api={available:()=>false,devices:async()=>[],listen:async()=>()=>{},control:async()=>emptyPlayback,configure:vi.fn(async()=>emptyPlayback)};
 function App(){ui=usePlayback(s.owner,s.media.id,undefined,api);return <MonitorGainControl ui={ui}/>;}const view=render(<App/>);
 fireEvent.click(screen.getByRole('button',{name:'监听增益'}));fireEvent.change(screen.getByLabelText('监听增益（dB）'),{target:{value:'6'}});expect(ui.effectiveMonitorGainDb).toBe(6);
 fireEvent.change(screen.getByLabelText('监听目标'),{target:{value:'media'}});fireEvent.change(screen.getByLabelText('监听增益（dB）'),{target:{value:''}});fireEvent.change(screen.getByLabelText('监听增益（dB）'),{target:{value:'6'}});expect(ui.monitor.mediaMonitorGainDb[s.media.id]).toBe(6);expect(screen.getByRole('button',{name:'恢复跟随全局'})).toBeEnabled();
 fireEvent.click(screen.getByRole('button',{name:'恢复跟随全局'}));expect(ui.monitor.mediaMonitorGainDb[s.media.id]).toBeNull();expect(ui.effectiveMonitorGainDb).toBe(6);fireEvent.keyDown(screen.getByRole('dialog'),{key:'Escape'});expect(screen.getByRole('button',{name:'监听增益'})).toHaveFocus();expect(api.configure).not.toHaveBeenCalled();view.unmount();s.finish();
});
it('monitor preferences and realtime failures remain independently reachable and retriable',async()=>{
 const s=rig(),preferences=vi.fn().mockRejectedValueOnce({code:'SaveFailed',message:'preferences disk failed',retryable:true}).mockResolvedValue(undefined);Object.assign(s.owner,{preferences:new PreferenceDraft(s.owner,{preferences} as never)});let ui!:PlaybackUI,generation=0;
 const monitorGain=vi.fn().mockRejectedValueOnce({code:'DeviceFailed',message:'monitor device failed',retryable:true}).mockResolvedValue(undefined);
 const api={available:()=>true,devices:async()=>[],listen:async()=>()=>{},control:async()=>({...emptyPlayback,generation:++generation}),configure:async(q:PlaybackRequest)=>({...emptyPlayback,generation:++generation,projectId:q.projectId,mediaId:q.mediaId,state:'playing' as const}),monitorGain};
 function App(){ui=usePlayback(s.owner,s.media.id,undefined,api);return <MonitorGainControl ui={ui}/>;}const view=render(<App/>);act(()=>ui.toggle());await waitFor(()=>expect(ui.playing).toBe(true));await act(async()=>{});
 fireEvent.click(screen.getByRole('button',{name:'监听增益'}));fireEvent.change(screen.getByLabelText('监听增益（dB）'),{target:{value:'3'}});await waitFor(()=>expect(screen.getByRole('button',{name:'重试监听'})).toBeInTheDocument());await act(async()=>{await s.owner.lifecycle.save().catch(()=>{});});expect(screen.getByRole('button',{name:'重试保存偏好'})).toBeInTheDocument();
 fireEvent.click(screen.getByRole('button',{name:'重试监听'}));await waitFor(()=>expect(screen.queryByRole('button',{name:'重试监听'})).toBeNull());expect(screen.getByRole('button',{name:'重试保存偏好'})).toBeInTheDocument();fireEvent.click(screen.getByRole('button',{name:'重试保存偏好'}));await waitFor(()=>expect(screen.queryByRole('button',{name:'重试保存偏好'})).toBeNull());expect(ui.monitor.monitorGainDb).toBe(3);expect(monitorGain).toHaveBeenCalledTimes(2);view.unmount();s.finish();
});
import { TransportBar } from './TransportBar';
it('transport adapts to its measured container and keeps sound source and volume reachable through compact controls',()=>{
 const s=rig();let measure!:ResizeObserverCallback;vi.stubGlobal('ResizeObserver',class {constructor(callback:ResizeObserverCallback){measure=callback;}observe(){}disconnect(){}});
 const api={available:()=>false,devices:async()=>[],listen:async()=>()=>{},control:async()=>emptyPlayback,configure:async()=>emptyPlayback};
 function App(){const ui=usePlayback(s.owner,s.media.id,undefined,api);return <TransportBar ui={ui} hasSelection onGain={vi.fn()}/>;}const view=render(<App/>);
 expect(measure).toBeTypeOf('function');act(()=>measure([{contentRect:{width:420}} as ResizeObserverEntry],{} as ResizeObserver));expect(screen.getByLabelText('播放控制')).toHaveAttribute('data-density','minimal');expect(screen.queryByRole('button',{name:'应用区域增益'})).toBeNull();expect(screen.queryByLabelText('声音版本')).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'更多播放操作'}));fireEvent.click(screen.getByRole('menuitem',{name:'声音版本'}));expect(screen.getByRole('menuitem',{name:'原音'})).toBeInTheDocument();fireEvent.keyDown(screen.getAllByRole('menu').at(-1)!,{key:'Escape'});fireEvent.keyDown(screen.getByRole('menu'),{key:'Escape'});
 fireEvent.click(screen.getByRole('button',{name:'监听增益'}));expect(screen.getByLabelText('输出音量')).toBeInTheDocument();fireEvent.keyDown(screen.getByRole('dialog'),{key:'Escape'});
 act(()=>measure([{contentRect:{width:1100}} as ResizeObserverEntry],{} as ResizeObserver));expect(screen.getByLabelText('播放控制')).toHaveAttribute('data-density','full');expect(screen.getByRole('button',{name:'应用区域增益'})).toBeInTheDocument();expect(screen.getByLabelText('声音版本')).toBeInTheDocument();view.unmount();s.finish();
});

it('StrictMode zero-gain completion closes cleanly without native content/history and allows another dismissible dialog',async()=>{
 const s=gainRig(true);try{const before=s.owner.store.snapshot,trigger=screen.getByRole('button',{name:'区域增益'});fireEvent.click(trigger);fireEvent.click(screen.getByRole('button',{name:'应用增益'}));await waitFor(()=>expect(screen.queryByRole('dialog')).toBeNull());
 expect(s.apply).not.toHaveBeenCalled();expect(s.owner.store.snapshot).toBe(before);expect(s.owner.store.snapshot.canUndo).toBe(false);expect(s.ui().selection).toBe(s.target);fireEvent.click(trigger);expect(screen.getByRole('button',{name:'取消'})).toBeEnabled();fireEvent.keyDown(screen.getByRole('dialog'),{key:'Escape'});expect(screen.queryByRole('dialog')).toBeNull();expect(trigger).toHaveFocus();}finally{s.finish();}
});
it('StrictMode gain rejection leaves a usable retry that accepts exactly one gain',async()=>{
 const s=gainRig(true);try{s.apply.mockRejectedValueOnce({code:'InvalidInput',message:'StrictMode gain failed',retryable:true});fireEvent.click(screen.getByRole('button',{name:'区域增益'}));fireEvent.change(screen.getByLabelText('区域增益（dB）'),{target:{value:'-6'}});fireEvent.click(screen.getByRole('button',{name:'应用增益'}));await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent('StrictMode gain failed'));
 expect(screen.getByRole('button',{name:'取消'})).toBeEnabled();expect(screen.getByLabelText('区域增益（dB）')).toHaveValue(-6);expect(s.ui().selection).toBe(s.target);fireEvent.click(screen.getByRole('button',{name:'重试应用'}));await waitFor(()=>expect(screen.queryByRole('dialog')).toBeNull());expect(s.apply).toHaveBeenCalledTimes(2);expect(s.owner.queue.unresolvedFailures).toHaveLength(0);expect(s.owner.store.snapshot.document.edits.filter(e=>e.operation.type==='gain')).toHaveLength(1);expect(s.ui().selection).toBeNull();}finally{s.finish();}
});
it.each(['Escape','outside'])('StrictMode gain rejection remains dismissible by %s with input and selection retained until dismissal',async dismiss=>{
 const s=gainRig(true);try{const before=s.owner.store.snapshot,trigger=screen.getByRole('button',{name:'区域增益'});s.apply.mockRejectedValueOnce({code:'InvalidInput',message:'StrictMode dismiss failure',retryable:true});trigger.focus();fireEvent.click(trigger);fireEvent.change(screen.getByLabelText('区域增益（dB）'),{target:{value:'6'}});fireEvent.click(screen.getByRole('button',{name:'应用增益'}));await waitFor(()=>expect(screen.getByRole('button',{name:'重试应用'})).toBeEnabled());
 expect(screen.getByLabelText('区域增益（dB）')).toHaveValue(6);expect(screen.getByRole('button',{name:'取消'})).toBeEnabled();if(dismiss==='Escape')fireEvent.keyDown(screen.getByRole('dialog'),{key:'Escape'});else fireEvent.pointerDown(document.querySelector('.dialog-backdrop')!);expect(screen.queryByRole('dialog')).toBeNull();expect(trigger).toHaveFocus();expect(s.ui().selection).toBe(s.target);expect(s.owner.store.snapshot).toBe(before);expect(s.owner.queue.unresolvedFailures).toHaveLength(1);}finally{s.finish();}
});
