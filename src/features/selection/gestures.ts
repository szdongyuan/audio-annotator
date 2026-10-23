import type { Handle } from '../annotations/selection';
export const exceedsThreshold = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(b.x - a.x, b.y - a.y) > 4;
export function gestureKind(button: number, alt: boolean, handle?: Handle, border = false) {
  if (button === 1 || (button === 0 && alt)) return 'pan';
  if (button !== 0) return null;
  return handle ? 'resize' : border ? 'move' : 'draw';
}
