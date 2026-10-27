import { labelText, labelColor } from './labels';
import { useState } from 'react';
import type { ProjectDocument } from '../../bridge/types';
import { classificationResults, type ClassificationResult } from './classification';
import type { ListFilterControl, ListFilters } from './listFilters';
export function AnnotationList({ doc, selectedId, onLocate, filterControl }: { doc: ProjectDocument; selectedId: string | null; onLocate: (result: ClassificationResult) => void; filterControl?: ListFilterControl }) {
  const [localFilters, setLocalFilters] = useState<ListFilters>({ category: '*', channel: '*', query: '' });
  const { value, onChange } = filterControl ?? { value: localFilters, onChange: setLocalFilters };
  const { category, channel, query } = value;
  const results = classificationResults(doc);
  const list = results.filter(r => (category === '*' || (category === '' ? r.categoryIds.length === 0 : r.categoryIds.includes(category))) && (channel === '*' || (r.scope === 'channel' ? r.channelIndex : r.scope === 'region' ? r.annotation.region.channelIndex : null) === +channel) && r.note.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  return <div className="annotation-list"><div className="annotation-filters"><select aria-label="筛选类别" value={category} onChange={e => onChange({ ...value, category: e.target.value })}><option value="*">所有类别</option><option value="">未分类</option>{doc.categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select><select aria-label="筛选通道" value={channel} onChange={e => onChange({ ...value, channel: e.target.value })}><option value="*">所有通道</option>{Array.from({ length: Math.max(0, ...doc.media.map(m => m.channelCount)) }, (_, i) => <option key={i} value={i}>通道 {i + 1}</option>)}</select><input aria-label="筛选备注" placeholder="搜索备注" value={query} onChange={e => onChange({ ...value, query: e.target.value })} /></div>
    <p className="subtle-label">{list.length} / {results.length} 个对象 · 点击定位</p>
    <div className="annotation-results">{list.map(r => {
      const m = doc.media.find(m => m.id === r.mediaId), a = r.scope === 'region' ? r.annotation : null;
      const scope = r.scope === 'file' ? '整个文件' : r.scope === 'channel' ? `整个通道 ${r.channelIndex + 1}` : `区域 · 通道 ${a!.region.channelIndex + 1}`;
      return <button title={labelText(doc.categories, r.categoryIds)} className={`annotation-row ${a && selectedId === a.id ? 'is-selected' : ''}`} key={`${r.scope}:${r.mediaId}:${r.scope === 'channel' ? r.channelIndex : a?.id ?? ''}`} onClick={() => onLocate(r)}><strong><i style={{ background: labelColor(doc.categories, r.categoryIds) }} />{labelText(doc.categories, r.categoryIds)}<small>{scope}</small></strong><span>{m?.displayName}</span>{a && <span>{a.region.startSeconds.toFixed(3)}–{a.region.endSeconds.toFixed(3)} s · {Math.round(a.region.lowHz)}–{Math.round(a.region.highHz)} Hz</span>}<span className="note-summary">{r.note || '无备注'}</span></button>;
    })}{!list.length && <p className="subtle-label">没有符合条件的标注</p>}</div>
  </div>;
}
