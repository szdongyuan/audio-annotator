import { expect, it } from 'vitest';
import { RasterBudget, backingSize } from './rasterBudget';
it('retains native size and counts every backing plus reusable scratch globally', () => {
  expect(backingSize(800, 600, 2)).toEqual({ width: 1600, height: 1200 });
  const b = new RasterBudget(32 * 1024 * 1024);
  b.reserve('a', 1600, 1200); b.reserve('b', 1600, 1200);
  expect(b.bytes).toBe((2 * 1600 + 64) * 1200 * 4);
  expect(() => b.reserve('c', 1600, 1200)).not.toThrow();
  b.reserve('d', 1600, 1200);
  expect(() => b.reserve('e', 1600, 1200)).toThrow(/栅格/);
  expect(b.bytes).toBeLessThanOrEqual(b.limit);
  b.release('a'); b.reserve('d', 1600, 1200);
  for (const key of ['b', 'c', 'd']) b.release(key);
  expect(b.bytes).toBe(0); b.reserve('a', 800, 600); expect(b.bytes).toBe((800 + 64) * 600 * 4);
});
it('fits an ordinary expanded 1800x850 CSS plot at DPR2 using bounded strip scratch', () => {
  const b = new RasterBudget();
  expect(() => b.reserve('single', 3600, 1700)).not.toThrow();
  expect(b.bytes).toBeLessThanOrEqual(3600 * 1700 * 4 + 1024 * 1024);
});
