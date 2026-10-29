import { beforeEach, expect, it, vi } from 'vitest';
import { inspectionClient } from './inspection';
import { parseProjectDocument } from './types';
import { emptyPlayback, type PlaybackRequest } from './playback';
import { analysisConfigHash, type TileRequest } from '../features/spectrogram/tileClient';
import fixture from '../../tests/fixtures/document-v3.json';
const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke, isTauri: () => false, Channel: class { onmessage: unknown } }));
const projectId = '22222222-2222-4222-8222-222222222222';
const runtimeNonce = '11111111-1111-4111-8111-111111111111';
const binding = { projectId, runtimeNonce };
const document = { ...parseProjectDocument(fixture), annotations: [] };
const mediaId = document.media[0].id;
const analysisSettings = document.analysis[mediaId];
const opened = { previewId: document.projectId, snapshot: { document, canUndo: false, canRedo: false } };
beforeEach(() => invoke.mockReset());
it('opens only a native project media ID with independent analysis parameters and cancellation identity', async () => {
  invoke.mockResolvedValue(opened);
  expect(await inspectionClient.open(binding, mediaId, analysisSettings, runtimeNonce)).toEqual(opened);
  expect(invoke).toHaveBeenLastCalledWith('inspection_open', { ...binding, mediaId, analysisSettings, requestId: runtimeNonce });
});

it('exposes independently bound analysis, processed region audition, scalar monitor gain and cleanup', async () => {
  invoke.mockResolvedValue(opened.snapshot);
  expect(await inspectionClient.configureAnalysis(binding, opened.previewId, analysisSettings)).toEqual(opened.snapshot);
  expect(invoke).toHaveBeenLastCalledWith('inspection_configure_analysis', { ...binding, previewId: opened.previewId, analysisSettings });
  const request: PlaybackRequest = { projectId: opened.previewId, mediaId, mode: { mode: 'selection', region: document.edits[0].region, selectionSource: 'processed' }, bypass: false, looping: false, volume: .5, monitorGainDb: 3, deviceId: null, seekSeconds: 0, play: true };
  const status = { ...emptyPlayback, projectId: opened.previewId, mediaId, generation: 7 };
  invoke.mockResolvedValue(status);
  await inspectionClient.configure(binding, opened.previewId, request);
  expect(invoke).toHaveBeenLastCalledWith('inspection_playback_configure', { ...binding, previewId: opened.previewId, request });
  const gain = { projectId: opened.previewId, mediaId, generation: 7, monitorGainDb: 6 };
  await inspectionClient.monitorGain(binding, opened.previewId, gain);
  expect(invoke).toHaveBeenLastCalledWith('inspection_monitor_gain', { ...binding, previewId: opened.previewId, request: gain });
  await inspectionClient.control(binding, opened.previewId, 'stop');
  await inspectionClient.playbackStatus(binding, opened.previewId);
  invoke.mockResolvedValue(undefined);
  await inspectionClient.close(binding, opened.previewId);
  await inspectionClient.cancelOpen(binding, runtimeNonce);
  expect(invoke).toHaveBeenLastCalledWith('inspection_cancel_open', { ...binding, requestId: runtimeNonce });
});

it('rejects stale or writable response shapes and parent-document playback before invoking native', async () => {
  for (const patch of [{ previewId: projectId }, { extra: 1 }, { snapshot: { ...opened.snapshot, canUndo: true } }, { snapshot: { ...opened.snapshot, document: { ...document, annotations: fixture.annotations } } }]) {
    invoke.mockResolvedValue({ ...opened, ...patch });
    await expect(inspectionClient.open(binding, mediaId, analysisSettings, runtimeNonce)).rejects.toBeDefined();
  }
  invoke.mockClear();
  await expect(inspectionClient.configure(binding, opened.previewId, { projectId, mediaId, monitorGainDb: 0 } as PlaybackRequest)).rejects.toBeDefined();
  await expect(inspectionClient.monitorGain(binding, opened.previewId, { projectId: opened.previewId, mediaId, generation: 0, monitorGainDb: 25 })).rejects.toBeDefined();
  expect(invoke).not.toHaveBeenCalled();
});

it('routes original/processed tile leases and status through the isolated transport and filters stale progress', async () => {
  const transport = inspectionClient.tiles(binding, opened.previewId);
  invoke.mockResolvedValue('view-1');
  expect(await transport.register(opened.previewId)).toBe('view-1');
  const request: TileRequest = { requestId: 'tile', viewId: 'view-1', projectId: opened.previewId, mediaId, generation: 3, configHash: await analysisConfigHash(analysisSettings), settings: analysisSettings, channelIndex: 0, kind: 'stft', startFrame: 0, frameCount: 1, timeLod: 0, frequencyStart: 0, frequencyCount: 64, frequencyLod: 0, visible: true, analysisSource: 'processed', processingVersion: 2, editSignature: 'a'.repeat(64) };
  invoke.mockResolvedValue(new ArrayBuffer(16));
  const progress = vi.fn(); await transport.request(request, progress);
  const args = invoke.mock.calls.at(-1)![1];
  const channel = args.onEvent as { onmessage: (value: unknown) => void };
  const event = { requestId: 'tile', viewId: 'view-1', generation: 3, phase: 'ready', completed: 1, total: 1 };
  channel.onmessage({ ...event, generation: 2 }); channel.onmessage(event);
  expect(progress).toHaveBeenCalledExactlyOnceWith(event);
  expect(invoke.mock.calls.at(-1)![0]).toBe('inspection_request_tile');
  invoke.mockResolvedValue(undefined);
  await transport.cancel(opened.previewId, 'view-1', 3);
  await transport.retire(opened.previewId, 'view-1');
  invoke.mockResolvedValue([{ mediaId, status: 'changed' }]);
  expect(await inspectionClient.status(binding, opened.previewId)).toEqual([{ mediaId, status: 'changed' }]);
});
