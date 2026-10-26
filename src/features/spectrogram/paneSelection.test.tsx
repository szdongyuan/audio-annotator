import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import fixture from '../../../tests/fixtures/document-v3.json';
import { parseProjectDocument } from '../../bridge/types';
import { ProjectStore } from '../../app/store';
import { CommandQueue, type ProjectCommands } from '../../app/commands';
import { ProjectLifecycle } from '../project/lifecycle';
import { useSelection } from '../selection/useSelection';
import { useWorkspace } from './useWorkspace';
import { defaultView } from './workspace';
import { AppShell } from '../../app/AppShell';
import type { ProjectLifecycleUI } from '../project/useProjectLifecycle';
import type { MediaUI } from '../media/useMedia';

function setup() {
  const document = parseProjectDocument(structuredClone(fixture)), first = document.media[0];
  document.media = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'].map(id => ({ ...first, id }));
  document.annotations = []; document.edits = [];
  document.viewState = { ...document.viewState, media: {}, activeMediaId: '11111111-1111-4111-8111-111111111111', compareMediaId: '22222222-2222-4222-8222-222222222222' };
  const store = new ProjectStore({ document, canUndo: false, canRedo: false });
  const apply = vi.fn<ProjectCommands['applyChange']>(async (_id, revision, change) => ({ ...store.snapshot, document: { ...store.snapshot.document, revision: revision + 1, ...(change.type === 'updateViewState' ? { viewState: change.viewState } : {}) } }));
  const queue = new CommandQueue(store, { applyChange: apply } as unknown as ProjectCommands);
  const lifecycle = new ProjectLifecycle(store, queue, { save: async (_, r) => r, close: vi.fn() });
  return { store, queue, lifecycle, path: 'project', apply };
}
it('retains an unresolved primary and its selection when an additive catalog sorts earlier, but honors new view authority and runtime', () => {
  const active = setup(), [earlier, original, compare] = active.store.snapshot.document.media;
  const initial = active.store.snapshot.document;
  initial.media = [original, compare]; initial.viewState = { ...initial.viewState, activeMediaId: null, compareMediaId: compare.id };
  const hook = renderHook(({ owner }) => {
    const workspace = useWorkspace(owner);
    const panes = [workspace.state.activeMediaId, workspace.state.compareMediaId].filter((id): id is string => !!id).map(mediaId => ({ mediaId, channels: [0, 1] }));
    return { workspace, selection: useSelection(owner, workspace.state.activeMediaId, panes) };
  }, { initialProps: { owner: active } });
  const selected = { region: { mediaId: original.id, channelIndex: 0, startSeconds: .01, endSeconds: .05, lowHz: 100, highHz: 1000 }, object: null };
  act(() => hook.result.current.selection.state.select(selected));
  const adopt = () => active.store.accept({ ...active.store.snapshot, document: { ...active.store.snapshot.document, revision: active.store.snapshot.document.revision + 1, media: [earlier, original, compare], viewState: structuredClone(initial.viewState) } });
  const select = hook.result.current.workspace.selectPane;
  act(() => { adopt(); expect(select('compare', original.id)).toBe(false); });
  expect(hook.result.current.workspace.state).toMatchObject({ activeMediaId: original.id, compareMediaId: compare.id });
  expect(hook.result.current.selection.selection).toBe(selected);
  act(adopt); // A later unchanged save/poll snapshot must not undo the retained fallback.
  act(() => hook.result.current.workspace.selectPane('primary', original.id));
  expect(hook.result.current.workspace.state.activeMediaId).toBe(original.id);
  expect(active.store.drafts.size).toBe(0); expect(active.apply).not.toHaveBeenCalled();
  const next = { ...active };
  hook.rerender({ owner: next });
  expect(hook.result.current.workspace.state.activeMediaId).toBe(earlier.id);
  expect(hook.result.current.selection.selection).toBeNull();
  act(() => active.store.accept({ ...active.store.snapshot, document: { ...active.store.snapshot.document, viewState: { ...initial.viewState, activeMediaId: original.id } } }));
  expect(hook.result.current.workspace.state.activeMediaId).toBe(original.id);
  act(adopt); // Undo restoring a null active ID is new authority and uses its normal fallback.
  expect(hook.result.current.workspace.state.activeMediaId).toBe(earlier.id);
  hook.unmount(); active.lifecycle.dispose();
});
it('selects each pane independently and rejects both duplicate directions without writing a draft', async () => {
  const active = setup(), hook = renderHook(() => useWorkspace(active));
  act(() => hook.result.current.selectPane('primary', '33333333-3333-4333-8333-333333333333'));
  expect(hook.result.current.state).toMatchObject({ activeMediaId: '33333333-3333-4333-8333-333333333333', compareMediaId: '22222222-2222-4222-8222-222222222222' });
  act(() => hook.result.current.selectPane('primary', '11111111-1111-4111-8111-111111111111'));
  act(() => hook.result.current.selectPane('compare', '33333333-3333-4333-8333-333333333333'));
  expect(hook.result.current.state).toMatchObject({ activeMediaId: '11111111-1111-4111-8111-111111111111', compareMediaId: '33333333-3333-4333-8333-333333333333' });
  await act(() => active.lifecycle.save());
  const state = hook.result.current.state, calls = active.apply.mock.calls.length;
  act(() => hook.result.current.selectPane('primary', '33333333-3333-4333-8333-333333333333'));
  expect(hook.result.current.state).toBe(state); expect(hook.result.current.duplicatePane).toBe('compare');
  act(() => hook.result.current.selectPane('compare', '11111111-1111-4111-8111-111111111111'));
  expect(hook.result.current.state).toBe(state); expect(hook.result.current.duplicatePane).toBe('primary');
  expect(active.store.drafts.size).toBe(0); expect(active.apply).toHaveBeenCalledTimes(calls);
  expect(active.store.snapshot.canUndo).toBe(false);
  hook.unmount(); active.lifecycle.dispose();
});
it('routes real sidebar/title/menu controls through the guard and preserves source on duplicate title clicks', () => {
  const active = setup(), [a, b, c] = active.store.snapshot.document.media;
  [a, b, c].forEach((m, i) => { m.displayName = `${'ABC'[i]}.wav`; });
  const project = { active, busy: false } as unknown as ProjectLifecycleUI;
  const mediaUI = { selected: a, selectedId: a.id, statuses: [a, b, c].map(m => ({ mediaId: m.id, status: 'missing' })), disabled: false, setSelectedId: vi.fn() } as unknown as MediaUI;
  const { container, unmount } = render(<AppShell project={project} mediaUI={mediaUI} />);
  const pair = () => [screen.getByRole('combobox', { name: '主面板音频' }), screen.getByRole('combobox', { name: '对比面板音频' })];
  const select = pair()[1]; fireEvent.pointerDown(select); fireEvent.focus(select); fireEvent.change(select, { target: { value: a.id } });
  expect(pair()[0]).toHaveValue(a.id); expect(pair()[1]).toHaveValue(b.id);
  expect(container.querySelector('[data-pane="primary"]')).toHaveClass('is-duplicate-target', 'is-playback-source');
  expect(active.store.drafts.size).toBe(0);
  fireEvent.click(container.querySelectorAll('.media-select')[2]); expect(pair()[0]).toHaveValue(c.id); expect(pair()[1]).toHaveValue(b.id);
  fireEvent.change(pair()[1], { target: { value: a.id } }); expect(pair()[0]).toHaveValue(c.id); expect(pair()[1]).toHaveValue(a.id);
  fireEvent.click(screen.getByRole('menuitem', { name: '视图' })); fireEvent.click(screen.getByRole('menuitem', { name: '双文件对比' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'C.wav' }));
  expect(pair()[0]).toHaveValue(c.id); expect(pair()[1]).toHaveValue(a.id);
  expect(mediaUI.setSelectedId).not.toHaveBeenCalled();
  unmount(); active.lifecycle.dispose();
});
it('dismisses settings when its target leaves or runtime changes and never revives the stale target', () => {
  const active = setup(), [a, b, c] = active.store.snapshot.document.media;
  [a, b, c].forEach((m, i) => { m.displayName = `${'ABC'[i]}.wav`; });
  const mediaUI = { selected: a, selectedId: a.id, statuses: [a, b, c].map(m => ({ mediaId: m.id, status: 'missing' })), disabled: false } as unknown as MediaUI;
  const project = { active, busy: false } as unknown as ProjectLifecycleUI;
  const ui = render(<AppShell project={project} mediaUI={mediaUI} />);
  fireEvent.click(screen.getByRole('button', { name: 'B.wav 分析设置' })); expect(screen.getByRole('dialog')).toBeInTheDocument();
  const saved = active.store.snapshot.document.viewState;
  act(() => active.store.accept({ ...active.store.snapshot, document: { ...active.store.snapshot.document, viewState: { ...saved, compareMediaId: c.id } } }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  act(() => active.store.accept({ ...active.store.snapshot, document: { ...active.store.snapshot.document, viewState: saved } }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'B.wav 分析设置' }));
  ui.rerender(<AppShell project={{ ...project, active: { ...active } }} mediaUI={mediaUI} />);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  ui.unmount(); active.lifecycle.dispose();
});
it('retained pane callbacks re-read the other pane and reject a replaced runtime', () => {
  const active = setup(), next = setup(), hook = renderHook(({ owner }) => useWorkspace(owner), { initialProps: { owner: active } });
  const select = hook.result.current.selectPane;
  act(() => select('compare', '33333333-3333-4333-8333-333333333333'));
  act(() => select('primary', '33333333-3333-4333-8333-333333333333'));
  expect(hook.result.current.state).toMatchObject({ activeMediaId: '11111111-1111-4111-8111-111111111111', compareMediaId: '33333333-3333-4333-8333-333333333333' });
  hook.rerender({ owner: next }); act(() => select('primary', '33333333-3333-4333-8333-333333333333'));
  expect(next.store.drafts.size).toBe(0); expect(hook.result.current.state.activeMediaId).toBe('11111111-1111-4111-8111-111111111111');
  hook.unmount(); active.lifecycle.dispose(); next.lifecycle.dispose();
});
it('rechecks accepted authority even before React effects reconcile the latest comparison', () => {
  const active = setup(), [a, , c] = active.store.snapshot.document.media;
  const hook = renderHook(() => useWorkspace(active));
  const select = hook.result.current.selectPane;
  act(() => {
    active.store.accept({ ...active.store.snapshot, document: { ...active.store.snapshot.document, revision: 1, viewState: { ...active.store.snapshot.document.viewState, compareMediaId: c.id } } });
    expect(select('primary', c.id)).toBe(false);
  });
  expect(hook.result.current.state).toMatchObject({ activeMediaId: a.id, compareMediaId: c.id });
  expect(active.store.drafts.size).toBe(0);
  hook.unmount(); active.lifecycle.dispose();
});
it('keeps a visible comparison selection and context when primary changes, clears only hidden targets', () => {
  const active = setup();
  const hook = renderHook(({ primary, compare }) => useSelection(active, primary, [{ mediaId: primary, channels: [0, 1] }, { mediaId: compare, channels: [0, 1] }]), { initialProps: { primary: '11111111-1111-4111-8111-111111111111', compare: '22222222-2222-4222-8222-222222222222' } });
  const selection = { region: { mediaId: '22222222-2222-4222-8222-222222222222', channelIndex: 0, startSeconds: .01, endSeconds: .05, lowHz: 100, highHz: 1000 }, object: null };
  act(() => hook.result.current.state.select(selection));
  hook.rerender({ primary: '33333333-3333-4333-8333-333333333333', compare: '22222222-2222-4222-8222-222222222222' });
  expect(hook.result.current.selection).toBe(selection); expect(hook.result.current.context?.mediaId).toBe('22222222-2222-4222-8222-222222222222');
  hook.rerender({ primary: '33333333-3333-4333-8333-333333333333', compare: '11111111-1111-4111-8111-111111111111' });
  expect(hook.result.current.selection).toBeNull();
  hook.unmount(); active.lifecycle.dispose();
});
it('links time without identities, saves/reopens independent views and reconciles removed media', async () => {
  const active = setup(), hook = renderHook(() => useWorkspace(active));
  act(() => { hook.result.current.patch('22222222-2222-4222-8222-222222222222', { gainDb: 12 }); hook.result.current.link(true); hook.result.current.selectPane('primary', '33333333-3333-4333-8333-333333333333'); });
  expect(hook.result.current.state).toMatchObject({ activeMediaId: '33333333-3333-4333-8333-333333333333', compareMediaId: '22222222-2222-4222-8222-222222222222', linkedTime: true });
  expect(hook.result.current.view('22222222-2222-4222-8222-222222222222').gainDb).toBe(12);
  await act(() => active.lifecycle.save()); hook.unmount();
  const reopened = renderHook(() => useWorkspace(active));
  expect(reopened.result.current.state).toMatchObject({ activeMediaId: '33333333-3333-4333-8333-333333333333', compareMediaId: '22222222-2222-4222-8222-222222222222' });
  act(() => active.store.accept({ ...active.store.snapshot, document: { ...active.store.snapshot.document, media: active.store.snapshot.document.media.filter(m => m.id !== '22222222-2222-4222-8222-222222222222') } }));
  expect(reopened.result.current.state.compareMediaId).toBeNull();
  reopened.unmount(); active.lifecycle.dispose();
});
it('central transport and resets belong to the current playback audio and preserve display settings',async()=>{
 const active=setup(),[a,b]=active.store.snapshot.document.media;a.displayName='A.wav';b.displayName='B.wav';b.frameCount=b.sampleRate*30;const preserved={gainDb:12,dynamicRangeDb:80,palette:'viridis' as const,frequencyMix:.4,spectrumKind:'mel' as const,visibleChannels:[1]};active.store.snapshot.document.viewState.media[b.id]={...defaultView(b),...preserved,startSeconds:10,endSeconds:12,lowHz:500,highHz:1000};
 const props={project:{active,busy:false} as unknown as ProjectLifecycleUI,mediaUI:{selected:a,selectedId:a.id,statuses:[a,b].map(m=>({mediaId:m.id,status:'missing'})),disabled:false} as unknown as MediaUI};
 const ui=render(<AppShell {...props}/>);const transport=screen.getByLabelText('播放控制');expect(transport.closest('.analysis-workspace')).toBeTruthy();expect(transport.closest('.analysis-workspace')?.lastElementChild).toBe(transport);
 fireEvent.click(screen.getByRole('button',{name:`${b.displayName} 设为播放源`}));
 fireEvent.click(screen.getByRole('button',{name:'更多播放操作'}));fireEvent.click(screen.getByRole('menuitem',{name:'重置视图'}));await act(async()=>active.lifecycle.submitDrafts());
 expect(active.store.snapshot.document.viewState.media[b.id]).toMatchObject({startSeconds:0,endSeconds:b.frameCount/b.sampleRate,lowHz:0,highHz:b.sampleRate/2,...preserved});ui.unmount();active.lifecycle.dispose();
});
it('reset masks uses one current-media change, preserves gain and other media, and the processing list only locates views',async()=>{
 const active=setup(),[a,b]=active.store.snapshot.document.media;a.displayName='A.wav';b.displayName='B.wav';const region=active.store.snapshot.document.annotations[0]?.region??{mediaId:a.id,channelIndex:0,startSeconds:.01,endSeconds:.05,lowHz:100,highHz:1000};
 const edit=(id:string,mediaId:string,channelIndex:number,operation:{type:'mask'}|{type:'gain';gainDb:number})=>({id,region:{...region,mediaId,channelIndex},enabled:false,processingVersion:2 as const,operation});active.store.snapshot.document.edits=[edit('00000000-0000-4000-8000-000000000081',b.id,0,{type:'mask'}),edit('00000000-0000-4000-8000-000000000082',b.id,1,{type:'mask'}),edit('00000000-0000-4000-8000-000000000083',b.id,0,{type:'gain',gainDb:-6}),edit('00000000-0000-4000-8000-000000000084',a.id,0,{type:'mask'})];
 const original=active.apply.getMockImplementation()!;active.apply.mockImplementation(async(id,revision,change)=>{if(change.type==='resetMediaMasks')return{...active.store.snapshot,document:{...active.store.snapshot.document,revision:revision+1,edits:active.store.snapshot.document.edits.filter(e=>e.region.mediaId!==change.mediaId||e.operation.type!=='mask')}};return original(id,revision,change);});
 const props={project:{active,busy:false} as unknown as ProjectLifecycleUI,mediaUI:{selected:a,selectedId:a.id,statuses:[a,b].map(m=>({mediaId:m.id,status:'missing'})),disabled:false} as unknown as MediaUI};const ui=render(<AppShell {...props}/>);
 fireEvent.click(screen.getByRole('button',{name:'B.wav 设为播放源'}));fireEvent.click(screen.getByRole('button',{name:'更多播放操作'}));fireEvent.click(screen.getByRole('menuitem',{name:'重置屏蔽'}));await act(async()=>active.lifecycle.submitDrafts());expect(active.apply.mock.calls.filter(c=>c[2].type==='resetMediaMasks')).toHaveLength(1);expect(active.store.snapshot.document.edits.map(e=>e.operation.type)).toEqual(['gain','mask']);
 fireEvent.click(screen.getByRole('button',{name:'更多播放操作'}));expect(screen.getByRole('menuitem',{name:'重置屏蔽'})).toHaveAttribute('aria-disabled','true');fireEvent.keyDown(screen.getByRole('menu'),{key:'Escape'});
 fireEvent.click(screen.getByRole('tab',{name:'处理'}));fireEvent.click(screen.getByRole('button',{name:'定位增益 -6.0 dB 1'}));await act(async()=>{});expect(screen.queryByRole('toolbar',{name:'选区操作'})).toBeNull();expect(document.querySelector('[data-edit-id]')).toBeNull();ui.unmount();active.lifecycle.dispose();
});
import { emptyPlayback, type PlaybackRequest } from '../../bridge/playback';
it('actual pane interaction switches operation source and stops the old stream without autoplay; selectors and settings preserve it',async()=>{
 const active=setup(),[a,b,c]=active.store.snapshot.document.media;[a,b,c].forEach((m,i)=>{m.displayName=`${'ABC'[i]}.wav`;});let generation=0;
 const playback={available:()=>true,devices:async()=>[],listen:async()=>()=>{},control:vi.fn(async()=>({...emptyPlayback,generation:++generation})),configure:vi.fn(async(q:PlaybackRequest)=>({...emptyPlayback,generation:++generation,projectId:q.projectId,mediaId:q.mediaId,state:'playing' as const}))};Object.assign(active,{commands:{playback}});
 const props={project:{active,busy:false} as unknown as ProjectLifecycleUI,mediaUI:{selected:a,selectedId:a.id,statuses:[a,b,c].map(m=>({mediaId:m.id,status:'missing'})),disabled:false} as unknown as MediaUI};const ui=render(<AppShell {...props}/>);
 fireEvent.click(screen.getByRole('button',{name:'播放 · 空格'}));await act(async()=>{});expect(playback.configure).toHaveBeenCalledOnce();const controls=playback.control.mock.calls.length;
 fireEvent.pointerDown(screen.getByRole('combobox',{name:'对比面板音频'}),{button:0});fireEvent.change(screen.getByRole('combobox',{name:'对比面板音频'}),{target:{value:c.id}});fireEvent.click(screen.getByRole('button',{name:'C.wav 分析设置'}));expect(playback.control).toHaveBeenCalledTimes(controls);expect(ui.container.querySelector('[data-pane="primary"]')).toHaveClass('is-playback-source');fireEvent.keyDown(screen.getByRole('dialog'),{key:'Escape'});
 fireEvent(ui.container.querySelector('[data-pane="compare"]')!,new MouseEvent('pointerdown',{bubbles:true,button:0}));await act(async()=>{});expect(playback.control).toHaveBeenLastCalledWith('reset');expect(playback.configure).toHaveBeenCalledOnce();expect(ui.container.querySelector('[data-pane="compare"]')).toHaveClass('is-playback-source');expect(screen.getByRole('button',{name:'播放 · 空格'})).toBeInTheDocument();ui.unmount();active.lifecycle.dispose();
});
