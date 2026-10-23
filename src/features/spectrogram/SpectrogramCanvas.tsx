import { useSelectionContext } from '../selection/useSelection';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { AnalysisSettings, MediaDescriptor, MediaView } from '../../bridge/types';
import type { MediaStatus } from '../../bridge/media';
import type { ActiveProject } from '../project/useProjectLifecycle';
import { drawSpectrogram } from './renderer';
import { backingSize, rasterBudget } from './rasterBudget';
import { useTiles } from './useTiles';
import { tileCache } from './tileScheduler';
import { panViewport } from './viewport';
import { wheelViewPatch } from './wheel';
import { menuIsOpen } from '../../components/menu/menuModel';
import type { AnalysisSource } from './analysisSource';
export function SpectrogramCanvas({ active, media, settings, view, channel, status, timeLimit, onView, children, analysisSource = 'original' }: {
  analysisSource?: AnalysisSource;
  active: ActiveProject; media: MediaDescriptor; settings: AnalysisSettings; view: MediaView; channel: number; status: MediaStatus['status']; timeLimit: number; onView: (patch: Partial<MediaView>) => void; children?: ReactNode;
}) {
  const selection = useSelectionContext();
  const canvas = useRef<HTMLCanvasElement>(null), host = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [dpr, setDpr] = useState(window.devicePixelRatio || 1);
  const [visible, setVisible] = useState(typeof IntersectionObserver === 'undefined');
  const [rasterError, setRasterError] = useState<string | null>(null);
  const pixels = backingSize(size.width, size.height, dpr);
  const latest = useRef({ view, onView, timeLimit, disabled: active.store.editingDisabled }); latest.current = { view, onView, timeLimit, disabled: active.store.editingDisabled };
  const drag = useRef<{ pointerId: number; x: number; y: number; view: MediaView } | null>(null);
  useEffect(() => () => { if (drag.current) { drag.current = null; selection?.state.endGesture(); } }, [selection?.state]);
  const endPan = (restore = false) => { if (!drag.current) return; if (restore) onView(drag.current.view); drag.current = null; selection?.state.endGesture(); };
  const tiles = useTiles(active, media, settings, view, channel, visible && size.width ? pixels.width : 0, status, analysisSource);
  useEffect(() => {
    if (!host.current) return;
    const observer = new ResizeObserver(entries => { const r = entries[0].contentRect; setSize({ width: r.width, height: r.height }); });
    observer.observe(host.current); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    let query: MediaQueryList | undefined;
    const update = () => { setDpr(window.devicePixelRatio || 1); query?.removeEventListener('change', update); query = window.matchMedia?.(`(resolution: ${window.devicePixelRatio || 1}dppx)`); query?.addEventListener('change', update); };
    update(); window.addEventListener('resize', update);
    return () => { window.removeEventListener('resize', update); query?.removeEventListener('change', update); };
  }, []);
  useEffect(() => {
    const target = canvas.current;
    if (!target) return;
    const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(entries => setVisible(entries[0].isIntersecting));
    if (host.current) observer?.observe(host.current);
    return () => { observer?.disconnect(); rasterBudget.release(target); target.width = 0; target.height = 0; };
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
    if (!target) return;
    if (status === 'missing' || status === 'changed' || !visible || !size.width || !size.height) { rasterBudget.release(target); target.width = 0; target.height = 0; return; }
    const frame = requestAnimationFrame(() => {
      const values = tiles.keys.map(k => tileCache.get(k)).filter(t => t !== undefined);
      // An explicit cache invalidation must never silently turn a completed
      // spectrum black. Keep its bitmap until the recovery state is published.
      if (tiles.total > 0 && tiles.completed === tiles.total && !tiles.error && !tiles.cancelled && values.length !== tiles.keys.length) { tiles.recoverMissing(); return; }
      try {
        rasterBudget.reserve(target, pixels.width, pixels.height);
        if (target.width !== pixels.width) target.width = pixels.width;
        if (target.height !== pixels.height) target.height = pixels.height;
        drawSpectrogram(target, view, settings, media.sampleRate, values);
        setRasterError(null);
      } catch (error) { setRasterError(error instanceof Error ? error.message : '频谱绘制失败'); }
    });
    return () => cancelAnimationFrame(frame);
  // Native snapshots recreate view/settings objects for unrelated panes too.
  // Depend on their visual values so an acknowledgement cannot repaint all HD canvases.
  }, [status, size, pixels.width, pixels.height, visible,
    view.startSeconds, view.endSeconds, view.lowHz, view.highHz, view.frequencyMix, view.spectrumKind, view.gainDb, view.dynamicRangeDb, view.palette,
    settings.window, settings.windowSize, settings.hopSize, settings.fftSize, settings.melBands,
    media.sampleRate, tiles.keys, tiles.version]);
  const busy = !tiles.error && !tiles.cancelled && tiles.completed < tiles.total;
  return <div ref={host} className="spectrogram-surface" tabIndex={0} aria-label={`通道 ${channel + 1} 频谱`} title="拖动框选；Alt 或中键拖动平移"
    onContextMenu={e => e.preventDefault()}
    onPointerDown={event => { if (active.store.editingDisabled || menuIsOpen() || !(event.button === 1 || event.button === 0 && event.altKey)) return; event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId); selection?.state.beginGesture(); drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, view }; }}
    onPointerMove={event => { if (!drag.current || drag.current.pointerId !== event.pointerId || active.store.editingDisabled) return; onView(panViewport(drag.current.view, timeLimit, media.sampleRate / 2, (drag.current.x - event.clientX) / size.width, (drag.current.y - event.clientY) / size.height)); }}
    onPointerUp={() => endPan()} onPointerCancel={() => endPan(true)} onLostPointerCapture={() => endPan(true)}
    onKeyDown={event => { if (active.store.editingDisabled || menuIsOpen()) return; if (event.key === 'Escape' && drag.current) { event.preventDefault(); endPan(true); return; } const delta = event.key === 'ArrowLeft' ? -.1 : event.key === 'ArrowRight' ? .1 : 0; if (delta) { event.preventDefault(); onView(panViewport(view, timeLimit, media.sampleRate / 2, delta, 0)); } }}>
    <canvas ref={canvas} data-channel={channel} aria-label={`通道 ${channel + 1} ${view.spectrumKind === 'mel' ? '梅尔' : 'STFT'} 频谱`} />
    <div className="spectrogram-overlays">{children}</div>
    {visible && (busy || rasterError || tiles.error || tiles.cancelled || !tiles.keys.length) && <div className="tile-status" onPointerDown={e => e.stopPropagation()}>
      <span role={rasterError || tiles.error ? 'alert' : 'status'}>{rasterError ?? tiles.error ?? (tiles.cancelled ? '分析已取消' : tiles.total ? `${tiles.phase} · ${tiles.completed}/${tiles.total}` : tiles.phase)}</span>
      {busy && <button onClick={tiles.cancel}>取消</button>}{(tiles.error || tiles.cancelled) && <button onClick={tiles.retry}>重试</button>}
    </div>}
  </div>;
}
