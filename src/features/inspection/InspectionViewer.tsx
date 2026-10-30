import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import type { AnalysisSettings, MediaView, MediaDescriptor, Region } from '../../bridge/types';
import type { InspectionBinding, InspectionPreview } from '../../bridge/inspection';
import { playbackClient, type PlaybackRequest } from '../../bridge/playback';
import { normalizeError } from '../../bridge/client';
import type { RemoteValue } from '../collaboration/remote';
import type { PlaybackUI } from '../playback/usePlayback';
import { usePlaybackStatus } from '../playback/statusStore';
import { ProgressLine } from '../playback/ProgressLine';
import { MediaDialog } from '../media/MediaDialog';
import { SelectionContext } from '../selection/useSelection';
import { SpectrogramCanvas } from '../spectrogram/SpectrogramCanvas';
import { AxisRulers } from '../spectrogram/AxisRulers';
import { ColorScale } from '../spectrogram/ColorScale';
import { frequencyRulerWidth } from '../spectrogram/ticks';
import { defaultSettings, defaultView, duration, analysisError } from '../spectrogram/workspace';
import type { ActiveProject } from '../project/useProjectLifecycle';
import { InspectionSession } from './session';
import { inspectionProject } from './adapter';
import type { InspectionTarget } from './targets';
import { Menu } from '../../components/menu/Menu';
import { Play, Pause, Square, RotateCcw, ScanLine, Maximize2, Minimize2, X, ArrowUpRight, Settings2 } from 'lucide-react';
import { coordinates } from '../spectrogram/coordinates';
import { isResetViewShortcut } from '../spectrogram/viewShortcut';
import './inspection.css';

function regionView(r: Region, media: MediaDescriptor) {
 const timeMargin = (r.endSeconds-r.startSeconds)*.1, frequencyMargin = (r.highHz-r.lowHz)*.1;
 return { startSeconds: Math.max(0,r.startSeconds-timeMargin), endSeconds: Math.min(duration(media),r.endSeconds+timeMargin), lowHz: Math.max(0,r.lowHz-frequencyMargin), highHz: Math.min(media.sampleRate/2,r.highHz+frequencyMargin) };
}

export function InspectionViewer({ target, value, binding, playback, onJump, onClose, onJumpComplete }: {
 target: InspectionTarget; value: RemoteValue | null; binding: InspectionBinding | null; playback: PlaybackUI;
 onJump: () => Promise<boolean>; onClose: () => void; onJumpComplete?: () => void;
}) {
 const [session] = useState(() => binding ? new InspectionSession(binding) : null);
 useSyncExternalStore(session?.subscribe ?? (() => () => {}), session?.getVersion ?? (() => 0));
 const latest = useRef({ playback, onJump, onClose, onJumpComplete, value }); latest.current = { playback, onJump, onClose, onJumpComplete, value };
 const [jumping, setJumping] = useState(false), [jumpError, setJumpError] = useState<string | null>(null);
 const jumpingRef = useRef(false), alive = useRef(true);
 const dialog = useRef<HTMLDivElement>(null);
 const initial = useRef(value);
 const media = value?.media ?? initial.current?.media;
 const [view, setView] = useState<MediaView>(() => media ? { ...defaultView(media), ...target.owner.store.snapshot.document.viewState.media[media.id], ...(value?.annotation ? regionView(value.annotation.region, media) : {}) } : {} as MediaView);
 const [channel, setChannel] = useState(value?.channelIndex ?? 0);
 const [draft, setDraft] = useState<AnalysisSettings>(() => media ? { ...(target.owner.store.snapshot.document.analysis[media.id] ?? defaultSettings) } : defaultSettings);
 const appliedAnalysis = useRef(draft);
 const committedAnalysis = session?.result?.snapshot.document.analysis[media?.id ?? ''];
 if (committedAnalysis) appliedAnalysis.current = committedAnalysis;
 const [volume] = useState(playback.options.volume), [gain, setGain] = useState(playback.monitor.mediaMonitorGainDb?.[media?.id ?? ''] ?? playback.monitor.monitorGainDb);
 const [gainDraft, setGainDraft] = useState(String(gain));
 const mode = 'original' as const;
 const [maximized, setMaximized] = useState(false), [settingsOpen, setSettingsOpen] = useState(false);
 const [cue, setCue] = useState<number | null>(null);
 const [menu, setMenu] = useState<{ x: number; y: number; seconds: number; trigger: HTMLElement } | null>(null);
 const resetView = () => media && setView(v => ({ ...v, startSeconds: 0, endSeconds: duration(media), lowHz: 0, highHz: media.sampleRate / 2 }));
 const locateRegion = () => { const region = latest.current.value?.annotation?.region; if (region && media) { setChannel(region.channelIndex); setView(v => ({ ...v, ...regionView(region, media) })); } };
 useEffect(() => { if (!settingsOpen) return; const close = (e: PointerEvent) => { if (!(e.target instanceof Element && e.target.closest('.inspection-settings'))) setSettingsOpen(false); }; document.addEventListener('pointerdown', close); return () => document.removeEventListener('pointerdown', close); }, [settingsOpen]);
 const auditionRegion = useRef(false);
 // Native SourceSeed also binds descriptor metadata, edits and mix. Reopen when that
 // authority changes instead of retaining a session native correctly considers stale.
 const sourceDocument = target.owner.store.snapshot.document;
 const sourceKey = value ? JSON.stringify([value.media, sourceDocument.edits.filter(e => e.region.mediaId === value.media.id), sourceDocument.playbackMix[value.media.id] ?? null]) : null;
 useEffect(() => {
  alive.current = true;
  const unregister = target.owner.lifecycle.registerBackgroundGuard(() => false);
  return () => { alive.current = false; unregister(); };
 }, [target.owner]);
 useEffect(() => {
  if (!session) return;
  session.start();
  if (sourceKey && latest.current.value) void session.open(latest.current.value.media.id, appliedAnalysis.current, () => latest.current.playback.stopAndWait());
  else session.unavailable();
  return () => session.dispose();
 }, [session, sourceKey]);
 const regionKey = JSON.stringify(value?.annotation?.region ?? null), previousRegion = useRef(regionKey);
 useEffect(() => { if (previousRegion.current !== regionKey) { previousRegion.current = regionKey; void session?.stop(); } }, [regionKey, session]);
 useEffect(() => {
  if (!session) return;
  let ended = false, unlisten: (() => void) | undefined;
  if (playbackClient.available()) void playbackClient.listen(status => { if (!ended) session.progress(status); }).then(fn => { if (ended) fn(); else unlisten = fn; }).catch(e => { if (!ended) session.unavailable(normalizeError(e).message); });
  let checking = false;
  const timer = setInterval(() => { if (!checking) { checking = true; void session.checkSource().finally(() => { checking = false; }); } }, 5000);
  return () => { ended = true; clearInterval(timer); unlisten?.(); };
 }, [session]);
 const jump = async () => {
  if (jumpingRef.current || !latest.current.value) return;
  jumpingRef.current = true; setJumping(true); setJumpError(null);
  try { if (await latest.current.onJump() && alive.current) (latest.current.onJumpComplete ?? latest.current.onClose)(); }
  catch (e) { if (alive.current) setJumpError(normalizeError(e).message); }
  finally { jumpingRef.current = false; if (alive.current) setJumping(false); }
 };
 const result = session?.result;
 const settings = () => ({ monitorGainDb: gain, volume, deviceId: latest.current.playback.options.deviceId, looping: latest.current.playback.options.looping });
 const play = (region = false, seconds: number | null = region ? null : cue) => {
  const current = latest.current.value;
  if (!session || !current) return;
  auditionRegion.current = region;
  const request: PlaybackRequest['mode'] = region && current.annotation ? { mode: 'selection', region: current.annotation.region, selectionSource: mode } : { mode };
  void session.play(settings(), request, seconds);
 };
 const toggle = () => {
  if (session?.wantsPlayback) { void session.control('pause'); return; }
  const paused = session?.status.state === 'paused';
  play(paused ? auditionRegion.current : !!value?.annotation && cue === null, paused ? null : undefined);
 };
 return <MediaDialog className={`inspection-dialog${maximized ? ' is-maximized' : ''}`} title="音频查看（只读）" onClose={onClose} resolveReturnFocus={previous => previous?.isConnected ? previous : document.querySelector<HTMLElement>('.inspector-tabs [aria-selected=true]')}>
  <div ref={dialog} className="inspection-viewer" onKeyDown={e => {
   if (isResetViewShortcut(e)) { e.preventDefault(); resetView(); }
   if (e.key === ' ' && !e.ctrlKey && !e.altKey && !(e.target instanceof Element && e.target.closest('input,select,textarea,button,summary'))) { e.preventDefault(); toggle(); }
  }}>
   <header><h2 title={media?.displayName}>{(value?.media.displayName ?? media?.displayName ?? '音频查看').split(/[\\/]/).at(-1)}</h2><span className="inspection-author" title={value?.author.identity.displayName}>{value?.author.identity.displayName} · 只读</span><button className="icon-button" title="跳转到音频" aria-label="跳转到音频" onClick={() => void jump()} disabled={!value || jumping || target.owner.store.editingDisabled}><ArrowUpRight size={16}/></button><button className="icon-button" aria-label={maximized ? '还原查看窗口' : '最大化查看窗口'} onClick={() => setMaximized(v => !v)}>{maximized ? <Minimize2 size={16}/> : <Maximize2 size={16}/>}</button><button className="icon-button" aria-label="关闭查看" onClick={onClose}><X size={16}/></button></header>
   {!value && <p role="status">此内容已不存在或不可用。</p>}
   {session?.loading && <p role="status">正在打开音频…</p>}
   {(session?.error || jumpError || !binding) && <p role="alert">{jumpError ?? session?.error ?? '查看会话不可用'}{session?.error && value && <button className="button" onClick={() => void session.open(value.media.id, appliedAnalysis.current, () => latest.current.playback.stopAndWait())}>重试打开</button>}</p>}
   {media && <><div className="inspection-tools"><label>通道<select aria-label="查看通道" value={channel} onChange={e => setChannel(+e.target.value)}>{Array.from({ length: media.channelCount }, (_, i) => <option key={i} value={i}>通道 {i + 1}</option>)}</select></label><select aria-label="查看频谱类型" value={view.spectrumKind} onChange={e => setView(v => ({ ...v, spectrumKind: e.target.value as MediaView['spectrumKind'] }))}><option value="stft">STFT</option><option value="mel">Mel</option></select>
    <button className="icon-button" title="定位标注" aria-label="定位标注" disabled={!value?.annotation} onClick={locateRegion}><ScanLine size={16}/></button><button className="icon-button" title="重置视图 · Ctrl+0" aria-label="重置视图" onClick={resetView}><RotateCcw size={16}/></button>
    {value && <div className="inspection-metadata" title={`${value.categoryText} · ${value.note || '无备注'} · ${value.media.displayName}`}><span>{value.categoryText}</span>{value.annotation && <span>{value.annotation.region.startSeconds.toFixed(3)}–{value.annotation.region.endSeconds.toFixed(3)} s · {value.annotation.region.lowHz.toFixed(0)}–{value.annotation.region.highHz.toFixed(0)} Hz</span>}<span className="inspection-note">{value.note}</span>{value.author.error && <span>读取异常</span>}</div>}
   <details className="inspection-settings" open={settingsOpen}><summary aria-label="分析与显示设置" onClick={e => { e.preventDefault(); setSettingsOpen(v => !v); }}><Settings2 size={16}/></summary><div>
    <label>窗函数<select aria-label="查看窗函数" value={draft.window} onChange={e => setDraft(s => ({ ...s, window: e.target.value as AnalysisSettings['window'] }))}>{['hann', 'hamming', 'blackman', 'rectangular'].map(w => <option key={w}>{w}</option>)}</select></label>
    {([['windowSize', '窗长'], ['hopSize', '步长'], ['fftSize', 'FFT 长度'], ['melBands', '梅尔频带']] as const).map(([key, label]) => <label key={key}>{label}<input aria-label={`查看${label}`} type="number" value={Number.isNaN(draft[key]) ? '' : draft[key]} onChange={e => setDraft(s => ({ ...s, [key]: e.target.valueAsNumber }))}/></label>)}
    <button className="button" disabled={!result || session?.analyzing || !!analysisError(draft)} onClick={() => void session?.analysis(draft)}>应用分析参数</button>{analysisError(draft) && <span role="alert">{analysisError(draft)}</span>}
    <label>线性 / 对数<input aria-label="查看线性对数混合" type="range" min="0" max="1" step=".01" disabled={view.spectrumKind === 'mel'} value={view.frequencyMix} onChange={e => setView(v => ({ ...v, frequencyMix: +e.target.value }))}/></label>
    <label>色表<select aria-label="查看色表" value={view.palette} onChange={e => setView(v => ({ ...v, palette: e.target.value }))}>{['ember', 'ocean', 'gray'].map(p => <option key={p}>{p}</option>)}</select></label>
    {([['gainDb', '显示增益', -60, 60], ['dynamicRangeDb', '动态范围', 20, 160]] as const).map(([key, label, min, max]) => <label key={key}>{label}<input aria-label={`查看${label}`} type="range" min={min} max={max} value={view[key]} onChange={e => setView(v => ({ ...v, [key]: +e.target.value }))}/></label>)}
   </div></details></div></>}
   {result && binding && session && !session.analyzing && <InspectionSpectrum result={result} binding={binding} view={view} onView={patch => setView(v => ({ ...v, ...patch }))} channel={channel} session={session} looping={playback.options.looping} analysisSource={mode} region={value?.annotation?.region} cue={cue} onCue={setCue} onMenu={(seconds, x, y, trigger) => { setCue(seconds); setMenu({ seconds, x, y, trigger }); }}/>}
   {menu && <Menu anchor={menu} returnFocus={menu.trigger} onClose={() => setMenu(null)} items={[
    { id: 'play', label: '从此处播放', action: () => play(false, menu.seconds) },
    { id: 'region', label: '播放区域', disabled: !value?.annotation, action: () => play(true) },
    { id: 'locate', label: '定位标注', disabled: !value?.annotation, action: locateRegion },
    { id: 'reset', label: '重置视图 · Ctrl+0', action: resetView },
   ]}/>}
   {session?.analyzing && <p role="status">正在更新分析…</p>}
   <footer className="inspection-transport" role="toolbar" aria-label="查看播放控制">
    <button className="icon-button" aria-label={session?.wantsPlayback ? '暂停' : '播放音频'} disabled={!result || session?.analyzing || !value} onClick={toggle}>{session?.wantsPlayback ? <Pause size={18}/> : <Play size={18}/>}</button><button className="icon-button" aria-label="停止" disabled={!result} onClick={() => void session?.stop()}><Square size={15}/></button><button className="button" disabled={!result || !value?.annotation || session?.analyzing} onClick={() => play(true)}>播放区域</button>
    <label>监听增益<input aria-label="查看监听增益" type="number" min="-60" max="24" step=".1" value={gainDraft} onBlur={() => setGainDraft(String(gain))} onChange={e => { setGainDraft(e.target.value); const next = e.target.value.trim() === '' ? NaN : e.target.valueAsNumber; if (Number.isFinite(next) && next >= -60 && next <= 24) { setGain(next); void session?.gain(next); } }}/>dB</label>
    {session && media && <InspectionPosition session={session} limit={duration(media)} seek={seconds => void session.play(settings(), auditionRegion.current && value?.annotation ? { mode: 'selection', region: value.annotation.region, selectionSource: mode } : { mode }, seconds, session.wantsPlayback)}/>}
   </footer>
  </div>
 </MediaDialog>;
}
function InspectionPosition({ session, limit, seek }: { session: InspectionSession; limit: number; seek: (seconds: number) => void }) {
 const status = usePlaybackStatus(session);
 return <><input aria-label="查看播放位置" type="range" min="0" max={limit} step=".001" disabled={!session.result} value={status.positionSeconds} onChange={e => seek(+e.target.value)}/><output>{status.positionSeconds.toFixed(2)} / {limit.toFixed(2)} s</output><span role="status">{({ stopped:'已停止',buffering:'准备音频…',playing:'播放中',paused:'已暂停',ended:'播放结束',error:'输出失败' } as const)[status.state]}</span></>;
}
function InspectionHead({ session, view, looping }: { session: InspectionSession; view: MediaView; looping: boolean }) {
 const status = usePlaybackStatus(session);
 return status.projectId && status.state !== 'stopped' ? <ProgressLine status={status} view={view} looping={looping} className="inspection-playhead"/> : null;
}

function InspectionSpectrum({ result, binding, view, onView, channel, session, looping, analysisSource, region, cue, onCue, onMenu }: { result: InspectionPreview; binding: InspectionBinding; view: MediaView; onView: (v: Partial<MediaView>) => void; channel: number; session: InspectionSession; looping: boolean; analysisSource: 'original' | 'processed'; region?: Region; cue: number | null; onCue: (seconds: number) => void; onMenu: (seconds: number, x: number, y: number, trigger: HTMLElement) => void }) {
 const down = useRef<{ x: number; y: number } | null>(null);
 const [active, setActive] = useState<ActiveProject | null>(null);
 useEffect(() => { const owner = inspectionProject(result, binding); setActive(owner); return () => owner.lifecycle.dispose(); }, [result, binding.runtimeNonce, binding.projectId]);
 const media = result.snapshot.document.media[0], settings = result.snapshot.document.analysis[media.id] ?? defaultSettings;
 if (!active || active.store.snapshot !== result.snapshot) return null;
 const point = (target: EventTarget | null, x: number) => { const surface = target instanceof Element ? target.closest<HTMLElement>('.spectrogram-surface') : null; const rect = surface?.getBoundingClientRect(); return surface && rect?.width ? { surface, seconds: Math.max(0, Math.min(duration(media), view.startSeconds + (x - rect.left) / rect.width * (view.endSeconds - view.startSeconds))) } : null; };
 const c = coordinates(view, media.sampleRate / 2, 100, 100);
 const box = region && region.channelIndex === channel ? { left: c.secondsToX(region.startSeconds), right: c.secondsToX(region.endSeconds), top: c.hzToY(region.highHz), bottom: c.hzToY(region.lowHz) } : null;
 return <SelectionContext.Provider value={null}><section className="channel-pane inspection-spectrum" style={{ '--frequency-ruler-width': `${frequencyRulerWidth(view)}px` } as CSSProperties} aria-label="查看频谱视图" onContextMenu={e => { const p = point(e.target, e.clientX); if (p) { e.preventDefault(); onMenu(p.seconds, e.clientX, e.clientY, p.surface); } }} onPointerDownCapture={e => { down.current = e.button === 0 && !e.altKey ? { x: e.clientX, y: e.clientY } : null; }} onPointerUpCapture={e => { const d = down.current; down.current = null; if (d && Math.hypot(e.clientX-d.x,e.clientY-d.y) < 4) { const p = point(e.target,e.clientX); if (p) onCue(p.seconds); } }}><div className="channel-graph"><AxisRulers lifecycle={active.lifecycle} owner={active} view={view} nyquist={media.sampleRate / 2} timeLimit={duration(media)} onView={onView}/><SpectrogramCanvas active={active} media={media} settings={settings} view={view} channel={channel} status="unverified" timeLimit={duration(media)} onView={onView} analysisSource={analysisSource}>{box && box.right > 0 && box.left < 100 && box.bottom > 0 && box.top < 100 && <div className="inspection-region" aria-label="正在查看的标注框" style={{ left: `${box.left}%`, top: `${box.top}%`, width: `${box.right-box.left}%`, height: `${box.bottom-box.top}%` }}/>}{cue !== null && cue >= view.startSeconds && cue <= view.endSeconds && <span className="inspection-cue" aria-label="查看播放起点" style={{ left: `${c.secondsToX(cue)}%` }}/>}<InspectionHead session={session} view={view} looping={looping}/></SpectrogramCanvas><ColorScale view={view}/></div></section></SelectionContext.Provider>;
}
