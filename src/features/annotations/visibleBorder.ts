import type { Region } from '../../bridge/types';
import { clamp, coordinates, type CoordinateView } from '../spectrogram/coordinates';

type ClientPoint = { clientX: number; clientY: number };
type ClientBox = { left: number; top: number; width: number; height: number };

/** Distance to actual visible border segments in CSS pixels, not to a clipped rectangle's new edges. */
export function visibleBorderHit(region: Region, event: ClientPoint, box: ClientBox, view: CoordinateView, nyquist: number) {
  if (box.width <= 0 || box.height <= 0) return false;
  const x = event.clientX - box.left, y = event.clientY - box.top;
  if (x < 0 || x > box.width || y < 0 || y > box.height) return false;
  const c = coordinates(view, nyquist, box.width, box.height);
  const left = c.secondsToX(region.startSeconds), right = c.secondsToX(region.endSeconds);
  const top = c.hzToY(region.highHz), bottom = c.hzToY(region.lowHz);
  const x1 = Math.max(0, left), x2 = Math.min(box.width, right);
  const y1 = Math.max(0, top), y2 = Math.min(box.height, bottom);
  // Client/local coordinate subtraction can round an exact 4px offset upward.
  const tolerance = 4 + 1e-9;
  const horizontal = (edge: number) => edge >= 0 && edge <= box.height && x1 <= x2 && Math.hypot(x - clamp(x, x1, x2), y - edge) <= tolerance;
  const vertical = (edge: number) => edge >= 0 && edge <= box.width && y1 <= y2 && Math.hypot(x - edge, y - clamp(y, y1, y2)) <= tolerance;
  return horizontal(top) || horizontal(bottom) || vertical(left) || vertical(right);
}
