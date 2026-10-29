import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Play, MoreHorizontal, Plus, RefreshCw } from 'lucide-react';
import { exampleClient, type ExampleEntry, type ExampleOwner, type ExampleScope } from '../../bridge/examples';
import type { MediaDescriptor } from '../../bridge/types';
import type { ActiveProject } from '../project/useProjectLifecycle';
import type { IdentityController } from '../identity/controller';
import type { PlaybackUI } from '../playback/usePlayback';
import { MediaDialog } from '../media/MediaDialog';
import { Menu } from '../../components/menu/Menu';
import { ExampleController, exampleOwner, friendlyName, nameError } from './controller';
import { ExamplePreview } from './ExamplePreview';
import './examples.css';

const noop=()=>()=>{},zero=()=>0;
type PreviewAction=(entry:ExampleEntry,play:boolean,trigger:HTMLElement)=>void;
export function ExampleLibrary({active,identity,selected,playback,visible,authors=[]}:{active:ActiveProject|null;identity?:IdentityController;selected?:MediaDescriptor;playback:PlaybackUI;visible:boolean;authors?:{authorId:string;displayName:string}[]}){
 useSyncExternalStore(identity?.subscribe??noop,identity?.getVersion??zero);
 const owner=exampleOwner(active,identity);
 useEffect(()=>{if(active&&identity&&!identity.snapshot)void identity.refresh();},[active,identity]);
 if(!active)return visible?<p className="example-empty">打开项目后查看示例</p>:null;
 if(!owner)return visible?<p role="status">正在读取项目身份…</p>:null;
 return <OwnedLibrary key={`${owner.runtimeNonce}/${owner.projectId}/${owner.actorId}`} owner={owner} selected={selected} playback={playback} visible={visible} authors={authors}/>;
}
function OwnedLibrary({owner,selected,playback,visible,authors}:{owner:ExampleOwner;selected?:MediaDescriptor;playback:PlaybackUI;visible:boolean;authors:{authorId:string;displayName:string}[]}){
 const controller=useMemo(()=>new ExampleController(owner),[]);
 const alive=useRef(true),chooseGeneration=useRef(0);
 const [preview,setPreview]=useState<{entry:ExampleEntry;play:boolean;trigger:HTMLElement;id:string}|null>(null);
 useSyncExternalStore(controller.subscribe,controller.getVersion);
 useEffect(()=>{alive.current=true;controller.start();return()=>{alive.current=false;chooseGeneration.current++;controller.dispose();};},[controller]);
 useEffect(()=>{if(!visible)return;void controller.refresh();const timer=setInterval(()=>{if(!controller.busy&&!controller.refreshing&&document.visibilityState!=='hidden')void controller.refresh(controller.scope,true);},5000);return()=>clearInterval(timer);},[controller,visible,controller.scope]);
 const choose=async()=>{const generation=++chooseGeneration.current;try{const paths=await exampleClient.choose();if(alive.current&&generation===chooseGeneration.current&&paths.length)controller.setImportPaths(paths);}catch(e){if(alive.current){controller.error=e instanceof Error?e.message:'无法选择示例文件';controller.setSearch(controller.search);}}};
 return <>{visible&&<ExampleLibraryPanel controller={controller} selected={selected} authors={authors} onChoose={()=>void choose()} onPreview={(entry,play,trigger)=>setPreview({entry,play,trigger,id:crypto.randomUUID()})}/>}
  {preview&&<ExamplePreview key={preview.id} binding={owner} entry={preview.entry} autoplay={preview.play} playback={playback} returnFocus={preview.trigger} onClose={()=>setPreview(null)}/>}
 </>;
}
export function ExampleLibraryPanel({controller:c,selected,authors=[],onChoose,onPreview}:{controller:ExampleController;selected?:MediaDescriptor;authors?:{authorId:string;displayName:string}[];onChoose:()=>void;onPreview:PreviewAction}){
 useSyncExternalStore(c.subscribe,c.getVersion);
 const [context,setContext]=useState<{entry:ExampleEntry;x:number;y:number;trigger:HTMLElement}|null>(null);
 const [current,setCurrent]=useState<{name:string;scope:ExampleScope;trigger:HTMLElement}|null>(null);
 const importOpen=c.importOpen,setImportOpen=(open:boolean)=>c.setImportOpen(open);
 const renameTrigger=useRef<HTMLElement|null>(null);
 useEffect(()=>{setContext(null);},[c.scope]);
 const creator=(id:string)=>authors.find(a=>a.authorId===id)?.displayName??(id===c.owner.actorId?'我':id.slice(0,8));
 const draft=c.renameDraft;
 return <div className="example-library">
  <div className="example-scopes" role="tablist" aria-label="示例范围">{(['private','shared'] as const).map(scope=><button key={scope} role="tab" aria-selected={c.scope===scope} disabled={c.busy||scope==='private'&&!c.owner.actorId} onClick={()=>c.setScope(scope)}>{scope==='private'?'我的示例':'共享示例'}</button>)}</div>
  <div className="example-tools"><input type="search" aria-label="筛选示例" placeholder="筛选名称" value={c.search} onChange={e=>c.setSearch(e.target.value)}/><button className="icon-button" aria-label="刷新示例" title="刷新示例" disabled={c.loading||c.busy} onClick={()=>void c.refresh()}><RefreshCw size={14}/></button><button className="icon-button" aria-label="导入示例" title="导入示例" disabled={!c.canMutate||c.busy} onClick={onChoose}><Plus size={16}/></button></div>
  <button className="text-button example-add-current" disabled={!c.canMutate||c.busy||!selected} onClick={e=>{if(selected)setCurrent({name:friendlyName(selected.displayName),scope:c.scope,trigger:e.currentTarget});}}>添加当前音频为示例</button>
  {c.rows.length>0&&<button className="text-button" onClick={()=>setImportOpen(true)}>查看导入结果</button>}
  {c.error&&!draft&&!current&&!importOpen&&<p role="alert" className="example-error">{c.error}</p>}
  {c.loading&&!c.entries.length?<p role="status">正在读取示例…</p>:!c.filtered.length?<p className="example-empty">{c.search?'没有匹配的示例':'暂无示例'}</p>:<ul className="example-list" aria-label="示例列表">{c.filtered.map(entry=><li key={`${entry.creatorId}/${entry.sampleId}`} data-sample-id={entry.sampleId} onContextMenu={e=>{e.preventDefault();const trigger=e.currentTarget.querySelector<HTMLButtonElement>('.example-name')!;setContext({entry,x:e.clientX,y:e.clientY,trigger});}}>
   <button className="icon-button" aria-label={`播放示例 ${entry.name}`} onClick={e=>onPreview(entry,true,e.currentTarget)}><Play size={14}/></button>
   <button className="example-name" title={`${entry.name}\n${entry.originalFilename}`} onClick={e=>onPreview(entry,false,e.currentTarget)}>{entry.name}</button>
   {c.scope==='shared'&&<small className="example-creator" title={creator(entry.creatorId)}>{creator(entry.creatorId)}</small>}
   <button className="icon-button" aria-label={`示例操作 ${entry.name}`} aria-haspopup="menu" onClick={e=>{const r=e.currentTarget.getBoundingClientRect();setContext({entry,x:r.left,y:r.bottom,trigger:e.currentTarget});}}><MoreHorizontal size={14}/></button>
  </li>)}</ul>}
  {context&&<Menu anchor={context} returnFocus={context.trigger} onClose={()=>setContext(null)} items={[
   {id:'spectrum',label:'查看频谱',action:()=>onPreview(context.entry,false,context.trigger)},
   ...(c.owns(context.entry)?[{id:'rename',label:'重命名',disabled:c.busy,action:()=>{renameTrigger.current=context.trigger;c.beginRename(context.entry);}},{id:'remove',label:'移除示例',disabled:c.busy,action:()=>void c.remove(context.entry)}]:[]),
   ...(c.canMutate?[{id:'copy',label:context.entry.scope==='private'?'复制到共享示例':'复制到我的示例',disabled:c.busy,action:()=>void c.copy(context.entry)}]:[]),
  ]}/>}
  {draft&&<MediaDialog title="重命名示例" returnFocus={renameTrigger.current} busy={c.busy} onClose={()=>c.cancelRename()}><header><h2>重命名示例</h2></header><div className="source-import-body"><label>示例名称<input autoFocus aria-label="示例名称" value={draft.name} onChange={e=>c.setRename(e.target.value)}/></label>{c.error&&<p role="alert">{c.error}</p>}</div><footer className="dialog-actions"><button className="button" disabled={c.busy} onClick={()=>c.cancelRename()}>取消</button><button className="button button-accent" disabled={c.busy} onClick={()=>void c.saveRename()}>保存名称</button></footer></MediaDialog>}
  {current&&selected&&<MediaDialog title="添加当前音频为示例" returnFocus={current.trigger} busy={c.busy} onClose={()=>setCurrent(null)}><header><h2>添加当前音频为示例</h2></header><div className="source-import-body"><ScopeSelect scope={current.scope} disabled={c.busy} allowPrivate={!!c.owner.actorId} onChange={scope=>setCurrent({...current,scope})}/><label>示例名称<input aria-label="示例名称" value={current.name} onChange={e=>setCurrent({...current,name:e.target.value})}/></label>{(nameError(current.name)||c.error)&&<p role="alert">{nameError(current.name)??c.error}</p>}</div><footer className="dialog-actions"><button className="button" disabled={c.busy} onClick={()=>setCurrent(null)}>取消</button><button className="button button-accent" disabled={c.busy} onClick={()=>void c.addCurrent(selected.id,current.name,current.scope).then(ok=>{if(ok)setCurrent(null);})}>添加示例</button></footer></MediaDialog>}
  {importOpen&&c.rows.length>0&&<MediaDialog title="导入示例" busy={c.busy} onClose={()=>setImportOpen(false)}><header><h2>导入示例</h2></header><div className="source-import-body example-import"><ScopeSelect scope={c.importScope} disabled={c.busy||c.rows.some(row=>row.state==='success')} allowPrivate={!!c.owner.actorId} onChange={scope=>c.setImportScope(scope)}/>{c.error&&<p role="alert">{c.error}</p>}{c.rows.map((row,i)=><div className="example-import-row" key={row.id}><span title={row.path}>{row.path.split(/[\\/]/).at(-1)}</span><input aria-label={`导入名称 ${i+1}`} value={row.name} disabled={c.busy||row.state==='success'} onChange={e=>c.editRow(row.id,e.target.value)}/><small role={row.error?'alert':'status'}>{row.state==='success'?'已导入':row.error??'待导入'}</small></div>)}</div><footer className="dialog-actions"><button className="button" disabled={c.busy} onClick={()=>setImportOpen(false)}>关闭</button><button className="button button-accent" disabled={c.busy||c.rows.every(r=>r.state==='success')} onClick={()=>void c.importRows()}>导入待处理文件</button></footer></MediaDialog>}
 </div>;
}
function ScopeSelect({scope,disabled,allowPrivate,onChange}:{scope:ExampleScope;disabled:boolean;allowPrivate:boolean;onChange:(scope:ExampleScope)=>void}){return <label>保存到<select aria-label="保存示例到" value={scope} disabled={disabled} onChange={e=>onChange(e.target.value as ExampleScope)}><option value="private" disabled={!allowPrivate}>我的示例</option><option value="shared">共享示例</option></select></label>;}
