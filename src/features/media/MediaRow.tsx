import {memo,type MouseEvent,type KeyboardEvent} from 'react';
import {FileAudio2} from 'lucide-react';
export const statusLabel={ready:'已校验',missing:'源文件缺失',changed:'源文件已改变',unverified:'等待校验'};
export interface MediaRowActions{
 menu:(event:MouseEvent<HTMLElement>|KeyboardEvent<HTMLElement>,id:string)=>void;
 select:(event:MouseEvent<HTMLButtonElement>,id:string)=>void;
 pick:(event:MouseEvent<HTMLInputElement>,id:string)=>void;
}
function StructuredName({name}:{name:string}){
 const parts=name.split('/');if(parts.length<2)return <>{name}</>;
 const filename=parts.pop()!;if(parts.at(-1)?.toLowerCase()==='audio')parts.pop();
 return <><span className="media-record-name">{parts.at(-1)??''}</span><span className="media-file-name">{filename}</span></>;
}
/** Native status changes must reconcile only the affected rows, not every icon. */
export const MediaRow=memo(function MediaRow({id,name,title,status,selected,batchSelected,batchMode,batchBusy,actions}:{
 id:string;name:string;title:string;status:keyof typeof statusLabel;selected:boolean;batchSelected:boolean;batchMode:boolean;batchBusy:boolean;actions:MediaRowActions;
}){
 return <div className={`media-card ${selected?'is-selected':''} ${batchSelected?'is-batch-selected':''}`} onContextMenu={e=>actions.menu(e,id)}>
  {batchMode&&<input type="checkbox" aria-label={`选择音频 · ${name}`} checked={batchSelected} disabled={batchBusy} onClick={e=>actions.pick(e,id)} onChange={()=>{}}/>}
  <button className="media-select" data-media-id={id} onKeyDown={e=>{if(e.key==='ContextMenu'||e.key==='F10'&&e.shiftKey)actions.menu(e,id);}} onClick={e=>actions.select(e,id)} aria-pressed={selected} title={title} aria-label={name}>
   <span className="media-file-disclosure" aria-hidden="true"/><FileAudio2 size={14}/><strong className={name.includes('/')?'media-display-name':undefined}><StructuredName name={name}/></strong><span className={`media-row-status ${status}`} aria-label={statusLabel[status]} title={statusLabel[status]}>{status==='ready'?'✓':status==='unverified'?'·':'!'}</span>
  </button>
 </div>;
});
