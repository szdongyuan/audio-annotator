import { useEffect, useState, type ButtonHTMLAttributes } from 'react';
import { PlaybackContext, usePlayback } from '../features/playback/usePlayback';
import { MaskContext, useMasks } from '../features/playback/useMasks';
import { TransportBar } from '../features/playback/TransportBar';
import { ChannelMixer } from '../features/playback/ChannelMixer';
import { EditList } from '../features/playback/EditList';
import { ProjectActions } from '../features/project/ProjectActions';
import { SaveIndicator } from '../features/project/SaveIndicator';
import type { ProjectLifecycleUI } from '../features/project/useProjectLifecycle';
import type { MediaUI } from '../features/media/useMedia';
import { MediaList, statusLabel } from '../features/media/MediaList';
import { ImportProgress } from '../features/media/ImportProgress';
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
import {
  AudioLines, CircleHelp, FolderOpen,
  PanelLeftClose,
  PanelLeftOpen, PanelRightClose, PanelRightOpen, Plus,
  Save, ScanLine, Settings2, ShieldCheck, SlidersHorizontal,
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

export function AppShell({ project, mediaUI, exchange }: { project?: ProjectLifecycleUI; mediaUI?: MediaUI; exchange?: ExchangeUI }) {
  const [mediaOpen, setMediaOpen] = useState(true);
  const [propertiesOpen, setPropertiesOpen] = useState(true);
  const selected = mediaUI?.selected;
  const workspace = useWorkspace(project?.active ?? null, selected?.id ?? null);
  const [settingsId, setSettingsId] = useState<string | null>(null);
  const annotations = useAnnotations(project?.active ?? null);
  const [inspectorTab, setInspectorTab] = useState('region');
  const doc = project?.active?.store.snapshot.document;
  const selectedAnnotation = doc?.annotations.find(a => a.id === annotations.selectedId);
  const masks = useMasks(project?.active ?? null);
  const selectedEdit = doc?.edits.find(e => e.id === masks.selectedId);
  const playback = usePlayback(project?.active ?? null, selected?.id ?? null, selectedEdit?.region ?? selectedAnnotation?.region);
  useEffect(() => { if (masks.selectedId) setInspectorTab('masks'); }, [masks.selectedId]);
  const selectedStatus = mediaUI?.statuses.find(s => s.mediaId === selected?.id)?.status ?? 'unverified';

  return <AnnotationContext.Provider value={annotations}><MaskContext.Provider value={masks}><PlaybackContext.Provider value={playback}><div className="app-shell">
    <header className="project-header">
      <div className="brand" aria-label="音频标注 Audio Annotator">
        <span className="brand-mark"><AudioLines size={23} aria-hidden="true" /></span>
        <div><strong>音频标注</strong><span className="brand-caption">AUDIO ANNOTATOR</span></div>
      </div>
      <span className="header-divider" />
      <div className="project-identity" title={project?.active?.path}><span>{project?.active?.store.snapshot.document.name ?? '尚未打开项目'}</span>{project?.active ? <SaveIndicator lifecycle={project.active.lifecycle} /> : <span className="status-label"><i />本地工作区</span>}</div>
      {project ? <ProjectActions project={project} onImport={mediaUI?.choose} importDisabled={mediaUI?.disabled} exchange={exchange} /> : <nav className="project-actions" aria-label="项目操作">
        <button className="button button-quiet" disabled title="项目打开功能将在项目服务接入后可用"><FolderOpen size={16} />打开项目</button>
        <button className="button button-quiet" disabled title="没有可保存的项目"><Save size={16} />保存<span className="key-hint">Ctrl S</span></button>
        <span className="header-divider" />
        <button className="button button-accent" disabled title="音频导入功能尚未接入"><Plus size={16} />导入音频</button>
      </nav>}
    </header>

    <div className="workspace-toolbar" role="toolbar" aria-label="工作区工具">
      <div className="toolbar-group">
        <IconButton icon={mediaOpen ? PanelLeftClose : PanelLeftOpen} label={mediaOpen ? '收起音频列表' : '展开音频列表'}
          aria-expanded={mediaOpen} aria-controls="media-panel" onClick={() => setMediaOpen(!mediaOpen)} />
        <span className="toolbar-divider" />
        <div className="segmented-control" aria-label="工作区模式">
          <button className={`segment ${!workspace.state.compareMediaId ? 'is-current' : ''}`} disabled={!selected || project?.active?.store.editingDisabled} onClick={() => workspace.compare(null)}><Square size={14} />单文件</button>
          <button className={`segment ${workspace.state.compareMediaId ? 'is-current' : ''}`} disabled={(project?.active?.store.snapshot.document.media.length ?? 0) < 2 || project?.active?.store.editingDisabled} onClick={() => workspace.compare(project?.active?.store.snapshot.document.media.find(m => m.id !== selected?.id)?.id ?? null)}><ScanLine size={14} />双文件对比</button>
        </div>
      </div>
      <AnnotationTools ui={annotations} />
      <div className="toolbar-group toolbar-end">
        <button className="button button-quiet analysis-settings" disabled={!selected || project?.active?.store.editingDisabled} onClick={() => setSettingsId(settingsId ? null : selected?.id ?? null)}><SlidersHorizontal size={16} /><span>分析设置</span></button>
        <span className="toolbar-divider" />
        <IconButton icon={propertiesOpen ? PanelRightClose : PanelRightOpen} label={propertiesOpen ? '收起属性面板' : '展开属性面板'}
          aria-expanded={propertiesOpen} aria-controls="properties-panel" onClick={() => setPropertiesOpen(!propertiesOpen)} />
      </div>
    </div>

    <div className="workspace">
      {mediaOpen && <aside id="media-panel" className="media-panel panel" aria-label="音频列表">
        <MediaList media={project?.active?.store.snapshot.document.media ?? []} annotations={project?.active?.store.snapshot.document.annotations ?? []} statuses={mediaUI?.statuses ?? []} selectedId={mediaUI?.selectedId ?? null} disabled={mediaUI?.disabled ?? true} onSelect={id => mediaUI?.setSelectedId(id)} onImport={() => mediaUI?.choose()} onRelink={media => mediaUI?.setRelink(media)} />
      </aside>}

      <main className="analysis-workspace" aria-label="音频分析工作区">
        <div className="analysis-heading"><div><span className="workspace-dot" /><h1>分析工作区</h1></div><span className="small-caption">SPECTRAL WORKSPACE</span></div>
        {mediaUI?.error && <p className="media-error" role="alert">{mediaUI.error.message}</p>}
        {mediaUI?.controller && <ImportProgress controller={mediaUI.controller} />}
        {mediaUI && <MediaAssociation active={project?.active ?? null} media={mediaUI} />}
        <AnnotationFailure ui={annotations} />
        {annotations.tool === 'mask' && <p className="tool-notice">屏蔽工具 · 拖出矩形创建暂存屏蔽，切换“处理后”试听效果。</p>}
        {selected && project?.active && mediaUI ? <CompareWorkspace active={project.active} mediaUI={mediaUI} workspace={workspace} settingsId={settingsId} setSettingsId={setSettingsId} /> : <div className="empty-workspace">
          <div className="empty-content">
            <div className="audio-emblem" aria-hidden="true"><AudioLines size={46} strokeWidth={1.25} /><span /></div>
            <span className="eyebrow">从一段声音开始</span>
            <h2>让声音的细节，清晰可见。</h2>
            <p className="empty-description">在频谱中观察、对比与标注音频。<br />每一个通道，每一处值得记录的细节。</p>
            <button className="button button-accent import-button" disabled={mediaUI?.disabled ?? true} onClick={mediaUI?.choose} aria-describedby="foundation-status"><Upload size={17} />导入音频文件</button>
            <div className="format-list" aria-label="计划支持的音频格式"><span>WAV</span><span>FLAC</span><span>MP3</span><i />最多 6 通道</div>
            <p id="foundation-status" className="foundation-status">{project?.active ? '原始文件只读 · 自动保存项目' : '新建或打开项目后即可导入音频'}</p>
          </div>
          <div className="workflow-guide" aria-label="工作流程">
            <div><span className="step-number">01</span><span><strong>导入音频</strong><small>保留原始音频，独立管理通道</small></span></div>
            <div><span className="step-number">02</span><span><strong>观察频谱</strong><small>聚焦细节，对比不同声音</small></span></div>
            <div><span className="step-number">03</span><span><strong>标注与分享</strong><small>记录区域、类别与备注</small></span></div>
          </div>
        </div>}
        <div className="workspace-status"><span><span className="tiny-dot" />{selected ? `${selected.channelCount} 通道 · ${statusLabel[selectedStatus]}` : '等待导入音频'}</span><span><ShieldCheck size={13} />原始文件保持只读</span></div>
      </main>

      {propertiesOpen && <aside id="properties-panel" className="properties-panel panel" aria-label="属性">
        <div className="panel-heading"><h2><Settings2 size={16} />标注与属性</h2><span className="subtle-label">{doc?.annotations.length ?? 0} 个区域</span></div>
        <div className="inspector-tabs" role="tablist" aria-label="属性分区">{[['region', '区域'], ['list', '列表'], ['notes', '备注'], ['categories', '类别'], ['masks', '屏蔽'], ['mix', '混合']].map(([id, label]) => <button role="tab" aria-selected={inspectorTab === id} key={id} onClick={() => setInspectorTab(id)}>{label}</button>)}</div>
        <div className="property-section inspector-content">
          {inspectorTab === 'region' && <AnnotationInspector ui={annotations} annotation={selectedAnnotation} />}
          {inspectorTab === 'list' && doc && <AnnotationList doc={doc} selectedId={annotations.selectedId} onLocate={a => { masks.select(null); annotations.select(a.id); annotations.setTool('select'); if (a.region.mediaId !== selected?.id && a.region.mediaId !== workspace.state.compareMediaId) mediaUI?.setSelectedId(a.region.mediaId); workspace.locate(a.region); setInspectorTab('region'); }} />}
          {inspectorTab === 'notes' && <NotesEditor ui={annotations} media={selected ?? null} />}
          {inspectorTab === 'masks' && <EditList ui={masks} onLocate={edit => { annotations.select(null); masks.select(edit.id); annotations.setTool('select'); if (edit.region.mediaId !== selected?.id && edit.region.mediaId !== workspace.state.compareMediaId) mediaUI?.setSelectedId(edit.region.mediaId); workspace.locate(edit.region); }} />}
          {inspectorTab === 'mix' && playback.media && <ChannelMixer media={playback.media} mix={playback.mix} disabled={project?.active?.store.editingDisabled ?? true} onChange={playback.updateMix} />}
          {inspectorTab === 'categories' && <CategoryManager ui={annotations} />}
        </div>
        <div className="inspector-tip"><CircleHelp size={15} /><p>标注以时间和频率保存，<br />不随频谱显示参数改变。</p></div>
      </aside>}
    </div>

    <TransportBar ui={playback} />
  </div></PlaybackContext.Provider></MaskContext.Provider></AnnotationContext.Provider>;
}
