import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { useSyncExternalStore } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke, isTauri: () => false, Channel: class { onmessage = () => {}; } }));
import fixture from '../../../tests/fixtures/document-v3.json';
import { useProjectLifecycle } from './useProjectLifecycle';
import { useCollaboration } from '../collaboration/useCollaboration';
import { usePlayback } from '../playback/usePlayback';
import { emptyPlayback } from '../../bridge/playback';
import { useSelection } from '../selection/useSelection';
import { MediaDialog } from '../media/MediaDialog';
import { syncLabel } from '../collaboration/CollaborationStatus';
import { IdentityDialog } from '../collaboration/IdentityDialog';
import type { CollaborationCommands, CollaborationStatus, Transition } from '../../bridge/collaboration';
import type { LocalProjectCommands, OpenedProject } from '../../bridge/projects';
import type { Change } from '../../bridge/types';

const nonce = '11111111-1111-4111-8111-111111111111';
const appendedId = '33333333-3333-4333-8333-333333333333';
function opened(): OpenedProject {
 return { snapshot: { document: structuredClone(fixture) as never, canUndo: false, canRedo: false }, persistedRevision: 0, recovery: null, path: 'shared', collaboration: { projectFlavor: 'default', identityMode: 'profile', canWriteAnnotations: true, canImportMedia: true, hiddenMediaIds: [], catalogPending: false, runtimeNonce: nonce, actor: { authorId: nonce, displayName: 'Me', createdAt: '2026-10-26T00:00:00Z' }, preferences: { monitorGainDb: 0, mediaMonitorGainDb: {}, volume: .75, deviceId: null, loopEnabled: false, source: 'processed' } } };
}
function remote(o: OpenedProject): CollaborationStatus {
 return { retirement: null, purgeMaintenance: { total: 0, items: [] }, formatVersion: 1, ...o.collaboration!, projectId: fixture.projectId, shared: true, pending: false, recoveryRequired: false, busy: false, lastSuccessMs: 1, error: null, snapshot: { projectId: fixture.projectId, authors: [] } };
}
function setup(readOnly = false) {
 const initial = opened();
 if (readOnly) Object.assign(initial.collaboration!, { identityMode: 'viewOnly', actor: null, canWriteAnnotations: false, canImportMedia: false });
 let status = remote(initial), failRefresh = false;
 const order: string[] = [];
 const refresh = vi.fn(async () => { if (failRefresh) throw { code: 'MissingMedia', message: 'offline', retryable: true }; return structuredClone(status); });
 const adoptCatalog = vi.fn(async (): Promise<Transition> => {
  order.push('adopt');
  const owner = hook.result.current.project.active!;
  const next = structuredClone(initial); next.snapshot = structuredClone(owner.store.snapshot);
  next.snapshot.document.media.push({ ...next.snapshot.document.media[0], id: appendedId }); next.snapshot.document.revision++;
  next.snapshot.document.analysis[appendedId] = structuredClone(next.snapshot.document.analysis[fixture.media[0].id]);
  next.snapshot.document.playbackMix[appendedId] = { soloChannels: [], mutedChannels: [] };
  next.persistedRevision = next.snapshot.document.revision;
  status = { ...status, catalogPending: false };
  return { opened: next, status };
 });
 const api = { choose: async () => '/project', open: async () => initial, openViewOnly: async () => initial, create: vi.fn(), save: vi.fn(), close: vi.fn(), recover: vi.fn(), saveAs: vi.fn(), cancelRecovery: vi.fn(), onCloseRequested: async () => () => {}, destroyWindow: vi.fn() } as LocalProjectCommands;
 const collab = { refresh, status: vi.fn(async () => status), adoptCatalog, cancel: vi.fn(async () => {}) } as unknown as CollaborationCommands;
 invoke.mockImplementation(async (name, args) => {
  if (name === 'save_project') { order.push('save'); return args.expectedRevision; }
  if (name === 'collaboration_preferences') { order.push('preferences'); status={...status,preferences:args.preferences}; return status; }
  if (name === 'apply_change') {
   const snapshot = structuredClone(hook.result.current.project.active!.store.snapshot), change = args.change as Change;
   const doc = snapshot.document;
   if (change.type === 'updateMediaNote') doc.media.find(m => m.id === change.mediaId)!.note = change.note;
   else if (change.type === 'updateViewState') doc.viewState = change.viewState;
   else if (change.type === 'setMediaCategories') doc.media.find(m => m.id === change.mediaId)!.categoryIds = change.categoryIds;
   else if (change.type === 'updateAnalysis') doc.analysis[change.mediaId] = change.settings;
   else throw new Error(`Unexpected fixture edit: ${change.type}`);
   doc.revision++; snapshot.canUndo = true; return snapshot;
  }
  if (name === 'playback_configure') return { ...emptyPlayback, generation: 1, projectId: fixture.projectId, mediaId: fixture.media[0].id, state: 'playing', positionSeconds: args.request.seekSeconds ?? .4 };
  if (name === 'playback_control') return { ...emptyPlayback, generation: 1, state: args.action === 'pause' ? 'paused' : 'stopped' };
 });
 const hook = renderHook(() => { const project = useProjectLifecycle(api); const selection = useSelection(project.active, fixture.media[0].id); const playback = usePlayback(project.active, fixture.media[0].id, undefined); return { project, selection, playback, collaboration: useCollaboration(project, collab) }; });
 const poll = async () => { await act(async () => { await hook.result.current.collaboration.controller!.refresh(); }); };
 return { hook, initial, order, refresh, adoptCatalog, collab, poll, pending: () => { status = { ...status, catalogPending: true }; }, busy: (busy: boolean) => { status = { ...status, busy }; }, offline: (offline: boolean) => { failRefresh = offline; } };
}
beforeEach(() => { vi.useFakeTimers(); invoke.mockReset(); });
afterEach(() => vi.useRealTimers());

it('automatically adopts a fresh pending catalog after the refresh flight and saves notes/views first', async () => {
 const h = setup(), compareId = '44444444-4444-4444-8444-444444444444';
 h.initial.snapshot!.document.media.push({ ...h.initial.snapshot!.document.media[0], id: compareId, sourceRef: 'media/compare.wav' });
 h.initial.snapshot!.document.analysis[compareId] = structuredClone(h.initial.snapshot!.document.analysis[fixture.media[0].id]);
 h.initial.snapshot!.document.playbackMix[compareId] = { soloChannels: [], mutedChannels: [] };
 await act(() => h.hook.result.current.project.open('open'));
 const owner = h.hook.result.current.project.active!, before = structuredClone(owner.store.snapshot.document);
 const mediaId = before.media[0].id;
 const view = { ...before.viewState, compareMediaId: compareId, linkedTime: true, compareLayout: 'vertical' as const };
 const settings = { ...before.analysis[mediaId], melBands: 64 };
 const changes: Record<string, Change> = {
  note: { type: 'updateMediaNote', mediaId, note: 'pending own note', mergeKey: null },
  view: { type: 'updateViewState', viewState: view },
  labels: { type: 'setMediaCategories', mediaId, categoryIds: [before.categories[0].id] },
  settings: { type: 'updateAnalysis', mediaId, settings },
 };
 for (const [key, change] of Object.entries(changes)) {
  owner.store.setDraft(key, key);
  owner.lifecycle.registerDraft(key, async () => { h.order.push(key); await owner.queue.enqueue(change, { draftKey: key }); });
 }
 const transition = vi.spyOn(owner.lifecycle, 'transitionAfterSave');
 act(() => h.hook.result.current.playback.update({ volume: .4, looping: true }));
 h.pending(); await h.poll();
 expect(owner.lifecycle.error).toBeNull();
 expect(h.adoptCatalog).toHaveBeenCalledTimes(1);
 expect(h.order).toEqual(['note', 'view', 'labels', 'settings', 'preferences', 'save', 'adopt']);
 expect(h.hook.result.current.project.active).toBe(owner);
 expect(owner.store.snapshot.document.media.map(m => m.id)).toEqual([...before.media.map(m => m.id), appendedId]);
 expect(owner.store.snapshot.document.media[0]).toMatchObject({ note: 'pending own note', categoryIds: [before.categories[0].id] });
 expect(owner.store.snapshot.document.annotations).toEqual(before.annotations);
 expect(owner.store.snapshot.document.categories).toEqual(before.categories);
 expect(owner.store.snapshot.document.viewState).toEqual(view);
 expect(owner.store.snapshot.document.analysis[mediaId]).toEqual(settings);
 expect(owner.store.snapshot.canUndo).toBe(true);
 expect(owner.store.snapshot.document.playbackMix).toMatchObject(before.playbackMix);
 expect(owner.collaboration!.preferences).toEqual(h.initial.collaboration!.preferences);
 expect(h.hook.result.current.playback.options).toMatchObject({ volume: .4, looping: true });
 await h.poll(); await h.poll();
 expect(h.adoptCatalog).toHaveBeenCalledTimes(1); expect(transition).toHaveBeenCalledTimes(1);
 expect(owner.store.drafts.size).toBe(0); expect(owner.store.editingDisabled).toBe(false);
 h.hook.unmount();
});

it.each(['playing', 'paused'] as const)('keeps %s playback intent and cue intact until explicitly stopped', async state => {
 const h = setup(); await act(() => h.hook.result.current.project.open('open'));
 const owner = h.hook.result.current.project.active!;
 await act(async () => h.hook.result.current.playback.playFrom(owner, fixture.media[0].id, .4));
 if (state === 'paused') await act(async () => h.hook.result.current.playback.toggle());
 const status = h.hook.result.current.playback.status;
 invoke.mockClear(); h.pending(); await h.poll(); await h.poll();
 expect(h.adoptCatalog).not.toHaveBeenCalled();
 expect(h.hook.result.current.collaboration.controller?.status?.catalogPending).toBe(true);
 expect(h.hook.result.current.playback.status).toBe(status);
 expect(invoke.mock.calls.filter(c => c[0] === 'playback_control')).toEqual([]);
 await act(async () => h.hook.result.current.playback.stopAndWait());
 await h.poll(); expect(h.adoptCatalog).toHaveBeenCalledTimes(1);
 h.hook.unmount();
});

it('releases failed first-configure intent and adopts pending catalog on the next poll', async () => {
 const h = setup(); await act(() => h.hook.result.current.project.open('open'));
 invoke.mockRejectedValueOnce({ code: 'DeviceFailed', message: 'No output device', retryable: true });
 await act(async () => h.hook.result.current.playback.toggle());
 expect(h.hook.result.current.playback.status.state).toBe('error');
 expect(h.hook.result.current.project.active!.lifecycle.allowsBackgroundTransition).toBe(true);
 h.pending(); await h.poll(); expect(h.adoptCatalog).toHaveBeenCalledOnce(); h.hook.unmount();
});

it.each(['pause', 'stop'] as const)('keeps a verified live stream guarded when %s rejects, until stop is acknowledged', async action => {
 const h = setup(); await act(() => h.hook.result.current.project.open('open'));
 await act(async () => h.hook.result.current.playback.toggle());
 invoke.mockRejectedValueOnce({ code: 'DeviceFailed', message: 'Control failed', retryable: true });
 await act(async () => { if (action === 'pause') h.hook.result.current.playback.toggle(); else await h.hook.result.current.playback.stopAndWait(); });
 expect(h.hook.result.current.project.active!.lifecycle.allowsBackgroundTransition).toBe(false);
 h.pending(); await h.poll(); expect(h.adoptCatalog).not.toHaveBeenCalled();
 await act(async () => h.hook.result.current.playback.stopAndWait());
 await h.poll(); expect(h.adoptCatalog).toHaveBeenCalledOnce(); h.hook.unmount();
});

it('keeps a MediaDialog modal, focus and input intact until it closes, then adopts later', async () => {
 const h = setup(); await act(() => h.hook.result.current.project.open('open'));
 const owner = h.hook.result.current.project.active!;
 function Root() { const disabled = useSyncExternalStore(owner.store.subscribe, () => owner.store.editingDisabled); return <div className="app-root" inert={disabled}>workspace</div>; }
 const rootView = render(<Root />), root = rootView.container.firstElementChild as HTMLElement;
 // jsdom lacks native inert reflection. Model the browser property/attribute contract.
 Object.defineProperty(root, 'inert', { configurable: true, get: () => root.hasAttribute('inert'), set: value => root.toggleAttribute('inert', value) });
 const dialog = render(<MediaDialog title="Keep this decision" onClose={vi.fn()}><input aria-label="Modal draft" defaultValue="unfinished" /></MediaDialog>);
 const input = screen.getByLabelText('Modal draft'); input.focus();
 h.pending(); await h.poll();
 expect(root.inert).toBe(true); expect(input).toHaveFocus(); expect(input).toHaveValue('unfinished');
 expect(h.adoptCatalog).not.toHaveBeenCalled();
 dialog.unmount(); expect(root.inert).toBe(false);
 await h.poll(); expect(h.adoptCatalog).toHaveBeenCalledOnce(); rootView.unmount(); h.hook.unmount();
});

it('rechecks modal eligibility after drafts submit and retries after the decision closes', async () => {
 const h = setup(); await act(() => h.hook.result.current.project.open('open'));
 const owner = h.hook.result.current.project.active!, modal = document.createElement('section'); modal.setAttribute('role', 'alertdialog');
 owner.store.setDraft('late-modal', 'draft');
 owner.lifecycle.registerDraft('late-modal', async () => { document.body.append(modal); owner.store.clearDraftIfUnchanged('late-modal', 'draft'); });
 try {
  h.pending(); await h.poll(); expect(h.adoptCatalog).not.toHaveBeenCalled(); expect(owner.store.editingDisabled).toBe(false);
  modal.remove(); await h.poll(); expect(h.adoptCatalog).toHaveBeenCalledOnce();
 } finally { modal.remove(); h.hook.unmount(); }
});

it.each(['dialog', 'alertdialog', 'native dialog'] as const)('defers for a visible %s while ignoring hidden dialogs', async kind => {
 const h = setup(); await act(() => h.hook.result.current.project.open('open'));
 const modal = document.createElement(kind === 'native dialog' ? 'dialog' : 'section');
 if (kind === 'native dialog') modal.setAttribute('open', ''); else modal.setAttribute('role', kind);
 document.body.append(modal);
 try {
  h.pending(); await h.poll(); expect(h.adoptCatalog).not.toHaveBeenCalled();
  modal.hidden = true; await h.poll(); expect(h.adoptCatalog).toHaveBeenCalledOnce();
 } finally { modal.remove(); h.hook.unmount(); }
});

it('defers while configure is pending and while its acknowledged stream is buffering', async () => {
 const h = setup(); await act(() => h.hook.result.current.project.open('open'));
 let finish!: (status: typeof emptyPlayback) => void;
 const native = invoke.getMockImplementation()!;
 invoke.mockImplementation((name, args, options) => name === 'playback_configure' ? new Promise(resolve => { finish = resolve; }) : native(name, args, options));
 await act(async () => h.hook.result.current.playback.playFrom(h.hook.result.current.project.active!, fixture.media[0].id, .4));
 h.pending(); await h.poll(); expect(h.adoptCatalog).not.toHaveBeenCalled();
 await act(async () => finish({ ...emptyPlayback, generation: 1, state: 'buffering', projectId: fixture.projectId, mediaId: fixture.media[0].id }));
 await h.poll(); expect(h.adoptCatalog).not.toHaveBeenCalled();
 await act(async () => h.hook.result.current.playback.stopAndWait());
 await h.poll(); expect(h.adoptCatalog).toHaveBeenCalledTimes(1); h.hook.unmount();
});

it('retains a newer draft typed during submission and retries on a later poll', async () => {
 const h = setup(); await act(() => h.hook.result.current.project.open('open'));
 const owner = h.hook.result.current.project.active!, before = owner.store.snapshot;
 owner.store.setDraft('changing-note', 'first'); let first = true;
 owner.lifecycle.registerDraft('changing-note', async () => {
  const captured = owner.store.drafts.get('changing-note');
  if (first) { first = false; owner.store.setDraft('changing-note', 'newer'); }
  owner.store.clearDraftIfUnchanged('changing-note', captured);
 });
 h.pending(); await h.poll(); expect(h.adoptCatalog).not.toHaveBeenCalled();
 expect(owner.store.snapshot).toBe(before); expect(owner.store.drafts.get('changing-note')).toBe('newer'); expect(owner.store.editingDisabled).toBe(false);
 await h.poll(); expect(h.adoptCatalog).toHaveBeenCalledTimes(1); h.hook.unmount();
});

it('ignores stale status and requires a successful current-runtime poll before automatic adoption', async () => {
 const h = setup(); await act(() => h.hook.result.current.project.open('open'));
 const controller = h.hook.result.current.collaboration.controller!, before = controller.status;
 h.refresh.mockResolvedValueOnce({ ...remote(h.initial), runtimeNonce: '22222222-2222-4222-8222-222222222222', catalogPending: true });
 await h.poll(); expect(h.adoptCatalog).not.toHaveBeenCalled(); expect(controller.status).toBe(before);
 h.pending(); await h.poll(); expect(h.adoptCatalog).toHaveBeenCalledTimes(1); h.hook.unmount();
});

it('does not publish or adopt a refresh completing after disposal', async () => {
 const h = setup(); await act(() => h.hook.result.current.project.open('open'));
 const owner = h.hook.result.current.project.active!, before = owner.store.snapshot;
 let finish!: (status: CollaborationStatus) => void;
 h.refresh.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
 let flight!: Promise<void>; await act(async () => { flight = h.hook.result.current.collaboration.controller!.refresh(); });
 const old = h.hook.result.current.collaboration.controller!;
 h.hook.unmount(); await act(async () => { finish({ ...remote(h.initial), catalogPending: true }); await flight; });
 expect(h.adoptCatalog).not.toHaveBeenCalled(); expect(owner.store.snapshot).toBe(before); expect(old.status?.catalogPending).toBe(false);
});

it('rechecks live playback eligibility after draft submission before freezing the editor', async () => {
 const h = setup(); await act(() => h.hook.result.current.project.open('open'));
 const owner = h.hook.result.current.project.active!;
 owner.store.setDraft('late-playback', 'draft');
 owner.lifecycle.registerDraft('late-playback', async () => {
  h.hook.result.current.playback.playFrom(owner, fixture.media[0].id, .4);
  owner.store.clearDraftIfUnchanged('late-playback', 'draft');
 });
 invoke.mockClear(); h.pending(); await h.poll();
 expect(h.adoptCatalog).not.toHaveBeenCalled();
 expect(owner.store.editingDisabled).toBe(false); expect(owner.lifecycle.error).toBeNull();
 expect(invoke.mock.calls.filter(c => c[0] === 'playback_control')).toEqual([]);
 await act(async () => h.hook.result.current.playback.stopAndWait());
 await h.poll(); expect(h.adoptCatalog).toHaveBeenCalledTimes(1); h.hook.unmount();
});

it('ignores a pending catalog from a replaced runtime', async () => {
 const h = setup(); await act(() => h.hook.result.current.project.open('open'));
 const owner = h.hook.result.current.project.active!;
 let finish!: (status: CollaborationStatus) => void;
 h.refresh.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
 let flight!: Promise<void>; await act(async () => { flight = h.hook.result.current.collaboration.controller!.refresh(); });
 const next = opened(); next.collaboration!.runtimeNonce = '22222222-2222-4222-8222-222222222222';
 await act(() => h.hook.result.current.project.performCollaboration(owner, async () => ({ opened: next, status: remote(next) })));
 const replacement = h.hook.result.current.project.active!;
 await act(async () => { finish({ ...remote(h.initial), catalogPending: true }); await flight; });
 expect(replacement).not.toBe(owner); expect(h.adoptCatalog).not.toHaveBeenCalled(); expect(replacement.store.snapshot.document.media).toHaveLength(1);
 h.hook.unmount();
});

it('keeps an active pointer gesture intact and adopts after it ends', async () => {
 const h = setup(); await act(() => h.hook.result.current.project.open('open'));
 const selection = { object: null, region: structuredClone(fixture.annotations[0].region) };
 act(() => { h.hook.result.current.selection.state.beginGesture(); h.hook.result.current.selection.state.select(selection); });
 h.pending(); await h.poll(); expect(h.adoptCatalog).not.toHaveBeenCalled();
 expect(h.hook.result.current.selection.gesturing).toBe(true); expect(h.hook.result.current.selection.selection).toBe(selection);
 act(() => h.hook.result.current.selection.state.endGesture());
 await h.poll(); expect(h.adoptCatalog).toHaveBeenCalledTimes(1); expect(h.hook.result.current.selection.selection).toBe(selection);
 h.hook.unmount();
});

it('defers a native job appearing after preflight without waiting or exposing an error banner', async () => {
 const h = setup(); await act(() => h.hook.result.current.project.open('open'));
 vi.mocked(h.collab.status).mockResolvedValueOnce(remote(h.initial)).mockResolvedValueOnce({ ...remote(h.initial), busy: true });
 h.pending(); await h.poll(); expect(h.adoptCatalog).not.toHaveBeenCalled();
 expect(h.hook.result.current.collaboration.error).toBeNull(); expect(h.hook.result.current.project.active!.store.editingDisabled).toBe(false);
 await h.poll(); expect(h.adoptCatalog).toHaveBeenCalledTimes(1); h.hook.unmount();
});

it('immediately releases a native busy rejection and retries on a later poll', async () => {
 const h = setup(); await act(() => h.hook.result.current.project.open('open'));
 h.adoptCatalog.mockRejectedValueOnce({ code: 'ResourceLimit', message: 'busy', retryable: true, details: { operationBusy: true } });
 h.pending(); await h.poll(); expect(h.adoptCatalog).toHaveBeenCalledTimes(1);
 expect(h.hook.result.current.project.active!.store.editingDisabled).toBe(false);
 expect(h.hook.result.current.collaboration.error).toBeNull();
 await h.poll(); expect(h.adoptCatalog).toHaveBeenCalledTimes(2); h.hook.unmount();
});

it('does not restart a save-triggered native refresh on every idle adoption retry', async () => {
 const h = setup(); await act(() => h.hook.result.current.project.open('open'));
 const owner = h.hook.result.current.project.active!, mediaId = owner.store.snapshot.document.media[0].id;
 owner.store.setDraft('note-before-catalog', 'draft');
 owner.lifecycle.registerDraft('note-before-catalog', async () => {
  await owner.queue.enqueue({ type: 'updateMediaNote', mediaId, note: 'preserved before NAS refresh', mergeKey: null }, { draftKey: 'note-before-catalog' });
 });
 const native = invoke.getMockImplementation()!;
 invoke.mockImplementation(async (command, args) => {
  const result = await native(command, args);
  // Production save_project schedules a background refresh. SMB can keep its
  // native single-flight occupied past the save acknowledgement.
  if (command === 'save_project') h.busy(true);
  return result;
 });
 h.pending(); await h.poll();
 expect(h.adoptCatalog).not.toHaveBeenCalled();
 expect(owner.store.isDirty).toBe(false); expect(owner.store.editingDisabled).toBe(false);
 expect(owner.store.snapshot.document.media[0].note).toBe('preserved before NAS refresh');
 h.busy(false); await h.poll();
 expect(h.adoptCatalog).toHaveBeenCalledOnce();
 expect(h.order.filter(step => step === 'save')).toHaveLength(1);
 expect(owner.lifecycle.error).toBeNull(); h.hook.unmount();
});

it('acknowledges an earlier preference-draft failure before skipping a clean guarded save', async () => {
 const h = setup(); await act(() => h.hook.result.current.project.open('open'));
 const owner = h.hook.result.current.project.active!;
 owner.store.markPersisted(owner.store.snapshot.document.projectId, owner.store.snapshot.document.revision);
 owner.preferences!.update({ ...h.initial.collaboration!.preferences!, volume: .25 });
 invoke.mockRejectedValueOnce({ code: 'SaveFailed', message: 'owned preference write failure', retryable: true });
 h.pending(); await h.poll();
 expect(h.adoptCatalog).not.toHaveBeenCalled(); expect(owner.store.isDirty).toBe(false);
 expect(owner.lifecycle.error?.message).toBe('owned preference write failure');
 await h.poll();
 expect(h.adoptCatalog).toHaveBeenCalledOnce(); expect(owner.store.drafts.size).toBe(0);
 expect(owner.lifecycle.error).toBeNull();
 expect(h.order.filter(step => step === 'save')).toHaveLength(1);
 h.hook.unmount();
});

it('cancels a scheduled automatic operation when the project closes during preflight', async () => {
 const h = setup(); await act(() => h.hook.result.current.project.open('open'));
 const owner = h.hook.result.current.project.active!, before = owner.store.snapshot;
 let finish!: (status: CollaborationStatus) => void;
 vi.mocked(h.collab.status).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
 h.pending(); await h.poll();
 await act(() => h.hook.result.current.project.close()); expect(h.hook.result.current.project.active).toBeNull();
 await act(async () => finish({ ...remote(h.initial), catalogPending: true }));
 expect(h.adoptCatalog).not.toHaveBeenCalled(); expect(owner.store.snapshot).toBe(before); h.hook.unmount();
});

it('coalesces overlapping polls and ignores an adoption result completing after unmount', async () => {
 const h = setup(); await act(() => h.hook.result.current.project.open('open'));
 const owner = h.hook.result.current.project.active!, before = owner.store.snapshot;
 let finish!: (result: Transition) => void;
 h.adoptCatalog.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
 h.pending(); await h.poll(); await h.poll();
 expect(h.adoptCatalog).toHaveBeenCalledTimes(1);
 const next = opened(); next.snapshot!.document.revision++;
 h.hook.unmount(); await act(async () => { finish({ opened: next, status: remote(next) }); });
 expect(h.collab.cancel).toHaveBeenCalledTimes(1); expect(owner.store.snapshot).toBe(before);
});

it('defers busy work and retries failed adoption only after another successful pending poll', async () => {
 const h = setup(); await act(() => h.hook.result.current.project.open('open'));
 const owner = h.hook.result.current.project.active!, before = owner.store.snapshot;
 h.pending(); h.busy(true); await h.poll(); expect(h.adoptCatalog).not.toHaveBeenCalled();
 h.adoptCatalog.mockRejectedValueOnce({ code: 'MissingMedia', message: 'offline', retryable: true });
 h.busy(false); await h.poll(); expect(h.adoptCatalog).toHaveBeenCalledTimes(1);
 expect(owner.store.snapshot).toBe(before); expect(owner.lifecycle.error).toBeNull(); expect(h.hook.result.current.collaboration.error).toBeNull();
 h.offline(true); await h.poll(); expect(h.adoptCatalog).toHaveBeenCalledTimes(1); expect(owner.store.snapshot).toBe(before);
 h.offline(false); await h.poll(); expect(h.adoptCatalog).toHaveBeenCalledTimes(2); expect(owner.store.snapshot.document.media).toHaveLength(2);
 h.hook.unmount();
});

it('exposes one bounded catalog error with manual retry and clears it on successful adoption', async () => {
 const h = setup(); await act(() => h.hook.result.current.project.open('open'));
 const failure = { code: 'MissingMedia', message: 'Share is offline', retryable: true };
 h.adoptCatalog.mockRejectedValueOnce(failure); h.pending(); await h.poll();
 const controller = h.hook.result.current.collaboration.controller!, before = h.hook.result.current.project.active!.store.snapshot;
 expect(controller.catalogError).toMatchObject(failure); expect(syncLabel(controller)).toBe('音频列表更新失败 · 可重试');
 expect(h.hook.result.current.collaboration.error).toBeNull();
 const lastError = controller.catalogError;
 h.adoptCatalog.mockRejectedValueOnce(failure); await h.poll();
 expect(controller.catalogError).toBe(lastError); expect(h.hook.result.current.project.active!.store.snapshot).toBe(before);
 await act(() => h.hook.result.current.collaboration.show('status'));
 const dialog = render(<IdentityDialog ui={h.hook.result.current.collaboration} />);
 expect(screen.getByText('Share is offline')).toBeVisible(); expect(screen.getAllByRole('alert')).toHaveLength(1);
 await act(async () => fireEvent.click(screen.getByRole('button', { name: '重试更新音频列表' })));
 expect(h.adoptCatalog).toHaveBeenCalledTimes(3); expect(controller.catalogError).toBeNull();
 expect(h.hook.result.current.project.active!.store.snapshot.document.media).toHaveLength(2);
 dialog.unmount(); h.hook.unmount();
});

it('bounds catalog error messages and clears the error on a later automatic retry', async () => {
 const h = setup(); await act(() => h.hook.result.current.project.open('open'));
 h.adoptCatalog.mockRejectedValueOnce({ code: 'InvalidInput', message: 'x'.repeat(4096), retryable: true });
 h.pending(); await h.poll();
 expect(h.hook.result.current.collaboration.controller!.catalogError?.message).toHaveLength(1024);
 await h.poll(); expect(h.adoptCatalog).toHaveBeenCalledTimes(2); expect(h.hook.result.current.collaboration.controller!.catalogError).toBeNull();
 h.hook.unmount();
});

it('keeps automatic cancellation quiet and retries from a later pending poll', async () => {
 const h = setup(); await act(() => h.hook.result.current.project.open('open'));
 h.adoptCatalog.mockRejectedValueOnce({ code: 'Cancelled', message: 'Cancelled', retryable: true });
 h.pending(); await h.poll();
 expect(h.hook.result.current.collaboration.error).toBeNull(); expect(h.hook.result.current.collaboration.controller!.catalogError).toBeNull();
 await h.poll(); expect(h.adoptCatalog).toHaveBeenCalledTimes(2); h.hook.unmount();
});

it('retains read-only capabilities and does not transition on unchanged polls', async () => {
 const h = setup(true); await act(() => h.hook.result.current.project.open('viewOnly'));
 const owner = h.hook.result.current.project.active!;
 const transition = vi.spyOn(owner.lifecycle, 'transitionAfterSave');
 await h.poll(); await h.poll(); expect(transition).not.toHaveBeenCalled();
 h.pending(); await h.poll(); expect(h.adoptCatalog).toHaveBeenCalledTimes(1);
 expect(owner.collaboration).toMatchObject({ identityMode: 'viewOnly', actor: null, canWriteAnnotations: false, canImportMedia: false });
 h.hook.unmount();
});
