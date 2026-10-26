import { useLayoutEffect, useRef, useState } from 'react';
import { MediaDialog } from '../media/MediaDialog';
import type { SelectionUI } from '../selection/useSelection';
import { validMonitorGain } from '../../bridge/playback';

export function RegionGainDialog({ ui }: { ui: SelectionUI }) {
  const gain = ui.gain;
  return gain ? <GainForm key={`${gain.owner.store.snapshot.document.projectId}:${gain.target.region.mediaId}`} ui={ui} gain={gain} /> : null;
}
function GainForm({ ui, gain }: { ui: SelectionUI; gain: NonNullable<SelectionUI['gain']> }) {
  const [value, setValue] = useState('0'), [pending, setPending] = useState(false), [failed, setFailed] = useState(false);
  const alive = useRef(true), applying = useRef(false), rejected = useRef<number | null>(null);
  useLayoutEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const latest = useRef(ui); latest.current = ui;
  const db = value.trim() === '' ? NaN : Number(value), valid = validMonitorGain(db);
  const current = () => latest.current.active === gain.owner && latest.current.gain === gain && latest.current.state.matches(gain.target) && !gain.owner.store.editingDisabled;
  const apply = async () => {
    if (!current() || applying.current || !valid) return;
    applying.current = true;
    setPending(true); setFailed(false);
    let ok: unknown;
    if (rejected.current !== null) {
      try { await gain.owner.lifecycle.retryFailure(rejected.current); gain.owner.store.setError(null); ui.state.clear(gain.target); ok = true; }
      catch { ok = false; }
    } else {
      const failures = new Set(gain.owner.queue.unresolvedFailures.map(f => f.id));
      ok = await ui.actions!.gain(gain.target, db);
      rejected.current = gain.owner.queue.unresolvedFailures.find(f => !failures.has(f.id) && f.owner === 'masks')?.id ?? null;
    }
    if (!alive.current || latest.current.active !== gain.owner) return;
    applying.current = false;
    setPending(false);
    if (ok === true) { if (latest.current.gain === gain) ui.closeGain(); }
    else setFailed(true);
  };
  return <MediaDialog title="区域增益" returnFocus={gain.trigger} busy={pending} onClose={ui.closeGain}>
    <header><h2>区域增益</h2></header>
    <div className="source-import-body"><label>增益（dB）<input aria-label="区域增益（dB）" type="number" min={-60} max={24} step="0.1" value={value} disabled={pending || rejected.current !== null} onChange={e => setValue(e.target.value)} /></label>
      {!valid && <p role="alert">请输入 −60 至 +24 dB。</p>}{failed && <p role="alert">{gain.owner.lifecycle.error?.message ?? '区域增益未应用，请重试。'}</p>}
    </div><footer className="dialog-actions"><button className="button" disabled={pending} onClick={ui.closeGain}>取消</button><button className="button button-accent" disabled={!valid || pending} onClick={() => void apply()}>{failed && rejected.current !== null ? '重试应用' : '应用增益'}</button></footer>
  </MediaDialog>;
}
