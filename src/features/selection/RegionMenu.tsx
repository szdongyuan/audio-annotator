import { annotationDisabled } from '../collaboration/capabilities';
import { useRef } from 'react';
import { classificationMenu } from '../annotations/classification';
import { useAnnotationContext } from '../annotations/useAnnotations';
import { Menu } from '../../components/menu/Menu';
import type { MenuItem } from '../../components/menu/menuModel';
import type { MediaStatus } from '../../bridge/media';
import type { PlaybackUI } from '../playback/usePlayback';
import type { WorkspaceUI } from '../spectrogram/useWorkspace';
import type { SelectionUI } from './useSelection';
import { targetCommands } from './targetCommands';
import { resolveRegion } from './actions';
export function RegionMenu({ ui, playback, workspace, statuses, focusNote }: { ui: SelectionUI; playback: PlaybackUI; workspace: WorkspaceUI; statuses: MediaStatus[]; focusNote: (id: string) => void }) {
  const latest = useRef({ui,statuses}); latest.current={ui,statuses};
  const annotations = useAnnotationContext();
  const menu = ui.menu, owner = ui.active;
  if (!menu || !owner || !ui.actions) return null;
  const target = menu.target, doc = owner.store.snapshot.document;
  const liveRegion = target ? resolveRegion(owner, target) : null, disabled = owner.store.editingDisabled || !liveRegion;
  const contextMedia = doc.media.find(m => m.id === menu.mediaId);
  const missing = statuses.find(s => s.mediaId === liveRegion?.mediaId)?.status !== 'ready';
  const canCue = () => latest.current.ui.active === owner && !!contextMedia && !owner.store.editingDisabled && Number.isFinite(menu.seconds) && menu.seconds! >= 0 && menu.seconds! * contextMedia.sampleRate < contextMedia.frameCount && latest.current.statuses.some(s=>s.mediaId===menu.mediaId&&s.status==='ready') && owner.store.snapshot.document.media.some(m=>m.id===menu.mediaId);
  const { audition, edit: editTarget } = targetCommands(ui, target, playback, () => latest.current.statuses);
  const items: MenuItem[] = [
    { id:'cue', label:'从此处播放', disabled:!canCue(), action:()=>{if(canCue())playback.playFrom(owner,menu.mediaId,menu.seconds!);} },
    { id: 'category', label: '标注类型', disabled:disabled||annotationDisabled(owner), children: [{ id: 'none', label: '未分类', action: () => { editTarget(selected=>{void ui.actions!.classify(selected, null);}); } }, ...doc.categories.map(c => ({ id: c.id, label: c.name, action: () => { editTarget(selected=>{void ui.actions!.classify(selected, c.id);}); } }))] },
    ...(annotations ? [classificationMenu(doc, { mediaId: menu.mediaId, channelIndex: null }, annotations.classify, '当前文件分类', annotationDisabled(owner)), classificationMenu(doc, { mediaId: menu.mediaId, channelIndex: menu.channelIndex }, annotations.classify, '当前通道分类', annotationDisabled(owner))] : []),
    { id: 'note', label: '备注', disabled:disabled||annotationDisabled(owner), action: () => { editTarget(selected=>{void ui.actions!.note(selected, focusNote);}); } },
    { id: 'mask', label: '屏蔽选区', disabled, action: () => { editTarget(selected=>{void ui.actions!.mask(selected);}); } },
    { id:'play', label:'播放选区', disabled:disabled||missing, action:()=>audition() },
    ...(['original','processed'] as const).map(source=>({id:source,label:source==='original'?'试听选区原音':'试听选区（应用屏蔽）',disabled:disabled||missing,action:()=>audition(source)})),
    { id: 'zoom', label: '放大到选区', disabled, action: () => ui.withTarget(target, r => workspace.patch(r.mediaId, { startSeconds: r.startSeconds, endSeconds: r.endSeconds, lowHz: r.lowHz, highHz: r.highHz })) },
    { id: 'reset', label: '重置当前视图', disabled: owner.store.editingDisabled || !contextMedia, action: () => { if (contextMedia) workspace.patch(contextMedia.id, { startSeconds: 0, endSeconds: Math.min(10, contextMedia.frameCount / contextMedia.sampleRate), lowHz: 0, highHz: contextMedia.sampleRate / 2 }); } },
  ];
  if (target?.object) items.push({ id: 'remove', label: target.object.kind === 'annotation' ? '删除标注' : '删除屏蔽', disabled:disabled||target.object.kind==='annotation'&&annotationDisabled(owner), action: () => { void ui.actions!.remove(target); } });
  if (target?.object?.kind === 'mask') items.push({ id: 'enabled', label: doc.edits.find(e => e.id === target.object!.id)?.enabled ? '禁用屏蔽' : '启用屏蔽', disabled, action: () => { void ui.actions!.toggleMask(target); } });
  if (menu.overlaps.length > 1) items.push({ id: 'objects', label: '重叠对象', children: menu.overlaps.map((s, i) => ({ id: s.object!.id, label: `${s.object!.kind === 'mask' ? '屏蔽' : doc.categories.find(c => c.id === doc.annotations.find(a => a.id === s.object!.id)?.categoryId)?.name ?? '未分类标注'} ${i + 1}`, checked: target?.object?.id === s.object!.id, action: () => ui.withTarget(s, region => ui.state.select({ ...s, region })) })) });
  return <Menu items={items} anchor={menu} onClose={ui.closeMenu} />;
}
