import { createElement, useState, type ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CommandQueue } from '../../app/commands';
import { ProjectStore } from '../../app/store';
import { emptyPlayback, type PlaybackRequest, type PlaybackStatus } from '../../bridge/playback';
import { parseProjectDocument, type MediaView } from '../../bridge/types';
import { ProjectLifecycle } from '../project/lifecycle';
import type { ActiveProject } from '../project/useProjectLifecycle';
import { SpectrogramCanvas } from '../spectrogram/SpectrogramCanvas';
import { defaultSettings, defaultView } from '../spectrogram/workspace';
import { PlaybackContext, usePlayback, type PlaybackUI } from './usePlayback';
import fixture from '../../../tests/fixtures/document-v3.json';

vi.mock('../spectrogram/useTiles', () => ({ useTiles: () => ({ keys: [], total: 0, completed: 0, version: 0, phase: 'idle', error: null, cancelled: false }) }));

const owners: ActiveProject[] = [];
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
});
afterEach(() => {
  cleanup();
  owners.splice(0).forEach(owner => owner.lifecycle.dispose());
  vi.unstubAllGlobals();
});

function project(): ActiveProject {
  const document = parseProjectDocument(structuredClone(fixture));
  document.media[0].frameCount = document.media[0].sampleRate * 100;
  const store = new ProjectStore({ document, canUndo: false, canRedo: false });
  const queue = new CommandQueue(store, {
    applyChange: async () => store.snapshot, getSnapshot: async () => store.snapshot,
    undo: async () => store.snapshot, redo: async () => store.snapshot,
  });
  const lifecycle = new ProjectLifecycle(store, queue, { save: async (_id, revision) => revision, close: async () => {} });
  const owner = { store, queue, lifecycle, path: '' };
  owners.push(owner);
  return owner;
}

function mount(options: { initialView?: Partial<MediaView>; context?: 'absent' | 'different'; dialog?: boolean; children?: ReactNode } = {}) {
  const active = project(), canvasOwner = options.context === 'different' ? project() : active;
  const media = canvasOwner.store.snapshot.document.media[0];
  const viewChanges: Partial<MediaView>[] = [];
  let ui!: PlaybackUI, renders = 0, generation = 0, native = emptyPlayback;
  let progress!: (status: PlaybackStatus) => void;
  const api = {
    available: () => true, devices: async () => [],
    listen: async (callback: typeof progress) => { progress = callback; return () => {}; },
    control: vi.fn(async (action: 'reset' | 'pause' | 'stop') => {
      native = action === 'reset' ? { ...emptyPlayback, generation: ++generation }
        : { ...native, generation: ++generation, state: action === 'pause' ? 'paused' as const : 'stopped' as const };
      return native;
    }),
    configure: vi.fn(async (request: PlaybackRequest) => {
      native = { ...emptyPlayback, generation: ++generation, projectId: request.projectId, mediaId: request.mediaId,
        state: request.play ? 'playing' : 'paused', positionSeconds: request.seekSeconds ?? native.positionSeconds,
        endSeconds: 100 };
      return native;
    }),
  };
  function Rig() {
    renders++;
    ui = usePlayback(active, media.id, undefined, api);
    const [view, setView] = useState({ ...defaultView(media), startSeconds: 10, endSeconds: 30, ...options.initialView });
    const plot = <SpectrogramCanvas active={canvasOwner} media={media} settings={defaultSettings} view={view} channel={0}
      status="ready" timeLimit={100} onView={patch => { viewChanges.push(patch); setView(before => ({ ...before, ...patch })); }}>{options.children}</SpectrogramCanvas>;
    return <PlaybackContext.Provider value={options.context === 'absent' ? null : ui}>
      <output data-testid="view">{JSON.stringify(view)}</output>
      {options.dialog ? <dialog open>{plot}</dialog> : plot}
      <button className="media-select" data-media-id={media.id}>Audio row</button>
      <button>Play control</button>
    </PlaybackContext.Provider>;
  }
  const rendered = render(<Rig />);
  return {
    ...rendered, active, api, viewChanges, surface: screen.getByLabelText('通道 1 频谱'),
    get ui() { return ui; }, get renders() { return renders; },
    readView: (): MediaView => JSON.parse(screen.getByTestId('view').textContent!),
    emit: (positionSeconds: number) => { native = { ...native, positionSeconds }; progress(native); },
    async seek(seconds: number) {
      act(() => ui.seek(seconds));
      await waitFor(() => expect(ui.status.positionSeconds).toBe(seconds));
    },
    async settle() { await act(async () => {}); },
  };
}

it.each([false, true])('one spectrum event pans and seeks once with playing=%s', async playing => {
  const s = mount();
  await s.seek(15);
  if (playing) {
    act(() => s.ui.toggle());
    await waitFor(() => expect(s.ui.status.state).toBe('playing'));
  }
  const before = s.api.configure.mock.calls.length;
  fireEvent.keyDown(s.surface, { key: 'ArrowRight' });
  await waitFor(() => expect(s.api.configure).toHaveBeenCalledTimes(before + 1));
  expect(s.api.configure.mock.calls.at(-1)?.[0]).toMatchObject({ seekSeconds: 17, play: playing });
  expect(s.readView()).toMatchObject({ startSeconds: 12, endSeconds: 32 });
  expect(s.viewChanges).toHaveLength(1);
  fireEvent.keyDown(s.surface, { key: 'ArrowLeft' });
  await waitFor(() => expect(s.api.configure).toHaveBeenCalledTimes(before + 2));
  expect(s.api.configure.mock.calls.at(-1)?.[0]).toMatchObject({ seekSeconds: 15, play: playing });
  expect(s.readView()).toMatchObject({ startSeconds: 10, endSeconds: 30 });
  expect(s.viewChanges).toHaveLength(2);
  await s.settle();
  expect(s.api.configure).toHaveBeenCalledTimes(before + 2);
});

it('spectrum cooperation uses native progress without an owning hook render', async () => {
  const s = mount();
  await s.seek(15);
  const renders = s.renders, before = s.api.configure.mock.calls.length;
  act(() => s.emit(23.25));
  expect(s.renders).toBe(renders);
  fireEvent.keyDown(s.surface, { key: 'ArrowRight' });
  await waitFor(() => expect(s.api.configure).toHaveBeenCalledTimes(before + 1));
  expect(s.api.configure.mock.calls.at(-1)?.[0]).toMatchObject({ seekSeconds: 25.25, play: false });
  expect(s.readView()).toMatchObject({ startSeconds: 12, endSeconds: 32 });
});

it.each([
  { view: { startSeconds: 0, endSeconds: 100 }, position: 15, next: 17, start: 0, end: 100 },
  { view: { startSeconds: 80, endSeconds: 100 }, position: 15, next: 17, start: 80, end: 100 },
  { view: { startSeconds: 10, endSeconds: 30 }, position: 100, next: 100, start: 12, end: 32 },
])('viewport and playback boundaries are independent: $view / $position', async ({ view, position, next, start, end }) => {
  const s = mount({ initialView: view });
  await s.seek(position);
  const before = s.api.configure.mock.calls.length;
  fireEvent.keyDown(s.surface, { key: 'ArrowRight' });
  await waitFor(() => expect(s.api.configure).toHaveBeenCalledTimes(before + 1));
  expect(s.api.configure.mock.calls.at(-1)?.[0]).toMatchObject({ seekSeconds: next, play: false });
  expect(s.readView()).toMatchObject({ startSeconds: start, endSeconds: end });
});

it.each(['body', 'Audio row', 'Play control'])('global arrow on %s seeks once without panning', async target => {
  const s = mount();
  await s.seek(15);
  const before = s.api.configure.mock.calls.length;
  fireEvent.keyDown(target === 'body' ? document.body : screen.getByRole('button', { name: target }), { key: 'ArrowRight' });
  await waitFor(() => expect(s.api.configure).toHaveBeenCalledTimes(before + 1));
  expect(s.api.configure.mock.calls.at(-1)?.[0]).toMatchObject({ seekSeconds: 17, play: false });
  expect(s.readView()).toMatchObject({ startSeconds: 10, endSeconds: 30 });
  await s.settle();
  expect(s.api.configure).toHaveBeenCalledTimes(before + 1);
});

function control(kind: string) {
  if (['input', 'textarea', 'select'].includes(kind)) return createElement(kind, { 'data-testid': 'key-target' });
  const child = <span data-testid="key-target">Control child</span>;
  if (kind === 'dialog') return <dialog open>{child}</dialog>;
  if (kind === 'editable') return <div contentEditable suppressContentEditableWarning>{child}</div>;
  return <div role={kind}>{child}</div>;
}

it.each(['input', 'textarea', 'select', 'dialog', 'editable', 'alertdialog', 'menu', 'menubar', 'tablist', 'slider', 'separator'])
  ('preserves %s arrows at both global and spectrum entry points', async kind => {
    const s = mount({ children: control(kind) });
    await s.seek(15);
    const before = s.api.configure.mock.calls.length;
    fireEvent.keyDown(screen.getByTestId('key-target'), { key: 'ArrowRight' });
    await s.settle();
    expect(s.api.configure).toHaveBeenCalledTimes(before);
    // Controls never opt into playback; the original parent pan still runs.
    expect(s.readView()).toMatchObject({ startSeconds: 12, endSeconds: 32 });
    const external = render(control(kind));
    fireEvent.keyDown(external.container.querySelector('[data-testid="key-target"]')!, { key: 'ArrowLeft' });
    await s.settle();
    expect(s.api.configure).toHaveBeenCalledTimes(before);
    expect(s.readView()).toMatchObject({ startSeconds: 12, endSeconds: 32 });
  });

it.each(['app', 'project'])('an open %s menu blocks global seek and original spectrum pan', async menu => {
  const s = mount();
  await s.seek(15);
  const before = s.api.configure.mock.calls.length;
  const opened = render(menu === 'app' ? <div data-app-menu /> : <dialog className="project-menu" open />);
  fireEvent.keyDown(s.surface, { key: 'ArrowRight' });
  fireEvent.keyDown(document.body, { key: 'ArrowRight' });
  await s.settle();
  expect(s.api.configure).toHaveBeenCalledTimes(before);
  expect(s.readView()).toMatchObject({ startSeconds: 10, endSeconds: 30 });
  opened.unmount();
  fireEvent.keyDown(s.surface, { key: 'ArrowRight' });
  await waitFor(() => expect(s.api.configure).toHaveBeenCalledTimes(before + 1));
});

it('does not seek when an unrelated React child already consumed the event', async () => {
  const s = mount({ children: <button onKeyDown={event => event.preventDefault()}>Consumes arrows</button> });
  await s.seek(15);
  const before = s.api.configure.mock.calls.length;
  fireEvent.keyDown(screen.getByRole('button', { name: 'Consumes arrows' }), { key: 'ArrowRight' });
  await s.settle();
  expect(s.api.configure).toHaveBeenCalledTimes(before);
  expect(s.readView()).toMatchObject({ startSeconds: 12, endSeconds: 32 });
});

it('does not seek when an unrelated global target already consumed the event', async () => {
  const s = mount();
  await s.seek(15);
  const before = s.api.configure.mock.calls.length;
  render(<button onKeyDown={event => event.preventDefault()}>Consumes arrows</button>);
  fireEvent.keyDown(screen.getByRole('button', { name: 'Consumes arrows' }), { key: 'ArrowRight' });
  await s.settle();
  expect(s.api.configure).toHaveBeenCalledTimes(before);
});

it.each(['ctrlKey', 'metaKey', 'altKey', 'shiftKey', 'isComposing'])
  ('%s preserves original pan but does not seek through React nativeEvent or globally', async flag => {
    const s = mount();
    await s.seek(15);
    const before = s.api.configure.mock.calls.length;
    fireEvent.keyDown(s.surface, { key: 'ArrowRight', [flag]: true });
    fireEvent.keyDown(document.body, { key: 'ArrowRight', [flag]: true });
    await s.settle();
    expect(s.api.configure).toHaveBeenCalledTimes(before);
    expect(s.readView()).toMatchObject({ startSeconds: 12, endSeconds: 32 });
  });

it.each(['absent', 'different', 'dialog'] as const)
  ('a spectrum with %s playback ownership keeps panning without driving the main stream', async isolation => {
    const s = mount(isolation === 'dialog' ? { dialog: true } : { context: isolation });
    await s.seek(15);
    const before = s.api.configure.mock.calls.length;
    fireEvent.keyDown(s.surface, { key: 'ArrowRight' });
    await s.settle();
    expect(s.api.configure).toHaveBeenCalledTimes(before);
    expect(s.readView()).toMatchObject({ startSeconds: 12, endSeconds: 32 });
    // The real main hook remains live; isolation is event ownership, not a disabled fake.
    fireEvent.keyDown(document.body, { key: 'ArrowRight' });
    await waitFor(() => expect(s.api.configure).toHaveBeenCalledTimes(before + 1));
    expect(s.api.configure.mock.calls.at(-1)?.[0].seekSeconds).toBe(17);
  });

it('a project transition blocks both routes and keeps the original view', async () => {
  const s = mount();
  await s.seek(15);
  const before = s.api.configure.mock.calls.length;
  const release = s.active.store.beginTransition();
  fireEvent.keyDown(s.surface, { key: 'ArrowRight' });
  fireEvent.keyDown(document.body, { key: 'ArrowRight' });
  await s.settle();
  expect(s.api.configure).toHaveBeenCalledTimes(before);
  expect(s.readView()).toMatchObject({ startSeconds: 10, endSeconds: 30 });
  release();
});

it('cleans up the window listener when its owning hook unmounts', async () => {
  const s = mount();
  await s.seek(15);
  const before = s.api.configure.mock.calls.length;
  s.unmount();
  fireEvent.keyDown(document.body, { key: 'ArrowRight' });
  await s.settle();
  expect(s.api.configure).toHaveBeenCalledTimes(before);
});
