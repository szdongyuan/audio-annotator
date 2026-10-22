import { describe, expect, it } from 'vitest';
import { drawRegion, moveRegion, resizeRegion, topmost, eventPoint } from './selection';
const region = { mediaId: 'm', channelIndex: 1, startSeconds: 2, endSeconds: 4, lowHz: 100, highHz: 300 };
describe('physical selection', () => {
  it('normalizes all four directions, clamps and cancels zero area', () => {
    for (const a of [{ seconds: 2, hz: 100 }, { seconds: 4, hz: 300 }, { seconds: 2, hz: 300 }, { seconds: 4, hz: 100 }]) {
      const b = { seconds: a.seconds === 2 ? 4 : 2, hz: a.hz === 100 ? 300 : 100 };
      expect(drawRegion('m', 1, a, b, 10, 500)).toEqual(region);
    }
    expect(drawRegion('m', 1, { seconds: -2, hz: -20 }, { seconds: 30, hz: 900 }, 10, 500)).toMatchObject({ startSeconds: 0, endSeconds: 10, lowHz: 0, highHz: 500 });
    expect(drawRegion('m', 1, { seconds: 2, hz: 100 }, { seconds: 2, hz: 300 }, 10, 500)).toBeNull();
  });
  it('moves without shrinking and resizes at physical boundaries', () => {
    expect(moveRegion(region, 99, -999, 10, 500)).toMatchObject({ startSeconds: 8, endSeconds: 10, lowHz: 0, highHz: 200 });
    expect(resizeRegion(region, 'ne', { seconds: 99, hz: 999 }, 10, 500)).toMatchObject({ startSeconds: 2, endSeconds: 10, lowHz: 100, highHz: 500 });
    expect(resizeRegion(region, 'sw', { seconds: 4, hz: 300 }, 10, 500)).toBeNull();
  });
  it('selects last drawn overlapping annotation and maps CSS coordinates independent of bitmap scale', () => {
    const items = [{ id: 'a', region }, { id: 'b', region }];
    expect(topmost(items, { seconds: 3, hz: 200 })?.id).toBe('b');
    const view = { startSeconds: 0, endSeconds: 10, lowHz: 0, highHz: 500, spectrumKind: 'stft' as const, frequencyMix: 0 };
    const point = eventPoint({ clientX: 300, clientY: 150 }, { left: 100, top: 50, width: 800, height: 400 }, view, 500);
    expect(point.seconds).toBeCloseTo(2.5, 10); expect(point.hz).toBeCloseTo(375, 10);
  });
});
