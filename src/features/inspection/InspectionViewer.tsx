import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import type { AnalysisSettings, MediaView } from '../../bridge/types';
import type { InspectionBinding, InspectionPreview } from '../../bridge/inspection';
import { playbackClient, type PlaybackRequest } from '../../bridge/playback';
import { normalizeError } from '../../bridge/client';
import type { RemoteValue } from '../collaboration/remote';
import type { PlaybackUI } from '../playback/usePlayback';
import { usePlaybackStatus } from '../playback/statusStore';
import { PresentationClock } from '../playback/presentationClock';
import { MediaDialog } from '../media/MediaDialog';
import { SelectionContext } from '../selection/useSelection';
import { SpectrogramCanvas } from '../spectrogram/SpectrogramCanvas';
import { AxisRulers } from '../spectrogram/AxisRulers';
import { ColorScale } from '../spectrogram/ColorScale';
import { frequencyRulerWidth } from '../spectrogram/ticks';
import { defaultSettings, defaultView, duration, analysisError } from '../spectrogram/workspace';
import { zoomViewport } from '../spectrogram/viewport';
import type { ActiveProject } from '../project/useProjectLifecycle';
import { InspectionSession } from './session';
import { inspectionProject } from './adapter';
import type { InspectionTarget } from './targets';
import './inspection.css';

export function InspectionViewer({ target, value, binding, playback, onJump, onClose }: {
 target: InspectionTarget; value: RemoteValue | null; binding: InspectionBinding | null; playback: PlaybackUI;
 onJump: () => Promise<boolean>; onClose: () => void;
}) {
 const [session] = useState(() => binding ? new InspectionSession(binding) : null);
 useSyncExternalStore(session?.subscribe ?? (() => () => {}), session?.getVersion ?? (() => 0));
 const latest = useRef({ playback, onJump, onClose, value }); latest.current = { playback, onJump, onClose, value };
 const [jumping, setJumping] = useState(false), [jumpError, setJumpError] = useState<string | null>(null);
 const jumpingRef = useRef(false), alive = useRef(true);
 const dialog = useRef<HTMLDivElement>(null);
 const initial = useRef(value);
 const media = value?.media ?? initial.current?.media;
 const [view, setView] = useState<MediaView>(() => media ? { ...defaultView(media), ...target.owner.store.snapshot.document.viewState.media[media.id], ...(value?.annotation ? { startSeconds: value.annotation.region.startSeconds, endSeconds: value.annotation.region.endSeconds, lowHz: value.annotation.region.lowHz, highHz: value.annotation.region.highHz } : {}) } : {} as MediaView);
 const [channel, setChannel] = useState(value?.channelIndex ?? 0);
 const [draft, setDraft] = useState<AnalysisSettings>(() => media ? { ...(target.owner.store.snapshot.document.analysis[media.id] ?? defaultSettings) } : defaultSettings);
 const appliedAnalysis = useRef(draft);
 const committedAnalysis = session?.result?.snapshot.document.analysis[media?.id ?? ''];
 if (committedAnalysis) appliedAnalysis.current = committedAnalysis;
 const [volume, setVolume] = useState(playback.options.volume), [gain, setGain] = useState(playback.monitor.mediaMonitorGainDb?.[media?.id ?? ''] ?? playback.monitor.monitorGainDb);
 const [gainDraft, setGainDraft] = useState(String(gain));
 const [mode, setMode] = useState<'original' | 'processed'>('original');
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
 useLayoutEffect(() => { if (dialog.current && !dialog.current.closest('[role=dialog]')?.contains(document.activeElement)) dialog.current.closest<HTMLElement>('[role=dialog]')?.focus(); });
 const jump = async () => {
  if (jumpingRef.current || !latest.current.value) return;
  jumpingRef.current = true; setJumping(true); setJumpError(null);
  try { if (await latest.current.onJump() && alive.current) latest.current.onClose(); }
  catch (e) { if (alive.current) setJumpError(normalizeError(e).message); }
  finally { jumpingRef.current = false; if (alive.current) setJumping(false); }
 };
 const result = session?.result;
 const settings = () => ({ monitorGainDb: gain, volume, deviceId: latest.current.playback.options.deviceId, looping: latest.current.playback.options.looping });
 const play = (region = false) => {
  const current = latest.current.value;
  if (!session || !current) return;
  auditionRegion.current = region;
  const request: PlaybackRequest['mode'] = region && current.annotation ? { mode: 'selection', region: current.annotation.region, selectionSource: mode } : { mode };
  void session.play(settings(), request);
 };
 return <MediaDialog title="音频查看（只读）" onClose={onClose} resolveReturnFocus={previous => previous?.isConnected ? previous : document.querySelector<HTMLElement>('.inspector-tabs [aria-selected=true]')}>
  <div ref={dialog} className="inspection-viewer">
   <header><h2 title={media?.displayName}>{value?.media.displayName ?? media?.displayName ?? '音频查看'}</h2><span>只读 · {value?.author.identity.displayName}</span><button className="button" onClick={() => void jump()} disabled={!value || jumping || target.owner.store.editingDisabled}>跳转到音频</button><button className="button" onClick={onClose}>关闭查看</button></header>
   {value && <div className="inspection-metadata"><span>{value.categoryText}</span><span>{value.channelIndex === undefined ? '文件' : `通道 ${value.channelIndex + 1}`}</span>{value.annotation && <span>{value.annotation.region.startSeconds.toFixed(3)}–{value.annotation.region.endSeconds.toFixed(3)} s · {value.annotation.region.lowHz.toFixed(1)}–{value.annotation.region.highHz.toFixed(1)} Hz</span>}<span className="inspection-note" title={value.note}>{value.note || '无备注'}</span>{value.author.error && <span title={value.author.error.message}>读取异常 · 保留上次已验证图层</span>}</div>}
   {!value && <p role="status">此内容已不存在或不可用。</p>}
   {session?.loading && <p role="status">正在打开音频…</p>}
   {(session?.error || jumpError || !binding) && <p role="alert">{jumpError ?? session?.error ?? '查看会话不可用'}{session?.error && value && <button className="button" onClick={() => void session.open(value.media.id, appliedAnalysis.current, () => latest.current.playback.stopAndWait())}>重试打开</button>}</p>}
   {media && <><div className="inspection-tools"><label>通道<select aria-label="查看通道" value={channel} onChange={e => setChannel(+e.target.value)}>{Array.from({ length: media.channelCount }, (_, i) => <option key={i} value={i}>通道 {i + 1}</option>)}</select></label><select aria-label="查看频谱类型" value={view.spectrumKind} onChange={e => setView(v => ({ ...v, spectrumKind: e.target.value as MediaView['spectrumKind'] }))}><option value="stft">STFT</option><option value="mel">Mel</option></select>
    {(['time', 'frequency'] as const).flatMap(axis => ([.5, 2] as const).map(factor => <button key={`${axis}${factor}`} className="button" onClick={() => setView(v => ({ ...v, ...zoomViewport(v, duration(media), media.sampleRate / 2, axis, .5, factor) }))}>{factor < 1 ? '放大' : '缩小'}{axis === 'time' ? '时间' : '频率'}</button>))}
    <button className="button" onClick={() => setView(v => ({ ...v, startSeconds: 0, endSeconds: duration(media), lowHz: 0, highHz: media.sampleRate / 2 }))}>重置视图</button>
   </div><details className="inspection-settings"><summary>分析与显示设置</summary><div>
    <label>窗函数<select aria-label="查看窗函数" value={draft.window} onChange={e => setDraft(s => ({ ...s, window: e.target.value as AnalysisSettings['window'] }))}>{['hann', 'hamming', 'blackman', 'rectangular'].map(w => <option key={w}>{w}</option>)}</select></label>
    {([['windowSize', '窗长'], ['hopSize', '步长'], ['fftSize', 'FFT 长度'], ['melBands', '梅尔频带']] as const).map(([key, label]) => <label key={key}>{label}<input aria-label={`查看${label}`} type="number" value={Number.isNaN(draft[key]) ? '' : draft[key]} onChange={e => setDraft(s => ({ ...s, [key]: e.target.valueAsNumber }))}/></label>)}
    <button className="button" disabled={!result || session?.analyzing || !!analysisError(draft)} onClick={() => void session?.analysis(draft)}>应用分析参数</button>{analysisError(draft) && <span role="alert">{analysisError(draft)}</span>}
    <label>线性 / 对数<input aria-label="查看线性对数混合" type="range" min="0" max="1" step=".01" disabled={view.spectrumKind === 'mel'} value={view.frequencyMix} onChange={e => setView(v => ({ ...v, frequencyMix: +e.target.value }))}/></label>
    <label>色表<select aria-label="查看色表" value={view.palette} onChange={e => setView(v => ({ ...v, palette: e.target.value }))}>{['ember', 'ocean', 'gray'].map(p => <option key={p}>{p}</option>)}</select></label>
    {([['gainDb', '显示增益', -60, 60], ['dynamicRangeDb', '动态范围', 20, 160]] as const).map(([key, label, min, max]) => <label key={key}>{label}<input aria-label={`查看${label}`} type="range" min={min} max={max} value={view[key]} onChange={e => setView(v => ({ ...v, [key]: +e.target.value }))}/></label>)}
   </div></details></>}
   {result && binding && session && !session.analyzing && <InspectionSpectrum result={result} binding={binding} view={view} onView={patch => setView(v => ({ ...v, ...patch }))} channel={channel} session={session} looping={playback.options.looping} analysisSource={mode}/>}
   {session?.analyzing && <p role="status">正在更新分析…</p>}
   <footer className="inspection-transport" role="toolbar" aria-label="查看播放控制">
    <select aria-label="查看试听来源" value={mode} onChange={e => { setMode(e.target.value as typeof mode); void session?.stop(); }}><option value="original">原音</option><option value="processed">处理后</option></select>
    <button className="button" disabled={!result || session?.analyzing || !value} onClick={() => play()}>播放音频</button><button className="button" disabled={!result || !value?.annotation || session?.analyzing} onClick={() => play(true)}>播放区域</button>
    <button className="button" disabled={!result} onClick={() => void session?.control('pause')}>暂停</button><button className="button" disabled={!result} onClick={() => void session?.stop()}>停止</button>
    <label>音量<input aria-label="查看音量" type="range" min="0" max="1" step=".01" value={volume} onChange={e => { const next = +e.target.value; setVolume(next); if (session?.result && session.status.projectId) void session.play({ ...settings(), volume: next }, auditionRegion.current && value?.annotation ? { mode: 'selection', region: value.annotation.region, selectionSource: mode } : { mode }, session.status.positionSeconds, session.wantsPlayback); }}/></label>
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
 const status = usePlaybackStatus(session), clock = useRef(new PresentationClock()), [seconds, setSeconds] = useState(0);
 useEffect(() => { setSeconds(clock.current.accept(status, performance.now(), looping)); }, [status, looping]);
 useEffect(() => { if (status.state !== 'playing') return; let frame = 0; const draw = () => { setSeconds(clock.current.position(performance.now())); frame = requestAnimationFrame(draw); }; frame = requestAnimationFrame(draw); return () => cancelAnimationFrame(frame); }, [status.state]);
 return status.projectId && seconds >= view.startSeconds && seconds <= view.endSeconds ? <span className="inspection-playhead" style={{ left: `${100 * (seconds - view.startSeconds) / (view.endSeconds - view.startSeconds)}%` }}/> : null;
}
function InspectionSpectrum({ result, binding, view, onView, channel, session, looping, analysisSource }: { result: InspectionPreview; binding: InspectionBinding; view: MediaView; onView: (v: Partial<MediaView>) => void; channel: number; session: InspectionSession; looping: boolean; analysisSource: 'original' | 'processed' }) {
 const [active, setActive] = useState<ActiveProject | null>(null);
 useEffect(() => { const owner = inspectionProject(result, binding); setActive(owner); return () => owner.lifecycle.dispose(); }, [result, binding.runtimeNonce, binding.projectId]);
 const media = result.snapshot.document.media[0], settings = result.snapshot.document.analysis[media.id] ?? defaultSettings;
 if (!active || active.store.snapshot !== result.snapshot) return null;
 return <SelectionContext.Provider value={null}><section className="channel-pane inspection-spectrum" style={{ '--frequency-ruler-width': `${frequencyRulerWidth(view)}px` } as CSSProperties} aria-label="查看频谱视图"><div className="channel-graph"><AxisRulers lifecycle={active.lifecycle} owner={active} view={view} nyquist={media.sampleRate / 2} timeLimit={duration(media)} onView={onView}/><SpectrogramCanvas active={active} media={media} settings={settings} view={view} channel={channel} status="unverified" timeLimit={duration(media)} onView={onView} analysisSource={analysisSource}><InspectionHead session={session} view={view} looping={looping}/></SpectrogramCanvas><ColorScale view={view}/></div></section></SelectionContext.Provider>;
}
