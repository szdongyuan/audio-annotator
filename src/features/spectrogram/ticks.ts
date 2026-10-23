import { clamp, coordinates, type CoordinateView } from './coordinates';
export type Axis = 'time' | 'frequency';
export type AxisTick = { value: number; pixel: number; label: string | null; labelPixel: number; labelSize: number };
function numberLabel(value: number, step: number, trim = true) {
  if (value === 0) return '0';
  if (Math.abs(value) >= 1e7 || Math.abs(value) < .0001) {
    const label = value.toExponential(Math.max(0, Math.min(14, Math.ceil(Math.log10(Math.abs(value) / step))))).replace('e+', 'e');
    return trim ? label.replace(/\.?(0+)e/, 'e') : label;
  }
  const label = value.toFixed(Math.max(0, Math.min(14, -Math.floor(Math.log10(step)))));
  return trim ? label.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '') : label;
}
/** Reserve enough room at 10px for even the finest candidate grid. Depending only
 * on physical bounds keeps every mixture's plot width (and tile LOD) identical. */
export function frequencyRulerWidth({ lowHz, highHz }: Pick<CoordinateView, 'lowHz' | 'highHz'>) {
  const step = 10 ** Math.floor(Math.log10((highHz - lowHz) / 4096));
  const labels = [lowHz, highHz, Math.min(highHz, 999)].filter(v => v >= lowHz).map(value => value >= 1000 ? `${numberLabel(value / 1000, step / 1000, false)}k` : numberLabel(value, step, false));
  return Math.max(42, ...labels.map(label => label.length * 6 + 8));
}
/** Coarse-to-fine 1/2/5 grids, accepted by their mapped pixel spacing, not their Hz spacing. */
export function axisTicks(view: CoordinateView, nyquist: number, axis: Axis, length: number): AxisTick[] {
  if (!(length > 0)) return [];
  const c = coordinates(view, nyquist, length, length);
  const [lo, hi] = axis === 'time' ? [view.startSeconds, view.endSeconds] : [view.lowHz, view.highHz];
  const map = axis === 'time' ? c.secondsToX : c.hzToY;
  const span = hi - lo, gap = axis === 'time' ? 60 : 22;
  if (!(span > 0)) return [];
  const ticks: AxisTick[] = [], candidates: { value: number; step: number }[] = [];
  const exponent = Math.ceil(Math.log10(span));
  // Physical endpoints remain honest even when the viewport ends between nice values.
  candidates.push({ value: lo, step: span / 100 }, { value: hi, step: span / 100 });
  for (let power = exponent; power > exponent - 18; power--) {
    for (const factor of [5, 2, 1]) {
      const step = factor * 10 ** power;
      if (span / step > 4096 || step < Number.EPSILON * Math.max(Math.abs(lo), Math.abs(hi)) * 2) break;
      const first = Math.ceil(lo / step), last = Math.floor(hi / step);
      for (let n = first; n <= last; n++) candidates.push({ value: Number((n * step).toPrecision(15)), step });
    }
  }
  const projected = candidates.map(candidate => ({ ...candidate, pixel: clamp(map(candidate.value), 0, length) }));
  const make = ({ value, step, pixel }: { value: number; step: number; pixel: number }): AxisTick => {
    const label = axis === 'frequency' && value >= 1000 ? `${numberLabel(value / 1000, step / 1000)}k` : `${numberLabel(value, step)}${axis === 'time' ? ' s' : ''}`;
    const labelSize = axis === 'time' ? label.length * 5.5 + 2 : 12;
    return { value, pixel, label, labelPixel: clamp(pixel, labelSize / 2, length - labelSize / 2), labelSize };
  };
  for (const candidate of projected) {
    if (ticks.some(t => Math.abs(t.pixel - candidate.pixel) < gap)) continue;
    // A fine minor grid must not invent a major such as 0.089 s merely to
    // squeeze between 0.08 and the endpoint. Keep the locally readable step.
    if (candidate.value !== lo && candidate.value !== hi && Math.max(
      Math.abs(map(clamp(candidate.value + candidate.step, lo, hi)) - candidate.pixel),
      Math.abs(map(clamp(candidate.value - candidate.step, lo, hi)) - candidate.pixel),
    ) < gap) continue;
    const tick = make(candidate);
    if (tick.labelSize <= length && ticks.every(t => Math.abs(t.labelPixel - tick.labelPixel) >= Math.max(gap, (t.labelSize + tick.labelSize) / 2 + 4))) ticks.push(tick);
  }
  for (const { value, pixel } of projected) {
    if (ticks.every(t => Math.abs(t.pixel - pixel) >= 4)) ticks.push({ value, pixel, label: null, labelPixel: pixel, labelSize: 0 });
  }
  return ticks.sort((a, b) => a.pixel - b.pixel);
}
