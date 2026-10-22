import type { MediaView } from '../../bridge/types';
export type CoordinateView = Pick<MediaView, 'startSeconds' | 'endSeconds' | 'lowHz' | 'highHz' | 'spectrumKind' | 'frequencyMix'>;
export const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
export function frequencyScale(f: number, nyquist: number, mix: number): number {
  return (1 - mix) * f / nyquist + mix * Math.log1p(f / 20) / Math.log1p(nyquist / 20);
}
export function inverseFrequencyScale(value: number, nyquist: number, mix: number): number {
  const target = clamp(value, 0, 1);
  if (target === 0) return 0;
  if (target === 1) return nyquist;
  let lo = 0, hi = nyquist;
  for (let i = 0; i < 52; i++) {
    const mid = (lo + hi) / 2;
    if (frequencyScale(mid, nyquist, mix) < target) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}
export function frequencyTransform(view: Pick<CoordinateView, 'spectrumKind' | 'frequencyMix'>, nyquist: number) {
  return view.spectrumKind === 'mel'
    ? { forward: (f: number) => Math.log1p(f / 700) / Math.log1p(nyquist / 700), inverse: (v: number) => 700 * Math.expm1(clamp(v, 0, 1) * Math.log1p(nyquist / 700)) }
    : { forward: (f: number) => frequencyScale(f, nyquist, view.frequencyMix), inverse: (v: number) => inverseFrequencyScale(v, nyquist, view.frequencyMix) };
}
/** The single coordinate contract for drawing, future overlays, hit testing and interaction. */
export function coordinates(view: CoordinateView, nyquist: number, width: number, height: number) {
  const f = frequencyTransform(view, nyquist), low = f.forward(view.lowHz), high = f.forward(view.highHz);
  return {
    secondsToX: (s: number) => (s - view.startSeconds) / (view.endSeconds - view.startSeconds) * width,
    xToSeconds: (x: number) => view.startSeconds + x / width * (view.endSeconds - view.startSeconds),
    hzToY: (hz: number) => (high - f.forward(hz)) / (high - low) * height,
    yToHz: (y: number) => f.inverse(high - y / height * (high - low)),
  };
}
