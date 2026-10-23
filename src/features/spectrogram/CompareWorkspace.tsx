import { Fragment, type CSSProperties } from 'react';
import { CompareSplitter } from './CompareSplitter';
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
    <div className="file-stack-scroll"><div className={`file-stack ${compare ? workspace.state.compareLayout : 'single'}`} style={{ '--compare-first': `${workspace.state.compareSplit}fr`, '--compare-second': `${1 - workspace.state.compareSplit}fr` } as CSSProperties}>{files.map((media, index) => <Fragment key={media.id}>{index > 0 && <CompareSplitter layout={workspace.state.compareLayout} value={workspace.state.compareSplit} disabled={active.store.editingDisabled} onChange={workspace.split} />}<FilePane active={active} media={media} settings={doc.analysis[media.id] ?? defaultSettings} view={workspace.view(media.id)} status={mediaUI.statuses.find(s => s.mediaId === media.id)?.status ?? 'unverified'} timeLimit={workspace.state.linkedTime ? limit : duration(media)} onView={patch => workspace.patch(media.id, patch)} onSettings={() => setSettingsId(media.id)} onRelink={() => mediaUI.setRelink(media)} /></Fragment>)}</div></div>
    {settingsMedia && <AnalysisSettings key={`${settingsMedia.id}:${analysisKey(doc.analysis[settingsMedia.id] ?? defaultSettings)}`} media={settingsMedia} settings={doc.analysis[settingsMedia.id] ?? defaultSettings} view={workspace.view(settingsMedia.id)} disabled={active.store.editingDisabled} onApply={s => workspace.settings(settingsMedia.id, s)} onView={patch => workspace.patch(settingsMedia.id, patch)} onClose={() => setSettingsId(null)} />}
  </div>;
}
