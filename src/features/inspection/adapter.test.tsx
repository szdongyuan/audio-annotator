import { webcrypto } from 'node:crypto';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import fixture from '../../../tests/fixtures/document-v3.json';
import { parseProjectDocument, type AnalysisSettings, type MediaDescriptor } from '../../bridge/types';
import type { InspectionBinding } from '../../bridge/inspection';
import type { MediaStatus } from '../../bridge/media';
import { useTiles } from '../spectrogram/useTiles';
import { tileCache } from '../spectrogram/tileScheduler';
import type { TileRequest } from '../spectrogram/tileClient';
import { defaultView } from '../spectrogram/workspace';
import { InspectionSession } from './session';
import { inspectionProject } from './adapter';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke, isTauri: () => false, Channel: class { onmessage: unknown } }));
afterEach(() => { vi.unstubAllGlobals(); tileCache.clear(); invoke.mockReset(); });

function packet(request: TileRequest, media: MediaDescriptor) {
 const sourceFrames = Math.min(Math.ceil(media.frameCount / request.settings.hopSize) - request.startFrame, request.frameCount * 2 ** request.timeLod);
 const rows = Math.ceil(sourceFrames / 2 ** request.timeLod), columns = Math.ceil(request.frequencyCount / 2 ** request.frequencyLod);
 const metadata = new TextEncoder().encode(JSON.stringify({ protocol: 1, request, encoding: 'f32le-db-row-major', valueCount: rows * columns,
  tile: { rows, columns, sourceFrames, sampleRate: media.sampleRate, totalSamples: media.frameCount,
   startSeconds: request.startFrame * request.settings.hopSize / media.sampleRate,
   endSeconds: Math.min((request.startFrame + sourceFrames) * request.settings.hopSize, media.frameCount) / media.sampleRate,
   frameStepSamples: request.settings.hopSize * 2 ** request.timeLod, melPointsHz: [] } }));
 const offset = Math.ceil((8 + metadata.length) / 4) * 4, bytes = new ArrayBuffer(offset + rows * columns * 4);
 new Uint8Array(bytes).set([65, 84, 48, 49]); new DataView(bytes).setUint32(4, metadata.length, true); new Uint8Array(bytes, 8, metadata.length).set(metadata);
 return bytes;
}

async function setup() {
 vi.stubGlobal('crypto', webcrypto);
 const binding: InspectionBinding = { runtimeNonce: crypto.randomUUID(), projectId: fixture.projectId }, previewId = crypto.randomUUID();
 const document = parseProjectDocument(structuredClone(fixture)); document.projectId = previewId; document.annotations = []; document.media = [document.media[0]];
 const media = document.media[0], snapshot = { document, canUndo: false, canRedo: false };
 const native = { sourceStatus: 'ready' as MediaStatus['status'], requests: [] as TileRequest[], leases: new Set<string>(), nextLease: 0 };
 invoke.mockImplementation(async (command: string, args: Record<string, any>) => {
  expect(args.runtimeNonce).toBe(binding.runtimeNonce); expect(args.projectId).toBe(binding.projectId);
  if (command === 'inspection_open') return { previewId, snapshot: structuredClone(snapshot) };
  expect(args.previewId).toBe(previewId);
  if (command === 'inspection_media_status') return [{ mediaId: media.id, status: native.sourceStatus }];
  if (command === 'inspection_register_view') { const lease = `inspection-${++native.nextLease}`; native.leases.add(lease); return lease; }
  if (command === 'inspection_request_tile') {
   const request = args.request as TileRequest;
   expect(native.leases.has(request.viewId)).toBe(true); expect(request.projectId).toBe(previewId); expect(request.mediaId).toBe(media.id);
   native.requests.push(request); return packet(request, media);
  }
  if (command === 'inspection_configure_analysis') { native.leases.clear(); document.analysis[media.id] = args.analysisSettings as AnalysisSettings; return structuredClone(snapshot); }
  if (command === 'inspection_cancel_generation') return;
  if (command === 'inspection_retire_view') { native.leases.delete(args.viewId); return; }
  if (command === 'inspection_close') { native.leases.clear(); return; }
  throw new Error(`Unexpected command outside inspection transport: ${command}`);
 });
 const session = new InspectionSession(binding); await session.open(media.id, document.analysis[media.id], async () => {});
 const owner = inspectionProject(session.result!, binding);
 return { binding, previewId, media, session, owner, native };
}

it('renders real useTiles through bound source verification and binary tiles, denies writes, and renews analysis leases', async () => {
 const s = await setup(), settings = s.owner.store.snapshot.document.analysis[s.media.id];
 const hook = renderHook(() => useTiles(s.owner, s.media, settings, defaultView(s.media), 0, 800, 'unverified'));
 await waitFor(() => expect(hook.result.current.completed > 0 || hook.result.current.error !== null).toBe(true));
 expect(hook.result.current.error).toBeNull(); expect(hook.result.current.completed).toBeGreaterThan(0);
 expect(hook.result.current.error).toBeNull(); expect(invoke.mock.calls.some(([command]) => command === 'inspection_media_status')).toBe(true);
 const firstRequests = [...s.native.requests], firstLeases = new Set(firstRequests.map(r => r.viewId)); expect(firstLeases.size).toBe(1);
 const before = invoke.mock.calls.length;
 await expect(s.owner.commands!.project.getSnapshot(s.previewId)).rejects.toMatchObject({ code: 'InvalidInput' });
 await expect(s.owner.commands!.project.applyChange(s.previewId, 0, { type: 'updateAnalysis', mediaId: s.media.id, settings })).rejects.toMatchObject({ code: 'InvalidInput' });
 await expect(s.owner.commands!.media.start(s.previewId, ['other.wav'], () => {}, s.media.id)).rejects.toMatchObject({ code: 'InvalidInput' });
 expect(invoke).toHaveBeenCalledTimes(before);
 hook.unmount(); s.owner.lifecycle.dispose(); await s.session.analysis({ ...settings, hopSize: 256 });
 const replacement = inspectionProject(s.session.result!, s.binding), nextSettings = replacement.store.snapshot.document.analysis[s.media.id];
 const next = renderHook(() => useTiles(replacement, s.media, nextSettings, defaultView(s.media), 0, 800, 'unverified'));
 await waitFor(() => expect(next.result.current.completed).toBeGreaterThan(0));
 expect(s.native.requests.length).toBeGreaterThan(firstRequests.length);
 expect(s.native.requests.slice(firstRequests.length).every(r => !firstLeases.has(r.viewId) && r.settings.hopSize === 256)).toBe(true);
 next.unmount(); replacement.lifecycle.dispose(); s.session.dispose();
});

it.each(['changed', 'missing'] as const)('real useTiles propagates %s source verification and drops retained pixels before requesting more tiles', async status => {
 const s = await setup(), settings = s.owner.store.snapshot.document.analysis[s.media.id];
 const hook = renderHook(({ view }) => useTiles(s.owner, s.media, settings, view, 0, 800, 'unverified'), { initialProps: { view: defaultView(s.media) } });
 await waitFor(() => expect(hook.result.current.completed > 0 || hook.result.current.error !== null).toBe(true));
 expect(hook.result.current.error).toBeNull(); expect(hook.result.current.completed).toBeGreaterThan(0);
 const requested = s.native.requests.length; s.native.sourceStatus = status;
 act(() => hook.rerender({ view: { ...defaultView(s.media), endSeconds: 1.5 } }));
 await waitFor(() => expect(hook.result.current.error).toBe(status === 'missing' ? '音频缺失，请重新关联' : '源文件已改变，请重新校验关联'));
 expect(hook.result.current.keys).toEqual([]); expect(s.native.requests).toHaveLength(requested);
 hook.unmount(); s.owner.lifecycle.dispose(); s.session.dispose();
});
