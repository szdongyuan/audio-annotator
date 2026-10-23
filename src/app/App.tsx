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
  return <><div className="app-root" inert={!!exchange.dialog || project.closePending || !!project.recovery || !!media.relink || (!!project.active && project.editingDisabled)}><AppShell project={project} mediaUI={media} exchange={exchange} /></div>
    {exchange.dialog === 'export' && <ExportDialog {...exchange} onStart={exchange.startExport} />}
    {exchange.dialog === 'import' && <ImportDialog {...exchange} onStart={exchange.startImport} />}
    <RelinkDialog media={media.relink} disabled={media.disabled} onChoose={media.chooseRelink} onVerify={media.verify} onClose={() => media.setRelink(null)} />
    <RecoveryDialog project={project} /><CloseFailureDialog project={project} />
    {project.error && !project.closePending && !project.recovery && <div className="project-notice" role="alert"><span>{project.error.message}</span><button className="button" disabled={project.busy} onClick={() => void project.retry()}>重试</button><button className="button" disabled={project.busy || !project.active} onClick={() => void project.saveAs()}>另存项目副本…</button><button className="button button-quiet" onClick={project.dismissError}>关闭提示</button></div>}
  </>;
}
