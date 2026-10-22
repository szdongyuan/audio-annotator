import { describe, it, expect } from 'vitest';
import { coordinates, frequencyScale } from './coordinates';
describe('physical coordinates', () => {
  it('matches the specified DC-inclusive transform', () => {
    expect(frequencyScale(1000, 24000, .5)).toBeCloseTo(.5 * 1000 / 24000 + .5 * Math.log1p(50) / Math.log1p(1200), 14);
  });
  it('round trips pixels within half a pixel at DC, Nyquist and cropped viewports', () => {
    for (const spectrumKind of ['stft', 'mel'] as const) for (const frequencyMix of [0, .17, .5, .83, 1]) {
      for (const [lowHz, highHz] of [[0, 24000], [31, 7200]]) {
        const c = coordinates({ startSeconds: 12, endSeconds: 35, lowHz, highHz, spectrumKind, frequencyMix }, 24000, 1234, 351);
        for (let p = 0; p <= 351; p += .37) expect(Math.abs(c.hzToY(c.yToHz(p)) - p)).toBeLessThan(.5);
        for (let p = 0; p <= 1234; p += .71) expect(Math.abs(c.secondsToX(c.xToSeconds(p)) - p)).toBeLessThan(.5);
        expect(c.yToHz(351)).toBeCloseTo(lowHz, 8); expect(c.yToHz(0)).toBeCloseTo(highHz, 8);
      }
    }
  });
});
