import { annotationDisabled } from '../collaboration/capabilities';
import { useState, useSyncExternalStore } from 'react';
import type { Change, MediaDescriptor } from '../../bridge/types';
import { ClassificationControl } from './ClassificationControl';
import type { AnnotationUI } from './useAnnotations';
export function NoteField({ ui, draftKey, label, note, change }: { ui: AnnotationUI; draftKey: string; label: string; note: string; change: (note: string, mergeKey: string) => Change }) {
  const active = ui.active!;
  useSyncExternalStore(active.lifecycle.subscribe, active.lifecycle.getVersion);
  const [mergeKey, setMergeKey] = useState(() => crypto.randomUUID());
  const draft = ui.drafts!.read(draftKey), value = draft && 'note' in draft ? draft.note : note;
  return <label className="note-field">{label}<textarea aria-label={label} value={value} rows={3} disabled={annotationDisabled(active)}
    onFocus={() => setMergeKey(crypto.randomUUID())} onChange={e => ui.drafts!.write(draftKey, change(e.target.value, mergeKey))}
    onBlur={() => { void ui.drafts!.submit(draftKey).catch(() => {}); }} placeholder="记录观察与想法…" /></label>;
}
export function NotesEditor({ ui, media, channelIndex = null }: { ui: AnnotationUI; media: MediaDescriptor | null; channelIndex?: number | null }) {
  if (!media || !ui.active) return <p className="subtle-label">尚未选择文件</p>;
  const c = channelIndex !== null && channelIndex >= 0 && channelIndex < media.channelCount ? channelIndex : null;
  return <div className="notes-editor"><p className="object-caption">{media.displayName} · {c === null ? '整个文件' : `通道 ${c + 1}`}</p>
    <ClassificationControl ui={ui} target={{ mediaId: media.id, channelIndex: c }} />
    {c === null ? <NoteField key={media.id} ui={ui} draftKey={`media-note:${media.id}`} label="音频备注" note={media.note} change={(note, mergeKey) => ({ type: 'updateMediaNote', mediaId: media.id, note, mergeKey })} /> :
    <NoteField key={`${media.id}:${c}`} ui={ui} draftKey={`channel-note:${media.id}:${c}`} label={`通道 ${c + 1} 备注`} note={media.channelNotes[c]} change={(note, mergeKey) => ({ type: 'updateChannelNote', mediaId: media.id, channelIndex: c, note, mergeKey })} />}
  </div>;
}
