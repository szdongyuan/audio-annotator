import { useEffect, useRef } from 'react';
import type { ProjectLifecycleUI } from './useProjectLifecycle';

export function RestoreSessionDialog({ project }: { project: ProjectLifecycleUI }) {
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  return <div className="dialog-backdrop"><div ref={dialog} role="dialog" aria-modal="true" aria-label="继续上次的项目？" tabIndex={-1} className="project-dialog restore-session-dialog"
    onKeyDown={event => {
      event.stopPropagation();
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') event.preventDefault();
      if (event.key !== 'Tab') return;
      const items = [...(dialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
      const first = items[0], last = items.at(-1);
      if (!first || !last) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) { event.preventDefault(); first.focus(); }
    }}>
    <h2>继续上次的项目？</h2><p>恢复项目与上次的面板、定位线。音频保持停止。</p>
    <p className="restore-session-path">{project.restorePrompt?.path}</p>
    {project.error && <p role="alert">{project.error.message}</p>}
    <div className="dialog-actions">
      <button className="button button-accent" disabled={project.busy} onClick={() => void project.restoreLast()}>{project.error ? '重试恢复' : '恢复项目与工作状态'}</button>
      <button className="button" disabled={project.busy} onClick={() => void project.open('open')}>选择其他项目…</button>
      <button className="button" disabled={project.busy} onClick={project.startEmpty}>暂不打开</button>
      <button className="button button-quiet" disabled={project.busy} onClick={project.forgetSession}>忘记此记录</button>
    </div>
  </div></div>;
}
