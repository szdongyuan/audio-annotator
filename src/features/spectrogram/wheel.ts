import type { MediaView } from '../../bridge/types';
import { clamp } from './coordinates';
import { zoomViewport } from './viewport';
export type WheelInput = Pick<WheelEvent, 'deltaY' | 'deltaMode' | 'ctrlKey' | 'shiftKey'>;
export function normalizedDeltaY(event: WheelInput, plotHeight: number) {
  return event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? plotHeight : 1);
}
/** Only return the changed axis; frequency edits must not propagate linked time. */
export function wheelViewPatch(view: MediaView, timeLimit: number, nyquist: number, event: WheelInput, x: number, y: number, plotHeight: number): Partial<MediaView> | null {
  const delta = normalizedDeltaY(event, plotHeight);
  if (event.ctrlKey) return view.spectrumKind === 'mel' ? null : { frequencyMix: clamp(view.frequencyMix - delta * .0005, 0, 1) };
  const next = zoomViewport(view, timeLimit, nyquist, event.shiftKey ? 'frequency' : 'time', clamp(event.shiftKey ? y : x, 0, 1), Math.exp(clamp(delta * .002, -1, 1)));
  return event.shiftKey ? { lowHz: next.lowHz, highHz: next.highHz } : { startSeconds: next.startSeconds, endSeconds: next.endSeconds };
}
