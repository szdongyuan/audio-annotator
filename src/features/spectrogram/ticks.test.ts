import { expect, it } from 'vitest';
import { axisTicks, frequencyRulerWidth } from './ticks';
import { coordinates } from './coordinates';
const base = { startSeconds: 0, endSeconds: 10, lowHz: 0, highHz: 24000, frequencyMix: .65, spectrumKind: 'stft' as const };
it('adapts physical major/minor ticks to actual size and nonlinear mapping without overlap or clipping', () => {
  for (const spectrumKind of ['stft', 'mel'] as const) for (const frequencyMix of [0, .5, 1]) for (const axis of ['time', 'frequency'] as const) {
    for (const length of [35, 180, 351, 800]) {
      const view = { ...base, spectrumKind, frequencyMix }, c = coordinates(view, 24000, length, length);
      const ticks = axisTicks(view, 24000, axis, length), majors = ticks.filter(t => t.label !== null);
      expect(majors.length).toBeGreaterThan(0);
      for (let i = 1; i < ticks.length; i++) expect(ticks[i].pixel - ticks[i - 1].pixel).toBeGreaterThanOrEqual(4 - 1e-7);
      for (let i = 1; i < majors.length; i++) {
        expect(majors[i].labelPixel - majors[i - 1].labelPixel).toBeGreaterThanOrEqual((axis === 'time' ? 60 : 22) - 1e-7);
        expect(majors[i].labelPixel - majors[i].labelSize / 2).toBeGreaterThanOrEqual(majors[i - 1].labelPixel + majors[i - 1].labelSize / 2);
      }
      for (const tick of ticks) {
        expect(tick.pixel).toBeCloseTo(axis === 'time' ? c.secondsToX(tick.value) : c.hzToY(tick.value), 6);
        if (tick.label !== null) { expect(tick.labelPixel - tick.labelSize / 2).toBeGreaterThanOrEqual(0); expect(tick.labelPixel + tick.labelSize / 2).toBeLessThanOrEqual(length); }
      }
    }
  }
  expect(axisTicks(base, 24000, 'time', 800).filter(t => t.label).length).toBeGreaterThan(axisTicks(base, 24000, 'time', 180).filter(t => t.label).length);
  expect(axisTicks(base, 24000, 'frequency', 351).some(t => t.label === null)).toBe(true);
});
it('reserves readable frequency-label width for narrow nonzero ranges without resizing on mix changes', () => {
  for (const [lowHz, highHz] of [[0, 24000], [1234.56789, 1234.56791], [0, .000001], [10000, 10000.1]]) {
    const width = frequencyRulerWidth({ lowHz, highHz });
    for (const frequencyMix of [0, .5, 1]) {
      const ticks = axisTicks({ ...base, lowHz, highHz, frequencyMix }, 24000, 'frequency', 351);
      expect(ticks.filter(t => t.label).length).toBeGreaterThan(1);
      for (const tick of ticks.filter(t => t.label)) expect(width).toBeGreaterThanOrEqual(tick.label!.length * 6 + 6);
    }
  }
});
it('keeps DC/Nyquist and formats distinct labels for tiny and large physical spans', () => {
  const full = axisTicks(base, 24000, 'frequency', 351);
  expect(full.find(t => t.value === 0)?.label).toBe('0'); expect(full.find(t => t.value === 24000)?.label).toBe('24k');
  for (const [startSeconds, endSeconds] of [[0, .000001], [100000, 100000.00001], [0, 1e9]]) {
    const ticks = axisTicks({ ...base, startSeconds, endSeconds }, 24000, 'time', 800).filter(t => t.label);
    expect(ticks.length).toBeGreaterThan(1); expect(new Set(ticks.map(t => t.label)).size).toBe(ticks.length);
    expect(ticks.every(t => !/NaN|Infinity/.test(t.label!))).toBe(true);
  }
  expect(axisTicks(base, 24000, 'time', 0)).toEqual([]);
});
it('does not fill near an endpoint with awkward fine-grid major labels on a linear axis', () => {
  const ticks = axisTicks({ ...base, endSeconds: .1 }, 24000, 'time', 730).filter(t => t.label);
  for (const tick of ticks) expect(tick.value * 100).toBeCloseTo(Math.round(tick.value * 100), 8);
});
