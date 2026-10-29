import { afterEach, expect, it, vi } from 'vitest';
import { PurgeController } from './purge';
import type { PurgeCommands, PurgeCleanupPage, PurgePreview, PurgeResult } from '../../bridge/purge';
import { collaborationClient, type CollaborationStatus } from '../../bridge/collaboration';
import { registerSuspension } from '../collaboration/admission';
import { ProjectStore } from '../../app/store';
import { CommandQueue } from '../../app/commands';
import { ProjectLifecycle } from '../project/lifecycle';
import type { ActiveProject } from '../project/useProjectLifecycle';
import fixture from '../../../tests/fixtures/document-v3.json';
import { parseProjectDocument } from '../../bridge/types';
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
const id = '11111111-1111-4111-8111-111111111111', other = '22222222-2222-4222-8222-222222222222';
const preview = (): PurgePreview => ({ previewId: other, operationId: id, projectId: id, runtimeNonce: id, requestedCount: 100, eligibleCount: 100, retainedCount: 0, otherAuthorRetainedCount: 0, audioBytes: 100, requiresFormatUpgrade: true, items: [{ mediaId: id, displayName: 'a', reason: null }] });
const result = (): PurgeResult => ({ operationId: id, projectId: id, runtimeNonce: id, status: 'committed-pending-cleanup', removedIds: [other], retained: [], deletedAudioBytes: 0, cleanupPendingCount: 2, cleanupFailedCount: 1 });
const page = (): PurgeCleanupPage => ({ operationId: id, projectId: id, runtimeNonce: id, total: 1, offset: 0, limit: 50, items: [{ cleanupId: 'opaque', mediaId: null, displayName: 'history', kind: 'history', status: 'failed', error: { code: 'SaveFailed', message: 'occupied', retryable: true } }] });
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { resolve, promise }; }
function setup() { const api = { preview: vi.fn<PurgeCommands['preview']>(async () => preview()), commit: vi.fn<PurgeCommands['commit']>(async () => result()), retryCleanup: vi.fn<PurgeCommands['retryCleanup']>(async () => ({ ...result(), status: 'complete' as const, cleanupPendingCount: 0, cleanupFailedCount: 0 })), cleanupPage: vi.fn<PurgeCommands['cleanupPage']>(async () => page()), cancel: vi.fn<PurgeCommands['cancel']>(async () => undefined) } satisfies PurgeCommands; return { api, controller: new PurgeController(id, id, true, api, undefined, () => id) }; }
function owned(writable = true) { const s = setup(), document = { ...parseProjectDocument(structuredClone(fixture)), projectId: id }; const store = new ProjectStore({ document, canUndo: false, canRedo: false }), queue = new CommandQueue(store, { applyChange: vi.fn(), getSnapshot: vi.fn(), undo: vi.fn(), redo: vi.fn() }), save = vi.fn(async (_id: string, revision: number) => revision), lifecycle = new ProjectLifecycle(store, queue, { save, close: vi.fn() }); const context = { runtimeNonce: id, projectFlavor: 'default' as const, identityMode: writable ? 'profile' as const : 'viewOnly' as const, actor: writable ? { authorId: id, displayName: 'Alice', createdAt: '2026-10-23T00:00:00Z' } : null, preferences: null, canWriteAnnotations: writable, canImportMedia: writable, hiddenMediaIds: [], catalogPending: false }; const owner: ActiveProject = { store, queue, lifecycle, path: 'shared', collaboration: context }; const status = (): CollaborationStatus => ({ ...context, formatVersion: 1, projectId: id, shared: true, pending: false, recoveryRequired: false, busy: false, lastSuccessMs: null, error: null, snapshot: null, retirement: null, purgeMaintenance: { total: 0, items: [] } }); vi.spyOn(collaborationClient, 'status').mockImplementation(async () => status()); return { ...s, owner, save, status, controller: new PurgeController(id, id, writable, s.api, owner, () => id) }; }
it('fixes preview targets and retries cleanup using only original operation', async () => {
    const { api, controller: c } = setup(), selection = { kind: 'selected' as const, mediaIds: [id] };
    await c.begin(selection);
    selection.mediaIds.push(other);
    await c.previewPage(50);
    expect(api.preview.mock.calls[1]).toEqual([id, { kind: 'selected', mediaIds: [id] }, 50, 50]);
    await c.commit();
    await c.retryCleanup();
    expect(api.retryCleanup).toHaveBeenCalledWith(id);
    expect(api.commit).toHaveBeenCalledWith(other, id);
    expect(c.result?.status).toBe('complete');
});
it('keeps committed summary on page error and ignores disposed late reads', async () => {
    const { api, controller: c } = setup();
    await c.begin({ kind: 'all' });
    await c.commit();
    api.cleanupPage.mockRejectedValueOnce({ code: 'SaveFailed', message: 'offline', retryable: true });
    await c.loadCleanupPage();
    expect(c.result?.operationId).toBe(id);
    expect(c.cleanupError?.message).toBe('offline');
    const read = deferred<PurgeCleanupPage>();
    api.cleanupPage.mockImplementationOnce(() => read.promise);
    const flight = c.loadCleanupPage();
    c.dispose();
    read.resolve(page() as PurgeCleanupPage);
    await flight;
    expect(c.cleanupPage).toBeNull();
});
it('suspends refresh before draft/save drain, retries busy with identical arguments and preserves survivor admission', async () => {
    vi.useFakeTimers();
    const s = owned(), order: string[] = [], resume = vi.fn(() => order.push('resume'));
    const unregister = registerSuspension(s.owner.lifecycle, async () => { order.push('suspend'); return resume; });
    s.owner.store.setDraft('draft', 'pending');
    s.owner.lifecycle.registerDraft('draft', async () => { order.push('draft'); s.owner.store.clearDraftIfUnchanged('draft', 'pending'); });
    s.save.mockImplementation(async (_id, r) => { order.push('save'); return r; });
    s.api.preview.mockRejectedValueOnce({ code: 'ResourceLimit', message: 'busy', retryable: true, details: { operationBusy: true } });
    const flight = s.controller.begin({ kind: 'all' });
    await vi.runAllTimersAsync();
    expect(await flight).toBe(true);
    expect(order).toEqual(['suspend', 'draft', 'save', 'resume']);
    expect(s.api.preview.mock.calls[0]).toEqual(s.api.preview.mock.calls[1]);
    expect(s.owner.store.editingDisabled).toBe(false);
    unregister();
    s.owner.lifecycle.dispose();
});
it('ignores late preview after actor switch and cancels the old native capability', async () => {
    const s = owned(), read = deferred<PurgePreview>();
    s.api.preview.mockImplementationOnce(() => read.promise);
    const flight = s.controller.begin({ kind: 'all' });
    await vi.waitFor(() => expect(s.api.preview).toHaveBeenCalledOnce());
    s.owner.collaboration!.actor!.authorId = other;
    read.resolve(preview());
    expect(await flight).toBe(false);
    expect(s.controller.preview).toBeNull();
    s.controller.dispose();
    expect(s.api.cancel).toHaveBeenCalledWith(id);
    s.owner.lifecycle.dispose();
});
it('discovers only committed original operations on readonly reopen and allows reads during normal project close', async () => {
    const s = owned(false), status = s.status();
    status.purgeMaintenance = { total: 2, items: [{ operationId: id, status: 'accepted', committed: false, cleanupPendingCount: null, cleanupFailedCount: null, deletedAudioBytes: null }, { operationId: other, status: 'committed-pending-cleanup', committed: true, cleanupPendingCount: 1, cleanupFailedCount: 1, deletedAudioBytes: 0 }] };
    s.controller.acceptStatus(status);
    expect(s.controller.viewOperation(id)).toBe(false);
    expect(s.controller.viewOperation(other)).toBe(true);
    const read = deferred<PurgeCleanupPage>();
    s.api.cleanupPage.mockImplementationOnce(() => read.promise);
    const flight = s.controller.loadCleanupPage();
    expect(await s.controller.retryCleanup()).toBe(false);
    await s.owner.lifecycle.close();
    s.controller.dispose();
    read.resolve({ ...page(), operationId: other });
    await flight;
    expect(s.controller.cleanupPage).toBeNull();
    expect(s.api.retryCleanup).not.toHaveBeenCalled();
});
it('retains original committed operation after summary loss and adjusts cleanup offset after retry', async () => {
    const s = setup();
    await s.controller.begin({ kind: 'all' });
    s.api.commit.mockRejectedValueOnce({ code: 'SaveFailed', message: 'summary unavailable', retryable: true, details: { purgeCommitted: true, operationId: id, projectId: id, runtimeNonce: id } });
    expect(await s.controller.commit()).toBe(false);
    expect(s.controller.committed).toBe(true);
    expect(await s.controller.retryCleanup()).toBe(true);
    expect(s.api.retryCleanup).toHaveBeenCalledWith(id);
    s.api.cleanupPage.mockResolvedValueOnce({ ...page(), offset: 50, total: 51 });
    await s.controller.loadCleanupPage(50);
    s.api.cleanupPage.mockResolvedValueOnce({ ...page(), offset: 50, total: 1, items: [] }).mockResolvedValueOnce(page());
    await s.controller.retryCleanup();
    expect(s.controller.cleanupOffset).toBe(0);
    expect(s.api.cleanupPage.mock.calls.at(-1)).toEqual([id, 0, 50]);
});
it('rejects a mismatched controller result without losing its fixed preview', async () => {
    const s = setup();
    await s.controller.begin({ kind: 'all' });
    s.api.commit.mockResolvedValueOnce({ ...result(), operationId: other });
    expect(await s.controller.commit()).toBe(false);
    expect(s.controller.result).toBeNull();
    expect(s.controller.preview?.operationId).toBe(id);
    expect(s.controller.error).not.toBeNull();
});
it('never re-commits a known committed operation when its summary was unavailable', async () => {
    const s = setup();
    await s.controller.begin({ kind: 'all' });
    s.api.commit.mockRejectedValueOnce({ code: 'SaveFailed', message: 'summary lost', retryable: true, details: { purgeCommitted: true, operationId: id, projectId: id, runtimeNonce: id } });
    await s.controller.commit();
    expect(await s.controller.commit()).toBe(false);
    expect(s.api.commit).toHaveBeenCalledOnce();
    s.controller.cancel();
    expect(s.api.cancel).toHaveBeenCalledWith(id);
    expect(s.controller.operationId).toBe(id);
    expect(s.controller.committed).toBe(true);
});
it.each(['complete', 'committed-pending-cleanup', 'unknown'] as const)('releases a %s capability on close while preserving the original cleanup operation', async status => {
    const { api, controller: c } = setup();
    if (status === 'unknown')
        api.commit.mockRejectedValueOnce({ code: 'SaveFailed', message: 'summary lost', retryable: true, details: { purgeCommitted: true, operationId: id, projectId: id, runtimeNonce: id } });
    else
        api.commit.mockResolvedValueOnce({ ...result(), status, ...(status === 'complete' ? { cleanupPendingCount: 0, cleanupFailedCount: 0 } : {}) });
    await c.begin({ kind: 'selected', mediaIds: [other] });
    await c.commit();
    const summary = c.result;
    expect(api.cancel).not.toHaveBeenCalled(); // Confirmation retry still owns its capability until close.
    c.cancel();
    c.cancel();
    expect(api.cancel.mock.calls).toEqual([[id]]);
    expect(c.operationId).toBe(id);
    expect(c.result).toBe(summary);
    expect(c.committed).toBe(true);
    expect(await c.loadCleanupPage()).toBe(true);
    expect(await c.retryCleanup()).toBe(true);
    expect(api.cleanupPage).toHaveBeenCalledWith(id, 0, 50);
    expect(api.retryCleanup).toHaveBeenCalledWith(id);
    expect(api.preview).toHaveBeenCalledOnce();
    expect(api.commit).toHaveBeenCalledOnce();
});
it.each(['dispose', 'begin'] as const)('releases a committed capability on %s and keeps late error generation guards', async action => {
    const { api, controller: c } = setup();
    let rejectRelease!: (error: unknown) => void;
    api.cancel.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectRelease = reject; }));
    await c.begin({ kind: 'selected', mediaIds: [other] });
    await c.commit();
    if (action === 'dispose') c.dispose();
    else expect(await c.begin({ kind: 'selected', mediaIds: [id] })).toBe(true);
    expect(api.cancel.mock.calls).toEqual([[id]]);
    if (action === 'begin') c.cancel(); // Closing the new preview supersedes the old release generation.
    rejectRelease({ code: 'SaveFailed', message: 'old release failed', retryable: true });
    await Promise.resolve();
    expect(c.error).toBeNull();
    if (action === 'begin') expect(api.preview.mock.calls.at(-1)).toEqual([id, { kind: 'selected', mediaIds: [id] }, 0, 50]);
});
it('completes and closes seventeen selected operations without exhausting native preview capacity or expanding scope', async () => {
    const { api } = setup(), capabilities = new Set<string>();
    let sequence = 0;
    api.preview.mockImplementation(async (operationId) => {
        if (capabilities.size >= 16) throw { code: 'ResourceLimit', message: 'Too many previews', retryable: false };
        capabilities.add(operationId);
        return { ...preview(), operationId };
    });
    api.commit.mockImplementation(async (_previewId, operationId) => ({ ...result(), operationId, status: 'complete', cleanupPendingCount: 0, cleanupFailedCount: 0 }));
    api.cancel.mockImplementation(async operationId => { capabilities.delete(operationId); });
    const c = new PurgeController(id, id, true, api, undefined, () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`);
    for (let index = 0; index < 17; index++) {
        expect(await c.begin({ kind: 'selected', mediaIds: [other] })).toBe(true);
        const operationId = c.operationId;
        expect(await c.commit()).toBe(true);
        expect(capabilities.size).toBe(1);
        c.cancel();
        expect(capabilities.size).toBe(0);
        expect(c.operationId).toBe(operationId);
        expect(c.result?.operationId).toBe(operationId);
    }
    expect(api.preview).toHaveBeenCalledTimes(17);
    expect(api.cancel).toHaveBeenCalledTimes(17);
    expect(api.preview.mock.calls.every(([, selection]) => selection.kind === 'selected' && selection.mediaIds.length === 1 && selection.mediaIds[0] === other)).toBe(true);
});
it('rejects a changed global other-author count on subsequent preview pages', async () => {
    const s = setup();
    const mixed = { ...preview(), eligibleCount: 98, retainedCount: 2, otherAuthorRetainedCount: 1 };
    s.api.preview.mockResolvedValueOnce(mixed).mockResolvedValueOnce({ ...mixed, otherAuthorRetainedCount: 2 });
    expect(await s.controller.begin({ kind: 'all' })).toBe(true);
    expect(await s.controller.previewPage(50)).toBe(false);
    expect(s.controller.preview?.otherAuthorRetainedCount).toBe(1);
    expect(s.controller.previewOffset).toBe(0);
    expect(s.controller.error?.code).toBe('InvalidInput');
});
