/// <reference types="node" />
import { afterEach, it, expect, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { webcrypto } from 'node:crypto';
import fixture from '../../../tests/fixtures/document-v1.json';
import { ProjectStore } from '../../app/store';
import { parseProjectDocument } from '../../bridge/types';
import { mediaClient } from '../../bridge/media';
import type { ActiveProject } from '../project/useProjectLifecycle';
import { SpectrogramCanvas } from './SpectrogramCanvas';
import { nativeTileTransport, type TileRequest } from './tileClient';
import { defaultSettings, defaultView, tilePlan } from './workspace';
import { tileCache } from './tileScheduler';
import { TileCache } from './tileCache';
const media = [0, 1].map(index => ({ ...fixture.media[0], id: index ? '00000000-0000-4000-8000-000000000009' : fixture.media[0].id, channelCount: 6, channelLayout: null, channelNotes: Array(6).fill(''), frameCount: 600 * 48000 }));
const settings = { ...defaultSettings, fftSize: 4096 };
const view = { ...defaultView(media[0]), lowHz: 6100, highHz: 17800, visibleChannels: [0, 1, 2, 3, 4, 5] };
function packet(r: TileRequest) {
  const source = media.find(m => m.id === r.mediaId)!;
  const sourceFrames = Math.min(Math.ceil(source.frameCount / r.settings.hopSize) - r.startFrame, r.frameCount * 2 ** r.timeLod);
  const rows = Math.ceil(sourceFrames / 2 ** r.timeLod), columns = Math.ceil(r.frequencyCount / 2 ** r.frequencyLod);
  const metadata = new TextEncoder().encode(JSON.stringify({ protocol: 1, request: r, encoding: 'f32le-db-row-major', valueCount: rows * columns, tile: { rows, columns, sourceFrames, sampleRate: source.sampleRate, totalSamples: source.frameCount, startSeconds: r.startFrame * r.settings.hopSize / source.sampleRate, endSeconds: Math.min((r.startFrame + sourceFrames) * r.settings.hopSize, source.frameCount) / source.sampleRate, frameStepSamples: r.settings.hopSize * 2 ** r.timeLod, melPointsHz: [] } }));
  const offset = Math.ceil((8 + metadata.length) / 4) * 4, bytes = new ArrayBuffer(offset + rows * columns * 4);
  new Uint8Array(bytes).set([65, 84, 48, 49]); new DataView(bytes).setUint32(4, metadata.length, true); new Uint8Array(bytes, 8, metadata.length).set(metadata);
  new Float32Array(bytes, offset).fill(-25); return bytes;
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); tileCache.clear(); });
it('budgets every channel working set for all twelve mounted canvases', () => {
  const requests = tilePlan(media[0], settings, view, 1024, 0, 'hash').filter(r => r.visible);
  const bytes = requests.reduce((sum, r) => sum + r.frameCount * Math.ceil(r.frequencyCount / 2 ** r.frequencyLod) * 4 + 16384, 0);
  expect(bytes).toBeLessThanOrEqual(5 * 1024 * 1024);
  expect(bytes * 12).toBeLessThanOrEqual(60 * 1024 * 1024);
  expect(tilePlan(media[0], settings, { ...view, lowHz: 7000, highHz: 8000 }, 1024, 0, 'hash')[0].timeLod).toBe(requests[0].timeLod);
  expect(tilePlan(media[0], settings, { ...view, endSeconds: 1 }, 1024, 0, 'hash').every(r => r.timeLod === 0)).toBe(true);
});
it('does not evict owned dependencies to admit background cache entries', () => {
  const cache = new TileCache<number>(12);
  cache.set('a', 1, 8); cache.setPins('view', ['a']); cache.set('b', 2, 4); cache.set('c', 3, 8);
  expect(cache.get('a')).toBe(1); expect(cache.bytes).toBeLessThanOrEqual(12);
  cache.setPins('view', []); cache.set('c', 3, 8); expect(cache.get('c')).toBe(3);
});
it('renders all twelve channels after gain, palette and mix changes without reload churn', async () => {
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('ResizeObserver', class { constructor(private callback: (entries: { contentRect: { width: number; height: number } }[]) => void) {} observe() { this.callback([{ contentRect: { width: 1024, height: 180 } }]); } disconnect() {} });
  const images = new Map<HTMLCanvasElement, ImageData>();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function(this: HTMLCanvasElement) {
    const canvas = this;
    return { createImageData: (width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4), width, height }), putImageData: (image: ImageData) => images.set(canvas, image) } as unknown as CanvasRenderingContext2D;
  });
  vi.spyOn(mediaClient, 'status').mockResolvedValue(media.map(m => ({ mediaId: m.id, status: 'ready' })));
  const request = vi.spyOn(nativeTileTransport, 'request').mockImplementation(async r => packet(r));
  vi.spyOn(nativeTileTransport, 'cancel').mockResolvedValue();
  vi.spyOn(nativeTileTransport, 'register').mockImplementation(async () => crypto.randomUUID());
  vi.spyOn(nativeTileTransport, 'retire').mockResolvedValue();
  const active = { store: new ProjectStore({ document: parseProjectDocument({ ...fixture, media, analysis: Object.fromEntries(media.map(m => [m.id, settings])), playbackMix: Object.fromEntries(media.map(m => [m.id, { soloChannels: [], mutedChannels: [] }])) }), canUndo: false, canRedo: false }) } as ActiveProject;
  const panes = (gainDb: number, palette: string, frequencyMix: number) => <>{media.flatMap(m => Array.from({ length: 6 }, (_, channel) => <SpectrogramCanvas key={`${m.id}:${channel}`} active={active} media={m} settings={settings} view={{ ...view, gainDb, palette, frequencyMix }} channel={channel} status="ready" timeLimit={600} onView={() => {}} />))}</>;
  const screen = render(panes(0, 'ember', .65));
  await waitFor(() => { expect(images.size).toBe(12); expect(screen.container.querySelector('.tile-status')).toBeNull(); }, { timeout: 10000 });
  const before = request.mock.calls.length;
  const retained = tileCache.get(tileCache.matchingKeys(() => true)[0])!;
  for (let i = 0; i < 80; i++) tileCache.set(`historical-${i}`, retained, 1024 * 1024);
  for (const style of [[10, 'ember', .65], [10, 'ocean', .65], [10, 'ocean', .2]] as const) {
    images.clear(); screen.rerender(panes(style[0], style[1], style[2]));
    await waitFor(() => expect(images.size).toBe(12));
    expect([...images.values()].every(image => image.data.every((n, i) => i % 4 !== 0 || n > 20))).toBe(true);
    expect(screen.container.querySelector('.tile-status')).toBeNull(); expect(request).toHaveBeenCalledTimes(before);
  }
  expect(tileCache.bytes).toBeLessThanOrEqual(64 * 1024 * 1024);
  // Explicit invalidation is different from pressure: an unexpectedly missing
  // dependency must enter recovery, never remain a silently completed black plot.
  tileCache.clear(); images.clear(); screen.rerender(panes(10, 'gray', .2));
  await waitFor(() => expect(request.mock.calls.length).toBeGreaterThan(before));
  await waitFor(() => { expect(screen.container.querySelector('.tile-status')).toBeNull(); expect(images.size).toBe(12); expect([...images.values()].every(image => image.data.every((n, i) => i % 4 !== 0 || n > 20))).toBe(true); }, { timeout: 10000 });
  screen.unmount(); expect(tileCache.set('new-session', retained, tileCache.limit)).toBe(true);
});
