import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import fixture from '../../../tests/fixtures/document-v3.json';
import { inspectionClient } from '../../bridge/inspection';
import { emptyPlayback, playbackClient } from '../../bridge/playback';
import { ProjectStore } from '../../app/store';
import type { ActiveProject } from '../project/useProjectLifecycle';
import { InspectionViewer } from './InspectionViewer';
import { resolveOwnInspection } from './targets';
import * as adapter from './adapter';
vi.mock('../spectrogram/SpectrogramCanvas', () => ({ SpectrogramCanvas: ({ settings, view, active, analysisSource, children }: any) => <div className="spectrogram-surface" tabIndex={0}><output data-testid="spectrum" data-owner={active.store.snapshot.document.projectId}>{JSON.stringify({settings,view,analysisSource})}</output>{children}</div> }));
function setup() {
 vi.restoreAllMocks();
 const owner = { store: new ProjectStore({ document: structuredClone(fixture) as never, canUndo: false, canRedo: false }), lifecycle: { registerBackgroundGuard: vi.fn(() => vi.fn()) } } as unknown as ActiveProject;
 const target = { owner, scope: 'region' as const, annotationId: fixture.annotations[0].id }, value = resolveOwnInspection(target)!;
 const binding = { runtimeNonce: crypto.randomUUID(), projectId: fixture.projectId }, previewId = crypto.randomUUID();
 const snapshot = structuredClone(owner.store.snapshot); snapshot.document.projectId = previewId; snapshot.document.annotations = []; snapshot.document.media = [snapshot.document.media[0]];
 vi.spyOn(inspectionClient, 'open').mockResolvedValue({ previewId, snapshot }); vi.spyOn(inspectionClient,'close').mockResolvedValue();
 vi.spyOn(inspectionClient,'status').mockResolvedValue([{mediaId:value.media.id,status:'ready'}]);
 vi.spyOn(inspectionClient,'configure').mockResolvedValue({...emptyPlayback,projectId:previewId,mediaId:value.media.id,generation:1,state:'playing'});
 vi.spyOn(playbackClient,'available').mockReturnValue(false);
 const playback = { stopAndWait: vi.fn(async () => {}), options: { volume: .8, deviceId: null, looping: false }, monitor: { monitorGainDb: 0 } } as any;
 return { owner, target, value, binding, playback, onClose: vi.fn(), onJump: vi.fn(async () => true) };
}
it('shows read-only metadata, native spectrum and independent controls without touching main state; closes without autoplay', async () => {
 const p = setup(), before = p.owner.store.snapshot; const ui = render(<InspectionViewer {...p}/>);
 await screen.findByTestId('spectrum'); expect(p.playback.stopAndWait).toHaveBeenCalledOnce(); expect(inspectionClient.configure).not.toHaveBeenCalled();
 expect(screen.getByRole('dialog')).toHaveTextContent('区域备注'); expect(screen.queryByRole('textbox')).toBeNull();
 fireEvent.change(screen.getByLabelText('查看频谱类型'), {target:{value:'mel'}});
 expect(screen.getByTestId('spectrum')).toHaveTextContent('mel'); fireEvent.click(screen.getByRole('button',{name:'重置视图'})); expect(screen.getByLabelText('正在查看的标注框')).toBeInTheDocument();
 expect(p.owner.store.snapshot).toBe(before); fireEvent.click(screen.getByRole('button',{name:'播放区域'}));
 await waitFor(()=>expect(inspectionClient.configure).toHaveBeenCalledWith(p.binding,expect.any(String),expect.objectContaining({mode:expect.objectContaining({mode:'selection',selectionSource:'original'})})));
 ui.unmount(); expect(inspectionClient.close).toHaveBeenCalledOnce();
});
it('keeps modal on failed jump, closes only after a successful jump and prevents duplicate requests', async () => {
 const p=setup(); p.onJump.mockResolvedValueOnce(false); render(<InspectionViewer {...p}/>); await screen.findByTestId('spectrum');
 fireEvent.click(screen.getByRole('button',{name:'跳转到音频'})); await act(async()=>{}); expect(p.onClose).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button',{name:'跳转到音频'})); await waitFor(()=>expect(p.onClose).toHaveBeenCalledOnce());
});
it('source deletion stops owned preview and leaves a focused unavailable modal', async () => {
 const p=setup(), ui=render(<InspectionViewer {...p}/>); await screen.findByTestId('spectrum');
 ui.rerender(<InspectionViewer {...p} value={null}/>); await waitFor(()=>expect(inspectionClient.close).toHaveBeenCalledOnce());
 expect(screen.getByRole('dialog')).toHaveTextContent('不可用'); expect(screen.getByRole('button',{name:'跳转到音频'})).toBeDisabled();
});
it('keeps whole-file audition when seeking and uses live scalar gain without configuring', async () => {
 const p=setup(); render(<InspectionViewer {...p} value={{...p.value,annotation:undefined}}/>); await screen.findByTestId('spectrum');
 fireEvent.click(screen.getByRole('button',{name:'播放音频'})); await waitFor(()=>expect(inspectionClient.configure).toHaveBeenCalledOnce());
 fireEvent.change(screen.getByLabelText('查看播放位置'),{target:{value:'.05'}});
 await waitFor(()=>expect(inspectionClient.configure).toHaveBeenCalledTimes(2));
 expect(vi.mocked(inspectionClient.configure).mock.lastCall?.[2].mode).toEqual({mode:'original'});
 vi.spyOn(inspectionClient,'monitorGain').mockResolvedValue({...emptyPlayback,projectId:vi.mocked(inspectionClient.configure).mock.lastCall![1],mediaId:p.value.media.id,generation:1,state:'playing'});
 fireEvent.change(screen.getByLabelText('查看监听增益'),{target:{value:'7'}});
 await waitFor(()=>expect(inspectionClient.monitorGain).toHaveBeenCalledOnce()); expect(inspectionClient.configure).toHaveBeenCalledTimes(2);
});
it('analysis replaces the canvas adapter after native retires leases and does not write to the source', async () => {
 const p=setup(), before=p.owner.store.snapshot;
 const adapters=vi.spyOn(adapter,'inspectionProject');
 vi.spyOn(inspectionClient,'configureAnalysis').mockImplementation(async(_b,_id,settings)=>{
  const snapshot=structuredClone(vi.mocked(inspectionClient.open).mock.results[0] ? await vi.mocked(inspectionClient.open).mock.results[0].value : before);
  const next='snapshot' in snapshot?snapshot.snapshot:snapshot; next.document.analysis[p.value.media.id]=settings; return next;
 });
 render(<InspectionViewer {...p}/>); await screen.findByTestId('spectrum');
 fireEvent.change(screen.getByLabelText('查看步长'),{target:{value:'256'}}); fireEvent.click(screen.getByRole('button',{name:'应用分析参数'}));
 await waitFor(()=>expect(screen.getByTestId('spectrum')).toHaveTextContent('"hopSize":256'));
 expect(adapters).toHaveBeenCalledTimes(2); expect(adapters.mock.results[0].value).not.toBe(adapters.mock.results[1].value);
 expect(p.owner.store.snapshot).toBe(before); expect(inspectionClient.configure).not.toHaveBeenCalled();
});
it('registers an idle guard, traps Escape/Tab, restores safe focus when the source row disappears', async()=>{
 const p=setup(), release=vi.fn(); vi.mocked(p.owner.lifecycle.registerBackgroundGuard).mockReturnValue(release);
 const root=document.createElement('div'); root.className='app-root';
 const tab=document.createElement('button'); tab.setAttribute('aria-selected','true'); const tabs=document.createElement('div'); tabs.className='inspector-tabs'; tabs.append(tab); root.append(tabs);
 const row=document.createElement('button'); root.append(row); document.body.append(root); row.focus();
 const ui=render(<InspectionViewer {...p}/>); await screen.findByTestId('spectrum');
 expect(root.inert).toBe(true); const guard=vi.mocked(p.owner.lifecycle.registerBackgroundGuard).mock.calls[0][0]; expect(guard()).toBe(false);
 row.remove(); fireEvent.keyDown(screen.getByRole('dialog'),{key:'Escape'}); expect(p.onClose).toHaveBeenCalledOnce();
 ui.unmount(); expect(root.inert).toBe(false); expect(document.activeElement).toBe(tab); expect(release).toHaveBeenCalledOnce(); root.remove();
});
it('refreshes its native source when main media metadata changes without replaying stale audition', async()=>{
 const p=setup(),ui=render(<InspectionViewer {...p}/>); await screen.findByTestId('spectrum');
 fireEvent.change(screen.getByLabelText('查看步长'),{target:{value:'256'}});
 ui.rerender(<InspectionViewer {...p} value={{...p.value,note:'new source note',media:{...p.value.media,note:'new source note'}}}/>);
 await waitFor(()=>expect(inspectionClient.open).toHaveBeenCalledTimes(2));
 expect(vi.mocked(inspectionClient.open).mock.lastCall?.[2].hopSize).toBe(p.owner.store.snapshot.document.analysis[p.value.media.id].hopSize);
 expect(screen.getByRole('dialog')).toHaveTextContent('new source note'); expect(inspectionClient.configure).not.toHaveBeenCalled();
});
it('auditions original audio and keeps private processing controls out of annotation review',async()=>{
 const p=setup(); render(<InspectionViewer {...p}/>); await screen.findByTestId('spectrum');
 expect(screen.queryByLabelText('查看试听来源')).toBeNull();
 expect(screen.getByTestId('spectrum')).toHaveTextContent('"analysisSource":"original"');
 fireEvent.click(screen.getByRole('button',{name:'播放区域'})); await waitFor(()=>expect(inspectionClient.configure).toHaveBeenCalledOnce());
 expect(vi.mocked(inspectionClient.configure).mock.lastCall?.[2].mode).toMatchObject({mode:'selection',selectionSource:'original'});
});
it('keeps the target frame through reset/analysis/channel changes and isolates review cue playback and resizing',async()=>{
 const p=setup(),before=p.owner.store.snapshot; render(<InspectionViewer {...p}/>); await screen.findByTestId('spectrum');
 const dialog=screen.getByRole('dialog'),surface=document.querySelector<HTMLElement>('.spectrogram-surface')!;
 vi.spyOn(surface,'getBoundingClientRect').mockReturnValue({left:100,top:100,width:500,height:300} as DOMRect);
 fireEvent.click(screen.getByRole('button',{name:'重置视图'}));
 expect(screen.getByLabelText('正在查看的标注框')).toBeVisible();
 fireEvent.keyDown(surface,{key:'0',ctrlKey:true}); expect(JSON.parse(screen.getByTestId('spectrum').textContent!).view.lowHz).toBe(0);
 fireEvent.click(screen.getByRole('button',{name:'最大化查看窗口'})); expect(dialog).toHaveClass('is-maximized');
 fireEvent.click(screen.getByRole('button',{name:'还原查看窗口'})); expect(dialog).not.toHaveClass('is-maximized');
 fireEvent.click(screen.getByLabelText('分析与显示设置')); expect(document.querySelector('details')).toHaveAttribute('open');
 fireEvent.pointerDown(surface); expect(document.querySelector('details')).not.toHaveAttribute('open');
 fireEvent.contextMenu(surface,{clientX:350,clientY:200}); expect(screen.getByLabelText('查看播放起点')).toHaveStyle({left:'50%'});
 fireEvent.click(screen.getByRole('menuitem',{name:'从此处播放'}));
 await waitFor(()=>expect(inspectionClient.configure).toHaveBeenCalledOnce());
 expect(vi.mocked(inspectionClient.configure).mock.lastCall?.[2]).toMatchObject({mode:{mode:'original'},seekSeconds:1});
 expect(p.owner.store.snapshot).toBe(before);
 const previewId=vi.mocked(inspectionClient.configure).mock.lastCall![1];
 vi.spyOn(inspectionClient,'control').mockResolvedValue({...emptyPlayback,projectId:previewId,mediaId:p.value.media.id,generation:1,state:'paused',positionSeconds:1.2});
 fireEvent.click(screen.getByRole('button',{name:'暂停'}));await screen.findByRole('button',{name:'播放音频'});
 fireEvent.click(screen.getByRole('button',{name:'播放音频'}));await waitFor(()=>expect(inspectionClient.configure).toHaveBeenCalledTimes(2));
 expect(vi.mocked(inspectionClient.configure).mock.lastCall?.[2]).toMatchObject({mode:{mode:'original'},seekSeconds:null});
});
it('allows an empty numeric gain draft and applies a valid negative gain only to the inspection', async()=>{
 const p=setup(); render(<InspectionViewer {...p}/>); await screen.findByTestId('spectrum');
 const field=screen.getByLabelText('查看监听增益'); fireEvent.change(field,{target:{value:''}}); expect(field).toHaveValue(null);
 fireEvent.change(field,{target:{value:'-12.5'}}); fireEvent.click(screen.getByRole('button',{name:'播放音频'}));
 await waitFor(()=>expect(inspectionClient.configure).toHaveBeenCalledOnce());expect(vi.mocked(inspectionClient.configure).mock.lastCall?.[2].monitorGainDb).toBe(-12.5);
 expect(p.playback.monitor.monitorGainDb).toBe(0);
});
