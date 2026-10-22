import { useEffect, useRef, useState, type PointerEvent, type CSSProperties } from 'react';
import type { Annotation, MediaDescriptor, MediaView, Region } from '../../bridge/types';
import { coordinates } from '../spectrogram/coordinates';
import { drawRegion, eventPoint, moveRegion, resizeRegion, topmost, type Handle, type Point } from './selection';
import { useAnnotationContext } from './useAnnotations';
import { useMaskContext } from '../playback/useMasks';
type Drag = { pointerId: number; start: Point; annotation?: Pick<Annotation, 'id' | 'region'>; mask?: boolean; handle?: Handle; region: Region | null };
const handles: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
export function AnnotationOverlay({ media, channel, view }: { media: MediaDescriptor; channel: number; view: MediaView }) {
  const ui = useAnnotationContext(), masks = useMaskContext(), drag = useRef<Drag | null>(null), [preview, setPreview] = useState<Region | null>(null);
  useEffect(() => { drag.current = null; setPreview(null); }, [ui?.cancelVersion, ui?.tool, media.id, channel, view.startSeconds, view.endSeconds, view.lowHz, view.highHz, view.frequencyMix, view.spectrumKind]);
  if (!ui?.active) return null;
  const { document: doc } = ui.active.store.snapshot;
  const items = doc.annotations.filter(a => a.region.mediaId === media.id && a.region.channelIndex === channel);
  const edits = (doc.edits ?? []).filter(e => e.region.mediaId === media.id && e.region.channelIndex === channel);
  const duration = media.frameCount / media.sampleRate, nyquist = media.sampleRate / 2;
  const point = (e: PointerEvent<HTMLDivElement>) => eventPoint(e, e.currentTarget.getBoundingClientRect(), view, nyquist);
  const update = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current; if (!d || d.pointerId !== e.pointerId) return null;
    const p = point(e);
    d.region = d.annotation ? d.handle ? resizeRegion(d.annotation.region, d.handle, p, duration, nyquist) : moveRegion(d.annotation.region, p.seconds - d.start.seconds, p.hz - d.start.hz, duration, nyquist) : drawRegion(media.id, channel, d.start, p, duration, nyquist);
    return d.region;
  };
  const rectStyle = (r: Region): CSSProperties => {
    const c = coordinates(view, nyquist, 100, 100);
    return { left: `${c.secondsToX(r.startSeconds)}%`, top: `${c.hzToY(r.highHz)}%`, width: `${c.secondsToX(r.endSeconds) - c.secondsToX(r.startSeconds)}%`, height: `${c.hzToY(r.lowHz) - c.hzToY(r.highHz)}%` };
  };
  return <div className={`annotation-overlay tool-${ui.tool}`} aria-label={`通道 ${channel + 1} 标注图层`}
    onPointerDown={e => {
      if (ui.active!.store.editingDisabled || e.button !== 0 || e.altKey) return;

      const p = point(e), annotation = ui.tool === 'select' ? topmost(items, p) : undefined;
      const handle = (e.target as HTMLElement).dataset.handle as Handle | undefined;
      const edit = ui.tool === 'select' ? topmost(edits, p) : undefined;
      const isMask = ui.tool === 'mask' || !!edit || !!(handle && masks?.selectedId);
      const selected = isMask ? (handle ? edits.find(e => e.id === masks?.selectedId) : edit) : handle ? items.find(a => a.id === ui.selectedId) : annotation;
      if (ui.tool === 'select' && !selected) { ui.select(null); masks?.select(null); return; }
      e.stopPropagation(); e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId);
      if (isMask) { ui.select(null); if (selected) masks?.select(selected.id); } else { masks?.select(null); if (selected) ui.select(selected.id); }
      drag.current = { pointerId: e.pointerId, start: p, annotation: selected, mask: isMask, handle, region: null };
    }}
    onPointerMove={e => { if (!drag.current) return; e.stopPropagation(); setPreview(update(e)); }}
    onPointerUp={e => {
      if (!drag.current || drag.current.pointerId !== e.pointerId) return; e.stopPropagation();
      const d = drag.current, region = update(e); drag.current = null; setPreview(null);
      if (!region || ui.active!.store.editingDisabled) return;
      if (d.annotation) { if (JSON.stringify(region) !== JSON.stringify(d.annotation.region)) { if (d.mask) masks?.mutate(d.annotation.id, region); else ui.mutate(d.annotation.id, { region }); } }
      else if (d.mask) masks?.create(region); else ui.create(region);
    }} onPointerCancel={() => { drag.current = null; setPreview(null); }} onLostPointerCapture={() => { drag.current = null; setPreview(null); }}>
    {items.map(a => {
      const category = doc.categories.find(c => c.id === a.categoryId), selected = ui.selectedId === a.id;
      const region = selected && drag.current?.annotation?.id === a.id && preview ? preview : a.region;
      return <div key={a.id} data-annotation-id={a.id} className={`annotation-rect ${selected ? 'is-selected' : ''}`} style={{ ...rectStyle(region), '--region-color': category?.color ?? '#e6a65d' } as CSSProperties}><span className="annotation-label">{category?.name ?? '未分类'}</span>{selected && ui.tool === 'select' && handles.map(h => <i key={h} data-handle={h} className={`region-handle handle-${h}`} />)}</div>;
    })}
    {edits.map(edit => { const selected = masks?.selectedId === edit.id;
      const region = selected && drag.current?.annotation?.id === edit.id && preview ? preview : edit.region;
      return <div key={edit.id} data-edit-id={edit.id} className={`annotation-rect mask-rect ${edit.enabled ? '' : 'is-disabled'} ${selected ? 'is-selected' : ''}`} style={rectStyle(region)}><span className="annotation-label">屏蔽 · {edit.enabled ? '启用' : '禁用'}</span>{selected && ui.tool === 'select' && handles.map(h => <i key={h} data-handle={h} className={`region-handle handle-${h}`} />)}</div>;
    })}
    {preview && !drag.current?.annotation && <div className="annotation-rect is-preview" style={rectStyle(preview)} />}
  </div>;
}
