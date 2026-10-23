import type { CollaborationController } from './controller';
import type { CollaborationUI } from './useCollaboration';
export function syncLabel(c:CollaborationController){
 const s=c.status;
 if(c.error||s?.error)return s?.error?.code==='RevisionConflict'?'共享冲突':'同步异常';
 const authorError=s?.snapshot?.authors.some(a=>a.error!==null)??false;
 if(c.owner.lifecycle.hasPendingWork)return authorError?'作者读取异常 · 未保存':'本机未保存';
 if(s?.pending)return authorError?'作者读取异常 · 待同步':'已存本机 · 待同步';
 if(authorError)return '部分作者读取异常';
 if(!c.owner.collaboration?.actor)return '访客 · 仅存本机';
 return s?.lastSuccessMs?'已同步':'正在同步';
}
export function CollaborationStatus({ui}:{ui:CollaborationUI}){if(!ui.controller)return null;return <button className="collaboration-status" disabled={ui.busy} onClick={()=>void ui.show('status')} title={syncLabel(ui.controller)}><span>{ui.active?.collaboration?.actor?.displayName??'访客'}</span><span aria-label="协作同步状态">{syncLabel(ui.controller)}</span></button>;}
