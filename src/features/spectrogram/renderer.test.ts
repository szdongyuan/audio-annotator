import { it, expect } from 'vitest';
import { frequencyRows, rasterize } from './renderer';
import { defaultSettings, defaultView } from './workspace';
import fixture from '../../../tests/fixtures/document-v1.json';
import type { TileResult } from './tileClient';
const media = fixture.media[0];
it('rasterizes raw dB with high frequency at top and blank short-file tail', () => {
  const view = { ...defaultView(media), startSeconds: 0, endSeconds: 2, frequencyMix: 0, palette: 'gray' };
  const pixels = new Uint8ClampedArray(4 * 2 * 4);
  const tile = { request: { frequencyStart: 0, frequencyCount: 2, frequencyLod: 0 }, metadata: { startSeconds: 0, endSeconds: 1, sampleRate: 48000, frameStepSamples: 48000, rows: 1, columns: 2 }, values: new Float32Array([-100, 0]) } as TileResult;
  rasterize(pixels, 4, 2, view, new Int32Array([1, 0]), [tile]);
  expect(Array.from(pixels.slice(0, 12))).toEqual([255, 255, 255, 255, 255, 255, 255, 255, 0, 0, 0, 255]);
  expect(pixels[4 * 4]).toBe(0);
  const gain = new Uint8ClampedArray(pixels.length);
  rasterize(gain, 4, 2, { ...view, gainDb: 50 }, new Int32Array([1, 0]), [tile]);
  expect(gain[4 * 4]).toBe(128); expect(tile.values[0]).toBe(-100);
});
it('precomputes mel/STFT screen row geometry including Nyquist/DC bins', () => {
  const view = defaultView(media);
  const stft = frequencyRows(view, 48000, defaultSettings, 256);
  expect(stft[0]).toBeGreaterThan(stft[255]); expect(stft.every(v => v >= 0 && v <= 1024)).toBe(true);
  const mel = frequencyRows({ ...view, spectrumKind: 'mel' }, 48000, defaultSettings, 256);
  expect(mel[0]).toBe(127); expect(mel[255]).toBe(0);
});
