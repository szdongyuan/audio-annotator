import { classificationMenu } from '../annotations/classification';
import { useAnnotationContext } from '../annotations/useAnnotations';
import { Menu } from '../../components/menu/Menu';
import type { MenuItem } from '../../components/menu/menuModel';
import type { MediaStatus } from '../../bridge/media';
import type { PlaybackUI } from '../playback/usePlayback';
import type { WorkspaceUI } from '../spectrogram/useWorkspace';
import type { SelectionUI } from './useSelection';
import { resolveRegion } from './actions';
export function RegionMenu({ ui, playback, workspace, statuses, focusNote }: { ui: SelectionUI; playback: PlaybackUI; workspace: WorkspaceUI; statuses: MediaStatus[]; focusNote: (id: string) => void }) {
  const annotations = useAnnotationContext();
  const menu = ui.menu, owner = ui.active;
  if (!menu || !owner || !ui.actions) return null;
  const target = menu.target, doc = owner.store.snapshot.document;
  const liveRegion = target ? resolveRegion(owner, target) : null, disabled = owner.store.editingDisabled || !liveRegion;
  const contextMedia = doc.media.find(m => m.id === menu.mediaId);
  const missing = statuses.find(s => s.mediaId === liveRegion?.mediaId)?.status !== 'ready';
  const items: MenuItem[] = [
    { id: 'category', label: '标注类型', disabled, children: [{ id: 'none', label: '未分类', action: () => { void ui.actions!.classify(target!, null); } }, ...doc.categories.map(c => ({ id: c.id, label: c.name, action: () => { void ui.actions!.classify(target!, c.id); } }))] },
    ...(annotations ? [classificationMenu(doc, { mediaId: menu.mediaId, channelIndex: null }, annotations.classify, '当前文件分类', owner.store.editingDisabled), classificationMenu(doc, { mediaId: menu.mediaId, channelIndex: menu.channelIndex }, annotations.classify, '当前通道分类', owner.store.editingDisabled)] : []),
    { id: 'note', label: '备注', disabled, action: () => { void ui.actions!.note(target!, focusNote); } },
    { id: 'mask', label: '屏蔽选区', disabled, action: () => { void ui.actions!.mask(target!); } },
    { id: 'play', label: '播放选区', disabled: disabled || missing, children: ['original', 'processed'].map(source => ({ id: source, label: source === 'original' ? '原始选区' : '处理后选区', action: () => ui.withTarget(target, region => playback.playSelection(region, source as 'original' | 'processed')) })) },
    { id: 'zoom', label: '放大到选区', disabled, action: () => ui.withTarget(target, r => workspace.patch(r.mediaId, { startSeconds: r.startSeconds, endSeconds: r.endSeconds, lowHz: r.lowHz, highHz: r.highHz })) },
    { id: 'reset', label: '重置当前视图', disabled: owner.store.editingDisabled || !contextMedia, action: () => { if (contextMedia) workspace.patch(contextMedia.id, { startSeconds: 0, endSeconds: Math.min(10, contextMedia.frameCount / contextMedia.sampleRate), lowHz: 0, highHz: contextMedia.sampleRate / 2 }); } },
  ];
  if (target?.object) items.push({ id: 'remove', label: target.object.kind === 'annotation' ? '删除标注' : '删除屏蔽', disabled, action: () => { void ui.actions!.remove(target); } });
  if (target?.object?.kind === 'mask') items.push({ id: 'enabled', label: doc.edits.find(e => e.id === target.object!.id)?.enabled ? '禁用屏蔽' : '启用屏蔽', disabled, action: () => { void ui.actions!.toggleMask(target); } });
  if (menu.overlaps.length > 1) items.push({ id: 'objects', label: '重叠对象', children: menu.overlaps.map((s, i) => ({ id: s.object!.id, label: `${s.object!.kind === 'mask' ? '屏蔽' : doc.categories.find(c => c.id === doc.annotations.find(a => a.id === s.object!.id)?.categoryId)?.name ?? '未分类标注'} ${i + 1}`, checked: target?.object?.id === s.object!.id, action: () => ui.withTarget(s, region => ui.state.select({ ...s, region })) })) });
  return <Menu items={items} anchor={menu} onClose={ui.closeMenu} />;
}
