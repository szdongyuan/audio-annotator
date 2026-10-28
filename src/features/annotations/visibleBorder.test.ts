import { expect, it } from 'vitest';
import type { Region } from '../../bridge/types';
import { coordinates, type CoordinateView } from '../spectrogram/coordinates';
import { visibleBorderHit } from './visibleBorder';

const region: Region = { mediaId: 'media', channelIndex: 0, startSeconds: 1, endSeconds: 3, lowHz: 3000, highHz: 12000 };
const box = { left: 83.25, top: 126.75, width: 937.5, height: 473.25 };
const views: CoordinateView[] = [
 { startSeconds: 0, endSeconds: 4, lowHz: 0, highHz: 24000, spectrumKind: 'stft', frequencyMix: 0 },
 { startSeconds: 0, endSeconds: 4, lowHz: 0, highHz: 24000, spectrumKind: 'stft', frequencyMix: 1 },
 { startSeconds: .5, endSeconds: 3.5, lowHz: 500, highHz: 18000, spectrumKind: 'mel', frequencyMix: 0 },
];
it.each(views)('all four edges have a CSS-pixel radius in $spectrumKind/$frequencyMix', view => {
 const c = coordinates(view, 24000, box.width, box.height);
 const left = c.secondsToX(1), right = c.secondsToX(3), top = c.hzToY(12000), bottom = c.hzToY(3000);
 const hit = (x: number, y: number) => visibleBorderHit(region, { clientX: box.left + x, clientY: box.top + y }, box, view, 24000);
 for (const offset of [-4, 0, 4]) {
  expect(hit(left + offset, (top + bottom) / 2)).toBe(true);
  expect(hit(right + offset, (top + bottom) / 2)).toBe(true);
  expect(hit((left + right) / 2, top + offset)).toBe(true);
  expect(hit((left + right) / 2, bottom + offset)).toBe(true);
 }
 for (const offset of [-4.01, 4.01]) {
  expect(hit(left + offset, (top + bottom) / 2)).toBe(false);
  expect(hit(right + offset, (top + bottom) / 2)).toBe(false);
  expect(hit((left + right) / 2, top + offset)).toBe(false);
  expect(hit((left + right) / 2, bottom + offset)).toBe(false);
 }
 expect(hit(left - 2, top - 2)).toBe(true);
 expect(hit(left - 3, top - 3)).toBe(false);
 expect(hit((left + right) / 2, (top + bottom) / 2)).toBe(false);
});
it('an offscreen edge is not visible even when it lies within the tolerance of the viewport', () => {
 const view = views[0], c = coordinates(view, 24000, box.width, box.height);
 const hit = (r: Region, x: number, y: number) => visibleBorderHit(r, { clientX: box.left + x, clientY: box.top + y }, box, view, 24000);
 const enclosing = { ...region, startSeconds: -.01, endSeconds: 4.01, lowHz: -100, highHz: 24100 };
 for (const [x, y] of [[1, 200], [box.width - 1, 200], [300, 1], [300, box.height - 1]]) expect(hit(enclosing, x, y)).toBe(false);
 const crossing = { ...enclosing, highHz: 12000 };
 expect(hit(crossing, 1, c.hzToY(12000))).toBe(true);
 expect(hit(crossing, box.width - 1, c.hzToY(12000))).toBe(true);
 expect(hit({ ...region, startSeconds: -.1, endSeconds: -.01 }, 1, c.hzToY(12000))).toBe(false);
});
it('rejects points outside the clipped surface and zero-size surfaces', () => {
 const view = views[0], edge = { clientX: box.left + box.width / 4, clientY: box.top + box.height / 2 };
 expect(visibleBorderHit(region, edge, { ...box, width: 0 }, view, 24000)).toBe(false);
 expect(visibleBorderHit(region, edge, { ...box, height: 0 }, view, 24000)).toBe(false);
 expect(visibleBorderHit({ ...region, startSeconds: 0 }, { clientX: box.left - 1, clientY: edge.clientY }, box, view, 24000)).toBe(false);
});
