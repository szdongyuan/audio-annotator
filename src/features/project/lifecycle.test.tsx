import { afterEach, expect, it, vi } from 'vitest';
import fixture from '../../../tests/fixtures/document-v1.json';
import { ProjectStore } from '../../app/store';
import { CommandQueue, type ProjectCommands } from '../../app/commands';
import { parseProjectDocument, type ProjectSnapshot } from '../../bridge/types';
import { ProjectLifecycle, type PersistenceCommands } from './lifecycle';
import { act, fireEvent, renderHook, waitFor } from '@testing-library/react';
import { useProjectLifecycle } from './useProjectLifecycle';
import type { LocalProjectCommands, OpenedProject } from '../../bridge/projects';

function setup() {
  const snapshot: ProjectSnapshot = { document: parseProjectDocument(structuredClone(fixture)), canUndo: false, canRedo: false };
  const store = new ProjectStore(snapshot);
  const api: ProjectCommands = {
    applyChange: vi.fn(async (_id, revision) => ({ ...snapshot, document: { ...snapshot.document, revision: revision + 1 } })),
    getSnapshot: vi.fn(async () => snapshot), undo: vi.fn(), redo: vi.fn(),
  };
  const persistence: PersistenceCommands = { save: vi.fn(async (_id, revision) => revision), close: vi.fn(async () => {}) };
  const queue = new CommandQueue(store, api);
  const lifecycle = new ProjectLifecycle(store, queue, persistence);
  const edit = () => queue.enqueue({ type: 'updateMediaNote', mediaId: fixture.media[0].id, note: '修改', mergeKey: null });
  return { snapshot, store, api, queue, persistence, lifecycle, edit };
}
afterEach(() => vi.useRealTimers());

it('debounces at 1 second and attempts by 5 seconds during continuous edits', async () => {
  vi.useFakeTimers();
  const { lifecycle, edit, persistence } = setup();
  await edit();
  await vi.advanceTimersByTimeAsync(999);
  expect(persistence.save).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(persistence.save).toHaveBeenCalledTimes(1);
  await edit();
  for (let i = 0; i < 6; i++) { await vi.advanceTimersByTimeAsync(800); await edit(); }
  await vi.advanceTimersByTimeAsync(200);
  expect(persistence.save).toHaveBeenCalledTimes(2);
  lifecycle.dispose();
});

it('immediately reports clean-project rejected edits and recovers only after explicit discard or retry', async () => {
  vi.useFakeTimers();
  const { store, api, queue, lifecycle, persistence } = setup();
  const rejected = { code: 'InvalidInput' as const, message: '类别名称重复', retryable: false };
  vi.mocked(api.applyChange).mockRejectedValueOnce(rejected);
  const change = { type: 'addCategory' as const, category: { id: '00000000-0000-4000-8000-000000000099', name: '鸟声', color: '#aabbcc' } };
  expect(lifecycle.status).toBe('saved');
  await expect(queue.enqueue(change)).rejects.toEqual(rejected);
  expect(store.isDirty).toBe(false);
  expect(lifecycle.status).toBe('failed');
  expect(lifecycle.error).toEqual(rejected);
  expect(lifecycle.hasPendingWork).toBe(true);
  const version = lifecycle.getVersion();
  store.setError(rejected);
  expect(lifecycle.getVersion()).toBe(version);
  await vi.advanceTimersByTimeAsync(20000);
  expect(persistence.save).not.toHaveBeenCalled();
  expect(api.applyChange).toHaveBeenCalledTimes(1);
  // Even an explicit save failure must not leave a stale disk-error after discard.
  await expect(lifecycle.save()).rejects.toEqual(rejected);
  queue.discardFailure(queue.unresolvedFailures[0].id);
  expect(lifecycle.status).toBe('saved');
  expect(lifecycle.error).toBeNull();
  expect(lifecycle.hasPendingWork).toBe(false);
  vi.mocked(api.applyChange).mockRejectedValueOnce(rejected);
  await expect(queue.enqueue(change)).rejects.toEqual(rejected);
  await lifecycle.retryFailures();
  expect(lifecycle.status).toBe('saved');
  expect(lifecycle.error).toBeNull();
  expect(store.persistedRevision).toBe(1);
  lifecycle.dispose();
});

it('submits registered drafts then flushes commands before saving and closing', async () => {
  const { store, queue, lifecycle, persistence } = setup();
  store.setDraft('note', 'draft');
  lifecycle.registerDraft('note', () => queue.enqueue({ type: 'updateMediaNote', mediaId: fixture.media[0].id, note: store.drafts.get('note')!, mergeKey: null }, { draftKey: 'note' }));
  await lifecycle.close();
  expect(persistence.save).toHaveBeenCalledWith(fixture.projectId, 1);
  expect(persistence.close).toHaveBeenCalledWith(fixture.projectId, 1, false);
  expect(store.drafts.size).toBe(0);
  lifecycle.dispose();
});

it('blocks safe close on unresolved failures or unregistered newer drafts', async () => {
  const { store, api, lifecycle, persistence, edit } = setup();
  vi.mocked(api.applyChange).mockRejectedValue({ code: 'RevisionConflict', message: '冲突', retryable: false });
  await expect(edit()).rejects.toBeDefined();
  await expect(lifecycle.close()).rejects.toBeDefined();
  expect(persistence.close).not.toHaveBeenCalled();
  store.setDraft('newer', 'retain me');
  await expect(lifecycle.save()).rejects.toBeDefined();
  expect(store.drafts.get('newer')).toBe('retain me');
  await lifecycle.close(true);
  expect(persistence.close).toHaveBeenCalledWith(fixture.projectId, 0, true);
  lifecycle.dispose();
});

it('does not lose a newer draft entered while submission is in flight', async () => {
  const { store, api, queue, lifecycle, persistence, snapshot } = setup();
  let finish!: (s: ProjectSnapshot) => void;
  vi.mocked(api.applyChange).mockImplementation(() => new Promise(r => { finish = r; }));
  store.setDraft('note', 'first');
  lifecycle.registerDraft('note', () => queue.enqueue({ type: 'updateMediaNote', mediaId: fixture.media[0].id, note: store.drafts.get('note')!, mergeKey: null }, { draftKey: 'note' }));
  const closing = lifecycle.close();
  const assertion = expect(closing).rejects.toBeDefined();
  await waitFor(() => expect(api.applyChange).toHaveBeenCalledTimes(1));
  store.setDraft('note', 'newer');
  finish({ ...snapshot, document: { ...snapshot.document, revision: 1 } });
  await assertion;
  expect(store.drafts.get('note')).toBe('newer');
  expect(persistence.close).not.toHaveBeenCalled();
  lifecycle.dispose();
});

it('serializes saves, keeps dirty status for newer edits, and retains memory on error', async () => {
  const { store, lifecycle, persistence, edit } = setup();
  let finish!: (revision: number) => void;
  vi.mocked(persistence.save).mockImplementationOnce(() => new Promise(r => { finish = r; }));
  await edit();
  const save = lifecycle.save();
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  expect(store.editingDisabled).toBe(false);
  await edit();
  finish(1);
  await save;
  expect(store.isDirty).toBe(true);
  vi.mocked(persistence.save).mockRejectedValueOnce({ code: 'SaveFailed', message: '磁盘已满', retryable: true });
  await expect(lifecycle.save()).rejects.toMatchObject({ code: 'SaveFailed' });
  expect(store.snapshot.document.revision).toBe(2);
  expect(lifecycle.status).toBe('failed');
  await lifecycle.save();
  expect(store.isDirty).toBe(false);
  expect(lifecycle.savedAt).not.toBeNull();
  lifecycle.dispose();
});

function uiSetup() {
  const base = setup(); base.lifecycle.dispose();
  const opened: OpenedProject = { snapshot: base.snapshot, path: 'C:/project', persistedRevision: 0, recovery: null };
  let closeRequested = () => {};
  const unsubscribe = vi.fn();
  const api: LocalProjectCommands = {
    ...base.persistence, choose: vi.fn(async () => 'C:/project'), create: vi.fn(async () => opened), open: vi.fn(async () => opened),
    recover: vi.fn(async () => opened), saveAs: vi.fn(async () => opened), cancelRecovery: vi.fn(async () => {}),
    onCloseRequested: vi.fn(async callback => { closeRequested = callback; return unsubscribe; }), destroyWindow: vi.fn(async () => {}),
  };
  const hook = renderHook(() => useProjectLifecycle(api, base.api));
  return { ...base, api, commands: base.api, hook, requestClose: () => closeRequested(), unsubscribe };
}

it('exposes a backend-rejected no-draft edit immediately through the UI hook', async () => {
  const { commands, hook } = uiSetup();
  await act(async () => { await hook.result.current.open('open'); });
  const rejected = { code: 'InvalidInput' as const, message: '类别名称重复', retryable: false };
  vi.mocked(commands.applyChange).mockRejectedValueOnce(rejected);
  const project = hook.result.current.active!;
  await act(async () => {
    await expect(project.queue.enqueue({ type: 'addCategory', category: { id: '00000000-0000-4000-8000-000000000099', name: '鸟声', color: '#aabbcc' } })).rejects.toEqual(rejected);
  });
  expect(project.lifecycle.status).toBe('failed');
  expect(hook.result.current.error).toEqual(rejected);
  act(() => project.queue.discardFailure(project.queue.unresolvedFailures[0].id));
  expect(project.lifecycle.status).toBe('saved');
  expect(hook.result.current.error).toBeNull();
  hook.unmount();
});

it('native close failure offers cancellation and retry without recursive handlers', async () => {
  const { api, hook, requestClose, unsubscribe } = uiSetup();
  await act(async () => { await hook.result.current.open('open'); });
  vi.mocked(api.save).mockRejectedValueOnce({ code: 'SaveFailed', message: '无写入权限', retryable: true });
  act(requestClose);
  await waitFor(() => expect(hook.result.current.closePending).toBe(true));
  expect(api.destroyWindow).not.toHaveBeenCalled();
  expect(hook.result.current.active).not.toBeNull();
  act(() => hook.result.current.cancelClose());
  expect(hook.result.current.active).not.toBeNull();
  act(requestClose);
  await waitFor(() => expect(api.destroyWindow).toHaveBeenCalledTimes(1));
  expect(api.onCloseRequested).toHaveBeenCalledTimes(1);
  hook.unmount(); expect(unsubscribe).toHaveBeenCalledTimes(1);
});

it('a native close requested during manual saving waits and then completes', async () => {
  const { api, hook, requestClose } = uiSetup();
  await act(async () => { await hook.result.current.open('open'); });
  let finish!: (revision: number) => void;
  vi.mocked(api.save).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  let saving!: Promise<void>;
  act(() => { saving = hook.result.current.save(); });
  await waitFor(() => expect(api.save).toHaveBeenCalledTimes(1));
  act(requestClose);
  expect(api.destroyWindow).not.toHaveBeenCalled();
  await act(async () => { finish(0); await saving; });
  await waitFor(() => expect(api.destroyWindow).toHaveBeenCalledTimes(1));
  hook.unmount();
});

it('Ctrl+S inside a text editor submits its registered draft before native save', async () => {
  const { api, hook } = uiSetup();
  await act(async () => { await hook.result.current.open('create'); });
  const project = hook.result.current.active!;
  act(() => { project.store.setDraft('editor', 'note'); });
  project.lifecycle.registerDraft('editor', () => project.queue.enqueue({ type: 'updateMediaNote', mediaId: fixture.media[0].id, note: 'note', mergeKey: null }, { draftKey: 'editor' }));
  const input = document.createElement('textarea'); document.body.append(input); input.focus();
  fireEvent.keyDown(input, { key: 's', ctrlKey: true });
  await waitFor(() => expect(api.save).toHaveBeenCalledWith(fixture.projectId, 1));
  expect(project.store.drafts.size).toBe(0);
  input.remove(); hook.unmount();
});

it('switching projects waits for safe close and cancel keeps the existing project', async () => {
  const { api, hook } = uiSetup();
  await act(async () => { await hook.result.current.open('open'); });
  vi.mocked(api.save).mockRejectedValueOnce({ code: 'SaveFailed', message: '已满', retryable: true });
  await act(async () => { await hook.result.current.open('create'); });
  expect(api.create).not.toHaveBeenCalled();
  expect(hook.result.current.closePending).toBe(true);
  act(() => hook.result.current.cancelClose());
  expect(hook.result.current.active).not.toBeNull();
  vi.mocked(api.choose).mockResolvedValueOnce(null);
  await act(async () => { await hook.result.current.open('open'); });
  expect(api.close).not.toHaveBeenCalled();
  hook.unmount();
});

it('recovery has no editable session until explicit selection; cancellation releases it', async () => {
  const { api, hook, snapshot } = uiSetup();
  vi.mocked(api.open).mockResolvedValue({ snapshot: null, path: 'C:/project', persistedRevision: 0,
    recovery: { primary: snapshot.document, candidates: [{ source: 'recovery', document: { ...snapshot.document, revision: 1 } }] } });
  await act(async () => { await hook.result.current.open('open'); });
  expect(hook.result.current.active).toBeNull();
  expect(hook.result.current.recovery).not.toBeNull();
  expect(api.recover).not.toHaveBeenCalled();
  await act(async () => { await hook.result.current.cancelRecovery(); });
  expect(api.cancelRecovery).toHaveBeenCalledTimes(1);
  expect(hook.result.current.recovery).toBeNull();
  hook.unmount();
});

it('Save As gates late drafts and commands until the old runtime is retired', async () => {
  const { api, hook, snapshot, commands } = uiSetup();
  await act(async () => { await hook.result.current.open('open'); });
  const oldProject = hook.result.current.active!;
  let publish!: (opened: OpenedProject) => void;
  vi.mocked(api.saveAs).mockImplementationOnce(() => new Promise(resolve => { publish = resolve; }));
  let saving!: Promise<void>;
  act(() => { saving = hook.result.current.saveAs(); });
  await waitFor(() => expect(api.saveAs).toHaveBeenCalledTimes(1));
  expect(hook.result.current.editingDisabled).toBe(true);
  expect(() => oldProject.store.setDraft('note', 'typed during save as')).toThrow();
  expect(() => oldProject.queue.enqueue({ type: 'removeMedia', mediaId: fixture.media[0].id })).toThrow();
  expect(commands.applyChange).not.toHaveBeenCalled();
  await act(async () => { publish({ snapshot, path: 'C:/new', persistedRevision: 0, recovery: null }); await saving; });
  expect(hook.result.current.active!.path).toBe('C:/new');
  expect(hook.result.current.editingDisabled).toBe(false);
  expect(() => oldProject.store.setDraft('note', 'stale editor callback')).toThrow();
  hook.unmount();
});

it('Save As drains a command accepted before transition and captures its completed revision', async () => {
  const { api, commands, hook, snapshot } = uiSetup();
  await act(async () => { await hook.result.current.open('open'); });
  const oldProject = hook.result.current.active!;
  let complete!: (value: ProjectSnapshot) => void;
  vi.mocked(commands.applyChange).mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
  let edit!: Promise<ProjectSnapshot>;
  act(() => { edit = oldProject.queue.enqueue({ type: 'updateMediaNote', mediaId: fixture.media[0].id, note: 'accepted', mergeKey: null }); });
  let saving!: Promise<void>;
  act(() => { saving = hook.result.current.saveAs(); });
  await waitFor(() => expect(commands.applyChange).toHaveBeenCalledTimes(1));
  expect(api.saveAs).not.toHaveBeenCalled();
  const newer = { ...snapshot, document: { ...snapshot.document, revision: 1, name: 'newer native snapshot' } };
  vi.mocked(api.saveAs).mockResolvedValueOnce({ snapshot: newer, path: 'C:/new', persistedRevision: 1, recovery: null });
  await act(async () => { complete(newer); await edit; await saving; });
  expect(api.saveAs).toHaveBeenCalledWith('C:/project', fixture.projectId, 1);
  expect(hook.result.current.active!.store.snapshot.document.name).toBe('newer native snapshot');
  hook.unmount();
});

it('Save As failure releases admission and retains drafts whose submission failed', async () => {
  const { api, hook } = uiSetup();
  await act(async () => { await hook.result.current.open('open'); });
  const project = hook.result.current.active!;
  act(() => project.store.setDraft('note', 'keep this draft'));
  await act(async () => { await hook.result.current.saveAs(); });
  expect(api.saveAs).not.toHaveBeenCalled();
  expect(project.store.drafts.get('note')).toBe('keep this draft');
  expect(hook.result.current.editingDisabled).toBe(false);
  act(() => project.store.clearDraftIfUnchanged('note', 'keep this draft'));
  vi.mocked(api.saveAs).mockRejectedValueOnce({ code: 'SaveFailed', message: '目标只读', retryable: true });
  await act(async () => { await hook.result.current.saveAs(); });
  expect(hook.result.current.active).toBe(project);
  expect(hook.result.current.editingDisabled).toBe(false);
  act(() => project.store.setDraft('note', 'can continue editing'));
  expect(project.store.drafts.get('note')).toBe('can continue editing');
  vi.mocked(api.choose).mockResolvedValueOnce(null);
  await act(async () => { await hook.result.current.saveAs(); });
  expect(hook.result.current.editingDisabled).toBe(false);
  hook.unmount();
});

it('close gates late renderer drafts during native close and reopens admission after failure', async () => {
  const { store, queue, lifecycle, persistence } = setup();
  let rejectClose!: (cause: unknown) => void;
  vi.mocked(persistence.close).mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectClose = reject; }));
  const closing = lifecycle.close();
  const rejected = expect(closing).rejects.toMatchObject({ code: 'SaveFailed' });
  await waitFor(() => expect(persistence.close).toHaveBeenCalledTimes(1));
  expect(store.editingDisabled).toBe(true);
  expect(() => store.setDraft('late', 'must not be silently accepted')).toThrow();
  expect(() => queue.undo()).toThrow();
  rejectClose({ code: 'SaveFailed', message: '关闭失败', retryable: true });
  await rejected;
  expect(store.editingDisabled).toBe(false);
  store.setDraft('late', 'retained after failed close');
  expect(store.drafts.get('late')).toBe('retained after failed close');
  store.clearDraftIfUnchanged('late', 'retained after failed close');
  await lifecycle.close();
  expect(store.editingDisabled).toBe(true);
  expect(() => store.setDraft('stale', 'closed editor')).toThrow();
  lifecycle.dispose();
});

it('explicit UI retry refreshes a blocked conflict before retrying and closing', async () => {
  const { api, commands, hook, snapshot } = uiSetup();
  await act(async () => { await hook.result.current.open('open'); });
  const project = hook.result.current.active!;
  const conflict = { code: 'RevisionConflict' as const, message: '版本冲突', retryable: true };
  const offline = { code: 'SaveFailed' as const, message: '暂时无法刷新', retryable: true };
  vi.mocked(commands.applyChange).mockRejectedValueOnce(conflict);
  vi.mocked(commands.getSnapshot).mockRejectedValueOnce(offline).mockRejectedValueOnce(offline)
    .mockResolvedValueOnce({ ...snapshot, document: { ...snapshot.document, revision: 7 } });
  act(() => project.store.setDraft('note', 'retained conflict draft'));
  await act(async () => {
    await expect(project.queue.enqueue({ type: 'updateMediaNote', mediaId: fixture.media[0].id, note: 'retained conflict draft', mergeKey: null }, { draftKey: 'note' })).rejects.toEqual(conflict);
  });
  const failureId = project.queue.unresolvedFailures[0].id;
  await act(async () => { await hook.result.current.retry(); });
  expect(commands.getSnapshot).toHaveBeenCalledTimes(2);
  expect(commands.applyChange).toHaveBeenCalledTimes(1);
  expect(project.queue.unresolvedFailures[0].id).toBe(failureId);
  expect(project.store.drafts.get('note')).toBe('retained conflict draft');
  expect(hook.result.current.error).toEqual(offline);
  await act(async () => { await hook.result.current.retry(); });
  expect(commands.getSnapshot).toHaveBeenCalledTimes(3);
  expect(commands.applyChange).toHaveBeenLastCalledWith(fixture.projectId, 7, expect.anything());
  expect(api.save).toHaveBeenCalledWith(fixture.projectId, 8);
  expect(project.queue.unresolvedFailures).toHaveLength(0);
  expect(project.store.drafts.size).toBe(0);
  await act(async () => { await hook.result.current.close(); });
  expect(api.close).toHaveBeenCalledWith(fixture.projectId, 8, false);
  expect(hook.result.current.active).toBeNull();
  hook.unmount();
});

it('explicit discard refreshes blocked authority without replay and preserves drafts if refresh fails', async () => {
  const { api, store, queue, lifecycle, persistence, snapshot } = setup();
  const conflict = { code: 'RevisionConflict' as const, message: '冲突', retryable: true };
  const offline = { code: 'SaveFailed' as const, message: '刷新失败', retryable: true };
  vi.mocked(api.applyChange).mockRejectedValueOnce(conflict);
  vi.mocked(api.getSnapshot).mockRejectedValueOnce(offline).mockRejectedValueOnce(offline)
    .mockResolvedValueOnce({ ...snapshot, document: { ...snapshot.document, revision: 7 } });
  store.setDraft('note', 'do not lose before successful explicit discard');
  await expect(queue.enqueue({ type: 'updateMediaNote', mediaId: fixture.media[0].id, note: store.drafts.get('note')!, mergeKey: null }, { draftKey: 'note' })).rejects.toEqual(conflict);
  const failureId = queue.unresolvedFailures[0].id;
  await expect(lifecycle.close(true)).rejects.toEqual(offline);
  expect(queue.unresolvedFailures[0].id).toBe(failureId);
  expect(store.drafts.size).toBe(1);
  expect(store.editingDisabled).toBe(false);
  expect(persistence.close).not.toHaveBeenCalled();
  await lifecycle.close(true);
  expect(api.applyChange).toHaveBeenCalledTimes(1);
  expect(persistence.close).toHaveBeenCalledWith(fixture.projectId, 7, true);
});
