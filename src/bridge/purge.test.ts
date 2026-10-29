import { expect, it, vi } from 'vitest';
import { createPurgeClient, parsePurgePreview, parsePurgeResult, parsePurgeCleanupPage } from './purge';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
import { invoke } from '@tauri-apps/api/core';
export const id = '11111111-1111-4111-8111-111111111111', other = '22222222-2222-4222-8222-222222222222';
export const preview = () => ({ previewId: other, operationId: id, projectId: id, runtimeNonce: id, requestedCount: 100, eligibleCount: 99, retainedCount: 1, otherAuthorRetainedCount: 0, audioBytes: 100, requiresFormatUpgrade: true, items: [{ mediaId: id, displayName: 'a', reason: null }] });
export const result = () => ({ operationId: id, projectId: id, runtimeNonce: id, status: 'committed-pending-cleanup' as const, removedIds: [other], retained: [], deletedAudioBytes: 0, cleanupPendingCount: 2, cleanupFailedCount: 1 });
export const page = () => ({ operationId: id, projectId: id, runtimeNonce: id, total: 1, offset: 0, limit: 50, items: [{ cleanupId: 'opaque-1', mediaId: null, displayName: 'history', kind: 'history', status: 'failed', error: { code: 'SaveFailed', message: 'file occupied', retryable: true } }] });
it('validates bounded native pages without inferring total scope from page size', () => {
    expect(parsePurgePreview(preview()).eligibleCount).toBe(99);
    expect(parsePurgeCleanupPage(page()).items[0].mediaId).toBeNull();
    for (const patch of [{ extra: 1 }, { previewId: 'bad' }, { audioBytes: Number.MAX_SAFE_INTEGER + 1 }, { eligibleCount: 101 }, { items: [preview().items[0], preview().items[0]] }])
        expect(() => parsePurgePreview({ ...preview(), ...patch })).toThrow();
    for (const patch of [{ cleanupFailedCount: 3 }, { removedIds: [other, other] }, { removedIds: ['bad'] }, { status: 'complete' }, { retained: [{ mediaId: other, reason: 'not-in-recycle' }] }])
        expect(() => parsePurgeResult({ ...result(), ...patch })).toThrow();
    for (const patch of [{ limit: 51 }, { items: [{ ...page().items[0], error: null }] }, { items: [page().items[0], page().items[0]], total: 2 }, { offset: 2 }])
        expect(() => parsePurgeCleanupPage({ ...page(), ...patch })).toThrow();
});
it('sends exact args and rejects mismatched native operation, binding and pagination', async () => {
    const client = createPurgeClient(id, id), single = { ...preview(), requestedCount: 1, eligibleCount: 1, retainedCount: 0 };
    vi.mocked(invoke).mockResolvedValue(single);
    await client.preview(id, { kind: 'all' }, 0, 50);
    expect(invoke).toHaveBeenCalledWith('purge_preview', { args: { runtimeNonce: id, projectId: id, operationId: id, selection: { kind: 'all' }, offset: 0, limit: 50 } });
    for (const patch of [{ operationId: other }, { projectId: other }, { runtimeNonce: other }]) {
        vi.mocked(invoke).mockResolvedValue({ ...single, ...patch });
        await expect(client.preview(id, { kind: 'all' }, 0, 50)).rejects.toBeDefined();
    }
    vi.mocked(invoke).mockResolvedValue({ ...page(), offset: 1 });
    await expect(client.cleanupPage(id, 0, 50)).rejects.toBeDefined();
    expect(() => client.preview(id, { kind: 'selected', mediaIds: [id, id] }, 0, 50)).toThrow();
});
it('rejects a preview page whose items contradict its native eligible and retained counts', () => {
    expect(() => parsePurgePreview({ ...preview(), eligibleCount: 0, retainedCount: 100 })).toThrow();
    expect(() => parsePurgePreview({ ...preview(), eligibleCount: 100, retainedCount: 0, items: [{ ...preview().items[0], reason: 'not-in-recycle' }] })).toThrow();
});
it('bounds the combined committed result scope to the native media limit', () => {
    const mediaId = (n: number) => `${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000001`;
    expect(() => parsePurgeResult({ ...result(), removedIds: Array.from({ length: 6000 }, (_, i) => mediaId(i + 1)), retained: Array.from({ length: 5000 }, (_, i) => ({ mediaId: mediaId(i + 6001), reason: 'not-in-recycle' })) })).toThrow();
});
it('requires bounded global other-author counts and checks each page against both reason totals', () => {
    const mixed = { ...preview(), requestedCount: 53, eligibleCount: 1, retainedCount: 52, otherAuthorRetainedCount: 2 };
    expect(parsePurgePreview(mixed)).toBe(mixed);
    const missing: Record<string, unknown> = { ...mixed };
    delete missing.otherAuthorRetainedCount;
    expect(() => parsePurgePreview(missing)).toThrow();
    for (const otherAuthorRetainedCount of [-1, 1.5, 53, Number.MAX_SAFE_INTEGER + 1])
        expect(() => parsePurgePreview({ ...mixed, otherAuthorRetainedCount })).toThrow();
    expect(() => parsePurgePreview({ ...mixed, otherAuthorRetainedCount: 0, items: [{ ...mixed.items[0], reason: 'other-author-annotation' }] })).toThrow();
    expect(() => parsePurgePreview({ ...mixed, otherAuthorRetainedCount: 52, items: [{ ...mixed.items[0], reason: 'not-in-recycle' }] })).toThrow();
});
