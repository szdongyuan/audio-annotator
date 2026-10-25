import { useEffect, useRef, useState } from 'react';
import type { CollaborationUI } from './useCollaboration';
import { AuthorFilter } from './AuthorFilter';
import { syncLabel,copyProgressText } from './CollaborationStatus';
import '../../styles/collaboration.css';
export function IdentityDialog({ui}:{ui:CollaborationUI}){
 const [login,setLogin]=useState(''),[displayName,setDisplayName]=useState(''),[password,setPassword]=useState('');const ref=useRef<HTMLElement>(null);
 const kind=ui.dialog?.kind;
 useEffect(()=>{setLogin('');setDisplayName('');setPassword('');const previous=document.activeElement as HTMLElement|null;ref.current?.focus();return()=>{previous?.focus();};},[kind]);
 if(!ui.dialog)return null;
 const title=kind==='create'?'创建协作副本':kind==='register'?'注册项目账号':kind==='login'?'登录项目账号':kind==='guest'?'发布本机访客标注':kind==='conflict'?'加载共享版本':'协作状态与作者显示';
 const form=kind==='register'||kind==='login',register=kind==='register',c=ui.controller,s=c?.status;
 return <div className="dialog-backdrop" onPointerDown={e=>{if(e.target===e.currentTarget&&!ui.busy)ui.cancel();}}><section ref={ref} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} className="project-dialog collaboration-dialog" onKeyDown={e=>{
  if(e.key==='Escape'&&!ui.busy){e.stopPropagation();ui.cancel();}
  if(e.key==='Tab'){const els=[...(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select,summary')??[])],first=els[0],last=els.at(-1);if(e.shiftKey&&(document.activeElement===first||document.activeElement===ref.current)){e.preventDefault();last?.focus();}else if(!e.shiftKey&&(document.activeElement===last||document.activeElement===ref.current)){e.preventDefault();first?.focus();}}
 }}><h2>{title}</h2>
 {form&&<form autoComplete="off" onSubmit={e=>{e.preventDefault();if(ui.busy)return;ui.submit({login,displayName,password});setPassword('');}}>
  <label>账号名<input aria-label="协作账号名" required maxLength={64} value={login} disabled={ui.busy} onChange={e=>setLogin(e.target.value)}/></label>
  {register&&<label>显示名称<input aria-label="协作显示名称" required maxLength={64} value={displayName} disabled={ui.busy} onChange={e=>setDisplayName(e.target.value)}/></label>}
  <label>密码<input aria-label="协作密码" type="password" autoComplete="new-password" required minLength={8} maxLength={128} value={password} disabled={ui.busy} onChange={e=>setPassword(e.target.value)}/></label>
  <details><summary>账号与共享范围</summary><p>账号仅属于这个共享项目。只共享各自的标注，播放、屏蔽和视图保存在本机。拥有 NAS 写权限的人仍可直接修改文件，目录权限由 NAS 管理。</p></details>
  <button type="submit" className="button button-accent" disabled={ui.busy}>{register?'注册并登录':'登录'}</button>
 </form>}
 {kind==='guest'&&<><p>从本机访客工作区复制标注、类别及文件/通道备注到当前账号。屏蔽和播放设置保持当前身份的值。此操作可一次撤销；已有内容冲突时会拒绝覆盖。</p><button className="button button-accent" disabled={ui.busy} onClick={ui.confirm}>确认复制访客标注</button></>}
 {kind==='conflict'&&<><p>加载共享版本将丢弃当前账号的待同步标注和撤销历史，保留个人设置。可先另存本机副本保留恢复材料。</p><button className="button" disabled={ui.busy} onClick={ui.saveAs}>另存我的项目副本…</button><button className="button button-accent" disabled={ui.busy} onClick={ui.confirm}>确认加载共享版本</button></>}
 {kind==='status'&&c&&<><p role="status">{syncLabel(c)}{s?.lastSuccessMs?` · 最近更新 ${new Date(s.lastSuccessMs).toLocaleTimeString('zh-CN')}`:''}</p>{(c.error||s?.error)&&<p role="alert">{(c.error??s?.error)?.message}</p>}<AuthorFilter controller={c}/>{s?.snapshot?.authors.filter(a=>a.error).map(a=><p role="alert" key={a.identity.authorId}>{a.identity.displayName}：{a.error?.message}（保留上次可用图层）</p>)}<button className="button" disabled={ui.busy} onClick={ui.sync}>保存并同步</button>{s?.catalogPending&&<button className="button" disabled={ui.busy} onClick={ui.adoptCatalog}>更新音频列表</button>}</>}
 {ui.busy&&<p role="status"><progress aria-label="协作操作进度"/>{ui.progress?copyProgressText(ui.progress):'正在保存与处理协作任务…'}</p>}
 {ui.error&&<p role="alert" className="project-error">{ui.error.message}</p>}
 <div className="dialog-actions"><button className="button" onClick={ui.cancel}>{ui.busy?'取消任务':'关闭'}</button></div>
 </section></div>;
}
