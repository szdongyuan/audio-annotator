import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { validMonitorGain } from '../../bridge/playback';
import { useSelectionContext } from '../selection/useSelection';
import type { Selection } from '../selection/state';
import type { ActiveProject } from '../project/useProjectLifecycle';
const subscribe = () => () => {}, version = () => 0;

export function RegionGainInput({ enabled }: { enabled: boolean }) {
  const ui = useSelectionContext(), [value, setValue] = useState('0'), [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<{ owner: ActiveProject; target: Selection; id: number | null; message: string } | null>(null);
  useSyncExternalStore(ui?.active?.lifecycle.subscribe ?? subscribe, ui?.active?.lifecycle.getVersion ?? version);
  const operation = useRef<object | null>(null), latest = useRef(ui); latest.current = ui;
  useLayoutEffect(() => { operation.current = null; setPending(false); setFailure(null); return () => { operation.current = null; }; }, [ui?.active]);
  const failureKey = ui?.active?.queue.unresolvedFailures.map(f => f.id).join('|');
  useLayoutEffect(() => { if (failure?.id != null && !failure.owner.queue.unresolvedFailures.some(f => f.id === failure.id)) setFailure(null); }, [failure, failureKey]);
  const db = value.trim() === '' ? NaN : Number(value), valid = validMonitorGain(db);
  const disabled = !enabled || !ui?.active || ui.active.store.editingDisabled || pending;
  const apply = async () => {
    const owner = ui?.active, target = ui?.state.getActiveSelection();
    if (disabled || operation.current || !owner || !target || !valid || !ui.actions) return;
    const token = {}; operation.current = token; setPending(true);
    let ok: unknown;
    const retained = failure?.owner === owner && failure.id !== null && owner.queue.unresolvedFailures.some(f => f.id === failure.id) ? failure : null;
    if (retained) {
      try { await owner.lifecycle.retryFailure(retained.id!); ui.state.clear(retained.target); ok = true; }
      catch { ok = false; }
    } else {
      const before = new Set(owner.queue.unresolvedFailures.map(f => f.id));
      ok = await ui.actions.gain(target, db);
      if (operation.current === token && latest.current?.active === owner && ok !== true) setFailure({ owner, target, id: owner.queue.unresolvedFailures.find(f => !before.has(f.id) && f.owner === 'masks')?.id ?? null, message: owner.lifecycle.error?.message ?? '区域增益未应用，请重试。' });
    }
    if (operation.current !== token || latest.current?.active !== owner) return;
    operation.current = null; setPending(false); if (ok === true) setFailure(null);
  };
  return <form className="region-gain-inline" aria-label="快捷区域增益" onSubmit={e => { e.preventDefault(); void apply(); }}>
    <label title="选区增益（dB），输入后回车应用，可撤销">区域<input aria-label="快捷区域增益（dB）" type="number" min={-60} max={24} step="0.1" value={value} disabled={disabled || !!failure?.id} onChange={e => { setValue(e.target.value); setFailure(null); }} onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setValue('0'); e.currentTarget.blur(); } }} /></label>
    <button type="submit" className="button button-quiet" aria-label={failure ? '重试区域增益' : '应用区域增益'} title={failure ? '重试原来的区域增益' : '应用到当前选区（dB）'} disabled={disabled || !valid}>✓</button>
    {(!valid || failure) && <span className="gain-inline-error" role="alert">{failure?.message ?? '请输入 −60 至 +24 dB。'}</span>}
  </form>;
}
