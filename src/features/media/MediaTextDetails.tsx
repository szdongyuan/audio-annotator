import { labelText } from '../annotations/labels';
import type { Annotation, Category, MediaDescriptor } from '../../bridge/types';
/** Saved text remains visible even when the original media cannot be located. */
export function MediaTextDetails({ media, annotations, categories }: { media: MediaDescriptor | null; annotations: Annotation[]; categories: Category[] }) {
  const visible = annotations.filter(a => a.region.mediaId === media?.id);
  return <>
    <div className="property-section"><div className="section-heading"><h3>标注列表</h3><span className="count">{visible.length}</span></div>
      {visible.length ? visible.map(a => <div className="saved-annotation" key={a.id}><strong>{labelText(categories, a.categoryIds)}</strong><small>通道 {a.region.channelIndex + 1} · {a.region.startSeconds.toFixed(3)}–{a.region.endSeconds.toFixed(3)} 秒<br />{a.region.lowHz.toFixed(0)}–{a.region.highHz.toFixed(0)} Hz</small><p>{a.note || '暂无区域备注'}</p></div>) : <p className="inline-empty">{media ? '当前文件暂无标注' : '选择音频后查看标注'}</p>}
    </div>
    <div className="property-section"><h3>音频备注</h3><p className="inline-empty media-note">{media?.note || (media ? '此音频暂无备注' : '选择音频后添加备注')}</p></div>
  </>;
}
