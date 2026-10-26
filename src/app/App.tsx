import { useIdentity } from '../features/identity/useIdentity';
import { IdentityDialog as ProfileDialog } from '../features/identity/IdentityDialog';
import { copyProgressText } from '../features/collaboration/CollaborationStatus';
import { useCollaboration, CollaborationContext } from '../features/collaboration/useCollaboration';
import { IdentityDialog } from '../features/collaboration/IdentityDialog';
import { AppShell } from './AppShell';
import { useProjectLifecycle } from '../features/project/useProjectLifecycle';
import { CloseFailureDialog, RecoveryDialog } from '../features/project/RecoveryDialog';
import { useMedia } from '../features/media/useMedia';
import { RelinkDialog } from '../features/media/RelinkDialog';
import { useExchange } from '../features/exchange/useExchange';
import { ExportDialog } from '../features/exchange/ExportDialog';
import { ImportDialog } from '../features/exchange/ImportDialog';

export function App() {
  const project = useProjectLifecycle();
  const media = useMedia(project.active);
  const exchange = useExchange(project);
  const collaboration = useCollaboration(project);
  const identity = useIdentity(project,collaboration);
  return <CollaborationContext.Provider value={collaboration}><div className="app-root" inert={!!identity.dialog || !!collaboration.dialog || !!exchange.dialog || project.closePending || !!project.recovery || !!media.relink || (!!project.active && project.editingDisabled)}><AppShell project={project} mediaUI={media} exchange={exchange} collaboration={collaboration} identity={identity} /></div>
    <IdentityDialog ui={collaboration} /><ProfileDialog controller={identity} />
    {project.copyProgress&&<div className="dialog-backdrop"><section role="dialog" aria-modal="true" aria-label="另存我的项目副本" className="project-dialog"><h2>另存我的项目副本</h2><p role="status"><progress aria-label="副本复制进度"/>{copyProgressText(project.copyProgress)}</p><button className="button" onClick={project.cancelCopy}>取消任务</button></section></div>}
    {exchange.dialog === 'export' && <ExportDialog shared={!!project.active?.collaboration} {...exchange} onPreview={exchange.prepareExport} onInvalidatePreview={exchange.invalidatePreview} onStart={exchange.startExport} />}
    {exchange.dialog === 'import' && <ImportDialog {...exchange} onStart={exchange.startImport} />}
    <RelinkDialog media={media.relink} disabled={media.disabled} onChoose={media.chooseRelink} onVerify={media.verify} onClose={() => media.setRelink(null)} />
    <RecoveryDialog project={project} /><CloseFailureDialog project={project} />
    {project.error && !project.closePending && !project.recovery && <div className="project-notice" role="alert"><span>{project.error.message}</span><button className="button" disabled={project.busy} onClick={() => void project.retry()}>重试</button><button className="button" disabled={project.busy || !project.active} onClick={() => void project.saveAs()}>另存我的项目副本…</button><button className="button button-quiet" onClick={project.dismissError}>关闭提示</button></div>}
  </CollaborationContext.Provider>;
}
