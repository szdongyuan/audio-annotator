import { annotationDisabled } from '../collaboration/capabilities';
import type { MediaDescriptor, MediaView } from '../../bridge/types';
import type { MediaStatus } from '../../bridge/media';
import { useLayoutEffect, useRef, useState } from 'react';
import { Menu } from '../../components/menu/Menu';
import { menuIsOpen, type MenuItem } from '../../components/menu/menuModel';
import { usePlaybackContext } from '../playback/usePlayback';
import { coordinates } from '../spectrogram/coordinates';
import { resolveSelection, type Selection } from './state';
import { useSelectionContext } from './useSelection';
import { targetCommands } from './targetCommands';
import { useCollaborationContext } from '../collaboration/useCollaboration';

type Box = { left: number; top: number; right: number; bottom: number };
const intersect = (a: Box, b: Box): Box => ({ left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) });


export function SelectionToolbar({ media, channel, view, status }: { media: MediaDescriptor; channel: number; view: MediaView; status: MediaStatus['status'] }) {
  const ui = useSelectionContext(), playback = usePlaybackContext();
  const collaboration = useCollaborationContext();
  const host = useRef<HTMLDivElement>(null), bar = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number; maxWidth: number } | null>(null);
  const [menu, setMenu] = useState<{ owner: NonNullable<typeof ui>['active']; target: Selection; kind: 'category' | 'audition'; x: number; y: number; trigger: HTMLElement } | null>(null);
  const latest = useRef({ ui, status }); latest.current = { ui, status };
  const target = ui?.active ? resolveSelection(ui.active.store.snapshot.document, ui.selection) : null;
  const ownVisible = !collaboration?.controller || collaboration.controller.visible(ui?.active?.collaboration?.actor?.authorId ?? null);
  const eligible = !!target && (target.object?.kind !== 'annotation' || ownVisible) && target.region.mediaId === media.id && target.region.channelIndex === channel && view.visibleChannels.includes(channel) && !ui?.gesturing;
  useLayoutEffect(() => {
    const element = host.current;
    if (!element) return;
    const plot = element.closest<HTMLElement>('.spectrogram-surface');
    if (!plot) return;
    const clips: HTMLElement[] = [];
    for (let p = plot.parentElement; p; p = p.parentElement) {
      const css = getComputedStyle(p);
      if (p.classList.contains('channel-scroll') || /(auto|scroll|hidden|clip)/.test(css.overflow + css.overflowX + css.overflowY)) clips.push(p);
    }
    const measure = () => {
      if (!eligible || !target) { setPosition(null); return; }
      const bounds = plot.getBoundingClientRect();
      let visible = intersect(bounds, { left: 0, top: 0, right: innerWidth, bottom: innerHeight });
      for (const clip of clips) visible = intersect(visible, clip.getBoundingClientRect());
      const c = coordinates(view, media.sampleRate / 2, bounds.width, bounds.height), r = target.region;
      const frame = intersect(visible, { left: bounds.left + c.secondsToX(r.startSeconds), right: bounds.left + c.secondsToX(r.endSeconds), top: bounds.top + c.hzToY(r.highHz), bottom: bounds.top + c.hzToY(r.lowHz) });
      if (frame.right <= frame.left || frame.bottom <= frame.top || visible.right <= visible.left || visible.bottom <= visible.top) { setPosition(null); return; }
      const size = bar.current?.getBoundingClientRect(), width = size?.width || 140, height = size?.height || 28;
      if (visible.bottom - visible.top < height) { setPosition(null); return; }
      const top = frame.top - height - 4 >= visible.top ? frame.top - height - 4 : Math.min(frame.top + 4, visible.bottom - height);
      const left = Math.max(visible.left, Math.min(frame.left, visible.right - width));
      const next = { left: left - bounds.left, top: top - bounds.top, maxWidth: visible.right - visible.left };
      setPosition(previous => previous && previous.left === next.left && previous.top === next.top && previous.maxWidth === next.maxWidth ? previous : next);
    };
    measure();
    const observer = new ResizeObserver(measure); observer.observe(plot); if (bar.current) observer.observe(bar.current); clips.forEach(clip => observer.observe(clip));
    window.addEventListener('scroll', measure, true); window.addEventListener('resize', measure);
    return () => { observer.disconnect(); window.removeEventListener('scroll', measure, true); window.removeEventListener('resize', measure); };
  }, [eligible, target, view, media.sampleRate]);
  const validMenu = menu && eligible && position && menu.owner === ui?.active && ui!.state.matches(menu.target) ? menu : null;
  useLayoutEffect(() => { if (menu && !validMenu) setMenu(null); }, [menu, validMenu]);
  const shown = eligible && !!position;
  const disabled = !ui?.active || ui.active.store.editingDisabled;
  const reason = status === 'ready' ? '' : status === 'missing' ? '音频文件缺失' : status === 'changed' ? '音频源文件已改变' : '音频尚未就绪';
  const commands = (captured: Selection) => targetCommands(ui!, captured, playback, () => [{ mediaId: media.id, status: latest.current.status }], () => latest.current.ui?.active === ui?.active && !!latest.current.ui?.state.matches(captured));
  const open = (kind: 'category' | 'audition', trigger: HTMLElement) => {
    if (!target || disabled || kind==='category'&&annotationDisabled(ui?.active) || menuIsOpen()) return;
    const rect = trigger.getBoundingClientRect(); setMenu({ owner: ui!.active, target, kind, x: rect.left, y: rect.bottom, trigger });
  };
  const items: MenuItem[] = validMenu?.kind === 'category' ? [
    { id: 'none', label: '清空标签', keepOpen: true, checked: false, disabled, action: () => commands(validMenu.target).edit(selected => { void ui!.actions!.classify(selected, null); }) },
    ...ui!.active!.store.snapshot.document.categories.map(c => ({ id: c.id, label: c.name, keepOpen: true, checked: ui!.active!.store.snapshot.document.annotations.find(a => a.id === ui!.state.follow(validMenu.target).object?.id)?.categoryIds.includes(c.id) ?? false, disabled, action: () => commands(validMenu.target).edit(selected => { void ui!.actions!.classify(selected, c.id); }) })),
  ] : (['original', 'processed'] as const).map(source => ({ id: source, label: source === 'original' ? '试听选区原音' : '试听选区（应用屏蔽）', disabled: disabled || !!reason, title: reason || undefined, action: () => { if (validMenu) commands(validMenu.target).audition(source); } }));
  return <div ref={host} className="selection-toolbar-layer" data-pane-control onPointerDown={e => e.stopPropagation()} onPointerUp={e => e.stopPropagation()} onClick={e => e.stopPropagation()} onContextMenu={e => { e.preventDefault(); e.stopPropagation(); }}>
    {eligible && <div ref={bar} role="toolbar" aria-label="选区操作" className="selection-toolbar" style={{ ...position, visibility: shown ? 'visible' : 'hidden' }}>
      <button disabled={disabled || !!reason} title={reason || '播放当前选区'} onClick={() => { if (target) commands(target).audition(); }}>播放</button>
      <button aria-label="试听选区版本" aria-haspopup="menu" aria-expanded={validMenu?.kind === 'audition'} disabled={disabled || !!reason} title={reason || '选择本次试听版本'} onClick={e => open('audition', e.currentTarget)}>▾</button>
      <button aria-label="应用区域增益" disabled={disabled} onClick={e => { if (target) ui!.openGain(target, e.currentTarget); }}>增益</button>
      <button aria-label="标注" aria-haspopup="menu" aria-expanded={validMenu?.kind === 'category'} disabled={disabled||annotationDisabled(ui?.active)} onClick={e => open('category', e.currentTarget)}>标注 ▾</button>
    </div>}
    {validMenu && <Menu items={items} anchor={validMenu} returnFocus={validMenu.trigger} onClose={() => setMenu(null)} />}
  </div>;
}
