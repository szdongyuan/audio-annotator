import { expect, it } from 'vitest';
import type { TileResult } from './tileClient';
import { createSampler, timeCenters, frequencyCenters } from './sampling';
export function tile(overrides: Partial<TileResult['request']> = {}, values = [-20, -40, -40, -20], extra: Partial<TileResult['metadata']> = {}): TileResult {
  const request = { requestId: 'r', viewId: 'v', projectId: 'p', mediaId: 'm', generation: 1, analysisSource:'original' as const,processingVersion:2,editSignature:'',configHash: 'h', channelIndex: 0, kind: 'stft' as const, settings: { window: 'hann' as const, windowSize: 64, hopSize: 100, fftSize: 200, melBands: 32 }, startFrame: 0, frameCount: 2, timeLod: 0, frequencyStart: 0, frequencyCount: 2, frequencyLod: 0, visible: true, ...overrides };
  const rows = request.frameCount, columns = Math.ceil(request.frequencyCount / 2 ** request.frequencyLod);
  return { request, metadata: { rows, columns, sourceFrames: rows * 2 ** request.timeLod, sampleRate: 1000, totalSamples: 200, startSeconds: request.startFrame / 10, endSeconds: (request.startFrame + rows * 2 ** request.timeLod) / 10, frameStepSamples: 100 * 2 ** request.timeLod, melPointsHz: [], ...extra }, values: Float32Array.from(values) };
}
const sample = (tiles: TileResult[], seconds: number, hz: number) => {
  const s = createSampler(tiles, Float64Array.of(seconds), Float64Array.of(hz));
  const a = new Float64Array(1), b = new Float64Array(1), p = s.time[0];
  if (p.low < 0) return NaN;
  s.profile(p.low, a); s.profile(p.high, b); return 10 * Math.log10(a[0] * (1 - p.weight) + b[0] * p.weight);
};
it('uses window starts, partial LOD real frame count, STFT bin means and native Mel center means', () => {
  expect([...timeCenters(tile({ startFrame: 8, timeLod: 2 }, [], { sourceFrames: 5 }))]).toEqual([.95, 1.2]);
  expect([...frequencyCenters(tile({ frequencyStart: 4, frequencyCount: 5, frequencyLod: 2 }))]).toEqual([27.5, 40]);
  expect([...frequencyCenters(tile({ kind: 'mel', frequencyStart: 1, frequencyCount: 3, frequencyLod: 1 }, [], { melPointsHz: [0, 20, 90, 230, 500, 900] }))]).toEqual([160, 500]);
});
it('interpolates power at real seconds and Hz, never averages dB', () => {
  const t = tile();
  const midpoint = 10 * Math.log10((.01 + .0001) / 2);
  expect(sample([t], 0, 2.5)).toBeCloseTo(midpoint, 10);
  expect(sample([t], .05, 0)).toBeCloseTo(midpoint, 10);
  expect(sample([t], .05, 2.5)).toBeCloseTo(midpoint, 10);
  expect(sample([t], 0, 0)).toBe(-20);
});
it('joins real time/frequency neighbors across partitions and does not extend missing neighbors', () => {
  const left = tile({ frameCount: 1, frequencyCount: 1 }, [-20], { totalSamples: 200 });
  const right = tile({ startFrame: 1, frameCount: 1, frequencyCount: 1 }, [-40], { totalSamples: 200 });
  expect(sample([left], .05, 0)).toBeNaN();
  expect(sample([left, right], .05, 0)).toBeCloseTo(10 * Math.log10(.00505));
  const upper = tile({ frameCount: 1, frequencyStart: 1, frequencyCount: 1 }, [-40]);
  expect(sample([left], 0, 2.5)).toBeNaN();
  expect(sample([left, upper], 0, 2.5)).toBeCloseTo(10 * Math.log10(.00505));
  const gap = tile({ startFrame: 2, frameCount: 1, frequencyCount: 1 }, [-40], { totalSamples: 300 });
  expect(sample([left, gap], .1, 0)).toBeNaN();
});
it('extends only actual global endpoints and leaves before/after audio blank', () => {
  const t = tile({ frequencyStart: 100, frequencyCount: 1 }, [-20, -40]);
  expect(sample([t], .1999, 500)).toBeCloseTo(-40);
  expect(sample([t], .2, 500)).toBeNaN(); expect(sample([t], -.01, 500)).toBeNaN();
  expect(sample([t], .05, 499)).toBeNaN(); expect(sample([t], .05, 501)).toBeNaN();
  const lod = tile({ timeLod: 1, frequencyLod: 1, frequencyCount: 2, frameCount: 1 }, [-20]);
  expect(sample([lod], 0, 0)).toBeCloseTo(-20);
});
it('uses physical Hz weights between nonlinear native Mel centers', () => {
  const t = tile({ kind: 'mel', frequencyCount: 2 }, [-20, -40, -20, -40], { melPointsHz: [0, 100, 500, 1000] });
  expect(sample([t], 0, 200)).toBeCloseTo(10 * Math.log10(.01 * .75 + .0001 * .25));
});
