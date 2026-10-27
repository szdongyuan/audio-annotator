import { labelText } from './labels';
import { annotationDisabled } from '../collaboration/capabilities';
import type { Annotation, Region } from '../../bridge/types';
import type { AnnotationUI } from './useAnnotations';
import { NoteField } from './NotesEditor';
const bounds = [{ key: 'startSeconds', name: '开始（秒）' }, { key: 'endSeconds', name: '结束（秒）' }, { key: 'lowHz', name: '下界（Hz）' }, { key: 'highHz', name: '上界（Hz）' }] as const;
export function AnnotationInspector({ ui, annotation }: { ui: AnnotationUI; annotation: Annotation | undefined }) {
  if (!annotation || !ui.active) return <div className="selection-empty"><p>尚未选择标注</p></div>;
  const doc = ui.active.store.snapshot.document, media = doc.media.find(m => m.id === annotation.region.mediaId)!;
  const key = `annotation-bounds:${annotation.id}`, draft = ui.drafts!.read(key);
  const region = draft?.type === 'updateAnnotation' ? draft.annotation.region : annotation.region;
  const valid = Number.isFinite(region.startSeconds) && Number.isFinite(region.endSeconds) && Number.isFinite(region.lowHz) && Number.isFinite(region.highHz) && region.startSeconds >= 0 && region.startSeconds < region.endSeconds && region.endSeconds <= media.frameCount / media.sampleRate && region.lowHz >= 0 && region.lowHz < region.highHz && region.highHz <= media.sampleRate / 2;
  return <div className="annotation-inspector"><p className="object-caption">{media.displayName} · 通道 {annotation.region.channelIndex + 1}</p>
    <div className="bounds-grid">{bounds.map(({ key: field, name }) => <label key={field}>{name}<input type="number" step="any" aria-label={name} value={region[field] == null ? '' : draft ? region[field] : Number(region[field].toFixed(field.endsWith('Seconds') ? 6 : 2))} disabled={annotationDisabled(ui.active)}
      onChange={e => { const next: Region = { ...region, [field]: e.target.value === '' ? null : Number(e.target.value) }; ui.drafts!.write(key, { type: 'updateAnnotation', annotation: { ...annotation, region: next, updatedAt: new Date().toISOString() } }); }} onBlur={() => { if (valid) void ui.drafts!.submit(key).catch(() => {}); }} /></label>)}</div>
    {!valid && <p className="inline-error" role="alert">范围必须满足开始 &lt; 结束、下界 &lt; 上界，且在音频范围内。</p>}
    <fieldset className="label-checkboxes" aria-label="区域类别" title={labelText(doc.categories, annotation.categoryIds)} disabled={annotationDisabled(ui.active)}><legend>区域类别</legend>{(ui.categories ?? doc.categories).map(c => <label key={c.id}><input type="checkbox" checked={annotation.categoryIds.includes(c.id)} onChange={() => ui.classifyAnnotation(annotation.id, c.id)} />{c.name}</label>)}<button className="text-button" onClick={() => ui.classifyAnnotation(annotation.id, null)}>清空标签</button></fieldset>
    <NoteField key={annotation.id} ui={ui} draftKey={`annotation-note:${annotation.id}`} label="区域备注" note={annotation.note} change={(note, mergeKey) => ({ type: 'updateAnnotationNote', id: annotation.id, note, mergeKey })} />
    <button className="button button-quiet danger-button" disabled={annotationDisabled(ui.active)} onClick={ui.remove}>删除标注</button>
  </div>;
}
