import { expect, it, vi } from 'vitest';
import fixture from '../../../tests/fixtures/document-v3.json';
import { parseProjectDocument } from '../../bridge/types';
import { emptyPlayback } from '../../bridge/playback';
import type { InspectionAPI, InspectionPreview } from '../../bridge/inspection';
import { defaultSettings } from '../spectrogram/workspace';
import { InspectionSession } from './session';

const binding = { runtimeNonce: crypto.randomUUID(), projectId: fixture.projectId };
const mediaId = fixture.media[0].id, previewId = crypto.randomUUID();
const document = parseProjectDocument(structuredClone(fixture));
document.projectId = previewId; document.annotations = []; document.media = [document.media[0]];
const result: InspectionPreview = { previewId, snapshot: { document, canUndo: false, canRedo: false } };
const settings = { monitorGainDb: 0, volume: .7, deviceId: null, looping: false };
const status = (generation = 1) => ({ ...emptyPlayback, projectId: previewId, mediaId, generation, state: 'playing' as const });
function fake() {
 return { open: vi.fn<InspectionAPI['open']>(async () => result), cancelOpen: vi.fn(async () => {}), close: vi.fn(async () => {}),
 configureAnalysis: vi.fn(async () => structuredClone(result.snapshot)), configure: vi.fn(async () => status()),
 control: vi.fn(async () => ({ ...status(), state: 'stopped' as const })), monitorGain: vi.fn(async () => status()),
 playbackStatus: vi.fn(async () => status()), status: vi.fn<InspectionAPI['status']>(async () => [{ mediaId, status: 'ready' as const }]), tiles: vi.fn() } satisfies InspectionAPI;
}
it('waits for acknowledged main handoff, never autoplays, and avoids control before a native stream exists', async () => {
 const api = fake(), s = new InspectionSession(binding, api); let resolve!: () => void;
 const opening = s.open(mediaId, defaultSettings, () => new Promise<void>(r => resolve = r));
 expect(api.open).not.toHaveBeenCalled(); resolve(); await opening;
 expect(api.configure).not.toHaveBeenCalled(); await s.stop(); expect(api.control).not.toHaveBeenCalled();
 await s.play(settings, { mode: 'processed' }); expect(api.configure).toHaveBeenCalledWith(binding, previewId, expect.objectContaining({ projectId: previewId, mediaId, mode: { mode: 'processed' }, play: true }));
 s.dispose(); expect(api.close).toHaveBeenCalledWith(binding, previewId);
});
it('cancels a pending native open and closes its late response without publishing', async () => {
 const api = fake(), s = new InspectionSession(binding, api); let resolve!: (r: InspectionPreview) => void;
 api.open.mockImplementation(() => new Promise(r => resolve = r)); const opening = s.open(mediaId, defaultSettings, async () => {}); await Promise.resolve();
 const requestId = api.open.mock.calls[0][3]; s.dispose(); expect(api.cancelOpen).toHaveBeenCalledWith(binding, requestId);
 resolve(result); await opening; expect(s.result).toBeNull(); expect(api.close).toHaveBeenCalledWith(binding, previewId);
});
it('cancels before handoff without submitting native work', async () => {
 const api = fake(), s = new InspectionSession(binding, api); let resolve!: () => void;
 const opening = s.open(mediaId, defaultSettings, () => new Promise<void>(r => resolve = r)); s.dispose(); resolve(); await opening;
 expect(api.open).not.toHaveBeenCalled(); expect(api.cancelOpen).not.toHaveBeenCalled();
});
it('analysis recreates snapshot identity and stops audio; gain queues behind configure using its current generation', async () => {
 const api = fake(), s = new InspectionSession(binding, api); await s.open(mediaId, defaultSettings, async () => {});
 let resolve!: (r: ReturnType<typeof status>) => void; api.configure.mockImplementationOnce(() => new Promise(r => resolve = r));
 const playing = s.play(settings, { mode: 'original' }); await Promise.resolve(); await Promise.resolve();
 const gain = s.gain(8); expect(api.monitorGain).not.toHaveBeenCalled(); resolve(status(4)); await Promise.all([playing, gain]);
 expect(api.monitorGain).toHaveBeenCalledWith(binding, previewId, { projectId: previewId, mediaId, generation: 4, monitorGainDb: 8 });
 const previous = s.result; await s.analysis({ ...defaultSettings, hopSize: 256 });
 expect(api.control).toHaveBeenCalled(); expect(s.result).not.toBe(previous); expect(s.wantsPlayback).toBe(false);
 expect(api.configureAnalysis).toHaveBeenCalledWith(binding, previewId, expect.objectContaining({ hopSize: 256 })); s.dispose();
});
it('source loss and playback failure release resources and never retain stale audition', async () => {
 const api = fake(), s = new InspectionSession(binding, api); await s.open(mediaId, defaultSettings, async () => {}); await s.play(settings, { mode: 'original' });
 api.status.mockResolvedValueOnce([{ mediaId, status: 'missing' }]); await s.checkSource();
 expect(s.result).toBeNull(); expect(s.error).toMatch(/不可用/); expect(s.wantsPlayback).toBe(false); expect(api.close).toHaveBeenCalledOnce();
 await s.open(mediaId, defaultSettings, async () => {}); api.configure.mockRejectedValueOnce(new Error('output failed'));
 await s.play(settings, { mode: 'original' }); expect(s.result).toBeNull(); expect(api.close).toHaveBeenCalledTimes(2); s.dispose();
});
it('scopes progress by preview, media and generation and keeps progress renders narrow', async () => {
 const api = fake(), s = new InspectionSession(binding, api); await s.open(mediaId, defaultSettings, async () => {}); await s.play(settings, { mode: 'original' });
 const renders = vi.fn(); s.subscribe(renders); s.progress({ ...status(), positionSeconds: .1 });
 expect(s.statusStore.getSnapshot().positionSeconds).toBe(.1); expect(renders).not.toHaveBeenCalled();
 s.progress({ ...status(), projectId: binding.projectId, positionSeconds: 2 }); s.progress({ ...status(0), positionSeconds: 3 });
 expect(s.statusStore.getSnapshot().positionSeconds).toBe(.1); s.dispose();
});
it('retains React subscription through effect cleanup/restart and rejects old analysis publication', async () => {
 const api = fake(), s = new InspectionSession(binding, api), changed = vi.fn(); s.subscribe(changed);
 await s.open(mediaId, defaultSettings, async () => {}); s.dispose(); s.start(); changed.mockClear();
 await s.open(mediaId, defaultSettings, async () => {}); expect(changed).toHaveBeenCalled();
 let resolve!: (snapshot: typeof result.snapshot) => void; api.configureAnalysis.mockImplementationOnce(() => new Promise(r => resolve = r));
 const pending=s.analysis(defaultSettings); await Promise.resolve(); await Promise.resolve(); s.dispose(); resolve(result.snapshot); await pending;
 expect(s.result).toBeNull();
});
