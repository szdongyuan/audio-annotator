import { useEffect, useRef, type ReactNode } from 'react';
import type { AppError } from '../../bridge/types';
export interface ExchangeState { busy: boolean; phase: string; completed: number; result: string | null; error: AppError | null; cancelled: boolean; onCancel: () => void; onClose: () => void }
export function ExchangeDialog({ title, children, ...state }: ExchangeState & { title: string; children: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => { const previous = document.activeElement as HTMLElement | null; ref.current?.focus(); return () => previous?.focus(); }, []);
  return <div className="dialog-backdrop"><section ref={ref} className="project-dialog exchange-dialog" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} onKeyDown={e => {
    if (e.key === 'Escape' && !state.busy) { e.stopPropagation(); state.onClose(); }
    if (e.key === 'Tab') { const items = [...(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)') ?? [])]; const first = items[0], last = items.at(-1); if (e.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { e.preventDefault(); last?.focus(); } else if (!e.shiftKey && (document.activeElement === last || document.activeElement === ref.current)) { e.preventDefault(); first?.focus(); } }
  }}><span className="exchange-eyebrow">LOCAL FILE EXCHANGE</span><h2>{title}</h2>{children}
    {state.busy && <div className="exchange-progress" role="status"><progress aria-label="交换任务进度" /><span>{state.phase || '保存项目与准备任务'} · {(state.completed / 1024 / 1024).toFixed(1)} MiB</span></div>}
    {state.cancelled && <p role="status">任务已取消。现有项目保持可用。</p>}
    {state.error && <p role="alert" className="project-error">{state.error.message}</p>}
    {state.result && <div className="exchange-result" role="status"><strong>已完成</strong><p className="media-source-path">{state.result}</p></div>}
    <div className="dialog-actions">{state.busy ? <button className="button" onClick={state.onCancel}>取消任务</button> : <button className="button" onClick={state.onClose}>关闭</button>}</div>
  </section></div>;
}
