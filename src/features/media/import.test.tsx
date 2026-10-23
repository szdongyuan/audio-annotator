import { expect, it, vi } from 'vitest';
import { render, screen, fireEvent, renderHook, act, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import fixture from '../../../tests/fixtures/document-v2.json';
import { ProjectStore } from '../../app/store';
import { CommandQueue, type ProjectCommands } from '../../app/commands';
import { parseProjectDocument, type ProjectSnapshot } from '../../bridge/types';
import type { MediaCommands, MediaEvent } from '../../bridge/media';
import { MediaImportController } from './imports';
import { MediaList } from './MediaList';
import { MediaTextDetails } from './MediaTextDetails';
import { useMedia } from './useMedia';
import { mediaClient } from '../../bridge/media';
import type { ActiveProject } from '../project/useProjectLifecycle';

function setup() {
  const store = new ProjectStore({ document: parseProjectDocument(structuredClone(fixture)), canUndo: false, canRedo: false });
  const commands: ProjectCommands = { applyChange: vi.fn(async (_id, revision, change) => {
    const snapshot: ProjectSnapshot = structuredClone(store.snapshot); snapshot.document.revision = revision + 1;
    if (change.type === 'importMedia') snapshot.document.media.push(change.media);
    return snapshot;
  }), getSnapshot: vi.fn(), undo: vi.fn(), redo: vi.fn() };
  const queue = new CommandQueue(store, commands);
  let emit!: (event: MediaEvent) => void;
  const api: MediaCommands = { start: vi.fn(async (_id, _paths, callback) => { emit = callback; return 'task'; }), cancel: vi.fn(async () => {}), release: vi.fn(async () => {}), status: vi.fn(async () => []) };
  const controller = new MediaImportController(store, queue, api);
  return { store, queue, commands, api, controller, emit: (event: MediaEvent) => emit(event) };
}
const candidate = { ...fixture.media[0], id: '00000000-0000-4000-8000-000000000077' };

it('commits decoded results through the queue at the latest revision and retains per-file failure', async () => {
  const s = setup(); await s.controller.start(['good.wav', 'bad.wav']);
  await s.queue.enqueue({ type: 'updateMediaNote', mediaId: fixture.media[0].id, note: 'latest', mergeKey: null });
  s.emit({ type: 'ready', taskId: 'task', index: 0, media: candidate });
  s.emit({ type: 'failed', taskId: 'task', index: 1, path: 'bad.wav', error: { code: 'DecodeFailed', message: 'bad file', retryable: false } });
  s.emit({ type: 'finished', taskId: 'task', cancelled: false });
  await s.controller.settled();
  expect(s.commands.applyChange).toHaveBeenLastCalledWith(fixture.projectId, 1, { type: 'importMedia', media: candidate });
  expect(s.controller.items.map(i => i.state)).toEqual(['success', 'failed']);
  s.controller.dispose();
});

it.each(['transition', 'deactivate', 'dispose'] as const)('ignores late media when owner %s occurs, even when project ID is unchanged', async action => {
  const s = setup(); await s.controller.start(['good.wav']);
  if (action === 'transition') s.store.beginTransition();
  if (action === 'deactivate') s.store.deactivate();
  if (action === 'dispose') s.controller.dispose();
  s.emit({ type: 'ready', taskId: 'task', index: 0, media: candidate });
  s.emit({ type: 'finished', taskId: 'task', cancelled: true });
  await s.controller.settled();
  expect(s.commands.applyChange).not.toHaveBeenCalled();
  expect(s.api.cancel).toHaveBeenCalledWith('task');
  expect(s.api.release).toHaveBeenCalledWith('task', candidate.id);
  s.controller.dispose();
});

it('cancels promptly, rejects late ready, and leaves remaining files visibly cancelled', async () => {
  const s = setup(); await s.controller.start(['one.wav', 'two.wav']);
  s.controller.cancel(); expect(s.controller.cancelling).toBe(true);
  s.emit({ type: 'ready', taskId: 'task', index: 0, media: candidate });
  s.emit({ type: 'finished', taskId: 'task', cancelled: true }); await s.controller.settled();
  expect(s.commands.applyChange).not.toHaveBeenCalled();
  expect(s.controller.items.every(i => i.state === 'cancelled')).toBe(true);
  s.controller.dispose();
});

it('keeps admission busy until both native completion and the start response arrive', async () => {
  const s = setup(); let resolve!: (id: string) => void; let emit!: (event: MediaEvent) => void;
  vi.mocked(s.api.start).mockImplementation((_id, _paths, callback) => { emit = callback; return new Promise(r => { resolve = r; }); });
  const starting = s.controller.start(['one.wav']);
  emit({ type: 'finished', taskId: 'task', cancelled: false });
  await s.controller.settled();
  expect(s.controller.busy).toBe(true);
  resolve('task'); await starting;
  expect(s.controller.busy).toBe(false); s.controller.dispose();
});

it('searches real document metadata and preserves missing media notes', () => {
  render(<MediaList media={fixture.media} annotations={fixture.annotations} statuses={[{ mediaId: fixture.media[0].id, status: 'missing' }]} selectedId={null} disabled={false} onSelect={() => {}} onImport={() => {}} onRelink={() => {}} />);
  expect(screen.getByText('源文件缺失')).toBeInTheDocument();
  expect(screen.getByText(fixture.media[0].displayName)).toBeInTheDocument();
  fireEvent.change(screen.getByRole('textbox', { name: '搜索音频' }), { target: { value: 'nothing matches' } });
  expect(screen.getByText('没有匹配的音频')).toBeInTheDocument();
});

it('renders saved annotation and media text without requiring a decoded source', () => {
  render(<MediaTextDetails media={fixture.media[0]} annotations={fixture.annotations} categories={fixture.categories} />);
  expect(screen.getByText('区域备注')).toBeInTheDocument();
  expect(screen.getByText('鸟声')).toBeInTheDocument();
  expect(screen.getByText('音频备注', { selector: 'p' })).toBeInTheDocument();
});

it('remains usable after StrictMode effect replay and retires replaced runtime', async () => {
  const s = setup();
  const status = vi.spyOn(mediaClient, 'status').mockResolvedValue([]);
  const start = vi.spyOn(mediaClient, 'start').mockResolvedValue('strict-task');
  const cancel = vi.spyOn(mediaClient, 'cancel').mockResolvedValue();
  const active = { store: s.store, queue: s.queue, path: 'D:/project' } as ActiveProject;
  const hook = renderHook(({ owner }) => useMedia(owner), { initialProps: { owner: active }, wrapper: StrictMode });
  await waitFor(() => expect(hook.result.current.controller).not.toBeNull());
  await act(() => hook.result.current.controller!.start(['a.wav']));
  expect(start).toHaveBeenCalledOnce();
  hook.rerender({ owner: { ...active } });
  expect(cancel).toHaveBeenCalledWith('strict-task');
  hook.unmount(); status.mockRestore(); start.mockRestore(); cancel.mockRestore(); s.controller.dispose();
});
