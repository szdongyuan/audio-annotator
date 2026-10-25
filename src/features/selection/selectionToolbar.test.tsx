import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fixture from '../../../tests/fixtures/document-v2.json';
import { parseProjectDocument, type Change, type MediaView } from '../../bridge/types';
import type { MediaStatus } from '../../bridge/media';
import { ProjectStore } from '../../app/store';
import { CommandQueue } from '../../app/commands';
import { ProjectLifecycle } from '../project/lifecycle';
import { PlaybackContext, type PlaybackUI } from '../playback/usePlayback';
import { SelectionContext, useSelection, type SelectionUI } from './useSelection';
import { SelectionToolbar } from './SelectionToolbar';
import { AnnotationOverlay } from '../annotations/AnnotationOverlay';
import type { Selection } from './state';
import { defaultView } from '../spectrogram/workspace';
import { FilePane } from '../spectrogram/FilePane';
import { SpectrogramCanvas } from '../spectrogram/SpectrogramCanvas';
import { CollaborationContext, type CollaborationUI } from '../collaboration/useCollaboration';
vi.mock('../spectrogram/useTiles', () => ({ useTiles: () => ({ keys: [], completed: 0, total: 0, version: 0 }) }));

let plot = new DOMRect(100, 100, 400, 240), clip = new DOMRect(100, 100, 400, 240);
beforeEach(() => {
  plot = new DOMRect(100, 100, 400, 240); clip = new DOMRect(100, 100, 400, 240);
  vi.stubGlobal('PointerEvent', MouseEvent);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('channel-scroll') ? clip : this.classList.contains('selection-toolbar') ? new DOMRect(0, 0, 140, 28) : plot;
  });
  HTMLElement.prototype.setPointerCapture = vi.fn();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function setup(kind: 'temporary' | 'annotation' | 'mask' = 'temporary', actualPane = false, collaboration: CollaborationUI | null = null) {
  const doc = parseProjectDocument(structuredClone(fixture)), media = doc.media[0];
  const region = { mediaId: media.id, channelIndex: 1, startSeconds: .5, endSeconds: 1, lowHz: 6000, highHz: 12000 };
  doc.annotations[0].region = region; doc.edits[0].region = region;
  const target: Selection = { region, object: kind === 'temporary' ? null : { kind, id: kind === 'annotation' ? doc.annotations[0].id : doc.edits[0].id } };
  const store = new ProjectStore({ document: doc, canUndo: true, canRedo: false });
  const changes: Change[] = [];
  const queue = new CommandQueue(store, { applyChange: async (_id, revision, change: Change) => {
    changes.push(change); const next = structuredClone(store.snapshot.document); next.revision = revision + 1;
    if (change.type === 'addAnnotation') next.annotations.push(change.annotation);
    if (change.type === 'updateAnnotation') next.annotations = next.annotations.map(a => a.id === change.annotation.id ? change.annotation : a);
    if (change.type === 'removeAnnotation') next.annotations = next.annotations.filter(a => a.id !== change.id);
    return { ...store.snapshot, document: next };
  }, undo: async () => store.snapshot, redo: async () => store.snapshot, getSnapshot: async () => store.snapshot });
  const lifecycle = new ProjectLifecycle(store, queue, { save: async (_id, rev) => rev, close: async () => {} });
  const owner = { store, queue, lifecycle, path: '' }, playSelection = vi.fn(), selectSource = vi.fn(), penetrate = vi.fn();
  let ui!: SelectionUI;
  let view: MediaView = { ...defaultView(media), startSeconds: 0, endSeconds: 2, lowHz: 0, highHz: 24000, frequencyMix: 0, visibleChannels: [1] };
  let status: MediaStatus['status'] = 'ready', active = owner;
  function App() {
    ui = useSelection(active, media.id);
    return <CollaborationContext.Provider value={collaboration}><SelectionContext.Provider value={ui}><PlaybackContext.Provider value={{ playSelection, selectSource, cues: {}, options: {} } as unknown as PlaybackUI}>
      {actualPane ? <FilePane active={active} media={media} settings={doc.analysis[media.id]} view={view} status={status} timeLimit={2} onView={() => {}} onSettings={() => {}} onRelink={() => {}} pane="primary" choices={[media]} duplicate={false} onSelect={() => {}} /> : <div onPointerDownCapture={e => { if (!(e.target as Element).closest('[data-pane-control]')) selectSource(); }}>
        <div className="channel-scroll" onPointerDown={penetrate}><SpectrogramCanvas active={active} media={media} channel={1} view={view} status={status} settings={doc.analysis[media.id]} timeLimit={2} onView={patch => { view = { ...view, ...patch }; rerender(); }}>
          <AnnotationOverlay media={media} channel={1} view={view} />
          <SelectionToolbar media={media} channel={1} view={view} status={status} />
        </SpectrogramCanvas></div>
      </div>}
    </PlaybackContext.Provider></SelectionContext.Provider></CollaborationContext.Provider>;
  }
  const rendered = render(<App />); act(() => ui.state.select(target));
  const rerender = () => rendered.rerender(<App />);
  return { media, target, owner, changes, playSelection, selectSource, penetrate, ui: () => ui,
    view: (patch: Partial<MediaView>) => { view = { ...view, ...patch }; rerender(); },
    ready: (value: MediaStatus['status']) => { status = value; rerender(); },
    replace: () => { active = { ...owner }; rerender(); },
    settle: async () => { await act(async () => { await lifecycle.submitDrafts(); }); },
    dispose: () => { rendered.unmount(); lifecycle.dispose(); },
  };
}
const toolbar = () => screen.queryByRole('toolbar', { name: '选区操作' });
const category = (name = '未分类') => { fireEvent.click(screen.getByRole('button', { name: '标注' })); fireEvent.click(screen.getByRole('menuitem', { name })); };
it('hidden own annotation has no floating toolbar but keeps its writable selection and restores with the filter',()=>{
 let visible=true;const collaboration={controller:{visible:()=>visible}} as unknown as CollaborationUI,s=setup('annotation',false,collaboration),selected=s.ui().selection;
 expect(toolbar()).toBeTruthy();visible=false;s.view({});expect(toolbar()).toBeNull();expect(s.ui().selection).toBe(selected);visible=true;s.view({});expect(toolbar()).toBeTruthy();s.dispose();
});

it.each(['temporary', 'annotation', 'mask'] as const)('shows one always-visible toolbar for active %s and none for inactive candidate', kind => {
  const s = setup(kind); expect(toolbar()).toBeInTheDocument(); expect(screen.getAllByRole('toolbar')).toHaveLength(1);
  act(() => s.ui().state.deactivate()); expect(toolbar()).not.toBeInTheDocument(); expect(s.ui().candidate).toBeTruthy(); s.dispose();
});
it('positions above the visible frame, clamps tiny edge regions, and tracks viewport/scroll/resize', () => {
  const s = setup(); expect(toolbar()).toHaveStyle({ left: '100px', top: '88px' });
  act(() => s.ui().state.select({ region: { ...s.target.region, startSeconds: 1.97, endSeconds: 1.99, highHz: 23900, lowHz: 23800 }, object: null }));
  expect(toolbar()).toHaveStyle({ left: '260px', top: '5px' });
  s.view({ startSeconds: 0, endSeconds: 1 }); expect(toolbar()).not.toBeInTheDocument();
  s.view({ endSeconds: 2 }); expect(toolbar()).toBeInTheDocument();
  plot = new DOMRect(100, -180, 400, 240); fireEvent.scroll(window); expect(toolbar()).not.toBeInTheDocument();
  plot = new DOMRect(100, 100, 300, 240); fireEvent.resize(window); expect(toolbar()).toHaveStyle({ left: '160px' });
  s.view({ visibleChannels: [] }); expect(toolbar()).not.toBeInTheDocument(); s.dispose();
});
it('hides during pointer gestures and restores after completion, without button penetration or source switching', () => {
  const s = setup();
  fireEvent.pointerDown(screen.getByLabelText('通道 2 标注图层'), { pointerId: 1, button: 0, clientX: 240, clientY: 250 });
  expect(toolbar()).not.toBeInTheDocument();
  fireEvent.pointerUp(screen.getByLabelText('通道 2 标注图层'), { pointerId: 1, button: 0, clientX: 240, clientY: 250 });
  expect(toolbar()).toBeInTheDocument(); s.selectSource.mockClear();
  const before = s.ui().selection;
  fireEvent.pointerDown(screen.getByRole('button', { name: '播放' }), { button: 0 }); fireEvent.click(screen.getByRole('button', { name: '播放' }));
  expect(s.penetrate).not.toHaveBeenCalled(); expect(s.selectSource).not.toHaveBeenCalled(); expect(s.ui().selection).toBe(before);
  expect(s.playSelection).toHaveBeenCalledWith(before!.region, undefined); s.dispose();
});
it('creates once, binds the new ID, then updates its category; mask classification preserves its separate edit', async () => {
  for (const kind of ['temporary', 'mask'] as const) {
    const s = setup(kind); category(); await s.settle();
    const id = s.ui().selection?.object?.id; expect(id).toBeTruthy(); expect(s.owner.store.snapshot.document.annotations).toHaveLength(2);
    category('鸟声'); await s.settle(); expect(s.ui().selection?.object?.id).toBe(id);
    expect(s.changes.filter(c => c.type === 'addAnnotation')).toHaveLength(1); expect(s.owner.store.snapshot.document.annotations.find(a => a.id === id)?.categoryId).toBe(s.owner.store.snapshot.document.categories[0].id);
    expect(s.owner.store.snapshot.document.edits).toHaveLength(1); s.dispose();
  }
});
it('missing source disables only playback with an explanation, and explicit auditions never change workspace source', async () => {
  const s = setup(); s.ready('missing'); expect(screen.getByRole('button', { name: '播放' })).toBeDisabled(); expect(screen.getByRole('button', { name: '播放' })).toHaveAttribute('title', '音频文件缺失');
  category(); await s.settle(); s.ready('ready');
  for (const [label, source] of [['试听选区原音', 'original'], ['试听选区（应用屏蔽）', 'processed']]) {
    fireEvent.click(screen.getByRole('button', { name: '试听选区版本' })); fireEvent.click(screen.getByRole('menuitem', { name: label }));
    expect(s.playSelection).toHaveBeenLastCalledWith(s.ui().selection!.region, source);
  }
  expect(s.selectSource).not.toHaveBeenCalled(); s.dispose();
});
it('open menus resolve latest saved geometry/readiness and disappear on deleted targets or replaced owner', async () => {
  const s = setup('annotation'); fireEvent.click(screen.getByRole('button', { name: '试听选区版本' }));
  const annotation = s.owner.store.snapshot.document.annotations[0], region = { ...annotation.region, startSeconds: .7 };
  await act(async () => { await s.owner.queue.enqueue({ type: 'updateAnnotation', annotation: { ...annotation, region } }); });
  fireEvent.click(screen.getByRole('menuitem', { name: '试听选区原音' })); expect(s.playSelection).toHaveBeenLastCalledWith(region, 'original');
  fireEvent.click(screen.getByRole('button', { name: '试听选区版本' })); s.ready('missing');
  fireEvent.click(screen.getByRole('menuitem', { name: '试听选区原音' })); expect(s.playSelection).toHaveBeenCalledTimes(1);
  fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
  fireEvent.click(screen.getByRole('button', { name: '标注' })); s.replace(); expect(screen.queryByRole('menu')).not.toBeInTheDocument(); expect(toolbar()).not.toBeInTheDocument(); s.dispose();
});
it('Escape closes the category menu first and preserves activation/focus, then deactivates normally', () => {
  const s = setup(); const button = screen.getByRole('button', { name: '标注' }); button.focus(); fireEvent.click(button);
  fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' }); expect(s.ui().selection).toBeTruthy(); expect(document.activeElement).toBe(button);
  fireEvent.keyDown(button, { key: 'Escape' }); expect(toolbar()).not.toBeInTheDocument(); s.dispose();
});
it.each([0, 1])('hides for an actual %s-button pan and restores on pointer end/cancel', button => {
  const s = setup(), surface = screen.getByLabelText('通道 2 频谱');
  fireEvent.pointerDown(surface, { button, altKey: button === 0, clientX: 240, clientY: 250 });
  expect(toolbar()).not.toBeInTheDocument();
  fireEvent.pointerCancel(surface); expect(toolbar()).toBeInTheDocument(); s.dispose();
});
it.each(['missing', 'changed'] as const)('retains a valid selection and classification in the real FilePane when audio becomes %s, clearing pixels', async status => {
  const s = setup('annotation', true), canvas = document.querySelector('canvas')!; canvas.width = 123;
  s.ready(status); expect(toolbar()).toBeInTheDocument(); expect(screen.getByRole('button', { name: '播放' })).toBeDisabled();
  expect(document.querySelector('canvas')?.width).toBe(0);
  category(); await s.settle(); expect(s.owner.store.snapshot.document.annotations[0].categoryId).toBeNull();
  expect(s.playSelection).not.toHaveBeenCalled(); s.dispose();
});
it('tracks nonlinear axis changes and hides through real resize and fresh draw gestures', () => {
  const s = setup(); s.view({ frequencyMix: 1 }); expect(parseFloat(toolbar()!.style.top)).toBeLessThan(88); s.view({ frequencyMix: 0 });
  const overlay = screen.getByLabelText('通道 2 标注图层'), handle = document.querySelector('.is-selected .handle-e')!;
  fireEvent.pointerDown(handle, { button: 0, clientX: 300, clientY: 250 }); expect(toolbar()).not.toBeInTheDocument();
  fireEvent.pointerMove(overlay, { button: 0, clientX: 340, clientY: 250 }); fireEvent.pointerUp(overlay, { button: 0, clientX: 340, clientY: 250 });
  expect(toolbar()).toBeInTheDocument(); expect(s.ui().selection!.region.endSeconds).toBe(1.2);
  fireEvent.pointerDown(overlay, { button: 0, clientX: 120, clientY: 120 }); fireEvent.pointerUp(overlay, { button: 0, clientX: 120, clientY: 120 }); expect(toolbar()).not.toBeInTheDocument();
  fireEvent.pointerDown(overlay, { button: 0, clientX: 120, clientY: 120 }); fireEvent.pointerMove(overlay, { button: 0, clientX: 180, clientY: 180 }); expect(toolbar()).not.toBeInTheDocument();
  fireEvent.pointerUp(overlay, { button: 0, clientX: 180, clientY: 180 }); expect(toolbar()).toBeInTheDocument(); s.dispose();
});
it('invalidates a deleted captured target and cannot classify through its old menu', async () => {
  const s = setup('annotation'); fireEvent.click(screen.getByRole('button', { name: '标注' }));
  const retainedButton = screen.getByRole('menuitem', { name: '未分类' });
  await act(async () => { await s.owner.queue.enqueue({ type: 'removeAnnotation', id: s.target.object!.id }); });
  expect(screen.queryByRole('menu')).not.toBeInTheDocument(); expect(toolbar()).not.toBeInTheDocument(); fireEvent.click(retainedButton);
  await s.settle(); expect(s.owner.store.snapshot.document.annotations).toHaveLength(0); s.dispose();
});
it('an accepted asynchronous classification never steals a newer active selection', async () => {
  const s = setup(); let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const work = s.owner.lifecycle.enqueueEdit(() => gate); category();
  const next = { region: { ...s.target.region, startSeconds: 1.2, endSeconds: 1.6 }, object: null };
  act(() => s.ui().state.select(next)); await act(async () => { release(); await work; }); await s.settle();
  expect(s.owner.store.snapshot.document.annotations).toHaveLength(2); expect(s.ui().selection).toBe(next); s.dispose();
});

it('view-only floating toolbar permits playback and disables annotation creation',()=>{
 const s=setup();Object.assign(s.owner,{collaboration:{canWriteAnnotations:false}});s.ready('ready');expect(screen.getByRole('button',{name:'标注'})).toBeDisabled();expect(screen.getByRole('button',{name:/^播放$/})).toBeEnabled();s.dispose();
});
