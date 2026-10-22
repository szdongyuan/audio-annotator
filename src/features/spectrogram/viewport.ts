import { clamp, frequencyTransform, type CoordinateView } from './coordinates';
export function boundRange(start: number, end: number, maximum: number, minimum = 1e-6): [number, number] {
  const span = clamp(end - start, Math.min(minimum, maximum), maximum);
  const lo = clamp(start, 0, maximum - span);
  return [lo, lo + span];
}
export function zoomViewport<T extends CoordinateView>(view: T, duration: number, nyquist: number, axis: 'time' | 'frequency', pointer: number, factor: number): T {
  if (axis === 'time') {
    const span = view.endSeconds - view.startSeconds, anchor = view.startSeconds + pointer * span;
    const [startSeconds, endSeconds] = boundRange(anchor - pointer * span * factor, anchor + (1 - pointer) * span * factor, duration);
    return { ...view, startSeconds, endSeconds };
  }
  const f = frequencyTransform(view, nyquist), low = f.forward(view.lowHz), high = f.forward(view.highHz);
  const anchor = high - pointer * (high - low);
  const [lo, hi] = boundRange(anchor - (1 - pointer) * (high - low) * factor, anchor + pointer * (high - low) * factor, 1);
  return { ...view, lowHz: f.inverse(lo), highHz: Math.min(nyquist, f.inverse(hi)) };
}
/** Deltas are fractions of the currently visible spans, independent of pixel density. */
export function panViewport<T extends CoordinateView>(view: T, duration: number, nyquist: number, dx: number, dy: number): T {
  const span = view.endSeconds - view.startSeconds;
  const [startSeconds, endSeconds] = boundRange(view.startSeconds + dx * span, view.endSeconds + dx * span, duration);
  const f = frequencyTransform(view, nyquist), low = f.forward(view.lowHz), high = f.forward(view.highHz);
  const [lo, hi] = boundRange(low - dy * (high - low), high - dy * (high - low), 1);
  return { ...view, startSeconds, endSeconds, lowHz: f.inverse(lo), highHz: Math.min(nyquist, f.inverse(hi)) };
}
