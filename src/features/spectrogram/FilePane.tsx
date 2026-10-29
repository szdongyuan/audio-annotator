import type { AnalysisSource } from './analysisSource';
import {useMemo,type ReactNode} from 'react';
import { ClassificationControl } from '../annotations/ClassificationControl';
import { useAnnotationContext } from '../annotations/useAnnotations';
import { useSelectionContext } from '../selection/useSelection';
import { usePlaybackContext } from '../playback/usePlayback';
import type { AnalysisSettings, MediaDescriptor, MediaView } from '../../bridge/types';
import type { ActiveProject } from '../project/useProjectLifecycle';
import type { MediaStatus } from '../../bridge/media';
import { ChannelPane } from './ChannelPane';
import type { PanePosition } from './useWorkspace';
import { duration } from './workspace';
export function FilePane({ analysisSource = 'processed', active, media, settings, view, status, timeLimit, onView, onSettings, onRelink, pane, choices, duplicate, onSelect, children }: { analysisSource?: AnalysisSource; active: ActiveProject; media: MediaDescriptor; settings: AnalysisSettings; view: MediaView; status: MediaStatus['status']; timeLimit: number; onView: (v: Partial<MediaView>) => void; onSettings: () => void; onRelink: () => void; pane: PanePosition; choices: MediaDescriptor[]; duplicate: boolean; onSelect: (id: string) => void; children?: ReactNode }) {
  const annotations = useAnnotationContext(), selection = useSelectionContext();
  const playback = usePlaybackContext();
  const choicesList=useMemo(()=>choices.map(choice=><option key={choice.id} value={choice.id}>{choice.displayName}</option>),[choices]);
  const title = <h2 title={media.displayName} tabIndex={0} onFocus={() => { selection?.state.select(null); selection?.state.interact({ mediaId: media.id, channelIndex: null }); }} onClick={() => { selection?.state.select(null); selection?.state.interact({ mediaId: media.id, channelIndex: null }); }}>{media.displayName}</h2>;
  const interact = () => { if (selection && selection.state.getContext()?.mediaId !== media.id) selection.state.interact({ mediaId: media.id, channelIndex: view.visibleChannels[0] ?? null }); };
  const isPaneControl = (target: EventTarget) => target instanceof Element && !!target.closest('[data-pane-control], .analysis-popover');
  const disabled = active.store.editingDisabled;
  const unavailable = status === 'missing' || status === 'changed';
  const retainedSelection = selection?.selection?.region.mediaId === media.id && view.visibleChannels.includes(selection.selection.region.channelIndex);
  return <section data-pane={pane} className={`file-pane ${playback?.sourceId === media.id ? "is-playback-source" : ""} ${duplicate ? "is-duplicate-target" : ""}`} onFocusCapture={e => { if (!(e.target as Element).closest('.analysis-popover')) interact(); }} onPointerDownCapture={e => { if (e.button === 0) { interact(); if (!isPaneControl(e.target)) playback?.selectSource(media.id); } }} aria-label={`${media.displayName} 频谱面板`}>
    <header className="file-heading"><select data-pane-control className="pane-file-select" title={`${media.displayName} · 切换面板音频`} aria-label={pane === 'primary' ? '主面板音频' : '对比面板音频'} value={media.id} disabled={disabled} onChange={e => onSelect(e.target.value)}>{choicesList}</select><div>{annotations ? <ClassificationControl ui={annotations} target={{ mediaId: media.id, channelIndex: null }}>{title}</ClassificationControl> : title}<small>{media.sampleRate / 1000} kHz · {duration(media).toFixed(2)} 秒 · {media.channelCount} 通道</small></div><button className="text-button" title="设为播放源" aria-label={`${media.displayName} 设为播放源`} aria-pressed={playback?.sourceId === media.id} disabled={disabled} onClick={() => playback?.selectSource(media.id)}>▶</button><button data-pane-control data-analysis-trigger={media.id} className="button button-quiet" disabled={disabled} onClick={onSettings} aria-label={`${media.displayName} 分析设置`}>设置</button><span className="pane-duplicate-message" role="status" aria-live="polite">{duplicate ? '该音频已在这一侧显示' : ''}</span></header>
    <div className="file-controls" data-pane-control>{media.channelCount > 1 && <div className="channel-select" aria-label={`${media.displayName} 通道选择`}>{Array.from({ length: media.channelCount }, (_, c) => <label key={c}><input type="checkbox" aria-label={`显示通道 ${c + 1}`} checked={view.visibleChannels.includes(c)} disabled={disabled} onChange={e => onView({ visibleChannels: e.target.checked ? [...view.visibleChannels, c].sort((a, b) => a - b) : view.visibleChannels.filter(v => v !== c) })} /><span>{c + 1}</span></label>)}<button disabled={disabled} onClick={() => onView({ visibleChannels: Array.from({ length: media.channelCount }, (_, i) => i) })}>全部</button></div>}
      <select aria-label={`${media.displayName} 频谱类型`} value={view.spectrumKind} disabled={disabled} onChange={e => onView({ spectrumKind: e.target.value as MediaView['spectrumKind'] })}><option value="stft">STFT 频谱</option><option value="mel">梅尔频谱</option></select>

    </div>
    {unavailable && <div className="spectrum-unavailable"><p>{status === 'missing' ? '音频文件缺失' : '音频源文件已改变'}</p><button className="button" disabled={disabled} onClick={onRelink}>校验 / 重新关联音频</button></div>}{(!unavailable || retainedSelection) && <div className={`channel-scroll ${view.visibleChannels.length === 2 ? 'is-pair' : view.visibleChannels.length === 1 ? 'is-single' : ''}`}>{view.visibleChannels.length ? view.visibleChannels.map(channel => <ChannelPane analysisSource={analysisSource} key={`${media.id}:${channel}`} active={active} media={media} settings={settings} view={view} channel={channel} status={status} timeLimit={timeLimit} onView={onView} />) : <p className="no-channels">选择上方通道以查看频谱</p>}</div>}
    {children}
  </section>;
}
