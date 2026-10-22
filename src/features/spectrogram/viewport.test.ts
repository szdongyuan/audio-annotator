import { describe, it, expect } from 'vitest';
import { coordinates } from './coordinates';
import { zoomViewport, panViewport } from './viewport';
const view = { startSeconds: 10, endSeconds: 30, lowHz: 100, highHz: 10000, frequencyMix: .65, spectrumKind: 'stft' as const };
describe('bounded anchored viewport', () => {
  it('preserves the physical point beneath the pointer when zooming either axis', () => {
    const before = coordinates(view, 24000, 800, 300);
    for (const axis of ['time', 'frequency'] as const) {
      const next = zoomViewport(view, 100, 24000, axis, .4, .5);
      const after = coordinates(next, 24000, 800, 300);
      expect(after.xToSeconds(320)).toBeCloseTo(before.xToSeconds(320), 8);
      expect(after.yToHz(120)).toBeCloseTo(before.yToHz(120), 8);
    }
  });
  it('clamps pan and zoom without stretching beyond physical bounds', () => {
    const next = panViewport(view, 35, 24000, 100, -100);
    expect(next.startSeconds).toBe(15); expect(next.endSeconds).toBe(35); expect(next.highHz).toBeCloseTo(24000, 8);
    const all = zoomViewport(view, 35, 24000, 'time', .2, 100);
    expect(all.startSeconds).toBe(0); expect(all.endSeconds).toBe(35);
  });
});
