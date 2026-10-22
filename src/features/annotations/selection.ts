import type { Region } from '../../bridge/types';
import { clamp, coordinates, type CoordinateView } from '../spectrogram/coordinates';
export type Point = { seconds: number; hz: number };
export type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
export function eventPoint(event: { clientX: number; clientY: number }, box: { left: number; top: number; width: number; height: number }, view: CoordinateView, nyquist: number): Point {
  const c = coordinates(view, nyquist, box.width, box.height);
  return { seconds: c.xToSeconds(event.clientX - box.left), hz: c.yToHz(event.clientY - box.top) };
}
export function drawRegion(mediaId: string, channelIndex: number, a: Point, b: Point, duration: number, nyquist: number): Region | null {
  const r = { mediaId, channelIndex, startSeconds: clamp(Math.min(a.seconds, b.seconds), 0, duration), endSeconds: clamp(Math.max(a.seconds, b.seconds), 0, duration), lowHz: clamp(Math.min(a.hz, b.hz), 0, nyquist), highHz: clamp(Math.max(a.hz, b.hz), 0, nyquist) };
  return r.startSeconds < r.endSeconds && r.lowHz < r.highHz ? r : null;
}
export function moveRegion(r: Region, seconds: number, hz: number, duration: number, nyquist: number): Region {
  const dt = clamp(seconds, -r.startSeconds, duration - r.endSeconds), df = clamp(hz, -r.lowHz, nyquist - r.highHz);
  return { ...r, startSeconds: r.startSeconds + dt, endSeconds: r.endSeconds + dt, lowHz: r.lowHz + df, highHz: r.highHz + df };
}
export function resizeRegion(r: Region, handle: Handle, p: Point, duration: number, nyquist: number) {
  return drawRegion(r.mediaId, r.channelIndex, { seconds: handle.includes('w') ? p.seconds : r.startSeconds, hz: handle.includes('s') ? p.hz : r.lowHz }, { seconds: handle.includes('e') ? p.seconds : r.endSeconds, hz: handle.includes('n') ? p.hz : r.highHz }, duration, nyquist);
}
/** Last document entry is painted last and wins overlapping hit tests. */
export function topmost<T extends { region: Region }>(items: T[], p: Point): T | undefined {
  return [...items].reverse().find(({ region: r }) => p.seconds >= r.startSeconds && p.seconds <= r.endSeconds && p.hz >= r.lowHz && p.hz <= r.highHz);
}
