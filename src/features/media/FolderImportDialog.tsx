import { useState, useSyncExternalStore } from 'react';
import { folderDialogs } from '../../bridge/folders';
import type { FolderImportController } from './folderImport';

export function FolderImportDialog({ controller, picker = folderDialogs.choose }: { controller: FolderImportController; picker?: () => Promise<string | string[] | null> }) {
  useSyncExternalStore(controller.subscribe, controller.getVersion);
  const [recursive, setRecursive] = useState(false);
  const [choosing, setChoosing] = useState(false);
  if (controller.state !== 'choosing') return null;
  return <div className="dialog-backdrop"><section className="project-dialog" role="dialog" aria-modal="true" aria-labelledby="folder-import-title" onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); controller.cancel(); } }}>
    <h2 id="folder-import-title">导入文件夹</h2>
    <label><input type="checkbox" checked={recursive} disabled={choosing} onChange={e => setRecursive(e.target.checked)} />包含子文件夹</label>
    <div className="dialog-actions"><button className="button" onClick={() => controller.cancel()}>取消</button><button className="button button-accent" autoFocus disabled={choosing} onClick={() => { setChoosing(true); void controller.choose(picker, recursive); }}>选择文件夹…</button></div>
  </section></div>;
}
