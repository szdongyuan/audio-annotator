import { ChevronDown, FolderOpen, Plus, Save } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { ProjectLifecycleUI } from './useProjectLifecycle';
import type { ExchangeUI } from '../exchange/useExchange';
export function ProjectActions({ project, onImport, importDisabled = true, exchange }: { project: ProjectLifecycleUI; onImport?: () => void; importDisabled?: boolean; exchange?: ExchangeUI }) {
  const menu = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (menu.current && !menu.current.contains(event.target as Node)) menu.current.open = false; };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && menu.current?.open) { menu.current.open = false; menu.current.querySelector('summary')?.focus(); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, []);
  return <nav className="project-actions" aria-label="项目操作">
    <details ref={menu} className="project-menu"><summary className="button button-quiet">项目<ChevronDown size={14} /></summary><div className="project-menu-items" onClick={event => { if ((event.target as HTMLElement).closest('button') && menu.current) menu.current.open = false; }}>
      <button disabled={project.busy || !!project.recovery} onClick={() => void project.open('create')}>新建项目<span>选择空文件夹</span></button>
      <button disabled={project.busy || !!project.recovery} onClick={() => void project.open('open')}>打开项目…</button>
      <button disabled={project.busy || !project.active} onClick={() => void project.saveAs()}>项目另存为…</button>
      <button disabled={project.busy || !project.active || !exchange} onClick={() => exchange?.show('export')}>分享项目…<span>JSON / ZIP</span></button>
      <button disabled={project.busy || !!project.recovery || !exchange} onClick={() => exchange?.show('import')}>导入分享文件…</button>
      <button disabled={project.busy || !project.active} onClick={() => void project.close()}>关闭项目</button>
    </div></details>
    <button className="button button-quiet" disabled={project.busy || !!project.recovery} onClick={() => void project.open('open')}><FolderOpen size={16} />打开项目</button>
    <button className="button button-quiet" disabled={project.busy || !project.active} onClick={() => void project.save()}><Save size={16} />保存<span className="key-hint">Ctrl S</span></button>
    <span className="header-divider" />
    <button className="button button-accent" disabled={importDisabled || project.editingDisabled} onClick={onImport}><Plus size={16} />导入音频</button>
  </nav>;
}
