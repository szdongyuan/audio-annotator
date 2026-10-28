import { labelText, labelColor } from './labels';
import { annotationDisabled } from '../collaboration/capabilities';
import { useEffect, useRef, useState, type PointerEvent, type CSSProperties } from 'react';
import type { MediaDescriptor, MediaView, Region } from '../../bridge/types';
import { coordinates } from '../spectrogram/coordinates';
import { drawRegion, eventPoint, moveRegion, resizeRegion, type Handle, type Point } from './selection';
import { useSelectionContext } from '../selection/useSelection';
import { exceedsThreshold, gestureKind } from '../selection/gestures';
import { resolveSelection, sameRegion, type Selection } from '../selection/state';
import { usePlaybackContext } from '../playback/usePlayback';
import { menuIsOpen } from '../../components/menu/menuModel';
import { useCollaborationContext } from '../collaboration/useCollaboration';
import { foreignAuthors, resolveRemote, useRemoteContext, type RemoteTarget } from '../collaboration/remote';
import { RemoteAnnotations } from '../collaboration/RemoteAnnotations';
import { visibleBorderHit } from './visibleBorder';
import { contentVisible, ownContentVisible, ownSelectionVisible } from '../collaboration/annotationVisibility';
type RemoteRegionTarget = Extract<RemoteTarget, { scope: 'region' }>;
type Drag = { pointerId: number; start: Point; css: { x: number; y: number }; target: Selection | null; remote?: RemoteRegionTarget; runtime?: string; kind: 'draw' | 'move' | 'resize' | 'deactivate'; handle?: Handle; region: Region | null; box: DOMRect; view: MediaView };
const handles: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
export function AnnotationOverlay({ media, channel, view }: { media: MediaDescriptor; channel: number; view: MediaView }) {
  const playback = usePlaybackContext();
  const collaboration = useCollaborationContext(), remote = useRemoteContext(), authors = foreignAuthors(collaboration);
  const ui = useSelectionContext(), host = useRef<HTMLDivElement>(null), drag = useRef<Drag | null>(null), [preview, setPreview] = useState<Region | null>(null), [height, setHeight] = useState(0);
  useEffect(() => { const el = host.current; if (!el) return; const observer = new ResizeObserver(entries => setHeight(entries[0].contentRect.height)); observer.observe(el); return () => observer.disconnect(); }, []);
  useEffect(() => { drag.current = null; setPreview(null); }, [ui?.cancelVersion]);
  useEffect(() => { if (drag.current) { drag.current = null; ui?.state.cancel(); setPreview(null); } }, [ui?.active, ui?.active?.collaboration?.runtimeNonce, media.id, channel, view.startSeconds, view.endSeconds, view.lowHz, view.highHz, view.frequencyMix, view.spectrumKind]);
  useEffect(() => () => { if (drag.current) { drag.current = null; ui?.state.cancel(); } }, [ui?.state]);
  if (!ui?.active) return null;
  const doc = ui.active.store.snapshot.document, duration = media.frameCount / media.sampleRate, nyquist = media.sampleRate / 2;
  const items = doc.annotations.filter(a => a.region.mediaId === media.id && a.region.channelIndex === channel && ownContentVisible(collaboration, ui.active, a.categoryIds));
  const current = ui.selection?.object?.kind !== 'mask' && ui.selection?.region.mediaId === media.id && ui.selection.region.channelIndex === channel && ownSelectionVisible(collaboration, ui.active, ui.selection) ? ui.selection : null;
  const candidate = ui.candidate?.object?.kind !== 'mask' && ui.candidate?.region.mediaId === media.id && ui.candidate.region.channelIndex === channel && ownSelectionVisible(collaboration, ui.active, ui.candidate) ? ui.candidate : null;
  const remoteHit = (e: { clientX: number; clientY: number }): RemoteRegionTarget | undefined => {
    const box = host.current!.getBoundingClientRect();
    // RemoteAnnotations paints in author/document order; the last painted edge wins.
    for (const author of [...foreignAuthors(collaboration)].reverse()) for (const a of [...(author.layer?.payload.annotations ?? [])].reverse()) {
      const r = a.region;
      if (r.mediaId === media.id && r.channelIndex === channel && contentVisible(collaboration, ui.active, author.identity.authorId, author.layer?.payload.categories ?? [], a.categoryIds) && visibleBorderHit(r, e, box, view, nyquist)) {
        const target: RemoteRegionTarget = { owner: ui.active!, authorId: author.identity.authorId, scope: 'region', annotationId: a.id };
        if (resolveRemote(collaboration, target)) return target;
      }
    }
  };
  const contains = (s: Selection | null, p: Point) => !!s && p.seconds >= s.region.startSeconds && p.seconds <= s.region.endSeconds && p.hz >= s.region.lowHz && p.hz <= s.region.highHz;
  const point = (e: { clientX: number; clientY: number }, box = host.current!.getBoundingClientRect(), mapping = view) => eventPoint(e, box, mapping, nyquist);
  const hits = (p: Point): Selection[] => {
    const all: Selection[] = items.map(a => ({ region: a.region, object: { kind: 'annotation' as const, id: a.id } })).reverse();
    const result = all.filter(({ region: r }) => p.seconds >= r.startSeconds && p.seconds <= r.endSeconds && p.hz >= r.lowHz && p.hz <= r.highHz);
    result.sort((a, b) => Number(b.object?.id === current?.object?.id) - Number(a.object?.id === current?.object?.id));
    return result;
  };
  const rectStyle = (r: Region): CSSProperties => {
    const c = coordinates(view, nyquist, 100, 100);
    return { left: `${c.secondsToX(r.startSeconds)}%`, top: `${c.hzToY(r.highHz)}%`, width: `${c.secondsToX(r.endSeconds) - c.secondsToX(r.startSeconds)}%`, height: `${c.hzToY(r.lowHz) - c.hzToY(r.highHz)}%` };
  };
  const border = (s: Selection | null, e: { clientX: number; clientY: number }) => {
    if (!s) return false;
    const box = host.current!.getBoundingClientRect(), c = coordinates(view, nyquist, box.width, box.height), r = s.region;
    const x = e.clientX - box.left, y = e.clientY - box.top;
    return x >= c.secondsToX(r.startSeconds) - 4 && x <= c.secondsToX(r.endSeconds) + 4 && y >= c.hzToY(r.highHz) - 4 && y <= c.hzToY(r.lowHz) + 4 && Math.min(Math.abs(x - c.secondsToX(r.startSeconds)), Math.abs(x - c.secondsToX(r.endSeconds)), Math.abs(y - c.hzToY(r.lowHz)), Math.abs(y - c.hzToY(r.highHz))) <= 4;
  };
  const priorityTarget = (p: Point, e: { clientX: number; clientY: number }, handle?: Handle) => {
    if (handle) return current;
    // Temporary selections retain their existing interior/border behavior.
    if (current && !current.object && (contains(current, p) || border(current, e))) return current;
    if (candidate && !candidate.object && contains(candidate, p)) return candidate;
    const box = host.current!.getBoundingClientRect();
    if (current?.object && visibleBorderHit(current.region, e, box, view, nyquist)) return current;
    const own = [...items].reverse().find(a => visibleBorderHit(a.region, e, box, view, nyquist));
    return own ? { region: own.region, object: { kind: 'annotation' as const, id: own.id } } : null;
  };
  const update = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current; if (!d || d.pointerId !== e.pointerId || d.kind === 'deactivate') return null;
    const p = point(e, d.box, d.view);
    d.region = d.kind === 'draw' ? drawRegion(media.id, channel, d.start, p, duration, nyquist) : d.kind === 'resize' ? resizeRegion(d.target!.region, d.handle!, p, duration, nyquist) : moveRegion(d.target!.region, p.seconds - d.start.seconds, p.hz - d.start.hz, duration, nyquist);
    return d.region;
  };
  const cancel = () => { if (!drag.current) return; drag.current = null; setPreview(null); ui.state.cancel(); };
  const frame = (selection: Selection, label: string, color: string) => {
    const selected = selection.object ? current?.object?.kind === selection.object.kind && current.object.id === selection.object.id : current === selection;
    const r = selected && drag.current?.kind !== 'draw' && preview ? preview : selection.region;
    const c = coordinates(view, nyquist, 100, height), low = c.hzToY(r.lowHz), high = c.hzToY(r.highHz);
    return <div key={selection.object?.id ?? 'temporary'} data-annotation-id={selection.object?.kind === 'annotation' ? selection.object.id : undefined} data-temporary-selection={!selection.object || undefined}
      title={label} className={`annotation-rect ${selected ? 'is-selected' : ''} ${!selection.object ? 'is-temporary' : ''} ${!selected && !selection.object ? 'is-inactive' : ''}`}
      style={{ ...rectStyle(r), '--region-color': color, zIndex: selected ? 2 : 1 } as CSSProperties}>
      {low - high >= 24 && <span className="annotation-label">{label}</span>}
      {selected && (selection.object?.kind!=='annotation'||!annotationDisabled(ui.active)) && handles.map(h => <i key={h} data-handle={h} className={`region-handle handle-${h}`} />)}
    </div>;
  };
  return <div ref={host} className="annotation-overlay" aria-label={`通道 ${channel + 1} 标注图层`} onPointerDown={e => {
    if (ui.active!.store.editingDisabled || menuIsOpen()) return;
    ui.state.interact({ mediaId: media.id, channelIndex: channel });
    const p = point(e), hit = hits(p)[0] ?? null;
    const activeHit = contains(current, p) || border(current, e);
    const handle = current ? (e.target as HTMLElement).dataset.handle as Handle | undefined : undefined;
    const priority = priorityTarget(p, e, handle), foreign = !priority ? remoteHit(e) : undefined;
    const target = resolveSelection(ui.active!.store.snapshot.document, priority ?? (foreign ? null : activeHit ? current : contains(candidate, p) ? candidate : hit));
    const active = ui.state.getActiveSelection();
    const visibleActive = active && ownSelectionVisible(collaboration, ui.active, active);
    const kind = gestureKind(e.button, e.altKey, handle, !foreign && activeHit, !!visibleActive && !target && !foreign);
    if (kind === 'pan' || !kind) return;
    if(target?.object?.kind==='annotation'&&annotationDisabled(ui.active)&&(kind==='move'||kind==='resize')){ui.state.select(target);return;}
    if (!foreign && !target && (activeHit || handle)) { ui.state.reconcile(ui.active!.store.snapshot.document); return; }
    e.preventDefault(); e.stopPropagation(); e.currentTarget.closest<HTMLElement>('.spectrogram-surface')?.focus(); e.currentTarget.setPointerCapture(e.pointerId);
    ui.state.beginGesture();
    drag.current = { pointerId: e.pointerId, start: p, css: { x: e.clientX, y: e.clientY }, target: kind === 'deactivate' ? active : target, remote: foreign, runtime: ui.active!.collaboration?.runtimeNonce, kind, handle, region: null, box: e.currentTarget.getBoundingClientRect(), view };
  }} onPointerMove={e => {
    if (!drag.current || drag.current.pointerId !== e.pointerId) return; e.stopPropagation();
    if (drag.current.kind !== 'deactivate' && exceedsThreshold(drag.current.css, { x: e.clientX, y: e.clientY })) setPreview(update(e));
  }} onPointerUp={e => {
    const d = drag.current; if (!d || d.pointerId !== e.pointerId) return; e.stopPropagation();
    const region = update(e), moved = exceedsThreshold(d.css, { x: e.clientX, y: e.clientY }); drag.current = null; setPreview(null);
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (d.kind === 'deactivate') { ui.state.endGesture(); if (d.target && ui.state.getCandidate() === ui.state.follow(d.target)) { if (!moved) playback?.setCue(ui.active!, media.id, point(e).seconds); ui.state.clearCandidate(d.target); } return; }
    const latest = ui.active!.store.snapshot.document;
    ui.state.reconcile(latest);
    if (ui.active!.store.editingDisabled) { ui.state.cancel(); return; }
    if (d.target && !ownSelectionVisible(collaboration, ui.active, d.target)) { ui.state.cancel(); return; }
    ui.state.endGesture();
    if (!moved && d.remote) {
      // Revalidate the accepted press, retaining the normal click jitter threshold.
      const latestRemote = remoteHit({ clientX: d.css.x, clientY: d.css.y });
      if (latestRemote?.owner === d.remote.owner && latestRemote.authorId === d.remote.authorId
        && latestRemote.annotationId === d.remote.annotationId && d.runtime === ui.active!.collaboration?.runtimeNonce) remote?.inspect(d.remote);
    }
    else if (!moved) { ui.state.select(resolveSelection(latest, d.target)); if (!d.target) playback?.setCue(ui.active!, media.id, point(e).seconds); }
    else if (region && d.kind === 'draw') ui.state.select(resolveSelection(latest, { region, object: null }));
    else if (region && d.target && !sameRegion(region, d.target.region)) {
      if (d.target.object) void ui.actions!.move(d.target, region);
      else ui.state.select(resolveSelection(latest, { region, object: null }));
    }
  }} onPointerCancel={cancel} onLostPointerCapture={cancel} onContextMenu={e => {
    e.preventDefault(); e.stopPropagation(); if (ui.active!.store.editingDisabled || menuIsOpen()) return;
    cancel(); const overlaps = hits(point(e)), p = point(e);
    const inside = current && p.seconds >= current.region.startSeconds && p.seconds <= current.region.endSeconds && p.hz >= current.region.lowHz && p.hz <= current.region.highHz;
    const handle = current ? (e.target as HTMLElement).dataset.handle as Handle | undefined : undefined;
    const priority = priorityTarget(p, e, handle), foreign = !priority ? remoteHit(e) : undefined;
    if (foreign) { remote?.inspect(foreign); return; }
    const active = ui.state.getActiveSelection();
    const target = resolveSelection(ui.active!.store.snapshot.document, priority ?? (inside ? current : overlaps[0] ?? (ownSelectionVisible(collaboration, ui.active, active) ? active : null)));
    playback?.setCue(ui.active!, media.id, p.seconds);
    ui.state.interact({ mediaId: media.id, channelIndex: channel });
    ui.openMenu({ x: e.clientX, y: e.clientY, target, overlaps, mediaId: media.id, channelIndex: channel, seconds: p.seconds });
  }}>
    <RemoteAnnotations authors={authors} media={media} channel={channel} view={view} visible={(author, ids) => contentVisible(collaboration, ui.active, author.identity.authorId, author.layer?.payload.categories ?? [], ids)} />
    {items.map(a => frame({ region: a.region, object: { kind: 'annotation', id: a.id } }, `${ui.active!.collaboration ? `${ui.active!.collaboration.actor?.displayName ?? '访客'} · ` : ''}${labelText(doc.categories, a.categoryIds)}`, labelColor(doc.categories, a.categoryIds, '#e6a65d')))}
    {candidate && !candidate.object && frame(candidate, '选区', '#f6e8b9')}
    {preview && drag.current?.kind === 'draw' && <div className="annotation-rect is-preview" style={rectStyle(preview)} />}
  </div>;
}
