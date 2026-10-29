import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { MediaView } from '../../bridge/types';
import { Menu } from '../../components/menu/Menu';
import { menuIsOpen, type MenuItem } from '../../components/menu/menuModel';
import { clamp, coordinates } from './coordinates';
import { boundRange, zoomViewport } from './viewport';
import { axisTicks, type Axis } from './ticks';
import type { ProjectLifecycle } from '../project/lifecycle';

type Drag = { axis: Axis; pointerId: number; element: HTMLDivElement; origin: number; length: number; start: number; view: MediaView };
export function AxisRulers({ view, nyquist, timeLimit, onView, disabled = false, owner, lifecycle }: { view: MediaView; nyquist: number; timeLimit: number; onView: (patch: Partial<MediaView>) => void; disabled?: boolean; owner?: object; lifecycle?: ProjectLifecycle }) {
  const time = useRef<HTMLDivElement>(null), frequency = useRef<HTMLDivElement>(null), drag = useRef<Drag | null>(null);
  useEffect(() => lifecycle?.registerBackgroundGuard(() => !drag.current), [lifecycle]);
  const [sizes, setSizes] = useState({ time: 0, frequency: 0 });
  const [preview, setPreview] = useState<{ axis: Axis; start: number; end: number } | null>(null);
  const [menu, setMenu] = useState<{ axis: Axis; pointer: number; x: number; y: number } | null>(null);
  const ticks = useMemo(() => ({ time: axisTicks(view, nyquist, 'time', sizes.time), frequency: axisTicks(view, nyquist, 'frequency', sizes.frequency) }), [view.startSeconds,view.endSeconds,view.lowHz,view.highHz,view.frequencyMix,view.spectrumKind,nyquist,sizes.time,sizes.frequency]);
  const cancel = () => {
    const pending = drag.current; drag.current = null; setPreview(null);
    if (pending?.element.hasPointerCapture(pending.pointerId)) pending.element.releasePointerCapture(pending.pointerId);
  };
  useEffect(() => {
    const observer = new ResizeObserver(entries => {
      setSizes(previous => {
        const next = { ...previous };
        for (const entry of entries) {
          if (entry.target === time.current) next.time = entry.contentRect.width;
          if (entry.target === frequency.current) next.frequency = entry.contentRect.height;
        }
        return next;
      });
    });
    observer.observe(time.current!); observer.observe(frequency.current!);
    return () => { observer.disconnect(); const pending = drag.current; drag.current = null; if (pending?.element.hasPointerCapture(pending.pointerId)) pending.element.releasePointerCapture(pending.pointerId); };
  }, []);
  useEffect(() => { cancel(); setMenu(null); }, [disabled, view.spectrumKind, nyquist, owner, lifecycle]);
  const down = (axis: Axis, event: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled || menuIsOpen() || event.button !== 0) return;
    const element = event.currentTarget, box = element.getBoundingClientRect();
    const origin = axis === 'time' ? box.left : box.top, length = axis === 'time' ? box.width : box.height;
    if (!length) return;
    event.preventDefault(); event.stopPropagation(); element.focus(); element.setPointerCapture(event.pointerId);
    const start = clamp((axis === 'time' ? event.clientX : event.clientY) - origin, 0, length);
    drag.current = { axis, pointerId: event.pointerId, element, origin, length, start, view: { ...view } };
    setPreview({ axis, start, end: start });
  };
  const endPoint = (pending: Drag, event: ReactPointerEvent<HTMLDivElement>) => clamp((pending.axis === 'time' ? event.clientX : event.clientY) - pending.origin, 0, pending.length);
  const up = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pending = drag.current;
    if (!pending || event.pointerId !== pending.pointerId) return;
    const end = endPoint(pending, event); cancel();
    if (disabled || menuIsOpen() || Math.abs(end - pending.start) < 6) return;
    const c = coordinates(pending.view, nyquist, pending.length, pending.length), lo = Math.min(pending.start, end), hi = Math.max(pending.start, end);
    if (pending.axis === 'time') {
      const [startSeconds, endSeconds] = boundRange(c.xToSeconds(lo), c.xToSeconds(hi), timeLimit);
      onView({ startSeconds, endSeconds });
    } else {
      const [lowHz, highHz] = boundRange(c.yToHz(hi), c.yToHz(lo), nyquist);
      onView({ lowHz, highHz });
    }
  };
  const patchAxis = (factor: number) => {
    if (!menu || disabled) return;
    const next = zoomViewport(view, timeLimit, nyquist, menu.axis, menu.pointer, factor);
    onView(menu.axis === 'time' ? { startSeconds: next.startSeconds, endSeconds: next.endSeconds } : { lowHz: next.lowHz, highHz: next.highHz });
  };
  const name = menu?.axis === 'time' ? '时间轴' : '频率轴';
  const items: MenuItem[] = [
    { id: 'in', label: `放大${name}`, disabled, action: () => patchAxis(.5) },
    { id: 'out', label: `缩小${name}`, disabled, action: () => patchAxis(2) },
    { id: 'reset', label: `重置${name}`, disabled, action: () => { if (!disabled) onView(menu?.axis === 'time' ? { startSeconds: 0, endSeconds: timeLimit } : { lowHz: 0, highHz: nyquist }); } },
    ...(menu?.axis === 'frequency' ? [0, 1].map(mix => ({ id: `mix-${mix}`, label: mix ? '完全对数' : '完全线性', disabled: disabled || view.spectrumKind === 'mel', title: view.spectrumKind === 'mel' ? '梅尔频谱使用固定梅尔映射' : undefined, checked: view.spectrumKind === 'stft' && view.frequencyMix === mix, action: () => { if (!disabled && view.spectrumKind === 'stft') onView({ frequencyMix: mix }); } })) : []),
  ];
  return <>{(['time', 'frequency'] as const).map(axis => <div key={axis} ref={axis === 'time' ? time : frequency} className={`${axis}-ruler`} tabIndex={0} aria-label={axis === 'time' ? '时间刻度（秒）' : '频率刻度（Hz）'} aria-disabled={disabled} title="沿刻度拖动局部放大；右键缩放或重置"
    onPointerDown={event => down(axis, event)} onPointerUp={up}
    onPointerMove={event => { const pending = drag.current; if (pending && pending.pointerId === event.pointerId) setPreview({ axis: pending.axis, start: pending.start, end: endPoint(pending, event) }); }}
    onPointerCancel={cancel} onLostPointerCapture={cancel}
    onKeyDown={event => { if (event.key === 'Escape' && drag.current) { event.preventDefault(); event.stopPropagation(); cancel(); } }}
    onContextMenu={event => {
      event.preventDefault(); event.stopPropagation(); cancel();
      if (disabled || menuIsOpen()) return;
      event.currentTarget.focus();
      const box = event.currentTarget.getBoundingClientRect(), length = axis === 'time' ? box.width : box.height;
      const pointer = clamp((axis === 'time' ? event.clientX - box.left : event.clientY - box.top) / (length || 1), 0, 1);
      setMenu({ axis, pointer, x: event.clientX, y: event.clientY });
    }}>
    {ticks[axis].map(tick => <div key={tick.value} data-tick={tick.label === null ? 'minor' : 'major'} data-value={tick.value} className="axis-tick" style={axis === 'time' ? { left: tick.pixel } : { top: tick.pixel }} />)}
    {ticks[axis].filter(tick => tick.label !== null).map(tick => <span key={tick.value} className="axis-label" title={`${tick.value} ${axis === 'time' ? 's' : 'Hz'}`} style={axis === 'time' ? { left: tick.labelPixel } : { top: tick.labelPixel }}>{tick.label}</span>)}
    {preview?.axis === axis && <div className="ruler-selection" style={axis === 'time' ? { left: Math.min(preview.start, preview.end), width: Math.abs(preview.end - preview.start) } : { top: Math.min(preview.start, preview.end), height: Math.abs(preview.end - preview.start) }} />}
  </div>)}{menu && <Menu items={items} anchor={menu} onClose={() => setMenu(null)} />}</>;
}
