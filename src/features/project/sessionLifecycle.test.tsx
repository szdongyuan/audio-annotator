import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fixture from '../../../tests/fixtures/document-v3.json';
import { useProjectLifecycle } from './useProjectLifecycle';
import { defaultSessionUI, readSession, sessionKey, type ProjectSession, SessionStore } from './session';
import type { LocalProjectCommands, OpenedProject } from '../../bridge/projects';
import type { ProjectCommands } from '../../app/commands';

const oldPath = 'C:/previous/project.json', newPath = 'C:/chosen/project.json';
const record = (): ProjectSession => ({ version: 1, path: oldPath, projectId: fixture.projectId, actorId: null, readOnly: false, ui: { ...defaultSessionUI(), inspectorTab: 'list', cues: { [fixture.media[0].id]: .4 } } });
function setup(seed = true) {
  if (seed) localStorage.setItem(sessionKey, JSON.stringify(record()));
  const opened: OpenedProject = { snapshot: { document: structuredClone(fixture) as never, canUndo: false, canRedo: false }, persistedRevision: fixture.revision, recovery: null, path: newPath };
  let exit = () => {};
  const api: LocalProjectCommands = { choose: vi.fn(async () => newPath), open: vi.fn(async () => opened), openViewOnly: vi.fn(async () => opened), create: vi.fn(async () => opened), recover: vi.fn(async () => opened), saveAs: vi.fn(async () => opened), save: vi.fn(async (_id, revision) => revision), close: vi.fn(async () => {}), cancelRecovery: vi.fn(async () => {}), onCloseRequested: vi.fn(async cb => { exit = cb; return () => {}; }), destroyWindow: vi.fn(async () => {}) };
  const commands = { applyChange: vi.fn(), getSnapshot: vi.fn(), undo: vi.fn(), redo: vi.fn() } as ProjectCommands;
  const hook = renderHook(() => useProjectLifecycle(api, commands));
  return { api, hook, opened, exit: () => exit() };
}
beforeEach(() => localStorage.clear());
afterEach(() => vi.useRealTimers());

it('offers restore on launch; decline keeps the record for next launch and forget removes it', () => {
  let s = setup(); expect(s.hook.result.current.restorePrompt).toEqual(record());
  act(() => s.hook.result.current.startEmpty()); expect(s.hook.result.current.restorePrompt).toBeNull(); expect(readSession()).toEqual(record());
  s.hook.unmount(); s = setup(false); expect(s.hook.result.current.restorePrompt).toEqual(record());
  act(() => s.hook.result.current.forgetSession()); expect(readSession()).toBeNull(); expect(s.hook.result.current.restorePrompt).toBeNull(); s.hook.unmount();
});

it('writes only after successful adoption, never a picker choice or failed path; retry reuses ordinary open', async () => {
  const s = setup(); let finish!: (o: OpenedProject) => void;
  vi.mocked(s.api.open).mockImplementationOnce(() => new Promise(r => { finish = r; }));
  let opening!: Promise<void>; act(() => { opening = s.hook.result.current.open('open'); });
  await waitFor(() => expect(s.api.open).toHaveBeenCalled()); expect(readSession()).toEqual(record());
  await act(async () => { finish(s.opened); await opening; }); expect(readSession()?.path).toBe(newPath); expect(s.hook.result.current.restorePrompt).toBeNull();
  s.hook.unmount();
});

it.each(['missing', 'locked', 'unavailable'])('retains restore choice and record after a %s path and can retry or choose another', async message => {
  const s = setup(); vi.mocked(s.api.open).mockRejectedValueOnce({ code: message === 'locked' ? 'ProjectLocked' : 'SaveFailed', message, retryable: true });
  await act(() => s.hook.result.current.restoreLast()); expect(s.api.open).toHaveBeenCalledWith(oldPath); expect(s.hook.result.current.active).toBeNull(); expect(readSession()).toEqual(record()); expect(s.hook.result.current.restorePrompt).toEqual(record());
  expect(s.hook.result.current.error?.message).toBe(message);
  if (message === 'unavailable') { await act(() => s.hook.result.current.restoreLast()); expect(s.api.choose).not.toHaveBeenCalled(); expect(s.api.open).toHaveBeenCalledTimes(2); }
  else await act(() => s.hook.result.current.open('open'));
  expect(readSession()?.path).toBe(newPath); expect(s.hook.result.current.restorePrompt).toBeNull(); s.hook.unmount();
});

it('failed opening and cleanup never rewrite a previous successful record; cancelling another picker preserves choice', async () => {
  const s = setup(), write = vi.spyOn(Storage.prototype, 'setItem');
  vi.mocked(s.api.open).mockRejectedValueOnce({ code: 'ProjectLocked', message: 'locked', retryable: true });
  await act(() => s.hook.result.current.restoreLast());
  vi.mocked(s.api.choose).mockResolvedValueOnce(null);
  await act(() => s.hook.result.current.open('open'));
  expect(s.hook.result.current.restorePrompt).toEqual(record());
  s.hook.unmount(); expect(write).not.toHaveBeenCalled(); write.mockRestore();
});

it('restores via view-only open, preserves null actor, and does not save transient UI before recovery resolves', async () => {
  const s = setup(); s.hook.unmount(); localStorage.setItem(sessionKey, JSON.stringify({ ...record(), readOnly: true }));
  const t = setup(false); vi.mocked(t.api.openViewOnly!).mockResolvedValueOnce({ ...t.opened, snapshot: null, recovery: { primary: null, candidates: [{ source: 'backup', document: t.opened.snapshot!.document }] } });
  await act(() => t.hook.result.current.restoreLast()); expect(t.api.openViewOnly).toHaveBeenCalledWith(oldPath); expect(t.api.open).not.toHaveBeenCalled(); expect(readSession()?.path).toBe(oldPath); expect(t.hook.result.current.active).toBeNull();
  await act(() => t.hook.result.current.recover('backup')); expect(t.hook.result.current.active?.restoredUI).toEqual(record().ui); expect(readSession()).toMatchObject({ path: newPath, actorId: null, readOnly: true }); t.hook.unmount();
});

it('path open drains and safely closes the old owner; failed close retains record until retry successfully closes', async () => {
  const s = setup(); await act(() => s.hook.result.current.openPath(newPath)); const owner = s.hook.result.current.active!;
  owner.lifecycle.registerDraft('note', async () => { owner.store.clearDraftIfUnchanged('note', 'pending'); });
  act(() => owner.store.setDraft('note', 'pending'));
  await act(() => s.hook.result.current.openPath(oldPath)); expect(owner.store.drafts.size).toBe(0); expect(s.api.close).toHaveBeenCalledOnce();
  vi.mocked(s.api.close).mockRejectedValueOnce({ code: 'SaveFailed', message: 'close failed', retryable: true });
  await act(() => s.hook.result.current.close()); expect(readSession()).not.toBeNull(); expect(s.hook.result.current.closePending).toBe(true);
  await act(() => s.hook.result.current.retry()); expect(s.hook.result.current.active).toBeNull(); expect(readSession()).toBeNull(); s.hook.unmount();
});

it('application exit keeps the successful project and flushes acknowledged UI', async () => {
  const s = setup(); await act(() => s.hook.result.current.restoreLast());
  act(() => s.hook.result.current.acknowledgeSessionUI(s.hook.result.current.active!, { ...record().ui, mediaOpen: false }, []));
  act(s.exit); await waitFor(() => expect(s.api.destroyWindow).toHaveBeenCalledOnce()); expect(readSession()?.ui.mediaOpen).toBe(false); expect(readSession()).not.toBeNull(); s.hook.unmount();
});

it('bounds debounce during continuous acknowledged UI updates and tolerates write failures', async () => {
  const s = setup(); await act(() => s.hook.result.current.restoreLast()); vi.useFakeTimers();
  const owner = s.hook.result.current.active!;
  for (let i = 1; i <= 10; i++) {
    act(() => s.hook.result.current.acknowledgeSessionUI(owner, { ...record().ui, cues: { [fixture.media[0].id]: i / 100 } }, []));
    await act(() => vi.advanceTimersByTimeAsync(200));
  }
  expect(readSession()?.ui.cues[fixture.media[0].id]).toBe(.1);
  const store = new SessionStore({ getItem: () => null, setItem: () => { throw Error('denied'); }, removeItem: () => { throw Error('denied'); } } as never);
  expect(() => { store.adopt(s.opened); store.forget(); }).not.toThrow(); s.hook.unmount();
});
