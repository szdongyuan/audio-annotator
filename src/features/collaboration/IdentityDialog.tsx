import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { CollaborationUI } from './useCollaboration';
import { AuthorFilter } from './AuthorFilter';
import { syncLabel,copyProgressText } from './CollaborationStatus';
import '../../styles/collaboration.css';
const noTimeSubscription=()=>()=>{},zeroTime=()=>0;
export function IdentityDialog({ui}:{ui:CollaborationUI}){
 const ref=useRef<HTMLElement>(null);
 useSyncExternalStore(ui.controller?.subscribeTime??noTimeSubscription,ui.controller?.getSuccessTime??zeroTime);
 const kind=ui.dialog?.kind;
 useEffect(()=>{const previous=document.activeElement as HTMLElement|null;ref.current?.focus();return()=>{previous?.focus();};},[kind]);
 if(!ui.dialog)return null;
 const title=kind==='create'?'创建协作副本':kind==='conflict'?'加载共享版本':'协作状态与作者显示';
 const c=ui.controller,s=c?.status;
 return <div className="dialog-backdrop" onPointerDown={e=>{if(e.target===e.currentTarget&&!ui.busy)ui.cancel();}}><section ref={ref} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} className="project-dialog collaboration-dialog" onKeyDown={e=>{
  if(e.key==='Escape'&&!ui.busy){e.stopPropagation();ui.cancel();}
  if(e.key==='Tab'){const els=[...(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select,summary')??[])],first=els[0],last=els.at(-1);if(e.shiftKey&&(document.activeElement===first||document.activeElement===ref.current)){e.preventDefault();last?.focus();}else if(!e.shiftKey&&(document.activeElement===last||document.activeElement===ref.current)){e.preventDefault();first?.focus();}}
 }}><h2>{title}</h2>
 {kind==='conflict'&&<><p>加载共享版本将丢弃当前身份的待同步标注和撤销历史，保留个人设置。可先另存本机副本保留恢复材料。</p><button className="button" disabled={ui.busy} onClick={ui.saveAs}>另存我的项目副本…</button><button className="button button-accent" disabled={ui.busy} onClick={ui.confirm}>确认加载共享版本</button></>}
 {kind==='status'&&c&&<><p role="status">{syncLabel(c)}{s?.lastSuccessMs?` · 最近更新 ${new Date(s.lastSuccessMs).toLocaleTimeString('zh-CN')}`:''}</p>{(c.error||s?.error)&&<p role="alert">{(c.error??s?.error)?.message}</p>}{c.catalogError&&<p role="alert">{c.catalogError.message}</p>}<AuthorFilter controller={c}/>{s?.snapshot?.authors.filter(a=>a.error).map(a=><p role="alert" key={a.identity.authorId}>{a.identity.displayName}：{a.error?.message}（保留上次可用图层）</p>)}<button className="button" disabled={ui.busy} onClick={ui.sync}>保存并同步</button>{s?.catalogPending&&<button className="button" disabled={ui.busy} onClick={ui.adoptCatalog}>{c.catalogError?'重试更新音频列表':'更新音频列表'}</button>}</>}
 {ui.busy&&<p role="status"><progress aria-label="协作操作进度"/>{ui.progress?copyProgressText(ui.progress):'正在保存与处理协作任务…'}</p>}
 {ui.error&&<p role="alert" className="project-error">{ui.error.message}</p>}
 <div className="dialog-actions"><button className="button" onClick={ui.cancel}>{ui.busy?'取消任务':'关闭'}</button></div>
 </section></div>;
}
