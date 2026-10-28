import type { ReactNode } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import fixture from '../../tests/fixtures/document-v3.json';
import { parseProjectDocument, type ProjectDocument, type ProjectSnapshot } from '../bridge/types';
import { emptyPlayback, parsePlaybackStatus, type PlaybackRequest, type PlaybackStatus } from '../bridge/playback';
import { createRuntimeCommands } from '../bridge/runtime';
import type { AuthorSnapshot } from '../bridge/collaboration';
import { ProjectStore } from './store';
import { CommandQueue, type ProjectCommands } from './commands';
import { ProjectLifecycle } from '../features/project/lifecycle';
import type { ActiveProject, ProjectLifecycleUI } from '../features/project/useProjectLifecycle';
import type { MediaUI } from '../features/media/useMedia';
import type { CollaborationUI } from '../features/collaboration/useCollaboration';
import type { IdentityController } from '../features/identity/controller';
import { AppShell } from './AppShell';

// Keep FilePane, ChannelPane, selection overlays and all application hooks real.
vi.mock('../features/spectrogram/SpectrogramCanvas', () => ({
  SpectrogramCanvas: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

function setup(layer?: 'file' | 'channel' | 'region') {
  const document = parseProjectDocument(structuredClone(fixture));
  const template = document.media[0], annotation = document.annotations[0];
  document.media = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'].map((id, i) => ({
    ...structuredClone(template), id, displayName: `random-${'ABC'[i]}.wav`, categoryIds: [], channelCategoryIds: [[], []],
  }));
  const [a, b, c] = document.media, category = document.categories[0];
  document.annotations = [{ ...annotation, region: { ...annotation.region, mediaId: b.id }, categoryIds: [] }];
  document.edits = []; document.analysis = {}; document.playbackMix = {};
  document.viewState = { ...document.viewState, media: {}, activeMediaId: a.id, compareMediaId: c.id };
  if (layer === 'file') b.categoryIds = [category.id];
  if (layer === 'channel') b.channelCategoryIds[0] = [category.id];
  if (layer === 'region') document.annotations[0].categoryIds = [category.id];

  // Native ProjectSession semantics: content records history; view updates do
  // not. Undo/redo restore content snapshots but preserve current view/mix.
  let accepted = structuredClone(document);
  const undo: ProjectDocument[] = [], redo: ProjectDocument[] = [];
  const snapshot = (): ProjectSnapshot => ({ document: structuredClone(accepted), canUndo: !!undo.length, canRedo: !!redo.length });
  const checkRevision = (id: string, revision: number) => {
    expect(id).toBe(accepted.projectId); expect(revision).toBe(accepted.revision);
  };
  const restore = (from: ProjectDocument[], to: ProjectDocument[], id: string, revision: number) => {
    checkRevision(id, revision);
    const previous = from.pop(); if (!previous) throw new Error('Missing history fixture');
    to.push(structuredClone(accepted));
    accepted = { ...previous, revision: revision + 1, viewState: structuredClone(accepted.viewState), playbackMix: structuredClone(accepted.playbackMix) };
    return snapshot();
  };
  const io: ProjectCommands = {
    applyChange: vi.fn(async (id, revision, change) => {
      checkRevision(id, revision);
      const next = structuredClone(accepted);
      if (change.type === 'updateViewState') next.viewState = change.viewState;
      else {
        undo.push(structuredClone(accepted)); redo.length = 0;
        if (change.type === 'setMediaCategories') next.media.find(m => m.id === change.mediaId)!.categoryIds = change.categoryIds;
        else if (change.type === 'setChannelCategories') next.media.find(m => m.id === change.mediaId)!.channelCategoryIds[change.channelIndex] = change.categoryIds;
        else if (change.type === 'updateAnnotation') next.annotations = next.annotations.map(a => a.id === change.annotation.id ? change.annotation : a);
        else throw new Error(`Unexpected fixture change: ${change.type}`);
      }
      accepted = { ...next, revision: revision + 1 }; return snapshot();
    }),
    getSnapshot: vi.fn(async () => snapshot()),
    undo: vi.fn(async (id, revision) => restore(undo, redo, id, revision)),
    redo: vi.fn(async (id, revision) => restore(redo, undo, id, revision)),
  };
  const store = new ProjectStore(snapshot()), queue = new CommandQueue(store, io);
  const lifecycle = new ProjectLifecycle(store, queue, { save: async (_, revision) => revision, close: vi.fn() });
  onTestFinished(() => lifecycle.dispose());
  let generation = 0, currentMediaId = a.id;
  const status = (state: PlaybackStatus['state']) => parsePlaybackStatus({ ...emptyPlayback, projectId: document.projectId, mediaId: currentMediaId, generation: ++generation, state });
  const unlisten = vi.fn();
  const playback = {
    available: () => true, devices: async () => [], listen: vi.fn(async () => unlisten),
    configure: vi.fn(async (request: PlaybackRequest) => { currentMediaId = request.mediaId; return status(request.play ? 'playing' : 'stopped'); }),
    control: vi.fn(async (action: 'pause' | 'stop' | 'reset') => status(action === 'pause' ? 'paused' : 'stopped')),
    monitorGain: vi.fn(async () => status('playing')),
  };
  const active: ActiveProject = { store, queue, lifecycle, path: 'random-navigation-project', commands: { ...createRuntimeCommands(), playback } };
  const mediaUI = { selected: a, selectedId: a.id, statuses: document.media.map(m => ({ mediaId: m.id, status: 'unverified' })), disabled: false } as unknown as MediaUI;
  const props = { project: { active, busy: false } as unknown as ProjectLifecycleUI, mediaUI };
  return { active, props, io, playback, unlisten, a, b, c, category };
}

afterEach(() => vi.restoreAllMocks());
function mount(layer?: 'file' | 'channel' | 'region') {
  const context = setup(layer);
  return { ...context, ui: render(<AppShell {...context.props} />) };
}
const primary = () => screen.getByRole('combobox', { name: '主面板音频' });
const row = (id: string) => document.querySelector<HTMLButtonElement>(`.media-select[data-media-id="${id}"]`)!;
function randomFrom(id: string) { row(id).focus(); fireEvent.keyDown(row(id), { key: 'r' }); }
async function settle(active: ActiveProject) { await act(async () => { await active.lifecycle.save(); }); }
function expectTarget(id: string, compareId: string, name: string) {
  expect(primary()).toHaveValue(id);
  expect(screen.getByRole('combobox', { name: '对比面板音频' })).toHaveValue(compareId);
  expect(document.querySelector('[data-pane="primary"]')).toHaveClass('is-playback-source');
  expect(screen.getByLabelText('播放控制')).toHaveAttribute('title', `播放源：${name}`);
  expect(row(id)).toHaveAttribute('aria-pressed', 'true');
}

it('R opens the only other eligible primary without autoplay, then Space plays and pauses that target', async () => {
  const { active, a, b, c, playback, unlisten, ui } = mount();
  row(a.id).focus(); fireEvent.keyDown(row(a.id), { key: ' ' });
  await waitFor(() => expect(playback.configure).toHaveBeenCalledOnce());
  expect(playback.configure.mock.calls[0][0]).toMatchObject({ mediaId: a.id, play: true });
  randomFrom(a.id);
  expectTarget(b.id, c.id, b.displayName);
  await waitFor(() => expect(row(b.id)).toHaveFocus());
  await waitFor(() => expect(playback.control).toHaveBeenLastCalledWith('reset'));
  expect(playback.configure).toHaveBeenCalledOnce();
  fireEvent.keyDown(document.activeElement!, { key: ' ' });
  await waitFor(() => expect(playback.configure).toHaveBeenCalledTimes(2));
  expect(playback.configure).toHaveBeenLastCalledWith(expect.objectContaining({ projectId: active.store.snapshot.document.projectId, mediaId: b.id, play: true }));
  fireEvent.keyDown(document.activeElement!, { key: ' ' });
  await waitFor(() => expect(playback.control).toHaveBeenLastCalledWith('pause'));
  expect(playback.configure).toHaveBeenCalledTimes(2);
  expectTarget(b.id, c.id, b.displayName);
  expect(screen.getByRole('button', { name: '播放 · 空格' })).toBeInTheDocument();
  ui.unmount(); expect(unlisten).toHaveBeenCalledOnce();
});

it('R stops an independently playing target before the next Space starts it again', async () => {
  const { a, b, c, playback } = mount();
  fireEvent.click(screen.getByRole('button', { name: '更多播放操作' }));
  fireEvent.click(screen.getByRole('menuitem', { name: '播放源' }));
  fireEvent.click(screen.getByRole('menuitem', { name: b.displayName }));
  expect(primary()).toHaveValue(a.id);
  expect(screen.getByLabelText('播放控制')).toHaveAttribute('title', `播放源：${b.displayName}`);
  expect(document.querySelector('.is-temporary.is-selected, .annotation-overlay .is-selected')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '播放 · 空格' }));
  await waitFor(() => expect(playback.configure).toHaveBeenCalledOnce());
  expect(playback.configure).toHaveBeenLastCalledWith(expect.objectContaining({ mediaId: b.id, play: true }));
  expect(screen.getByRole('button', { name: '暂停 · 空格' })).toBeInTheDocument();
  playback.control.mockClear();

  randomFrom(a.id);
  expectTarget(b.id, c.id, b.displayName);
  await waitFor(() => expect(row(b.id)).toHaveFocus());
  expect(screen.queryByRole('button', { name: '暂停 · 空格' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '播放 · 空格' })).toBeInTheDocument();
  await waitFor(() => expect(playback.control).toHaveBeenCalledExactlyOnceWith('stop'));
  expect(playback.configure).toHaveBeenCalledOnce();

  fireEvent.keyDown(document.activeElement!, { key: ' ' });
  await waitFor(() => expect(playback.configure).toHaveBeenCalledTimes(2));
  expect(playback.configure).toHaveBeenLastCalledWith(expect.objectContaining({ mediaId: b.id, play: true }));
  expect(screen.getByRole('button', { name: '暂停 · 空格' })).toBeInTheDocument();
  expect(playback.control).toHaveBeenCalledExactlyOnceWith('stop');
});

it('keeps an unverified random target after output failure and retries the same media through the real transport', async () => {
  const { a, b, c, playback } = mount();
  playback.configure.mockRejectedValueOnce({ code: 'DeviceFailed', message: '测试输出失败', retryable: true });
  randomFrom(a.id); await waitFor(() => expect(row(b.id)).toHaveFocus());
  expect(playback.configure).not.toHaveBeenCalled();
  fireEvent.keyDown(document.activeElement!, { key: ' ' });
  await screen.findByText('测试输出失败');
  expectTarget(b.id, c.id, b.displayName);
  expect(playback.configure).toHaveBeenCalledOnce();
  expect(playback.configure.mock.calls[0][0]).toMatchObject({ mediaId: b.id, play: true });
  fireEvent.click(screen.getByRole('button', { name: '重试播放' }));
  await waitFor(() => expect(playback.configure).toHaveBeenCalledTimes(2));
  expect(playback.configure.mock.calls.map(([request]) => [request.mediaId, request.play])).toEqual([[b.id, true], [b.id, true]]);
  expectTarget(b.id, c.id, b.displayName);
  expect(await screen.findByRole('button', { name: '暂停 · 空格' })).toBeInTheDocument();
  expect(screen.queryByText('测试输出失败')).not.toBeInTheDocument();
});

it.each(['file', 'channel', 'region'] as const)('recomputes %s eligibility after clearing the last tag, real undo/redo, and undoing a UI addition', async layer => {
  const { active, a, b, c, category, io } = mount(layer);
  const labels = () => {
    const doc = active.store.snapshot.document, media = doc.media.find(m => m.id === b.id)!;
    return layer === 'file' ? media.categoryIds : layer === 'channel' ? media.channelCategoryIds[0] : doc.annotations[0].categoryIds;
  };
  const originalRegion = structuredClone(active.store.snapshot.document.annotations[0].region);
  const classify = async (clear: boolean) => {
    fireEvent.click(row(b.id));
    if (layer === 'region') {
      fireEvent.click(screen.getByRole('tab', { name: '列表' }));
      const result = [...document.querySelectorAll<HTMLButtonElement>('.annotation-row')].find(button => button.textContent?.includes(b.displayName) && button.textContent.includes('区域 · 通道'))!;
      fireEvent.click(result);
      await act(async () => {});
      fireEvent.click(screen.getByRole('tab', { name: '区域' }));
      const categories = await screen.findByRole('group', { name: '区域类别' });
      fireEvent.click(clear ? within(categories).getByRole('button', { name: '清空标签' }) : within(categories).getByRole('checkbox', { name: category.name }));
    } else {
      fireEvent.click(within(document.querySelector('[data-pane="primary"]')! as HTMLElement).getByRole('button', { name: `${b.displayName} ${layer === 'file' ? '文件' : '通道 1'} 类别` }));
      fireEvent.click(screen.getByRole('menuitem', { name: layer === 'file' ? '文件类别' : '通道类别' }));
      fireEvent.click(screen.getByRole('menuitemcheckbox', { name: clear ? '清空标签' : category.name }));
      fireEvent.keyDown(screen.getAllByRole('menu').at(-1)!, { key: 'Escape' });
    }
    await settle(active);
  };
  const checkEligible = (eligible: boolean) => {
    fireEvent.click(row(a.id)); randomFrom(a.id);
    expect(primary()).toHaveValue(eligible ? b.id : a.id);
    expect(screen.getByRole('combobox', { name: '对比面板音频' })).toHaveValue(c.id);
    if (!eligible) expect(screen.getByText('没有其他未分类音频')).toBeInTheDocument();
  };
  checkEligible(false);
  await classify(true); expect(labels()).toEqual([]);
  expect(active.store.snapshot.document.annotations[0].region).toEqual(originalRegion);
  checkEligible(true);
  row(b.id).focus(); fireEvent.keyDown(row(b.id), { key: 'z', ctrlKey: true }); await settle(active);
  expect(io.undo).toHaveBeenCalledOnce(); expect(labels()).toEqual([category.id]); checkEligible(false);
  fireEvent.keyDown(row(a.id), { key: 'y', ctrlKey: true }); await settle(active);
  expect(io.redo).toHaveBeenCalledOnce(); expect(labels()).toEqual([]); checkEligible(true);
  await classify(false); expect(labels()).toEqual([category.id]); checkEligible(false);
  fireEvent.keyDown(row(a.id), { key: 'z', ctrlKey: true }); await settle(active);
  expect(io.undo).toHaveBeenCalledTimes(2); expect(labels()).toEqual([]); checkEligible(true);
  expect(active.store.snapshot.document.annotations[0].region).toEqual(originalRegion);
  expect(active.store.snapshot.document.annotations).toHaveLength(1);
});

it('ignores other authors’ file, channel and region labels when own media has only an untagged region', () => {
  const context = setup();
  const { active, props, a, b, c, category } = context;
  const authors = [{ identity: { authorId: 'foreign-author', displayName: '其他作者' }, error: null, layer: { payload: {
    categories: [category], annotations: active.store.snapshot.document.annotations.map(annotation => ({ ...annotation, categoryIds: [category.id] })),
    mediaLabels: [{ mediaId: b.id, categoryIds: [category.id], channelCategoryIds: [[category.id], []], note: '', channelNotes: ['', ''] }],
  } } }] as unknown as AuthorSnapshot[];
  const collaboration = { active, busy: false, controller: { owner: active, status: { snapshot: { authors } }, visible: () => true } } as unknown as CollaborationUI;
  render(<AppShell {...props} collaboration={collaboration} />);
  randomFrom(a.id); expectTarget(b.id, c.id, b.displayName);
});

it.each(['runtime', 'identity'] as const)('clears the old notice and rejects late focus after %s changes', async change => {
  const frames: FrameRequestCallback[] = [];
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { frames.push(callback); return frames.length; });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
  const context = mount('file'), { active, props, a, b, ui } = context;
  const identity = (authorId: string) => ({ selected: { authorId, displayName: authorId }, busy: false } as unknown as IdentityController);
  let owner = active, author = 'original';
  const replaceScope = () => {
    if (change === 'runtime') owner = { ...owner }; else author = `${author}-next`;
    ui.rerender(<AppShell {...props} project={{ ...props.project, active: owner }} identity={identity(author)} />);
  };
  ui.rerender(<AppShell {...props} identity={identity(author)} />);
  randomFrom(a.id); expect(screen.getByText('没有其他未分类音频')).toBeInTheDocument();
  replaceScope(); expect(screen.queryByText('没有其他未分类音频')).not.toBeInTheDocument();
  fireEvent.click(row(b.id));
  fireEvent.click(screen.getByRole('button', { name: `${b.displayName} 文件 类别` }));
  fireEvent.click(screen.getByRole('menuitem', { name: '文件类别' }));
  fireEvent.click(screen.getByRole('menuitemcheckbox', { name: '清空标签' }));
  fireEvent.keyDown(screen.getAllByRole('menu').at(-1)!, { key: 'Escape' });
  await settle(active);
  fireEvent.click(row(a.id)); randomFrom(a.id);
  expect(primary()).toHaveValue(b.id); expect(frames.length).toBeGreaterThan(0);
  const delayed = frames.at(-1)!;
  replaceScope();
  const search = screen.getByRole('textbox', { name: '搜索音频' }); search.focus();
  act(() => delayed(0)); expect(search).toHaveFocus();
  expect(screen.queryByText('没有其他未分类音频')).not.toBeInTheDocument();
});
