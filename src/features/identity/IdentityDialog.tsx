import { useEffect, useRef, useState } from 'react';
import { normalizeNickname } from '../../bridge/profiles';
import { parseCollaborationError } from '../../bridge/collaboration';
import type { AppError } from '../../bridge/types';
import type { IdentityController } from './controller';
import '../../styles/collaboration.css';
function warningCause(warning:AppError|null):string|null {
 const details=warning?.details;
 if(!details||typeof details!=='object'||Array.isArray(details)||!('cause' in details))return null;
 // The native optional cause is an AppError. Reuse its bounded parser, and
 // keep the committed local-success warning usable if optional data is invalid.
 try{return parseCollaborationError(details.cause).message;}catch{return null;}
}
export function IdentityDialog({controller:c}:{controller:IdentityController}){
 const ref=useRef<HTMLElement>(null),[name,setName]=useState(''),[inputError,setInputError]=useState(''),[copied,setCopied]=useState('');const kind=c.dialog;
 useEffect(()=>{setName(kind==='rename'?c.selected?.displayName??'':'');setInputError('');setCopied('');if(!kind)return;const previous=c.returnFocus??(document.activeElement as HTMLElement|null);ref.current?.focus();return()=>{previous?.focus();};},[kind]);
 if(!kind)return null;
 const cause=warningCause(c.warning);
 const title={create:'创建身份',switch:'切换身份',rename:'修改昵称',import:'导入身份',export:'导出当前身份'}[kind];
 return <div className="dialog-backdrop" onPointerDown={e=>{if(e.target===e.currentTarget&&!c.busy)c.close();}}><section ref={ref} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} className="project-dialog collaboration-dialog" onKeyDown={e=>{
  if(e.key==='Escape'&&!c.busy){e.stopPropagation();c.close();}
  if(e.key==='Tab'){const els=[...(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),summary')??[])],first=els[0],last=els.at(-1);if(e.shiftKey&&(document.activeElement===first||document.activeElement===ref.current)){e.preventDefault();last?.focus();}else if(!e.shiftKey&&(document.activeElement===last||document.activeElement===ref.current)){e.preventDefault();first?.focus();}}
 }}><h2>{title}</h2>
 {(kind==='create'||kind==='rename')&&<form onSubmit={e=>{e.preventDefault();if(c.busy)return;try{const value=normalizeNickname(name);setInputError('');void(kind==='create'?c.create(value):c.rename(value));}catch{setInputError('昵称需为 1–64 个字符，不能包含控制字符。');}}}>
  <label>身份昵称<input aria-label="身份昵称" required value={name} disabled={c.busy} onChange={e=>setName(e.target.value)}/></label>
  <button className="button button-accent" disabled={c.busy||!c.snapshot}>{kind==='create'?'创建并使用':'保存昵称'}</button>
 </form>}
 {kind==='switch'&&<ul className="identity-list">{c.snapshot?.profiles.map(p=><li key={p.authorId}><div><strong>{p.displayName}</strong> · <code>{p.authorId.slice(0,8)}</code>{p.authorId===c.snapshot?.selectedAuthorId&&<span> · 当前身份</span>}</div><details><summary>查看完整 UUID</summary><input aria-label="完整身份 UUID" readOnly value={p.authorId}/><button className="button" onClick={()=>void navigator.clipboard.writeText(p.authorId).then(()=>setCopied(p.authorId)).catch(()=>setInputError('复制失败，请选中 UUID 手动复制。'))}>复制 UUID</button></details><button className="button" disabled={c.busy||p.authorId===c.snapshot?.selectedAuthorId} onClick={()=>void c.select(p.authorId)}>使用此身份</button></li>)}</ul>}
 {kind==='import'&&<><p>导入后保留当前身份，可再选择使用导入的身份。</p><button className="button button-accent" disabled={c.busy||!c.snapshot} onClick={()=>void c.import()}>选择身份文件…</button></>}
 {kind==='export'&&<><p>{c.selected?.displayName} · {c.selected?.authorId}</p><p>身份文件仅包含 UUID、昵称和创建时间。</p><button className="button button-accent" disabled={c.busy||!c.selected} onClick={()=>void c.export()}>选择保存位置…</button></>}
 {c.result&&<div role="status">{kind==='import'?c.result.profile?(c.result.alreadyExists?'该身份已存在，保留本机昵称和创建时间。':'身份已导入，当前身份未改变。'):'当前身份已更新。':kind==='export'?'身份已导出。':kind==='rename'?'昵称已保存。':kind==='create'?'身份已创建。':'当前身份已更新。'}{c.result.profile&&c.result.profile.authorId!==c.selected?.authorId&&<button className="button" disabled={c.busy} onClick={()=>void c.select(c.result!.profile!.authorId)}>使用此身份</button>}</div>}
 {copied&&<p role="status">已复制 UUID：{copied}</p>}
 {c.busy&&<p role="status"><progress aria-label="身份操作进度"/>正在处理身份操作…</p>}
 {(c.error||inputError)&&<p role="alert">{c.error?.message??inputError}</p>}
 {c.warning&&<p role="alert">{c.warning.message}{cause&&<> · 原因：{cause}</>}</p>}
 {!c.snapshot&&c.error&&<button className="button" disabled={c.busy} onClick={()=>void c.refresh()}>重试加载身份</button>}
 <div className="dialog-actions"><button className="button" onClick={()=>c.busy?c.cancel():c.close()}>{c.busy?'取消任务':'关闭'}</button></div>
 </section></div>;
}
