import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { AnalysisSettings, MediaDescriptor, MediaView } from '../../bridge/types';
import type { MediaStatus } from '../../bridge/media';
import type { ActiveProject } from '../project/useProjectLifecycle';
import { drawSpectrogram } from './renderer';
import { useTiles } from './useTiles';
import { tileCache } from './tileScheduler';
import { panViewport } from './viewport';
import { wheelViewPatch } from './wheel';
import { menuIsOpen } from '../../components/menu/menuModel';
export function SpectrogramCanvas({ active, media, settings, view, channel, status, timeLimit, onView, children }: {
  active: ActiveProject; media: MediaDescriptor; settings: AnalysisSettings; view: MediaView; channel: number; status: MediaStatus['status']; timeLimit: number; onView: (patch: Partial<MediaView>) => void; children?: ReactNode;
}) {
  const canvas = useRef<HTMLCanvasElement>(null), host = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const latest = useRef({ view, onView, timeLimit, disabled: active.store.editingDisabled }); latest.current = { view, onView, timeLimit, disabled: active.store.editingDisabled };
  const drag = useRef<{ pointerId: number; x: number; y: number; view: MediaView } | null>(null);
  const tiles = useTiles(active, media, settings, view, channel, size.width, status);
  useEffect(() => {
    if (!host.current) return;
    const observer = new ResizeObserver(entries => { const r = entries[0].contentRect; setSize({ width: r.width, height: r.height }); });
    observer.observe(host.current); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const target = host.current;
    if (!target) return;
    const wheel = (event: WheelEvent) => {
      // Ctrl always belongs to the plot, including Mel and transition barriers.
      if (event.ctrlKey) event.preventDefault();
      if (latest.current.disabled || menuIsOpen()) return;
      event.preventDefault();
      const box = target.getBoundingClientRect(), state = latest.current;
      if (!box.width || !box.height) return;
      const patch = wheelViewPatch(state.view, state.timeLimit, media.sampleRate / 2, event, (event.clientX - box.left) / box.width, (event.clientY - box.top) / box.height, box.height);
      if (patch) state.onView(patch);
    };
    target.addEventListener('wheel', wheel, { passive: false }); return () => target.removeEventListener('wheel', wheel);
  }, [media.sampleRate]);
  useEffect(() => {
    const target = canvas.current;
    if (!target || !size.width || !size.height) return;
    const frame = requestAnimationFrame(() => {
      const values = tiles.keys.map(k => tileCache.get(k)).filter(t => t !== undefined);
      // An explicit cache invalidation must never silently turn a completed
      // spectrum black. Keep its bitmap until the recovery state is published.
      if (tiles.total > 0 && tiles.completed === tiles.total && !tiles.error && !tiles.cancelled && values.length !== tiles.keys.length) { tiles.recoverMissing(); return; }
      // One MiB maximum live surface per channel; map CSS coordinates separately.
      const ratio = Math.min(window.devicePixelRatio || 1, 1024 / size.width, 256 / size.height);
      target.width = Math.max(1, Math.round(size.width * ratio)); target.height = Math.max(1, Math.round(size.height * ratio));
      drawSpectrogram(target, view, settings, media.sampleRate, values);
    });
    return () => cancelAnimationFrame(frame);
  }, [size, view, settings, media.sampleRate, tiles.keys, tiles.version]);
  const busy = !tiles.error && !tiles.cancelled && tiles.completed < tiles.total;
  return <div ref={host} className="spectrogram-surface" tabIndex={0} aria-label={`通道 ${channel + 1} 频谱`} title="拖动框选；Alt 或中键拖动平移"
    onContextMenu={e => e.preventDefault()}
    onPointerDown={event => { if (active.store.editingDisabled || menuIsOpen() || !(event.button === 1 || event.button === 0 && event.altKey)) return; event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId); drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, view }; }}
    onPointerMove={event => { if (!drag.current || drag.current.pointerId !== event.pointerId || active.store.editingDisabled) return; onView(panViewport(drag.current.view, timeLimit, media.sampleRate / 2, (drag.current.x - event.clientX) / size.width, (drag.current.y - event.clientY) / size.height)); }}
    onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { if (drag.current) onView(drag.current.view); drag.current = null; }} onLostPointerCapture={() => { if (drag.current) onView(drag.current.view); drag.current = null; }}
    onKeyDown={event => { if (active.store.editingDisabled || menuIsOpen()) return; if (event.key === 'Escape' && drag.current) { event.preventDefault(); onView(drag.current.view); drag.current = null; return; } const delta = event.key === 'ArrowLeft' ? -.1 : event.key === 'ArrowRight' ? .1 : 0; if (delta) { event.preventDefault(); onView(panViewport(view, timeLimit, media.sampleRate / 2, delta, 0)); } }}>
    <canvas ref={canvas} data-channel={channel} aria-label={`通道 ${channel + 1} ${view.spectrumKind === 'mel' ? '梅尔' : 'STFT'} 频谱`} />
    <div className="spectrogram-overlays">{children}</div>
    {(busy || tiles.error || tiles.cancelled || !tiles.keys.length) && <div className="tile-status" onPointerDown={e => e.stopPropagation()}>
      <span role={tiles.error ? 'alert' : 'status'}>{tiles.error ?? (tiles.cancelled ? '分析已取消' : tiles.total ? `${tiles.phase} · ${tiles.completed}/${tiles.total}` : tiles.phase)}</span>
      {busy && <button onClick={tiles.cancel}>取消</button>}{(tiles.error || tiles.cancelled) && <button onClick={tiles.retry}>重试</button>}
    </div>}
  </div>;
}
