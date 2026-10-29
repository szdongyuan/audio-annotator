import { invoke } from '@tauri-apps/api/core';
import { normalizeError } from './client';
import { collaborationClient, parseCollaborationError } from './collaboration';
import { organizationCheck as check, organizationShape as shape, organizationUuid as uuid } from './organization';
import type { AppError } from './types';
export type PurgeSelection = {
    kind: 'selected';
    mediaIds: string[];
} | {
    kind: 'all';
};
export type PurgeBlockReason = 'other-author-annotation' | 'not-in-recycle';
interface Binding {
    operationId: string;
    projectId: string;
    runtimeNonce: string;
}
export interface PurgePreview extends Binding {
    previewId: string;
    requestedCount: number;
    eligibleCount: number;
    retainedCount: number;
    otherAuthorRetainedCount: number;
    audioBytes: number;
    requiresFormatUpgrade: boolean;
    items: {
        mediaId: string;
        displayName: string;
        reason: PurgeBlockReason | null;
    }[];
}
export interface PurgeResult extends Binding {
    status: 'committed-pending-cleanup' | 'complete' | 'no-eligible-items';
    removedIds: string[];
    retained: {
        mediaId: string;
        reason: PurgeBlockReason;
    }[];
    deletedAudioBytes: number;
    cleanupPendingCount: number;
    cleanupFailedCount: number;
}
export interface PurgeCleanupPage extends Binding {
    total: number;
    offset: number;
    limit: number;
    items: {
        cleanupId: string;
        mediaId: string | null;
        displayName: string;
        kind: 'audio' | 'catalog' | 'history' | 'metadata';
        status: 'pending' | 'failed';
        error: AppError | null;
    }[];
}
const integer = (v: unknown) => check(Number.isSafeInteger(v) && (v as number) >= 0);
const count = (v: unknown) => { integer(v); check((v as number) <= 10000); };
const limit = (v: unknown) => { integer(v); check((v as number) > 0 && (v as number) <= 50); };
const text = (v: unknown) => check(typeof v === 'string' && v.length > 0 && v.length <= 32768 && !v.includes('\0'));
const reason = (v: unknown) => check(v === 'other-author-annotation' || v === 'not-in-recycle');
const binding = { operationId: uuid, projectId: uuid, runtimeNonce: uuid };
function unique(ids: string[]) { check(new Set(ids).size === ids.length); }
function array(v: unknown, max: number, item: (v: unknown) => void) { check(Array.isArray(v) && v.length <= max); (v as unknown[]).forEach(item); }
export function parsePurgeSelection(v: unknown): PurgeSelection {
    if ((v as PurgeSelection)?.kind === 'all')
        shape(v, { kind: v => check(v === 'all') });
    else
        shape(v, { kind: v => check(v === 'selected'), mediaIds: v => { array(v, 10000, uuid); check((v as string[]).length > 0); unique(v as string[]); } });
    return v as PurgeSelection;
}
export function parsePurgePreview(v: unknown): PurgePreview {
    shape(v, { ...binding, previewId: uuid, requestedCount: count, eligibleCount: count, retainedCount: count, otherAuthorRetainedCount: count, audioBytes: integer, requiresFormatUpgrade: v => check(typeof v === 'boolean'), items: v => array(v, 50, i => shape(i, { mediaId: uuid, displayName: text, reason: v => { if (v !== null)
                reason(v); } })) });
    const p = v as PurgePreview;
    check(p.eligibleCount + p.retainedCount === p.requestedCount && p.items.length <= p.requestedCount);
    check(p.items.filter(i => i.reason === null).length <= p.eligibleCount && p.items.filter(i => i.reason !== null).length <= p.retainedCount);
    check(p.otherAuthorRetainedCount <= p.retainedCount);
    check(p.items.filter(i => i.reason === 'other-author-annotation').length <= p.otherAuthorRetainedCount);
    check(p.items.filter(i => i.reason === 'not-in-recycle').length <= p.retainedCount - p.otherAuthorRetainedCount);
    unique(p.items.map(i => i.mediaId));
    return p;
}
export function parsePurgeResult(v: unknown): PurgeResult {
    shape(v, { ...binding, status: v => check(['committed-pending-cleanup', 'complete', 'no-eligible-items'].includes(v as string)), removedIds: v => array(v, 10000, uuid), retained: v => array(v, 10000, i => shape(i, { mediaId: uuid, reason })), deletedAudioBytes: integer, cleanupPendingCount: integer, cleanupFailedCount: integer });
    const r = v as PurgeResult;
    check(r.removedIds.length + r.retained.length <= 10000);
    unique([...r.removedIds, ...r.retained.map(i => i.mediaId)]);
    check(r.cleanupFailedCount <= r.cleanupPendingCount);
    check(r.status === 'committed-pending-cleanup' ? r.cleanupPendingCount > 0 : r.cleanupPendingCount === 0);
    if (r.status === 'no-eligible-items')
        check(r.removedIds.length === 0 && r.deletedAudioBytes === 0);
    return r;
}
export function parsePurgeCleanupPage(v: unknown): PurgeCleanupPage {
    shape(v, { ...binding, total: integer, offset: integer, limit, items: v => array(v, 50, i => shape(i, { cleanupId: text, mediaId: v => { if (v !== null)
                uuid(v); }, displayName: text, kind: v => check(['audio', 'catalog', 'history', 'metadata'].includes(v as string)), status: v => check(v === 'pending' || v === 'failed'), error: v => { if (v !== null)
                parseCollaborationError(v); } })) });
    const p = v as PurgeCleanupPage;
    unique(p.items.map(i => i.cleanupId));
    check(p.items.length === Math.min(p.limit, Math.max(0, p.total - p.offset)));
    check(p.offset <= p.total || p.items.length === 0);
    for (const i of p.items)
        if (i.status === 'failed')
            check(i.error !== null && i.error.message.trim().length > 0);
    return p;
}
export function createPurgeClient(runtimeNonce: string, projectId: string) {
    uuid(runtimeNonce);
    uuid(projectId);
    const call = async <T extends Binding>(command: string, operationId: string, args: Record<string, unknown>, parse: (v: unknown) => T): Promise<T> => {
        try {
            const r = parse(await invoke(command, { args: { runtimeNonce, projectId, operationId, ...args } }));
            check(r.runtimeNonce === runtimeNonce && r.projectId === projectId && r.operationId === operationId);
            return r;
        }
        catch (e) {
            throw normalizeError(e);
        }
    };
    return {
        preview: (operationId: string, selection: PurgeSelection, offset = 0, pageLimit = 50) => { uuid(operationId); parsePurgeSelection(selection); integer(offset); limit(pageLimit); return call('purge_preview', operationId, { selection, offset, limit: pageLimit }, v => { const p = parsePurgePreview(v); check(p.items.length === Math.min(pageLimit, Math.max(0, p.requestedCount - offset))); return p; }); },
        commit: (previewId: string, operationId: string) => { uuid(previewId); uuid(operationId); return call('purge_commit', operationId, { previewId }, parsePurgeResult); },
        retryCleanup: (operationId: string) => { uuid(operationId); return call('purge_retry_cleanup', operationId, {}, parsePurgeResult); },
        cleanupPage: (operationId: string, offset = 0, pageLimit = 50) => { uuid(operationId); integer(offset); limit(pageLimit); return call('purge_cleanup_page', operationId, { offset, limit: pageLimit }, v => { const p = parsePurgeCleanupPage(v); check(p.offset === offset && p.limit === pageLimit); return p; }); },
        cancel: collaborationClient.cancel,
    };
}
export type PurgeCommands = ReturnType<typeof createPurgeClient>;
