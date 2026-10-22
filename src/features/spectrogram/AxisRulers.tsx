import type { MediaView } from '../../bridge/types';
import { coordinates } from './coordinates';
export function formatHz(hz: number) { return hz >= 1000 ? `${(hz / 1000).toFixed(hz % 1000 ? 1 : 0)}k` : `${Math.round(hz)}`; }
export function AxisRulers({ view, nyquist }: { view: MediaView; nyquist: number }) {
  const c = coordinates(view, nyquist, 1, 1);
  return <><div className="time-ruler" aria-label="时间刻度（秒）">{Array.from({ length: 6 }, (_, i) => <span key={i} style={{ left: `${i * 20}%` }}>{c.xToSeconds(i / 5).toFixed(view.endSeconds - view.startSeconds < 1 ? 3 : 2)} s</span>)}</div>
    <div className="frequency-ruler" aria-label="频率刻度（Hz）">{Array.from({ length: 5 }, (_, i) => <span key={i} style={{ top: `${i * 25}%` }}>{formatHz(c.yToHz(i / 4))}</span>)}<small>Hz</small></div></>;
}
