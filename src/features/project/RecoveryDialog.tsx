import { useEffect, useRef, type ReactNode } from 'react';
import type { ProjectLifecycleUI } from './useProjectLifecycle';

function Modal({ title, children }: { title: string; children: ReactNode }) {
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    return () => previous?.focus();
  }, []);
  return <div className="dialog-backdrop"><div className="project-dialog" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={dialog}
    onKeyDown={event => {
      if (event.key !== 'Tab') return;
      const items = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)') ?? [])];
      if (!items.length) { event.preventDefault(); return; }
      const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) { event.preventDefault(); first.focus(); }
    }}><h2>{title}</h2>{children}</div></div>;
}
export function RecoveryDialog({ project }: { project: ProjectLifecycleUI }) {
  const report = project.recovery?.recovery;
  if (!report) return null;
  return <Modal title="发现可恢复的项目版本">
    <p>请选择要继续使用的版本。恢复操作会在成功写入后打开项目。</p>
    <div className="recovery-versions">{report.candidates.map(c => <button className="recovery-version" key={c.source} disabled={project.busy} onClick={() => void project.recover(c.source)}>
      <strong>{c.source === 'recovery' ? '恢复工作副本' : '恢复有效备份'}<span>版本 {c.document.revision}</span></strong><small>{c.document.name} · {new Date(c.document.updatedAt).toLocaleString('zh-CN')}</small>
    </button>)}</div>
    {project.error && <p role="alert" className="project-error">{project.error.message}</p>}
    <div className="dialog-actions"><button className="button" disabled={project.busy} onClick={() => void project.cancelRecovery()}>取消打开</button>
      {report.primary && <button className="button" disabled={project.busy} onClick={() => void project.recover(null)}>保留正式版本（{report.primary.revision}）</button>}</div>
  </Modal>;
}
export function CloseFailureDialog({ project }: { project: ProjectLifecycleUI }) {
  if (!project.closePending) return null;
  return <Modal title="项目尚未安全保存">
    <p>关闭前需要处理未保存的内容或编辑草稿。放弃更改会丢弃当前内存内容；磁盘故障时，下次打开仍可能显示恢复版本。</p>
    {project.error && <p role="alert" className="project-error">{project.error.message}</p>}
    <div className="dialog-actions"><button className="button" disabled={project.busy} onClick={project.cancelClose}>取消关闭</button><button className="button button-danger" disabled={project.busy} onClick={() => void project.discard()}>放弃更改</button><button className="button" disabled={project.busy} onClick={() => void project.saveAs()}>另存项目副本…</button><button className="button button-accent" disabled={project.busy} onClick={() => void project.retry()}>重试并继续</button></div>
  </Modal>;
}
