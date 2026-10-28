import { Channel, invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { normalizeError } from './client';
import { parseChange, parseProjectSnapshot, type AnalysisSettings, type MediaDescriptor, type ProjectSnapshot } from './types';
import { parsePlaybackStatus, type PlaybackRequest } from './playback';
import type { MediaStatus } from './media';
import type { TileProgress, TileTransport } from '../features/spectrogram/tileClient';
export type ExampleScope = 'private' | 'shared';
export interface ExampleBinding {
    runtimeNonce: string;
    projectId: string;
}
export interface ExampleOwner extends ExampleBinding {
    actorId: string | null;
}
export interface ExampleEntry {
    sampleId: string;
    projectId: string;
    creatorId: string;
    scope: ExampleScope;
    name: string;
    originalFilename: string;
    media: MediaDescriptor;
    revision: number;
}
export interface ExampleLibrary {
    entries: ExampleEntry[];
    revisions: Record<string, number>;
}
export interface PreviewResult {
    previewId: string;
    snapshot: ProjectSnapshot;
}
function check(value: unknown): asserts value { if (!value)
    throw new Error('Invalid example response'); }
function shape(v: unknown, keys: string[]): Record<string, unknown> { check(v && typeof v === 'object' && !Array.isArray(v)); const o = v as Record<string, unknown>; check(Object.keys(o).length === keys.length && keys.every(k => Object.hasOwn(o, k))); return o; }
function uuid(v: unknown) { check(typeof v === 'string' && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(v) && v !== '00000000-0000-0000-0000-000000000000'); }
function revision(v: unknown) { check(Number.isSafeInteger(v) && (v as number) >= 0); }
export function parseExampleEntry(v: unknown): ExampleEntry {
    const e = shape(v, ['sampleId', 'projectId', 'creatorId', 'scope', 'name', 'originalFilename', 'media', 'revision']);
    uuid(e.sampleId);
    uuid(e.projectId);
    uuid(e.creatorId);
    revision(e.revision);
    check(e.scope === 'private' || e.scope === 'shared');
    check(typeof e.name === 'string' && e.name.trim().length > 0 && Array.from(e.name).length <= 128 && !/[\u0000-\u001f\u007f-\u009f]/.test(e.name));
    check(typeof e.originalFilename === 'string' && e.originalFilename.length > 0 && e.originalFilename.length <= 4096 && !/[\u0000/\\]/.test(e.originalFilename));
    parseChange({ type: 'importMedia', media: e.media });
    return v as ExampleEntry;
}
export function parseExampleLibrary(v: unknown, b: ExampleBinding, scope: ExampleScope): ExampleLibrary {
    const o = shape(v, ['entries', 'revisions']);
    check(Array.isArray(o.entries) && o.entries.length <= 256000);
    check(o.revisions && typeof o.revisions === 'object' && !Array.isArray(o.revisions));
    const revisions = Object.entries(o.revisions);
    check(revisions.length <= 256);
    for (const [id, r] of revisions) {
        uuid(id);
        revision(r);
    }
    const ids = new Set<string>();
    const counts = new Map<string, number>();
    for (const value of o.entries) {
        const e = parseExampleEntry(value);
        check(e.projectId === b.projectId && e.scope === scope && !ids.has(`${e.creatorId}/${e.sampleId}`));
        ids.add(`${e.creatorId}/${e.sampleId}`);
        counts.set(e.creatorId, (counts.get(e.creatorId) ?? 0) + 1);
        check(counts.get(e.creatorId)! <= 1000 && (o.revisions as Record<string, number>)[e.creatorId] === e.revision);
    }
    return v as ExampleLibrary;
}
async function call<T>(name: string, b: ExampleBinding, extra: Record<string, unknown>, parse: (v: unknown) => T): Promise<T> { uuid(b.runtimeNonce); uuid(b.projectId); try {
    return parse(await invoke(name, { runtimeNonce: b.runtimeNonce, projectId: b.projectId, ...extra }));
}
catch (e) {
    throw normalizeError(e);
} }
const recordArgs = (e: ExampleEntry) => ({ scope: e.scope, creatorId: e.creatorId, sampleId: e.sampleId });
const boundEntry = (b: ExampleBinding, scope: ExampleScope) => (v: unknown) => { const e = parseExampleEntry(v); check(e.projectId === b.projectId && e.scope === scope); return e; };
export const exampleClient = {
    list: (b: ExampleBinding, scope: ExampleScope) => call('examples_list', b, { scope }, v => parseExampleLibrary(v, b, scope)),
    import: (b: ExampleBinding, scope: ExampleScope, path: string, name: string, expectedRevision: number) => call('examples_import', b, { scope, path, name, expectedRevision }, boundEntry(b, scope)),
    fromProject: (b: ExampleBinding, scope: ExampleScope, mediaId: string, name: string, expectedRevision: number) => call('examples_from_project', b, { scope, mediaId, name, expectedRevision }, boundEntry(b, scope)),
    rename: (b: ExampleBinding, e: ExampleEntry, name: string) => call('examples_rename', b, { ...recordArgs(e), name, expectedRevision: e.revision }, boundEntry(b, e.scope)),
    remove: (b: ExampleBinding, e: ExampleEntry) => call('examples_remove', b, { ...recordArgs(e), expectedRevision: e.revision }, () => { }),
    copy: (b: ExampleBinding, e: ExampleEntry, targetScope: ExampleScope, expectedRevision: number) => call('examples_copy', b, { ...recordArgs(e), targetScope, expectedRevision }, boundEntry(b, targetScope)),
    choose: async () => { const paths = await open({ multiple: true, title: '导入示例音频', filters: [{ name: '音频', extensions: ['wav', 'flac', 'mp3'] }] }); return typeof paths === 'string' ? [paths] : paths ?? []; },
    open: (b: ExampleBinding, e: ExampleEntry, analysisSettings: AnalysisSettings, requestId: string) => call('example_preview_open', b, { ...recordArgs(e), analysisSettings, requestId }, v => {
        const o = shape(v, ['previewId', 'snapshot']);
        uuid(o.previewId);
        const snapshot = parseProjectSnapshot(o.snapshot);
        check(snapshot.document.projectId !== b.projectId && snapshot.document.media.length === 1 && !snapshot.document.annotations.length && !snapshot.document.edits.length && !snapshot.canUndo && !snapshot.canRedo);
        return { previewId: o.previewId as string, snapshot };
    }),
    cancelOpen: (b: ExampleBinding, requestId: string) => call('example_preview_cancel_open', b, { requestId }, () => { }),
    close: (b: ExampleBinding, previewId: string) => call('example_preview_close', b, { previewId }, () => { }),
    status: (b: ExampleBinding, previewId: string) => call('example_preview_media_status', b, { previewId }, v => { check(Array.isArray(v) && v.length === 1); const o = shape(v[0], ['mediaId', 'status']); uuid(o.mediaId); check(['ready', 'missing', 'changed'].includes(o.status as string)); return v as MediaStatus[]; }),
    configure: async (b: ExampleBinding, previewId: string, request: PlaybackRequest) => {
        check(request.projectId !== b.projectId && request.mode.mode === 'original' && request.bypass === false);
        uuid(request.projectId);
        uuid(request.mediaId);
        return call('example_preview_playback_configure', b, { previewId, request }, v => { const status = parsePlaybackStatus(v); check(status.projectId === request.projectId && status.mediaId === request.mediaId); return status; });
    },
    control: (b: ExampleBinding, previewId: string, action: 'pause' | 'stop') => call('example_preview_playback_control', b, { previewId, action }, parsePlaybackStatus),
    playbackStatus: (b: ExampleBinding, previewId: string) => call('example_preview_playback_status', b, { previewId }, parsePlaybackStatus),
    tiles: (b: ExampleBinding, previewId: string): TileTransport => ({
        register: () => call('example_preview_register_view', b, { previewId }, v => { check(typeof v === 'string' && v.length > 0 && v.length <= 128); return v as string; }),
        retire: (_projectId, viewId) => call('example_preview_retire_view', b, { previewId, viewId }, () => { }),
        cancel: (_projectId, viewId, generation) => call('example_preview_cancel_generation', b, { previewId, viewId, generation }, () => { }),
        request: (request, onProgress) => { const onEvent = new Channel<TileProgress>(); onEvent.onmessage = p => { if (p.requestId === request.requestId && p.viewId === request.viewId && p.generation === request.generation)
            onProgress?.(p); }; return call('example_preview_request_tile', b, { previewId, request, onEvent }, v => { check(v instanceof ArrayBuffer); return v; }); },
    }),
};
export type ExampleAPI = Pick<typeof exampleClient, 'list' | 'import' | 'fromProject' | 'rename' | 'remove' | 'copy'>;
export type PreviewAPI = Pick<typeof exampleClient, 'open' | 'cancelOpen' | 'close' | 'status' | 'configure' | 'control' | 'playbackStatus' | 'tiles'>;
