import { Play, Pause, Square, Repeat2, Volume2 } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Menu } from '../../components/menu/Menu';
import { MonitorGainControl } from './MonitorGainControl';
import type { PlaybackUI } from './usePlayback';
import { PlaybackModeControl } from './PlaybackMode';

const time = (seconds: number) => `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toFixed(3).padStart(6, '0')}`;
type Props = {
  ui: PlaybackUI;
  onGain?: (trigger: HTMLElement | null) => void;
  onResetView?: () => void;
  onResetMasks?: () => void;
  hasMasks?: boolean;
  hasSelection?: boolean;
};
export function TransportBar({ ui, onGain, onResetView, onResetMasks, hasMasks = false, hasSelection = false }: Props) {
  const host = useRef<HTMLElement>(null), latest = useRef(ui);
  latest.current = ui;
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = host.current;
    if (!element) return;
    const observer = new ResizeObserver(entries => setWidth(entries[0].contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const [menu, setMenu] = useState<{ x: number; y: number; trigger: HTMLElement; owner: PlaybackUI['active']; sourceId: string | null } | null>(null);
  useEffect(() => setMenu(null), [ui.active, ui.sourceId]);
  const valid = () => latest.current.active === ui.active && latest.current.sourceId === ui.sourceId && !ui.active?.store.editingDisabled;
  const validMenu = menu && menu.owner === ui.active && menu.sourceId === ui.sourceId && !ui.active?.store.editingDisabled ? menu : null;
  const disabled = !ui.media || !ui.active || ui.active.store.editingDisabled;
  const status = ui.status, duration = ui.media ? ui.media.frameCount / ui.media.sampleRate : 0;
  return <footer ref={host} className="playback-bar transport-live" aria-label="播放控制" title={`播放源：${ui.media?.displayName ?? '未选择'}`} data-density={width <= 460 ? 'minimal' : width <= 680 ? 'compact' : 'full'}>
    <div className="transport-main">
      <div className="transport-controls">
        <button className="icon-button" aria-label="停止" disabled={disabled} onClick={ui.stop}><Square size={17} /></button>
        <button className="icon-button play-button" aria-label={ui.playing ? '暂停 · 空格' : '播放 · 空格'} disabled={disabled} onClick={ui.toggle}>{ui.playing ? <Pause size={20} /> : <Play size={20} />}</button>
        <button className="icon-button" aria-label="循环播放" aria-pressed={ui.options.looping} disabled={disabled} onClick={() => ui.update({ looping: !ui.options.looping })}><Repeat2 size={17} /></button>
      </div>
      <div className="playback-clock"><span>{time(status.positionSeconds)}</span><small>/ {time(duration)}</small></div>
      {width > 680 && <div className="playback-position">
        <input type="range" aria-label="播放位置" min={ui.selection ? status.firstSeconds : 0} max={ui.selection ? status.endSeconds || duration : duration} step="0.001" value={status.positionSeconds} disabled={disabled} onChange={e => ui.seek(Number(e.target.value))} />
        <span>{({ stopped: '已停止', buffering: '准备音频…', playing: '播放中', paused: '已暂停', ended: '播放结束', error: '输出失败' } as const)[status.state]}</span>
      </div>}
      {width > 900 && <span className="transport-source" title={ui.media?.displayName}>{ui.media?.displayName}</span>}
      {width > 460 && <>
        <PlaybackModeControl source={ui.workspaceSource} disabled={disabled} onChange={ui.updateWorkspaceSource} />
        <Volume2 className="transport-volume-icon" size={16} />
        <input className="volume-slider" type="range" min="0" max="1" step=".01" aria-label="播放音量" value={ui.options.volume} disabled={disabled} onChange={e => ui.update({ volume: Number(e.target.value) })} />
      </>}
      <MonitorGainControl ui={ui} />
      {width > 900 && <button className="button button-quiet transport-gain" aria-label="应用区域增益" disabled={disabled || !hasSelection} onClick={e => onGain?.(e.currentTarget)}>区域增益</button>}
      <button className="button button-quiet" aria-label="更多播放操作" aria-haspopup="menu" aria-expanded={!!validMenu} disabled={disabled} onClick={e => {
        const bounds = e.currentTarget.getBoundingClientRect();
        setMenu({ x: bounds.left, y: bounds.top, trigger: e.currentTarget, owner: ui.active, sourceId: ui.sourceId });
      }}>•••</button>
    </div>
    {validMenu && <Menu anchor={validMenu} returnFocus={validMenu.trigger} onClose={() => setMenu(null)} items={[
      { id: 'sound', label: '声音版本', disabled, children: ([{ id: 'original', label: '原音' }, { id: 'processed', label: '暂存编辑' }] as const).map(source => ({ ...source, checked: ui.workspaceSource === source.id, action: () => { if (valid()) ui.updateWorkspaceSource(source.id); } })) },
      { id: 'source', label: '播放源', disabled, children: ui.active?.store.snapshot.document.media.map(media => ({ id: media.id, label: media.displayName, checked: ui.sourceId === media.id, action: () => { if (valid()) ui.selectSource(media.id); } })) },
      { id: 'gain', label: '区域增益…', disabled: disabled || !hasSelection, action: trigger => { if (valid()) onGain?.(trigger ?? null); } },
      { id: 'view', label: '重置视图', disabled, action: () => { if (valid()) onResetView?.(); } },
      { id: 'masks', label: '重置屏蔽', disabled: disabled || !hasMasks, action: () => { if (valid()) onResetMasks?.(); } },
    ]} />}
    {ui.error && <div className="playback-error" role="alert">{ui.error.message}<button className="button" onClick={ui.retry}>重试播放</button></div>}
  </footer>;
}
export function TransportDevices({ ui }: { ui: PlaybackUI }) {
  const status = ui.status;
  return <div className="transport-detail">
    <label>播放源<select aria-label="播放源" disabled={!ui.active || ui.active.store.editingDisabled} value={ui.sourceId ?? ''} onChange={e => ui.selectSource(e.target.value)}><option value="" disabled>未选择播放源</option>{ui.active?.store.snapshot.document.media.map(media => <option key={media.id} value={media.id}>{media.displayName}</option>)}</select></label>
    <label>设备<select aria-label="输出设备" disabled={!ui.active || ui.active.store.editingDisabled} value={ui.options.deviceId ?? ''} onChange={e => ui.update({ deviceId: e.target.value || null })}><option value="">系统默认</option>{ui.devices.map(device => <option key={device.id} value={device.id}>{device.name}</option>)}</select></label>
    <button className="text-button" disabled={!ui.active || ui.active.store.editingDisabled} onClick={ui.refreshDevices}>刷新设备</button>
    <span className="playback-counters">{status.deviceRate ? `${status.deviceRate} Hz · ` : ''}已提交 {status.consumedFrames} 帧 · 欠载 {status.underrunFrames}</span>
    {ui.selection && <span>通道 {ui.selection.channelIndex + 1} · {ui.selection.startSeconds.toFixed(3)}–{ui.selection.endSeconds.toFixed(3)} 秒 · {Math.round(ui.selection.lowHz)}–{Math.round(ui.selection.highHz)} Hz</span>}
  </div>;
}
