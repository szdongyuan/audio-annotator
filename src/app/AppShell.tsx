import type { IdentityController } from '../features/identity/controller';
import { CollaborationStatus } from '../features/collaboration/CollaborationStatus';
import { RemoteContext, useRemoteInspection } from '../features/collaboration/remote';
import { RemoteInspector, RemoteList } from '../features/collaboration/RemoteInspector';
import type { CollaborationUI } from '../features/collaboration/useCollaboration';
import { useEffect, useState, type ButtonHTMLAttributes } from 'react';
import { PlaybackContext, usePlayback } from '../features/playback/usePlayback';
import { MaskContext, useMasks } from '../features/playback/useMasks';
import { AppMenu } from './AppMenu';
import { workspaceMenus } from './WorkspaceActions';
import { HelpDialog, type HelpTopic } from './HelpDialog';
import { RegionGainDialog } from '../features/playback/RegionGainDialog';
import { TransportBar, TransportDevices } from '../features/playback/TransportBar';
import { ChannelMixer } from '../features/playback/ChannelMixer';
import { EditList } from '../features/playback/EditList';
import { ProjectActions } from '../features/project/ProjectActions';
import { SaveIndicator } from '../features/project/SaveIndicator';
import type { ProjectLifecycleUI } from '../features/project/useProjectLifecycle';
import type { MediaUI } from '../features/media/useMedia';
import { MediaList } from '../features/media/MediaList';
import { ImportAcknowledgements, ImportProgress } from '../features/media/ImportProgress';
import { FolderImportDialog } from '../features/media/FolderImportDialog';
import { FolderImportProgress } from '../features/media/FolderImportProgress';
import { SourceImportDialog } from '../features/media/SourceImportDialog';
import { SourceImportProgress } from '../features/media/SourceImportProgress';
import { MediaAssociation } from '../features/exchange/MediaAssociation';
import type { ExchangeUI } from '../features/exchange/useExchange';
import { AnnotationContext, useAnnotations } from '../features/annotations/useAnnotations';
import { AnnotationTools } from '../features/annotations/AnnotationTools';
import { AnnotationInspector } from '../features/annotations/AnnotationInspector';
import { AnnotationList } from '../features/annotations/AnnotationList';
import { NotesEditor } from '../features/annotations/NotesEditor';
import { CategoryManager } from '../features/annotations/CategoryManager';
import { AnnotationFailure } from '../features/annotations/AnnotationFailure';
import { CompareWorkspace } from '../features/spectrogram/CompareWorkspace';
import { useWorkspace } from '../features/spectrogram/useWorkspace';
import { SelectionContext, useSelection } from '../features/selection/useSelection';
import { RegionMenu } from '../features/selection/RegionMenu';
import {
  AudioLines,
  PanelLeftClose,
  PanelLeftOpen, PanelRightClose, PanelRightOpen,
  ScanLine, Settings2, SlidersHorizontal,
  Square, Upload,
  type LucideIcon,
} from 'lucide-react';

type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: LucideIcon;
  label: string;
};

function IconButton({ icon: Icon, label, className = '', ...props }: IconButtonProps) {
  return <button type="button" className={`icon-button ${className}`} aria-label={label} title={label} {...props}>
    <Icon size={17} aria-hidden="true" />
  </button>;
}

export function AppShell({ project, mediaUI, exchange, collaboration, identity }: { identity?:IdentityController; collaboration?: CollaborationUI; project?: ProjectLifecycleUI; mediaUI?: MediaUI; exchange?: ExchangeUI }) {
  const [mediaOpen, setMediaOpen] = useState(true);
  const [propertiesOpen, setPropertiesOpen] = useState(true);
  const hiddenMediaIds=collaboration?.controller?.status?.hiddenMediaIds??project?.active?.collaboration?.hiddenMediaIds??[];
  const workspace = useWorkspace(project?.active ?? null,hiddenMediaIds,collaboration?async id=>{await collaboration.hideMedia(id,false);}:undefined);
  const selected = project?.active?.store.snapshot.document.media.find(m => m.id === workspace.state.activeMediaId);
  const [settingsId, setSettingsId] = useState<string | null>(null);
  const panes = [selected?.id, workspace.state.compareMediaId].filter((id): id is string => !!id && !!project?.active?.store.snapshot.document.media.some(m => m.id === id)).map(mediaId => ({ mediaId, channels: workspace.view(mediaId).visibleChannels }));
  const selection = useSelection(project?.active ?? null, selected?.id ?? null, panes);
  useEffect(() => { setSettingsId(null); }, [project?.active]);
  useEffect(() => { if (settingsId && !panes.some(p => p.mediaId === settingsId)) setSettingsId(null); }, [settingsId, workspace.state.activeMediaId, workspace.state.compareMediaId, project?.active?.store.snapshot.document.media]);
  const annotations = useAnnotations(project?.active ?? null, selection);
  const [inspectorTab, setInspectorTab] = useState('region');
  const doc = project?.active?.store.snapshot.document;
  const selectedAnnotation = doc?.annotations.find(a => a.id === annotations.selectedId);
  const masks = useMasks(project?.active ?? null, selection);
  const playback = usePlayback(project?.active ?? null, selected?.id ?? null, selection.selection?.region);
  const remote = useRemoteInspection(collaboration, workspace, playback);
  const [noteFocusId, setNoteFocusId] = useState<string | null>(null);
  useEffect(() => { setNoteFocusId(null); setInspectorTab('region'); }, [project?.active]);
  useEffect(() => { if (noteFocusId && selectedAnnotation?.id === noteFocusId && propertiesOpen && inspectorTab === 'region') { document.querySelector<HTMLTextAreaElement>('[aria-label="区域备注"]')?.focus(); setNoteFocusId(null); } }, [noteFocusId, selectedAnnotation?.id, propertiesOpen, inspectorTab]);
  useEffect(() => { if (masks.selectedId) setInspectorTab('masks'); }, [masks.selectedId]);
  useEffect(() => { if (annotations.selectedId) setInspectorTab('region'); }, [annotations.selectedId]);
  useEffect(() => { if (selection.context && !selection.selection) setInspectorTab('notes'); }, [selection.context, selection.selection]);
  const [helpTopic, setHelpTopic] = useState<HelpTopic | null>(null);
  const focusNote = (id: string) => { setPropertiesOpen(true); setInspectorTab('region'); setNoteFocusId(id); };
  const menus = workspaceMenus({ identity, collaboration, project, mediaUI, exchange, annotations, selection, workspace, playback, mediaOpen, propertiesOpen,
    toggleMedia: () => setMediaOpen(v => !v), toggleProperties: () => setPropertiesOpen(v => !v), settings: setSettingsId,
    inspector: tab => { setPropertiesOpen(true); setInspectorTab(tab); }, help: setHelpTopic, focusNote });

  return <RemoteContext.Provider value={remote}><SelectionContext.Provider value={selection}><AnnotationContext.Provider value={annotations}><MaskContext.Provider value={masks}><PlaybackContext.Provider value={playback}><div className="app-shell">
    <header className="project-header">
      <AppMenu menus={menus} owner={project?.active ?? null} contextKey={`${selection.context?.mediaId}:${selection.context?.channelIndex}:${selection.state.intentVersion}`} />
      <div className="project-identity" title={project?.active?.path}><span>{doc?.name ?? '音频标注'}</span>{project?.active && <SaveIndicator lifecycle={project.active.lifecycle} shared={!!project.active.collaboration} />}</div>{collaboration && <CollaborationStatus ui={collaboration} />}
    </header>

    <div className="workspace-toolbar" role="toolbar" aria-label="工作区工具">
      <div className="toolbar-group">
        <IconButton icon={mediaOpen ? PanelLeftClose : PanelLeftOpen} label={mediaOpen ? '收起音频列表' : '展开音频列表'}
          aria-expanded={mediaOpen} aria-controls="media-panel" onClick={() => setMediaOpen(!mediaOpen)} />
        <span className="toolbar-divider" />
        <div className="segmented-control" aria-label="工作区模式">
          <button className={`segment ${!workspace.state.compareMediaId ? 'is-current' : ''}`} disabled={!selected || project?.active?.store.editingDisabled} onClick={() => workspace.compare(null)}><Square size={14} />单文件</button>
          <button className={`segment ${workspace.state.compareMediaId ? 'is-current' : ''}`} disabled={workspace.visibleMedia.length < 2 || project?.active?.store.editingDisabled} onClick={() => workspace.compare(workspace.visibleMedia.find(m => m.id !== selected?.id)?.id ?? null)}><ScanLine size={14} />双文件对比</button>
        </div>
      </div>
      <AnnotationTools ui={annotations} />
      {project && <ProjectActions project={project} onImport={mediaUI?.choose} importDisabled={mediaUI?.disabled || project.active?.collaboration?.canImportMedia===false} exchange={exchange} />}
      <div className="toolbar-group toolbar-end">
        <button data-analysis-trigger={selected?.id} className="button button-quiet analysis-settings" disabled={!selected || project?.active?.store.editingDisabled} onClick={() => setSettingsId(settingsId === selected?.id ? null : selected?.id ?? null)}><SlidersHorizontal size={16} /><span>分析设置</span></button>
        <span className="toolbar-divider" />
        <IconButton icon={propertiesOpen ? PanelRightClose : PanelRightOpen} label={propertiesOpen ? '收起属性面板' : '展开属性面板'}
          aria-expanded={propertiesOpen} aria-controls="properties-panel" onClick={() => setPropertiesOpen(!propertiesOpen)} />
      </div>
    </div>

    <div className="workspace">
      {mediaOpen && <aside id="media-panel" className="media-panel panel" aria-label="音频列表">
        <MediaList organization={mediaUI?.organization} hiddenMediaIds={hiddenMediaIds} onHide={project?.active?.collaboration?.projectFlavor==='default'?id=>void collaboration?.hideMedia(id,true).catch(()=>{}):undefined} onRestore={id=>void collaboration?.hideMedia(id,false).catch(()=>{})} catalogLocked={project?.active?.collaboration?.canImportMedia===false} categories={doc?.categories ?? []} media={project?.active?.store.snapshot.document.media ?? []} annotations={project?.active?.store.snapshot.document.annotations ?? []} statuses={mediaUI?.statuses ?? []} selectedId={workspace.state.activeMediaId} disabled={mediaUI?.disabled ?? true} onSelect={id => workspace.selectPane('primary', id)} onImport={() => mediaUI?.choose()} onRelink={media => mediaUI?.setRelink(media)} />
      </aside>}

      <main className="analysis-workspace" aria-label="音频分析工作区">
        <div className="workspace-feedback" aria-label="工作区操作反馈">
          {collaboration?.error&&!collaboration.dialog&&<p role="alert">{collaboration.error.message}</p>}
          {mediaUI?.error && <p className="media-error" role="alert">{mediaUI.error.message}</p>}
          {mediaUI?.controller && <ImportAcknowledgements controller={mediaUI.controller} />}
          {mediaUI?.controller && !mediaUI.folder?.ownsCurrentBatch && !mediaUI.source?.ownsCurrentBatch && <ImportProgress controller={mediaUI.controller} />}
          {mediaUI?.folder && <FolderImportProgress controller={mediaUI.folder} />}
          {mediaUI?.source && <SourceImportProgress controller={mediaUI.source} />}
          {mediaUI && <MediaAssociation active={project?.active ?? null} media={mediaUI} />}
          <AnnotationFailure ui={annotations} />
        </div>
        {selected && project?.active && mediaUI ? <CompareWorkspace active={project.active} mediaUI={mediaUI} workspace={workspace} settingsId={settingsId} setSettingsId={setSettingsId} /> : <div className="empty-workspace">
          <div className="empty-content">
            <div className="audio-emblem" aria-hidden="true"><AudioLines size={46} strokeWidth={1.25} /><span /></div>
            <h2>{project?.active ? '导入音频开始标注' : '音频标注'}</h2>
            {project?.active ? <button className="button button-accent import-button" disabled={(mediaUI?.disabled ?? true) || project?.active?.collaboration?.canImportMedia===false} onClick={mediaUI?.choose}><Upload size={17} />导入音频文件</button> : <div className="empty-actions"><button className="button button-accent" disabled={!project || project.busy} onClick={() => void project?.open('create')}>新建项目</button><button className="button" disabled={!project || project.busy} onClick={() => void project?.open('open')}>打开项目…</button></div>}
            <div className="format-list"><span>WAV</span><span>FLAC</span><span>MP3</span></div>
          </div>
        </div>}

        <TransportBar key={project?.active?.collaboration?.runtimeNonce ?? project?.active?.path ?? ''} ui={playback} hasSelection={!!selection.selection && selection.selection.region.mediaId === playback.sourceId} hasMasks={!!doc?.edits.some(e => e.region.mediaId === playback.sourceId && e.operation.type === 'mask')}
          onGain={trigger => { const target = selection.state.getActiveSelection(); if (target && target.region.mediaId === playback.sourceId) selection.openGain(target, trigger); }}
          onResetView={() => { const m = playback.media; if (m) workspace.patch(m.id, { startSeconds: 0, endSeconds: m.frameCount / m.sampleRate, lowHz: 0, highHz: m.sampleRate / 2 }); }}
          onResetMasks={() => { if (playback.sourceId) masks.command({ type: 'resetMediaMasks', mediaId: playback.sourceId }); }} />
      </main>

      {propertiesOpen && <aside id="properties-panel" className="properties-panel panel" aria-label="属性">
        <div className="panel-heading"><h2><Settings2 size={16} />标注与属性</h2><span className="subtle-label">{doc?.annotations.length ?? 0} 个区域</span></div>
        <div className={`inspector-tabs${collaboration?.controller ? ' is-shared' : ''}`} role="tablist" aria-label="属性分区">{[['region', '区域'], ['list', '列表'], ['notes', '文件/通道'], ...(collaboration?.controller ? [['authors', '作者']] : []), ['categories', '类别'], ['masks', '处理'], ['mix', '混合'], ['devices', '设备']].map(([id, label]) => <button role="tab" aria-selected={inspectorTab === id} key={id} onClick={() => setInspectorTab(id)}>{label}</button>)}</div>
        <div className="property-section inspector-content">
          {inspectorTab === 'authors' && collaboration && <RemoteList ui={collaboration} inspect={remote.inspect} />}
          {inspectorTab === 'region' && <AnnotationInspector ui={annotations} annotation={selectedAnnotation} />}
          {inspectorTab === 'list' && doc && <AnnotationList doc={doc} selectedId={annotations.selectedId} onLocate={async result => {
            if(!await workspace.revealMedia(result.mediaId))return;
            if (result.mediaId !== selected?.id && result.mediaId !== workspace.state.compareMediaId) workspace.selectPane('primary', result.mediaId);
            if (result.scope === 'region') { annotations.select(result.annotation.id); workspace.locate(result.annotation.region); setInspectorTab('region'); }
            else { selection.state.select(null); const channelIndex = result.scope === 'channel' ? result.channelIndex : null; if (channelIndex !== null) workspace.patch(result.mediaId, { visibleChannels: [...new Set([...workspace.view(result.mediaId).visibleChannels, channelIndex])].sort((a, b) => a - b) }); selection.state.interact({ mediaId: result.mediaId, channelIndex }); setInspectorTab('notes'); }
          }} />}
          {inspectorTab === 'notes' && <NotesEditor ui={annotations} media={doc?.media.find(m => m.id === selection.context?.mediaId) ?? selected ?? null} channelIndex={selection.context?.channelIndex ?? null} />}
          {inspectorTab === 'masks' && <EditList ui={masks} onLocate={async edit => { if(!await workspace.revealMedia(edit.region.mediaId))return; if (edit.region.mediaId !== selected?.id && edit.region.mediaId !== workspace.state.compareMediaId) workspace.selectPane('primary', edit.region.mediaId); workspace.locate(edit.region); }} />}
          {inspectorTab === 'mix' && playback.media && <ChannelMixer media={playback.media} mix={playback.mix} disabled={project?.active?.store.editingDisabled ?? true} onChange={playback.updateMix} />}
          {inspectorTab === 'devices' && <TransportDevices ui={playback} />}
          {inspectorTab === 'categories' && <CategoryManager key={project?.active?.collaboration?.runtimeNonce ?? project?.active?.path} ui={annotations} />}
        </div>

      </aside>}
    </div>

    <RegionGainDialog ui={selection} />
    {mediaUI?.folder?.state === 'choosing' && <FolderImportDialog controller={mediaUI.folder} />}
    {mediaUI?.source?.open && <SourceImportDialog controller={mediaUI.source} organization={mediaUI.organization} />}
    {helpTopic && <HelpDialog topic={helpTopic} onClose={() => setHelpTopic(null)} />}
    <RegionMenu ui={selection} playback={playback} workspace={workspace} statuses={mediaUI?.statuses ?? []} focusNote={focusNote} />
    {remote.selected && <RemoteInspector target={remote.selected} value={remote.value} close={remote.close} play={remote.play} locate={remote.locate} />}
  </div></PlaybackContext.Provider></MaskContext.Provider></AnnotationContext.Provider></SelectionContext.Provider></RemoteContext.Provider>;
}
