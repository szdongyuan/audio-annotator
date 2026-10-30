import { InspectionViewer } from '../features/inspection/InspectionViewer';
import { isResetViewShortcut } from '../features/spectrogram/viewShortcut';
import { inspectionBinding, inspectionTargetKey, resolveOwnInspection, type OwnInspectionTarget } from '../features/inspection/targets';
import type { Region } from '../bridge/types';
import { normalizeError } from '../bridge/client';
import { reconcileContext } from '../features/annotations/classification';
import type { ClassificationResult } from '../features/annotations/classification';
import type { IdentityController } from '../features/identity/controller';
import { CollaborationStatus } from '../features/collaboration/CollaborationStatus';
import { RemoteContext, resolveRemote, useRemoteInspection, type RemoteTarget } from '../features/collaboration/remote';
import { RemoteList } from '../features/collaboration/RemoteInspector';
import type { CollaborationUI } from '../features/collaboration/useCollaboration';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ButtonHTMLAttributes } from 'react';
import { PlaybackContext, usePlayback } from '../features/playback/usePlayback';
import { MaskContext, useMasks } from '../features/playback/useMasks';
import { AppMenu } from './AppMenu';
import { ListNavigation } from './listNavigation';
import { validRegion } from '../features/selection/state';
import { workspaceMenus } from './WorkspaceActions';
import { HelpDialog, type HelpTopic } from './HelpDialog';
import { RegionGainDialog } from '../features/playback/RegionGainDialog';
import { GlobalSettings } from '../features/settings/GlobalSettings';
import { useLocalSettings } from '../features/settings/localSettings';
import { TransportBar } from '../features/playback/TransportBar';
import { DeviceDialog } from '../features/playback/DeviceDialog';
import { ExampleLibrary } from '../features/examples/ExampleLibrary';
import { ChannelMixer } from '../features/playback/ChannelMixer';
import { EditList } from '../features/playback/EditList';
import { ProjectActions } from '../features/project/ProjectActions';
import { SaveIndicator } from '../features/project/SaveIndicator';
import { useSessionUI } from '../features/project/useSessionUI';
import type { ProjectLifecycleUI } from '../features/project/useProjectLifecycle';
import type { MediaUI } from '../features/media/useMedia';
import { useRecycle } from '../features/media/useRecycle';
import { MediaList } from '../features/media/MediaList';
import { MediaPanelResize, useMediaPanelWidth } from '../features/media/MediaPanelResize';
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
import { useAnnotationListFilters } from '../features/annotations/listFilters';
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
  const localSettings = useLocalSettings();
  const [globalSettingsOpen,setGlobalSettingsOpen] = useState(false);
  const [mediaOpen, setMediaOpen] = useState(true);
  const [propertiesOpen, setPropertiesOpen] = useState(true);
  const [listNavigation] = useState(() => new ListNavigation());
  const workspaceHost = useRef<HTMLDivElement>(null);
  const hiddenMediaIds=collaboration?.controller?.status?.hiddenMediaIds??project?.active?.collaboration?.hiddenMediaIds??[];
  const recycle = useRecycle(project?.active ?? null, collaboration?.controller?.status);
  const trashedMediaIds = recycle?.snapshot?.trashed.map(m=>m.mediaId) ?? [];
  const excludedMediaIds = [...new Set([...hiddenMediaIds,...trashedMediaIds])];
  const projectWorkspace = useWorkspace(project?.active ?? null,excludedMediaIds,collaboration?async id=>{if(trashedMediaIds.includes(id))throw new Error('请先从回收站恢复音频');await collaboration.hideMedia(id,false);}:undefined);
  // Explicit workspace navigation supersedes pending list work even when context
  // remains in the other pane. List completion uses projectWorkspace directly.
  const workspace = {
    ...projectWorkspace,
    revealMedia: (...args: Parameters<typeof projectWorkspace.revealMedia>) => { listNavigation.cancel(); return projectWorkspace.revealMedia(...args); },
    selectPane: (...args: Parameters<typeof projectWorkspace.selectPane>) => { listNavigation.cancel(); return projectWorkspace.selectPane(...args); },
    compare: (...args: Parameters<typeof projectWorkspace.compare>) => { listNavigation.cancel(); return projectWorkspace.compare(...args); },
    patch: (...args: Parameters<typeof projectWorkspace.patch>) => { listNavigation.cancel(); return projectWorkspace.patch(...args); },
    locate: (...args: Parameters<typeof projectWorkspace.locate>) => { listNavigation.cancel(); return projectWorkspace.locate(...args); },
  };
  const mediaPanel = useMediaPanelWidth(workspaceHost, propertiesOpen, !!workspace.state.compareMediaId && workspace.state.compareLayout === 'horizontal');
  const selected = project?.active?.store.snapshot.document.media.find(m => m.id === workspace.state.activeMediaId);
  useEffect(() => {
    const reset = (event: KeyboardEvent) => {
      if (event.defaultPrevented || document.querySelector('[role=dialog],[role=alertdialog],[data-app-menu]') || !isResetViewShortcut(event) || project?.active?.store.editingDisabled) return;
      const media = project?.active?.store.snapshot.document.media.find(m => m.id === (selection.context?.mediaId ?? workspace.state.activeMediaId));
      if (media) { event.preventDefault(); workspace.patch(media.id, { startSeconds: 0, endSeconds: media.frameCount / media.sampleRate, lowHz: 0, highHz: media.sampleRate / 2 }); }
    };
    window.addEventListener('keydown', reset); return () => window.removeEventListener('keydown', reset);
  });
  const [settingsId, setSettingsId] = useState<string | null>(null);
  const panes = [selected?.id, workspace.state.compareMediaId].filter((id): id is string => !!id && !!project?.active?.store.snapshot.document.media.some(m => m.id === id)).map(mediaId => ({ mediaId, channels: workspace.view(mediaId).visibleChannels }));
  const selection = useSelection(project?.active ?? null, selected?.id ?? null, panes);
  useEffect(() => { setSettingsId(null); }, [project?.active]);
  useEffect(() => { if (settingsId && !panes.some(p => p.mediaId === settingsId)) setSettingsId(null); }, [settingsId, workspace.state.activeMediaId, workspace.state.compareMediaId, project?.active?.store.snapshot.document.media]);
  const annotations = useAnnotations(project?.active ?? null, selection);
  const [inspectorTab, setInspectorTab] = useState('region');
  const doc = project?.active?.store.snapshot.document;
  const authorId = project?.active?.collaboration?.actor?.authorId ?? identity?.selected?.authorId ?? null;
  const mediaNavigationScope = useMemo(() => ({}), [project?.active, authorId]);
  const listFilters = useAnnotationListFilters(doc, authorId);
  const navigationScope = { owner: project?.active ?? null, authorId, runtimeNonce: project?.active?.collaboration?.runtimeNonce ?? identity?.snapshot?.runtimeNonce, state: selection.state };
  const latestNavigation = useRef({ scope: navigationScope, workspace: projectWorkspace, collaboration });
  latestNavigation.current = { scope: navigationScope, workspace: projectWorkspace, collaboration };
  const selectionIntent = useSyncExternalStore(selection.state.subscribe, () => selection.state.intentVersion);
  // Cancel at gesture start, before the first onView patch, and keep the
  // request cancelled after the gesture ends.
  useEffect(() => selection.state.subscribe(() => { if (selection.state.getGesture()) listNavigation.cancel(); }), [selection.state, listNavigation]);
  useEffect(() => { listNavigation.cancel(); return () => listNavigation.cancel(); }, [listNavigation, project?.active, authorId, navigationScope.runtimeNonce, selection.state]);
  const openInspector = (tab: string) => { listNavigation.cancel(); setInspectorTab(tab); };
  const selectedAnnotation = doc?.annotations.find(a => a.id === annotations.selectedId);
  const masks = useMasks(project?.active ?? null, selection);
  const playback = usePlayback(project?.active ?? null, selected?.id ?? null, selection.selection?.region);
  useEffect(()=>{if(playback.sourceId && excludedMediaIds.includes(playback.sourceId)){playback.stop();playback.selectSource(workspace.state.activeMediaId ?? workspace.state.compareMediaId ?? null);}},[excludedMediaIds.join('|'),playback.sourceId,workspace.state.activeMediaId,workspace.state.compareMediaId]);
  const remote = useRemoteInspection(collaboration, workspace, playback);
  const [ownInspection, setOwnInspection] = useState<{ target: OwnInspectionTarget; result: ClassificationResult } | null>(null);
  const inspectRemote: typeof remote.inspect = target => { listNavigation.cancel(); setOwnInspection(null); remote.inspect(target); };
  const inspection = ownInspection?.target.owner === project?.active ? ownInspection : null;
  const runtime = project?.active ? inspectionBinding(project.active, identity?.snapshot?.runtimeNonce) : null;
  const inspectionActor = `${runtime?.runtimeNonce}:${authorId}`;
  useEffect(() => { setOwnInspection(null); remote.close(); }, [project?.active, inspectionActor]);
  type NavigationTarget = { region?: Region; channelIndex?: number | null; own: boolean; annotationId?: string };
  const navigateList = async (mediaId: string, resolve: () => NavigationTarget | null) => {
    const owner = project?.active;
    if (!owner || owner.store.editingDisabled) return false;
    const request = listNavigation.begin(navigationScope, mediaId);
    try {
      const revealed = await projectWorkspace.revealMedia(mediaId);
      const latest = latestNavigation.current;
      if (!revealed || owner.store.editingDisabled || !listNavigation.current(request, latest.scope)) return false;
      const target = resolve(), currentDoc = owner.store.snapshot.document;
      const media = currentDoc.media.find(m => m.id === mediaId);
      if (!target || !media || target.region && (!validRegion(currentDoc, target.region) || target.region.mediaId !== mediaId)) return false;
      const channelIndex = target.region?.channelIndex ?? target.channelIndex;
      if (channelIndex != null && (!Number.isInteger(channelIndex) || channelIndex < 0 || channelIndex >= media.channelCount)) return false;
      const currentWorkspace = latest.workspace, state = latest.scope.state;
      const replacesPrimary = mediaId !== currentWorkspace.state.activeMediaId && mediaId !== currentWorkspace.state.compareMediaId;
      if (replacesPrimary && !currentWorkspace.selectPane('primary', mediaId)) return false;
      let channels = currentWorkspace.view(mediaId).visibleChannels;
      if (target.region) {
        currentWorkspace.locate(target.region);
        channels = [target.region.channelIndex];
      } else if (channelIndex != null) {
        channels = [...new Set([...channels, channelIndex])].sort((a, b) => a - b);
        currentWorkspace.patch(mediaId, { visibleChannels: channels });
      }
      if (target.own) {
        state.endGesture();
        state.select(target.region && target.annotationId ? { region: target.region, object: { kind: 'annotation', id: target.annotationId } } : null);
        if (!target.region) state.interact({ mediaId, channelIndex: channelIndex ?? null });
      }
      // Reconcile the panes produced by this action before capturing protection.
      // React's useSelection effect will then observe the same stable state.
      const panes = [replacesPrimary ? mediaId : currentWorkspace.state.activeMediaId, currentWorkspace.state.compareMediaId]
        .filter((id): id is string => !!id && currentDoc.media.some(m => m.id === id))
        .map(id => ({ mediaId: id, channels: id === mediaId ? channels : currentWorkspace.view(id).visibleChannels }));
      const candidate = state.getCandidate();
      if (candidate && !panes.some(p => p.mediaId === candidate.region.mediaId && p.channels.includes(candidate.region.channelIndex))) {
        state.endGesture(); state.select(null);
      }
      state.interact(reconcileContext(currentDoc, state.getContext(), panes));
      listNavigation.applied(request, latest.scope);
      return true;
    } finally {
      // Also release requests if the external reveal boundary rejects. The caller
      // remains responsible for presenting that error to the user.
      listNavigation.finish(request);
    }
  };
  const locateList = (result: ClassificationResult) => navigateList(result.mediaId, () => {
    if (result.scope !== 'region') return { own: true, channelIndex: result.scope === 'channel' ? result.channelIndex : null };
    const annotation = project?.active?.store.snapshot.document.annotations.find(a => a.id === result.annotation.id);
    return annotation ? { own: true, region: annotation.region, annotationId: annotation.id } : null;
  });
  const locateRemote = (target: RemoteTarget) => {
    const before = resolveRemote(latestNavigation.current.collaboration, target);
    if (!before) return Promise.resolve(false);
    return navigateList(before.media.id, () => {
      const value = resolveRemote(latestNavigation.current.collaboration, target);
      return value && value.media.id === before.media.id ? { own: false, region: value.annotation?.region, channelIndex: value.channelIndex } : null;
    });
  };
  const locateProcessing = (id: string, mediaId: string) => {
    const owner = project?.active;
    void navigateList(mediaId, () => {
      const edit = owner?.store.snapshot.document.edits.find(edit => edit.id === id);
      return edit ? { own: false, region: edit.region } : null;
    }).catch(error => owner?.store.setError(normalizeError(error)));
  };
  const [noteFocusId, setNoteFocusId] = useState<string | null>(null);
  useEffect(() => { setNoteFocusId(null); setInspectorTab('region'); }, [project?.active]);
  useEffect(() => { if (noteFocusId && selectedAnnotation?.id === noteFocusId && propertiesOpen && inspectorTab === 'region') { document.querySelector<HTMLTextAreaElement>('[aria-label="区域备注"]')?.focus(); setNoteFocusId(null); } }, [noteFocusId, selectedAnnotation?.id, propertiesOpen, inspectorTab]);
  useEffect(() => { if (masks.selectedId && !listNavigation.suppresses(navigationScope)) setInspectorTab('masks'); }, [masks.selectedId, selectionIntent]);
  useEffect(() => { if (annotations.selectedId && !listNavigation.suppresses(navigationScope)) setInspectorTab('region'); }, [annotations.selectedId, selectionIntent]);
  useEffect(() => { if (selection.context && !selection.selection && !listNavigation.suppresses(navigationScope)) setInspectorTab('notes'); }, [selection.context, selection.selection, selectionIntent]);
  useSessionUI(project, { inspectorTab, mediaOpen, propertiesOpen, cues: playback.cues }, ui => { setInspectorTab(ui.inspectorTab); setMediaOpen(ui.mediaOpen); setPropertiesOpen(ui.propertiesOpen); }, playback, excludedMediaIds, (!project?.active?.collaboration || !!recycle?.snapshot) && (!workspace.visibleMedia.length || !!selected && !!selection.context));
  const [helpTopic, setHelpTopic] = useState<HelpTopic | null>(null);
  const [deviceDialog, setDeviceDialog] = useState<{trigger:HTMLElement|null}|null>(null);
  useEffect(()=>setDeviceDialog(null),[project?.active]);
  const focusNote = (id: string) => { setPropertiesOpen(true); openInspector('region'); setNoteFocusId(id); };
  const menus = workspaceMenus({ identity, collaboration, project, mediaUI, exchange, annotations, selection, workspace, playback, mediaOpen, propertiesOpen,
    toggleMedia: () => setMediaOpen(v => !v), toggleProperties: () => setPropertiesOpen(v => !v), settings: setSettingsId, globalSettings:localSettings?()=>{setSettingsId(null);setGlobalSettingsOpen(true);}:undefined,
    inspector: tab => { setPropertiesOpen(true); openInspector(tab); }, devices:trigger=>setDeviceDialog({trigger}), help: setHelpTopic, focusNote });

  return <RemoteContext.Provider value={{...remote,inspect:inspectRemote,locate:locateRemote}}><SelectionContext.Provider value={selection}><AnnotationContext.Provider value={annotations}><MaskContext.Provider value={masks}><PlaybackContext.Provider value={playback}><div className="app-shell">
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
        <button data-global-settings-trigger className="button button-quiet analysis-settings" aria-label="全局播放与显示设置" title="全局播放、显示与分析设置（本机）" disabled={!localSettings || project?.active?.store.editingDisabled} onClick={() => { setSettingsId(null); setGlobalSettingsOpen(!globalSettingsOpen); }}><SlidersHorizontal size={16} /><span>全局设置</span></button>
        <span className="toolbar-divider" />
        <IconButton icon={propertiesOpen ? PanelRightClose : PanelRightOpen} label={propertiesOpen ? '收起属性面板' : '展开属性面板'}
          aria-expanded={propertiesOpen} aria-controls="properties-panel" onClick={() => setPropertiesOpen(!propertiesOpen)} />
      </div>
    </div>

    <div className="workspace" ref={workspaceHost}>
      <aside id="media-panel" className="media-panel panel" aria-label="音频列表" style={{ maxWidth: mediaPanel.maximum, ...(mediaPanel.width === null ? {} : { width: mediaPanel.width }), ...(!mediaOpen ? { display: 'none' } : {}) }}>
        <MediaList navigationScope={mediaNavigationScope} projectId={doc?.projectId} actorId={project?.active?.collaboration?.actor?.authorId ?? null} navigationDisabled={project?.active?.store.editingDisabled ?? true} recycle={recycle} authors={collaboration?.controller?.status?.snapshot?.authors ?? []} onHideBatch={collaboration ? (ids,hidden)=>collaboration.hideMediaBatch(ids,hidden) : undefined} organization={mediaUI?.organization} hiddenMediaIds={hiddenMediaIds} onHide={project?.active?.collaboration?.projectFlavor==='default'?id=>void collaboration?.hideMedia(id,true).catch(()=>{}):undefined} onRestore={id=>void collaboration?.hideMedia(id,false).catch(()=>{})} catalogLocked={project?.active?.collaboration?.canImportMedia===false} navigationExcludedId={workspace.state.compareMediaId} categories={doc?.categories ?? []} media={project?.active?.store.snapshot.document.media ?? []} annotations={project?.active?.store.snapshot.document.annotations ?? []} statuses={mediaUI?.statuses ?? []} selectedId={workspace.state.activeMediaId} disabled={mediaUI?.disabled ?? true} onSelect={(id, intent) => { const accepted = workspace.selectPane('primary', id); if (accepted) { if (intent === 'random' && id === playback.sourceId) playback.stop(); playback.selectSource(id); } return accepted; }} onImport={() => mediaUI?.choose()} onRelink={media => mediaUI?.setRelink(media)} />
      </aside>
      {mediaOpen && <MediaPanelResize width={mediaPanel.width} maximum={mediaPanel.maximum} onPreview={mediaPanel.preview} onCommit={mediaPanel.commit} />}

      <main className="analysis-workspace" aria-label="音频分析工作区">
        <div className="workspace-feedback" aria-label="工作区操作反馈">
          {localSettings?.error && <p role="alert">{localSettings.error}<button className="text-button" onClick={()=>setGlobalSettingsOpen(true)}>打开全局设置</button></p>}
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
          onDevices={trigger=>setDeviceDialog({trigger})}
          onGain={trigger => { const target = selection.state.getActiveSelection(); if (target && target.region.mediaId === playback.sourceId) selection.openGain(target, trigger); }}
          onResetView={() => { const m = playback.media; if (m) workspace.patch(m.id, { startSeconds: 0, endSeconds: m.frameCount / m.sampleRate, lowHz: 0, highHz: m.sampleRate / 2 }); }}
          onResetMasks={() => { if (playback.sourceId) masks.command({ type: 'resetMediaMasks', mediaId: playback.sourceId }); }} />
      </main>

      {propertiesOpen && <aside id="properties-panel" className="properties-panel panel" aria-label="属性">
        <div className="panel-heading"><h2><Settings2 size={16} />标注与属性</h2><span className="subtle-label">{doc?.annotations.length ?? 0} 个区域</span></div>
        <div className={`inspector-tabs${collaboration?.controller ? ' is-shared' : ''}`} role="tablist" aria-label="属性分区">{[['region', '区域'], ['list', '列表'], ['notes', '文件/通道'], ...(collaboration?.controller ? [['authors', '作者']] : []), ['categories', '类别'], ['masks', '处理'], ['mix', '混合'], ['examples', '示例']].map(([id, label]) => <button role="tab" aria-selected={inspectorTab === id} key={id} onClick={() => openInspector(id)}>{label}</button>)}</div>
        <div className="property-section inspector-content">
          {inspectorTab === 'authors' && collaboration && <RemoteList ui={collaboration} inspect={inspectRemote} />}
          {inspectorTab === 'region' && <AnnotationInspector ui={annotations} annotation={selectedAnnotation} />}
          {inspectorTab === 'list' && doc && <AnnotationList doc={doc} selectedId={annotations.selectedId} filterControl={listFilters} onLocate={result => {
            const owner = project?.active;
            if (!owner) return;
            listNavigation.cancel(); remote.close();
            setOwnInspection({ target: result.scope === 'region' ? { owner, scope: 'region', annotationId: result.annotation.id } : result.scope === 'channel' ? { owner, scope: 'channel', mediaId: result.mediaId, channelIndex: result.channelIndex } : { owner, scope: 'file', mediaId: result.mediaId }, result });
          }} />}
          {inspectorTab === 'notes' && <NotesEditor ui={annotations} media={doc?.media.find(m => m.id === selection.context?.mediaId) ?? selected ?? null} channelIndex={selection.context?.channelIndex ?? null} />}
          {inspectorTab === 'masks' && <EditList ui={masks} onLocate={edit => locateProcessing(edit.id, edit.region.mediaId)} />}
          {inspectorTab === 'mix' && playback.media && <ChannelMixer media={playback.media} mix={playback.mix} disabled={project?.active?.store.editingDisabled ?? true} onChange={playback.updateMix} />}
          <ExampleLibrary active={project?.active??null} identity={identity} selected={selected} playback={playback} visible={inspectorTab==='examples'} authors={collaboration?.controller?.status?.snapshot?.authors.map(a=>a.identity)??[]}/>
          {inspectorTab === 'categories' && <CategoryManager key={project?.active?.collaboration?.runtimeNonce ?? project?.active?.path} ui={annotations} />}
        </div>

      </aside>}
    </div>

    <RegionGainDialog ui={selection} />
    {deviceDialog&&<DeviceDialog ui={playback} returnFocus={deviceDialog.trigger} onClose={()=>setDeviceDialog(null)}/>}
    {globalSettingsOpen && localSettings && <GlobalSettings store={localSettings} initialDisplay={selected?workspace.view(selected.id):undefined} initialAnalysis={selected?workspace.analysis(selected.id):undefined} initialPlayback={{monitorGainDb:playback.monitor.monitorGainDb,volume:playback.options.volume,looping:playback.options.looping,source:playback.workspaceSource}} onClose={()=>setGlobalSettingsOpen(false)} />}
    {mediaUI?.folder?.state === 'choosing' && <FolderImportDialog controller={mediaUI.folder} />}
    {mediaUI?.source?.open && <SourceImportDialog controller={mediaUI.source} organization={mediaUI.organization} />}
    {helpTopic && <HelpDialog topic={helpTopic} onClose={() => setHelpTopic(null)} />}
    <RegionMenu ui={selection} playback={playback} workspace={workspace} statuses={mediaUI?.statuses ?? []} focusNote={focusNote} />
    {(inspection || remote.selected) && <InspectionViewer key={`${inspectionActor}:${inspectionTargetKey(inspection?.target ?? remote.selected!)}`} target={inspection?.target ?? remote.selected!} value={inspection ? resolveOwnInspection(inspection.target) : remote.value} binding={runtime} playback={playback} onJumpComplete={() => { setOwnInspection(null); remote.close(); }} onClose={() => { listNavigation.cancel(); setOwnInspection(null); remote.close(); }} onJump={async () => {
      if (inspection) return locateList(inspection.result);
      const target = remote.selected, value = remote.value;
      if (!target || !value) return false;
      if (target.authorId === authorId) return locateList(value.annotation ? { scope: 'region', mediaId: value.media.id, annotation: value.annotation, categoryIds: value.annotation.categoryIds, note: value.note } : value.channelIndex !== undefined ? { scope: 'channel', mediaId: value.media.id, channelIndex: value.channelIndex, categoryIds: [], note: value.note } : { scope: 'file', mediaId: value.media.id, categoryIds: [], note: value.note });
      return locateRemote(target);
    }} />}
  </div></PlaybackContext.Provider></MaskContext.Provider></AnnotationContext.Provider></SelectionContext.Provider></RemoteContext.Provider>;
}
