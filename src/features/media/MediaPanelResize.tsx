import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

const storageKey = 'audio-annotator.media-panel-width';
const minimum = 180;
function savedWidth(): number | null {
  try { const value = localStorage.getItem(storageKey); const width = value === null ? NaN : Number(value); return Number.isFinite(width) && width >= minimum && width <= 480 ? width : null; }
  catch { return null; }
}
export function useMediaPanelWidth(workspace: RefObject<HTMLDivElement | null>, propertiesOpen: boolean, comparing = false) {
  const [preferred, setPreferred] = useState<number | null>(savedWidth), [maximum, setMaximum] = useState(480);
  useLayoutEffect(() => {
    const node = workspace.current; if (!node) return;
    const measure = () => { const total = node.getBoundingClientRect().width; if (!total) return; const right = node.querySelector('.properties-panel')?.getBoundingClientRect().width ?? 0; setMaximum(Math.max(minimum, Math.min(480, total - right - (comparing ? 625 : 365)))); };
    measure(); const observer = new ResizeObserver(measure); observer.observe(node); window.addEventListener('resize', measure);
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); };
  }, [workspace, propertiesOpen, comparing]);
  const commit = (value: number | null) => {
    const next = value === null ? null : Math.max(minimum, Math.min(maximum, value)); setPreferred(next);
    try { if (next === null) localStorage.removeItem(storageKey); else localStorage.setItem(storageKey, String(next)); } catch { /* Resizing remains usable when local preference storage is unavailable. */ }
  };
  return { width: preferred === null ? null : Math.min(preferred, maximum), maximum, preview: setPreferred, commit };
}

export function MediaPanelResize({ width, maximum, onPreview, onCommit }: { width: number | null; maximum: number; onPreview: (value: number | null) => void; onCommit: (value: number | null) => void }) {
  const drag = useRef<{ id: number; x: number; width: number; previous: number | null; value: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const clamp = (value: number) => Math.max(minimum, Math.min(maximum, value));
  const restore = () => { const current = drag.current; if (!current) return; drag.current = null; onPreview(current.previous); setDragging(false); };
  useEffect(() => { const cancel = (event: KeyboardEvent) => { if (event.key === 'Escape' && drag.current) { event.preventDefault(); event.stopImmediatePropagation(); restore(); } }; window.addEventListener('keydown', cancel, true); return () => window.removeEventListener('keydown', cancel, true); });
  return <div role="separator" aria-label="调整音频列表宽度" aria-orientation="vertical" aria-valuemin={minimum} aria-valuemax={maximum} aria-valuenow={width ?? undefined} tabIndex={0} className={`media-panel-resize${dragging ? ' is-dragging' : ''}`} title="拖动调整宽度，双击恢复默认" onDoubleClick={() => onCommit(null)}
    onPointerDown={e => { if (e.button !== 0) return; e.preventDefault(); const actual = e.currentTarget.previousElementSibling?.getBoundingClientRect().width ?? width ?? 232; drag.current = { id: e.pointerId, x: e.clientX, width: actual, previous: width, value: actual }; e.currentTarget.setPointerCapture?.(e.pointerId); setDragging(true); }}
    onPointerMove={e => { const current = drag.current; if (!current || current.id !== e.pointerId) return; current.value = clamp(current.width + e.clientX - current.x); onPreview(current.value); }}
    onPointerUp={e => { const current = drag.current; if (!current || current.id !== e.pointerId) return; drag.current = null; onCommit(current.value); setDragging(false); if (e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId); }}
    onPointerCancel={restore} onLostPointerCapture={restore}
    onKeyDown={e => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return; e.preventDefault(); e.stopPropagation(); onCommit(e.key === 'Home' ? minimum : e.key === 'End' ? maximum : clamp((width ?? e.currentTarget.previousElementSibling?.getBoundingClientRect().width ?? 232) + (e.key === 'ArrowRight' ? 10 : -10))); }} />;
}
