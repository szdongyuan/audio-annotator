import { useRef, useState } from 'react';
import { exchangeClient, exchangeDialogs, type ExchangeEvent, type ExchangeRequest } from '../../bridge/exchange';
import type { OpenedProject } from '../../bridge/projects';
import { normalizeError } from '../../bridge/client';
import type { AppError } from '../../bridge/types';
import type { ProjectLifecycleUI } from '../project/useProjectLifecycle';
export function useExchange(project: ProjectLifecycleUI) {
  const [dialog, setDialog] = useState<'export' | 'import' | null>(null);
  const [busy, setBusy] = useState(false); const running = useRef(false);
  const [phase, setPhase] = useState(''); const [completed, setCompleted] = useState(0);
  const [result, setResult] = useState<string | null>(null); const [error, setError] = useState<AppError | null>(null);
  const [cancelled, setCancelled] = useState(false); const cancelRequested = useRef(false); const task = useRef<string | null>(null);
  const reset = () => { setPhase(''); setCompleted(0); setResult(null); setError(null); setCancelled(false); cancelRequested.current = false; task.current = null; };
  const startNative = (request: ExchangeRequest) => new Promise<OpenedProject | null>((resolve, reject) => {
    let terminal = false;
    const receive = (event: ExchangeEvent) => {
      task.current ??= event.taskId;
      if (event.taskId !== task.current || terminal) return;
      if (event.type === 'progress') { setPhase(event.phase); setCompleted(event.completed); return; }
      terminal = true;
      if (event.type === 'completed') { setResult(event.path); resolve(event.opened); }
      else reject(event.type === 'failed' ? event.error : { code: 'Cancelled', message: '任务已取消', retryable: true });
    };
    void exchangeClient.start(request, receive).then(id => { if (terminal) return; task.current ??= id; if (cancelRequested.current) void exchangeClient.cancel(id).catch(e => setError(normalizeError(e))); }).catch(reject);
  });
  const start = async (kind: 'annotations' | 'bundle' | 'import') => {
    if (running.current) return;
    running.current = true; setBusy(true); reset();
    try {
      let request: Omit<ExchangeRequest, 'expected'>;
      if (kind === 'import') { const source = await exchangeDialogs.source(); if (typeof source !== 'string' || cancelRequested.current) return; const parent = await exchangeDialogs.parent(); if (typeof parent !== 'string' || cancelRequested.current) return; request = { kind, source, parent }; }
      else { const path = await exchangeDialogs.save(kind); if (!path || cancelRequested.current) return; request = { kind, path }; }
      await project.performExchange(async expected => {
        if (cancelRequested.current) throw { code: 'Cancelled', message: '任务已取消', retryable: true };
        if (kind !== 'import' && !expected) throw { code: 'InvalidInput', message: '请先打开项目', retryable: false };
        return startNative({ ...request, expected });
      });
    } catch (cause) { const e = normalizeError(cause); if (e.code === 'Cancelled') setCancelled(true); else setError(e); }
    finally { setBusy(false); running.current = false; task.current = null; }
  };
  return { dialog, busy, phase, completed, result, error, cancelled,
    show: (kind: 'export' | 'import') => { if (!running.current) { reset(); setDialog(kind); } },
    onClose: () => { if (!running.current) setDialog(null); }, onCancel: () => { cancelRequested.current = true; setPhase('正在取消'); if (task.current) void exchangeClient.cancel(task.current).catch(e => setError(normalizeError(e))); },
    startExport: (kind: 'annotations' | 'bundle') => void start(kind), startImport: () => void start('import'),
  };
}
export type ExchangeUI = ReturnType<typeof useExchange>;
