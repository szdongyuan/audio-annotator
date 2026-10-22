import type { ActiveProject } from '../project/useProjectLifecycle';
import type { MediaUI } from '../media/useMedia';
import type { WorkspaceUI } from './useWorkspace';
import { AnalysisSettings } from './AnalysisSettings';
import { FilePane } from './FilePane';
import { analysisKey, defaultSettings, duration } from './workspace';
export function CompareWorkspace({ active, mediaUI, workspace, settingsId, setSettingsId }: { active: ActiveProject; mediaUI: MediaUI; workspace: WorkspaceUI; settingsId: string | null; setSettingsId: (id: string | null) => void }) {
  const doc = active.store.snapshot.document;
  const selected = mediaUI.selected;
  if (!selected) return null;
  const compare = doc.media.find(m => m.id === workspace.state.compareMediaId && m.id !== selected.id);
  const files = compare ? [selected, compare] : [selected];
  const settingsMedia = files.find(m => m.id === settingsId);
  const limit = Math.max(...files.map(duration));
  return <div className={`spectrum-workspace ${compare ? 'is-comparing' : ''}`}>
    {compare && <div className="compare-controls"><label>对比文件<select aria-label="对比文件" disabled={active.store.editingDisabled} value={compare.id} onChange={e => workspace.compare(e.target.value)}>{doc.media.filter(m => m.id !== selected.id).map(m => <option key={m.id} value={m.id}>{m.displayName}</option>)}</select></label><label><input aria-label="联动时间轴" type="checkbox" disabled={active.store.editingDisabled} checked={workspace.state.linkedTime} onChange={e => workspace.link(e.target.checked)} />联动时间轴 · 秒</label></div>}
    <div className="file-stack">{files.map(media => <FilePane key={media.id} active={active} media={media} settings={doc.analysis[media.id] ?? defaultSettings} view={workspace.view(media.id)} status={mediaUI.statuses.find(s => s.mediaId === media.id)?.status ?? 'unverified'} timeLimit={workspace.state.linkedTime ? limit : duration(media)} onView={patch => workspace.patch(media.id, patch)} onSettings={() => setSettingsId(media.id)} onRelink={() => mediaUI.setRelink(media)} />)}</div>
    <div className="spectrum-help">滚轮缩放时间 · Shift + 滚轮缩放频率 · 拖动平移 · ← → 浏览</div>
    {settingsMedia && <AnalysisSettings key={`${settingsMedia.id}:${analysisKey(doc.analysis[settingsMedia.id] ?? defaultSettings)}`} media={settingsMedia} settings={doc.analysis[settingsMedia.id] ?? defaultSettings} view={workspace.view(settingsMedia.id)} disabled={active.store.editingDisabled} onApply={s => workspace.settings(settingsMedia.id, s)} onView={patch => workspace.patch(settingsMedia.id, patch)} onClose={() => setSettingsId(null)} />}
  </div>;
}
