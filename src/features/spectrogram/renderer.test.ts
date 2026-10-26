import { it, expect } from 'vitest';
import { frequencyRows, rasterize } from './renderer';
import { defaultSettings, defaultView } from './workspace';
import fixture from '../../../tests/fixtures/document-v3.json';
import type { TileResult } from './tileClient';
const media = fixture.media[0];
it('rasterizes raw dB with high frequency at top and blank short-file tail', () => {
  const view = { ...defaultView(media), startSeconds: 0, endSeconds: 2, frequencyMix: 0, palette: 'gray' };
  const pixels = new Uint8ClampedArray(4 * 2 * 4);
  const tile = { request: { requestId: 'r', viewId: 'v', projectId: 'p', mediaId: 'm', generation: 1, analysisSource:'original' as const,processingVersion:2,editSignature:'',configHash: 'h', channelIndex: 0, visible: true, settings: { ...defaultSettings, hopSize: 48000, fftSize: 48000 }, kind: 'stft', startFrame: 0, frameCount: 1, timeLod: 0, frequencyStart: 0, frequencyCount: 2, frequencyLod: 0 }, metadata: { startSeconds: 0, endSeconds: 1, sampleRate: 48000, totalSamples: 48000, sourceFrames: 1, frameStepSamples: 48000, rows: 1, columns: 2, melPointsHz: [] }, values: new Float32Array([-100, 0]) } as TileResult;
  rasterize(pixels, 4, 2, view, new Float64Array([1, 0]), [tile]);
  expect(Array.from(pixels.slice(0, 12))).toEqual([255, 255, 255, 255, 255, 255, 255, 255, 0, 0, 0, 255]);
  expect(pixels[4 * 4]).toBe(0);
  const gain = new Uint8ClampedArray(pixels.length);
  rasterize(gain, 4, 2, { ...view, gainDb: 50 }, new Float64Array([1, 0]), [tile]);
  expect(gain[4 * 4]).toBe(128); expect(tile.values[0]).toBe(-100);
});
it('precomputes mel/STFT screen row geometry including Nyquist/DC bins', () => {
  const view = defaultView(media);
  const stft = frequencyRows(view, 48000, defaultSettings, 256);
  expect(stft[0]).toBeGreaterThan(stft[255]); expect(stft.every(v => v >= 0 && v <= 24000)).toBe(true);
  const mel = frequencyRows({ ...view, spectrumKind: 'mel' }, 48000, defaultSettings, 256);
  expect(mel[0]).toBeGreaterThan(23000); expect(mel[255]).toBeGreaterThan(0); expect(mel[255]).toBeLessThan(10);
});
it('interpolates physical frequency in the power domain before color mapping', () => {
  const view = { ...defaultView(media), endSeconds: 1, frequencyMix: 0, palette: 'gray' };
  const tile = { request: { requestId: 'r', viewId: 'v', projectId: 'p', mediaId: 'm', generation: 1, analysisSource:'original' as const,processingVersion:2,editSignature:'',configHash: 'h', channelIndex: 0, visible: true, settings: { ...defaultSettings, hopSize: 48000, fftSize: 48000 }, kind: 'stft', startFrame: 0, frameCount: 1, timeLod: 0, frequencyStart: 0, frequencyCount: 2, frequencyLod: 0 }, metadata: { startSeconds: 0, endSeconds: 1, sampleRate: 48000, totalSamples: 48000, sourceFrames: 1, frameStepSamples: 48000, rows: 1, columns: 2, melPointsHz: [] }, values: new Float32Array([-20, -40]) } as TileResult;
  const pixels = new Uint8ClampedArray(4);
  rasterize(pixels, 1, 1, view, Float64Array.of(.5), [tile]);
  expect(pixels[0]).toBe(Math.round((10 * Math.log10(.00505) + 100) / 100 * 255));
});
