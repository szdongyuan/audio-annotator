import { usePlaybackContext } from '../playback/usePlayback';
import { Fragment, type CSSProperties } from 'react';
import { CompareSplitter } from './CompareSplitter';
import type { ActiveProject } from '../project/useProjectLifecycle';
import type { MediaUI } from '../media/useMedia';
import type { WorkspaceUI } from './useWorkspace';
import { AnalysisSettings } from './AnalysisSettings';
import { FilePane } from './FilePane';
import { defaultSettings, duration } from './workspace';
export function CompareWorkspace({ active, mediaUI, workspace, settingsId, setSettingsId }: { active: ActiveProject; mediaUI: MediaUI; workspace: WorkspaceUI; settingsId: string | null; setSettingsId: (id: string | null) => void }) {
  const playback = usePlaybackContext();
  const doc = active.store.snapshot.document;
  const selected = doc.media.find(m => m.id === workspace.state.activeMediaId);
  if (!selected) return null;
  const compare = doc.media.find(m => m.id === workspace.state.compareMediaId && m.id !== selected.id);
  const files = compare ? [selected, compare] : [selected];
  const limit = Math.max(...files.map(duration));
  return <div className={`spectrum-workspace ${compare ? 'is-comparing' : ''}`}>
    <div className="file-stack-scroll"><div className={`file-stack ${compare ? workspace.state.compareLayout : 'single'}`} style={{ '--compare-first': `${workspace.state.compareSplit}fr`, '--compare-second': `${1 - workspace.state.compareSplit}fr` } as CSSProperties}>{files.map((media, index) => <Fragment key={media.id}>{index > 0 && <CompareSplitter lifecycle={active.lifecycle} layout={workspace.state.compareLayout} value={workspace.state.compareSplit} disabled={active.store.editingDisabled} onChange={workspace.split} />}<FilePane analysisSource={playback?.workspaceSource ?? 'processed'} active={active} media={media} settings={workspace.renderAnalysis?.(media.id) ?? doc.analysis[media.id] ?? defaultSettings} view={workspace.view(media.id)} status={mediaUI.statuses.find(s => s.mediaId === media.id)?.status ?? 'unverified'} timeLimit={workspace.state.linkedTime ? limit : duration(media)} onView={patch => workspace.patch(media.id, patch)} pane={index === 0 ? 'primary' : 'compare'} choices={workspace.visibleMedia??doc.media} duplicate={workspace.duplicatePane === (index === 0 ? 'primary' : 'compare')} onSelect={id => workspace.selectPane(index === 0 ? 'primary' : 'compare', id)} onSettings={() => setSettingsId(settingsId === media.id ? null : media.id)} onRelink={() => mediaUI.setRelink(media)}>{settingsId === media.id && <AnalysisSettings media={media} settings={workspace.analysis?.(media.id) ?? doc.analysis[media.id] ?? defaultSettings} view={workspace.view(media.id)} disabled={active.store.editingDisabled} onApply={s => workspace.settings(media.id, s)} onView={patch => workspace.patch(media.id, patch)} onClose={() => setSettingsId(null)} onFollowGlobal={workspace.hasGlobalSettings ? () => workspace.followGlobal(media.id) : undefined} />}</FilePane></Fragment>)}</div></div>

  </div>;
}
