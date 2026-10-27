import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { PlaybackUI } from './usePlayback';
import { validMonitorGain } from '../../bridge/playback';

const subscribe = () => () => {}, snapshot = () => 0;
function QuickMonitorGain({ ui }: { ui: PlaybackUI }) {
  const [draft, setDraft] = useState(String(ui.effectiveMonitorGainDb));
  useEffect(() => setDraft(String(ui.effectiveMonitorGainDb)), [ui.effectiveMonitorGainDb, ui.active, ui.sourceId]);
  const disabled = !ui.active || !ui.media || ui.active.store.editingDisabled;
  return <input className="quick-monitor-gain" aria-invalid={draft.trim() === '' || !validMonitorGain(Number(draft))} aria-label="快捷监听增益（dB）" title={ui.sourceId && ui.monitor.mediaMonitorGainDb[ui.sourceId] != null ? '此音频监听增益（dB）' : '跟随全局；输入后设为此音频的监听增益（dB）'} type="number" min={-60} max={24} step="0.1" value={draft} disabled={disabled} onChange={e => { setDraft(e.target.value); const db = e.target.value.trim() === '' ? NaN : Number(e.target.value); if (ui.sourceId && validMonitorGain(db)) ui.setMediaMonitorGain(ui.sourceId, db); }} onBlur={() => setDraft(String(ui.effectiveMonitorGainDb))} onKeyDown={e => { if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); e.currentTarget.blur(); } }} />;
}
export function MonitorGainControl({ ui }: { ui: PlaybackUI }) {
  const [open, setOpen] = useState(false), [target, setTarget] = useState<'global' | 'media'>('global');
  const host = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  const disabled = !ui.active || ui.active.store.editingDisabled;
  useSyncExternalStore(ui.active?.lifecycle.subscribe ?? subscribe, ui.active?.lifecycle.getVersion ?? snapshot);
  useEffect(() => { setOpen(false); setTarget('global'); }, [ui.active, ui.sourceId]);
  useEffect(() => {
    if (!open) return;
    panel.current?.focus();
    const outside = (e: PointerEvent) => { if (!host.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    return () => { document.removeEventListener('pointerdown', outside); if (trigger.current?.isConnected) trigger.current.focus(); };
  }, [open]);
  const value = target === 'global' ? ui.monitor.monitorGainDb : ui.sourceId ? ui.monitor.mediaMonitorGainDb[ui.sourceId] ?? ui.monitor.monitorGainDb : 0;
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value, target, open]);
  const valid = draft.trim() !== '' && validMonitorGain(Number(draft));
  const preferencesFailed = ui.active?.store.drafts.has('collaboration:playback-preferences') && ui.active.lifecycle.status === 'failed';
  return <div ref={host} className="monitor-control" data-pane-control>
    <QuickMonitorGain ui={ui} /><button ref={trigger} className="button button-quiet" aria-label="监听增益" aria-expanded={open} disabled={disabled} title={`监听增益 ${ui.effectiveMonitorGainDb.toFixed(1)} dB · 全局与跟随设置`} onClick={() => setOpen(!open)}>dB{(ui.monitorError || preferencesFailed) && ' !'}</button>
    {open && <div ref={panel} className="monitor-popover" role="dialog" aria-label="监听增益" tabIndex={-1} onKeyDown={e => { e.stopPropagation(); if (e.key === 'Escape') { e.preventDefault(); setOpen(false); } }}>
      <label>监听目标<select aria-label="监听目标" value={target} onChange={e => setTarget(e.target.value as typeof target)}><option value="global">全局</option><option value="media" disabled={!ui.media}>此音频 · {ui.media?.displayName}</option></select></label>
      <label>监听增益（dB）<input aria-label="监听增益（dB）" type="number" min={-60} max={24} step="0.1" value={draft} disabled={disabled} onChange={e => { setDraft(e.target.value); const db = e.target.value.trim() === '' ? NaN : Number(e.target.value); if (validMonitorGain(db)) { if (target === 'global') ui.setGlobalMonitorGain(db); else if (ui.sourceId) ui.setMediaMonitorGain(ui.sourceId, db); } }} /></label>
      <label>输出音量<input type="range" aria-label="输出音量" min="0" max="1" step="0.01" disabled={disabled} value={ui.options.volume} onChange={e => ui.update({ volume: Number(e.target.value) })} /></label>
      {!valid && <p role="alert">请输入 −60 至 +24 dB。</p>}
      {target === 'media' && <button className="button" disabled={disabled || !ui.sourceId || ui.monitor.mediaMonitorGainDb[ui.sourceId] == null} onClick={() => { if (ui.sourceId) ui.setMediaMonitorGain(ui.sourceId, null); }}>恢复跟随全局</button>}
      {ui.monitorError && <p role="alert">实时监听：{ui.monitorError.message}<button className="text-button" onClick={ui.retryMonitor}>重试监听</button></p>}
      {preferencesFailed && <p role="alert">偏好保存：{ui.active?.lifecycle.error?.message}<button className="text-button" onClick={() => void ui.active?.lifecycle.save().catch(() => {})}>重试保存偏好</button></p>}
    </div>}
  </div>;
}
