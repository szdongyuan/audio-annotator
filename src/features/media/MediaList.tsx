import { useState } from 'react';
import { FileAudio2, ListMusic, Plus, Search, Link2 } from 'lucide-react';
import type { Annotation, Category, MediaDescriptor } from '../../bridge/types';
import type { MediaStatus } from '../../bridge/media';
export const statusLabel = { ready: '已校验', missing: '源文件缺失', changed: '源文件已改变', unverified: '等待校验' };
function StructuredName({name}:{name:string}){const parts=name.split('/');if(parts.length<2)return <>{name}</>;const filename=parts.pop()!;if(parts.at(-1)?.toLowerCase()==='audio')parts.pop();const record=parts.at(-1)??'';return <><span className="media-record-name">{record}</span><span className="media-file-name">{filename}</span></>;}
export function MediaList({ hiddenMediaIds=[],onHide,onRestore,categories = [], catalogLocked = false, media, annotations, statuses, selectedId, disabled, onSelect, onImport, onRelink }: {
  hiddenMediaIds?:readonly string[];onHide?:(id:string)=>void;onRestore?:(id:string)=>void;catalogLocked?: boolean; categories?: Category[]; media: MediaDescriptor[]; annotations: Annotation[]; statuses: MediaStatus[]; selectedId: string | null; disabled: boolean;
  onSelect: (id: string) => void; onImport: () => void; onRelink: (media: MediaDescriptor) => void;
}) {
  const [search, setSearch] = useState('');
  const visible = media.filter(m => !hiddenMediaIds.includes(m.id)&&m.displayName.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  return <>
    <div className="panel-heading"><h2><ListMusic size={16} />音频文件<span className="count">{media.length-hiddenMediaIds.length}</span></h2><button className="icon-button" aria-label="添加音频" onClick={onImport} disabled={disabled || catalogLocked}><Plus size={17} /></button></div>
    <div className="media-filters"><label className="search-field"><Search size={15} aria-hidden="true" /><input aria-label="搜索音频" placeholder="搜索音频文件…" value={search} onChange={e => setSearch(e.target.value)} /></label></div>
    {hiddenMediaIds.length>0&&<details className="media-filters"><summary>显示隐藏音频（{hiddenMediaIds.length}）</summary>{media.filter(m=>hiddenMediaIds.includes(m.id)).map(m=><button className="button button-quiet" disabled={disabled} key={m.id} onClick={()=>onRestore?.(m.id)} title={m.displayName}>恢复 · {m.displayName}</button>)}</details>}
    <div className="media-items">{visible.length ? visible.map(m => {
      const status = statuses.find(s => s.mediaId === m.id)?.status ?? 'unverified';
      return <div key={m.id} className={`media-card ${selectedId === m.id ? 'is-selected' : ''}`}>
        <button className="media-select" onClick={() => onSelect(m.id)} aria-pressed={selectedId === m.id} title={m.displayName} aria-label={m.displayName}>
          <FileAudio2 size={19} /><span><strong className={m.displayName.includes('/')?'media-display-name':undefined}><StructuredName name={m.displayName}/></strong><small>{m.channelCount} 通道 · {(m.frameCount / m.sampleRate).toFixed(3)} 秒 · {m.sampleRate / 1000} kHz</small><small>{categories.find(c => c.id === m.categoryId)?.name ?? '未分类'} · {annotations.filter(a => a.region.mediaId === m.id).length} 个标注</small></span>
        </button>
        {onHide&&<button className="button button-quiet" disabled={disabled} onClick={()=>onHide(m.id)}>从我的列表隐藏</button>}
        {status !== 'ready' && <div className={`media-availability ${status}`}><span>{statusLabel[status]}</span><button onClick={() => onRelink(m)} disabled={disabled}><Link2 size={12} />重新关联</button></div>}
      </div>;
    }) : <div className="sidebar-empty"><FileAudio2 size={30} strokeWidth={1.25} /><p>{media.length ? '没有匹配的音频' : '还没有音频文件'}</p></div>}</div>

  </>;
}
