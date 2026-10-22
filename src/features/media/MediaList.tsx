import { useState } from 'react';
import { FileAudio2, ListMusic, Plus, Search, Link2 } from 'lucide-react';
import type { Annotation, MediaDescriptor } from '../../bridge/types';
import type { MediaStatus } from '../../bridge/media';
export const statusLabel = { ready: '已校验', missing: '源文件缺失', changed: '源文件已改变', unverified: '等待校验' };
export function MediaList({ media, annotations, statuses, selectedId, disabled, onSelect, onImport, onRelink }: {
  media: MediaDescriptor[]; annotations: Annotation[]; statuses: MediaStatus[]; selectedId: string | null; disabled: boolean;
  onSelect: (id: string) => void; onImport: () => void; onRelink: (media: MediaDescriptor) => void;
}) {
  const [search, setSearch] = useState('');
  const visible = media.filter(m => m.displayName.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  return <>
    <div className="panel-heading"><h2><ListMusic size={16} />音频文件<span className="count">{media.length}</span></h2><button className="icon-button" aria-label="添加音频" onClick={onImport} disabled={disabled}><Plus size={17} /></button></div>
    <div className="media-filters"><label className="search-field"><Search size={15} aria-hidden="true" /><input aria-label="搜索音频" placeholder="搜索音频文件…" value={search} onChange={e => setSearch(e.target.value)} /></label></div>
    <div className="media-items">{visible.length ? visible.map(m => {
      const status = statuses.find(s => s.mediaId === m.id)?.status ?? 'unverified';
      return <div key={m.id} className={`media-card ${selectedId === m.id ? 'is-selected' : ''}`}>
        <button className="media-select" onClick={() => onSelect(m.id)} aria-pressed={selectedId === m.id}>
          <FileAudio2 size={19} /><span><strong>{m.displayName}</strong><small>{m.channelCount} 通道 · {(m.frameCount / m.sampleRate).toFixed(3)} 秒 · {m.sampleRate / 1000} kHz</small><small>{annotations.filter(a => a.region.mediaId === m.id).length} 个标注</small></span>
        </button>
        <div className={`media-availability ${status}`}><span>{statusLabel[status]}</span>{status !== 'ready' && <button onClick={() => onRelink(m)} disabled={disabled}><Link2 size={12} />重新关联</button>}</div>
      </div>;
    }) : <div className="sidebar-empty"><FileAudio2 size={30} strokeWidth={1.25} /><p>{media.length ? '没有匹配的音频' : '还没有音频文件'}</p><span>导入后在此管理文件与通道</span></div>}</div>
    <div className="panel-footnote"><span className="tiny-dot" />{visible.length} / {media.length} 个文件<span>本地存储</span></div>
  </>;
}
