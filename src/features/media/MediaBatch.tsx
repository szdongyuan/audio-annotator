import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import type { AuthorSnapshot } from '../../bridge/collaboration';
import type { Annotation } from '../../bridge/types';
import type { RecycleController, RecycleDraft } from './recycle';
import { MediaDialog } from './MediaDialog';
export function TriCheckbox({ids,selected,onToggle,label}:{ids:string[];selected:ReadonlySet<string>;onToggle:(ids:string[])=>void;label:string}) {
  const ref=useRef<HTMLInputElement>(null),count=ids.filter(id=>selected.has(id)).length;
  useEffect(()=>{if(ref.current)ref.current.indeterminate=count>0&&count<ids.length;},[count,ids.length]);
  return <input ref={ref} type="checkbox" aria-label={label} checked={ids.length>0&&count===ids.length} disabled={!ids.length} onChange={()=>onToggle(ids)}/>;
}
export function useMediaBatch(scope:string, ids:string[], disabled:boolean, onHide:((ids:string[],hidden:boolean)=>Promise<void>)|undefined,recycle:RecycleController|null|undefined) {
  const [mode,setMode]=useState(false),[state,setState]=useState({scope,ids:[] as string[]}),anchor=useRef<string|null>(null);
  const allowed=new Set(ids),selected=new Set(state.scope===scope?state.ids.filter(id=>allowed.has(id)):[]);
  const [pending,setPending]=useState(false),[error,setError]=useState<string|null>(null),[notice,setNotice]=useState<{text:string;undo?:()=>Promise<void>}|null>(null);
  const [confirm,setConfirm]=useState<{scope:string;draft:RecycleDraft;trigger:HTMLElement|null}|null>(null);
  const current=useRef(scope);current.current=scope;
  useEffect(()=>{setState({scope,ids:[]});anchor.current=null;setConfirm(null);setNotice(null);setError(null);},[scope]);
  useEffect(()=>{if(!notice)return;const timer=setTimeout(()=>setNotice(null),6000);return()=>clearTimeout(timer);},[notice]);
  const busy=disabled||pending||!!recycle?.pending;
  const replace=(next:string[])=>{setState({scope,ids:next});};
  const toggle=(targets:string[])=>{if(busy)return;setMode(true);const next=new Set(selected),remove=targets.every(id=>next.has(id));for(const id of targets)remove?next.delete(id):next.add(id);replace([...next]);};
  const pick=(id:string,e:MouseEvent)=>{if(busy)return;if(e.shiftKey&&anchor.current&&ids.includes(anchor.current)){const a=ids.indexOf(anchor.current),b=ids.indexOf(id);setMode(true);replace([...new Set([...selected,...ids.slice(Math.min(a,b),Math.max(a,b)+1)])]);}else toggle([id]);anchor.current=id;};
  const hide=async(hidden:boolean,targets=[...selected])=>{
    if(busy||!onHide||!targets.length)return;setPending(true);setError(null);
    try{await onHide(targets,hidden);if(current.current!==scope)return;replace([]);setNotice({text:`已${hidden?'隐藏':'取消隐藏'} ${targets.length} 个音频`,undo:()=>onHide(targets,!hidden)});}
    catch(e){if(current.current===scope)setError(e instanceof Error?e.message:(e as {message?:string}).message??'操作失败，请重试');}
    finally{setPending(false);}
  };
  const requestTrash=(trash:boolean,targets=[...selected])=>{if(busy||!recycle?.writable||!recycle.snapshot||!targets.length)return;setConfirm({scope,draft:recycle.beginEdit({operationId:crypto.randomUUID(),mediaIds:targets,trash}),trigger:document.activeElement as HTMLElement});};
  const submit=async()=>{if(!confirm||confirm.scope!==scope||busy||!recycle)return;const target=confirm;const ok=await recycle.submit(target.draft);if(ok&&current.current===scope){setConfirm(null);replace([]);setNotice({text:target.draft.operation.trash?'已移入共享回收站':'已从回收站恢复；个人隐藏设置保持不变'});}};
  const keys=(e:KeyboardEvent)=>{
    if((e.target as HTMLElement).closest('input:not([type="checkbox"]),textarea,select,[role="dialog"],[role="menu"]'))return;
    if(e.key==='Delete'){e.preventDefault();e.stopPropagation();if(selected.size)requestTrash(true);}
    else if(e.key==='Escape'){e.preventDefault();e.stopPropagation();if(!busy){setMode(false);replace([]);}}
    else if(e.key.toLowerCase()==='a'&&(e.ctrlKey||e.metaKey)){e.preventDefault();e.stopPropagation();if(!busy){setMode(true);replace(ids);}}
  };
  return {mode,setMode,selected,toggle,pick,replace,busy,hide,requestTrash,keys,notice,error,confirm:confirm?.scope===scope?confirm:null,submit,cancel:()=>{if(!busy)setConfirm(null);},undo:async()=>{if(!notice?.undo||busy)return;setPending(true);try{await notice.undo();setNotice(null);}catch(e){setError((e as Error).message??'撤销失败');}finally{setPending(false);}}};
}
export type MediaBatch=ReturnType<typeof useMediaBatch>;
export function BatchActions({batch:b,view,canHide,canTrash}:{batch:MediaBatch;view:string;canHide:boolean;canTrash:boolean}) {
  return <>{b.mode&&<div className="media-batch-actions"><span>已选 {b.selected.size}</span>{view==='trash'?<button disabled={b.busy||!canTrash||!b.selected.size} onClick={()=>b.requestTrash(false)}>恢复</button>:<><button disabled={b.busy||!canHide||!b.selected.size} onClick={()=>void b.hide(view!=='hidden')}>{view==='hidden'?'取消隐藏':'隐藏'}</button><button disabled={b.busy||!canTrash||!b.selected.size} onClick={()=>b.requestTrash(true)}>移入回收站</button></>}<button disabled={b.busy} onClick={()=>{b.setMode(false);b.replace([]);}}>完成</button></div>}
  {(b.error||b.notice)&&<div className="media-batch-notice" role={b.error?'alert':'status'}>{b.error??b.notice?.text}{b.notice?.undo&&<button disabled={b.busy} onClick={()=>void b.undo()}>撤销</button>}</div>}</>;
}
export function BatchConfirmation({batch:b,recycle,annotations,authors}:{batch:MediaBatch;recycle:RecycleController;annotations:Annotation[];authors:AuthorSnapshot[]}) {
  const c=b.confirm;if(!c)return null;
  const ids=new Set(c.draft.operation.mediaIds),trash=c.draft.operation.trash;
  const own=annotations.filter(a=>ids.has(a.region.mediaId)).length;
  const involved=authors.filter(a=>a.layer?.payload.annotations.some(a=>ids.has(a.region.mediaId))||a.layer?.payload.mediaLabels.some(m=>ids.has(m.mediaId)&&(m.note||m.categoryIds.length||m.channelNotes.some(Boolean)||m.channelCategoryIds.some(c=>c.length))));
  return <MediaDialog title={trash?'移入共享回收站':'恢复音频'} returnFocus={c.trigger} busy={b.busy} onClose={b.cancel}><header><h2>{trash?'移入共享回收站':'恢复音频'}</h2></header><div className="source-import-body"><p>{c.draft.operation.mediaIds.length} 个音频{trash?'将从所有协作者的正常列表移除。':'将恢复到原目录。'}</p>{trash&&<><p>我的区域标注：{own}；已加载的作者中，{involved.length} 人有标注或备注。</p><p>音频、目录位置和所有作者的标注均保留，可在回收站恢复。未加载的作者也会保留。</p></>}{recycle.error&&<p role="alert">{recycle.error.message}；选中项目已保留，请核对后重试。</p>}</div><footer className="dialog-actions"><button className="button" disabled={b.busy} onClick={b.cancel}>取消</button><button className="button button-accent" disabled={b.busy} onClick={()=>void b.submit()}>{recycle.error?'核对并重试':trash?'移入回收站':'恢复音频'}</button></footer></MediaDialog>;
}
