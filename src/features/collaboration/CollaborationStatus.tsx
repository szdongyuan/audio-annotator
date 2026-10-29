import type { CopyProgress } from '../../bridge/collaboration';
import type { CollaborationController } from './controller';
import type { CollaborationUI } from './useCollaboration';
export function syncLabel(c:CollaborationController){
 const s=c.status;
 if(c.error||s?.error)return s?.error?.code==='RevisionConflict'?'共享冲突':'同步异常';
 if(c.catalogError)return '音频列表更新失败 · 可重试';
 const authorError=s?.snapshot?.authors.some(a=>a.error!==null)??false;
 if(c.owner.lifecycle.hasPendingWork)return authorError?'作者读取异常 · 未保存':'本机未保存';
 if(s?.pending)return authorError?'作者读取异常 · 待同步':'已存本机 · 待同步';
 if(authorError)return '部分作者读取异常';
 if(s?.catalogPending)return '有新增音频 · 更新列表后查看';
 if(c.owner.collaboration?.identityMode==='viewOnly')return '只读查看';
 if(!c.owner.collaboration?.actor)return '本机项目';
 return s?.lastSuccessMs?'已同步':'正在同步';
}
export function CollaborationStatus({ui}:{ui:CollaborationUI}){if(!ui.controller)return null;return <button className="collaboration-status" disabled={ui.busy} onClick={()=>void ui.show('status')} title={syncLabel(ui.controller)}><span>{(ui.controller.status?.actor??ui.active?.collaboration?.actor)?.displayName??(ui.active?.collaboration?.identityMode==='viewOnly'?'只读查看':'本机项目')}</span><span aria-label="协作同步状态">{syncLabel(ui.controller)}</span></button>;}

export function copyProgressText(p:CopyProgress){
 if(p.phase==='publishManifest')return `保存项目 · ${p.completed} 个音频`;
 if(p.phase==='copyMedia'||p.phase==='hashing')return `${p.phase==='copyMedia'?'复制音频':'校验音频'} · ${(p.completed/1048576).toFixed(1)} MiB`;
 if(p.phase==='decoding')return `解码音频 · ${p.completed.toLocaleString()} 帧`;
 return '正在准备副本…';
}
