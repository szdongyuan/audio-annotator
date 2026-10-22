import { useState, useSyncExternalStore } from 'react';
import type { Change, MediaDescriptor } from '../../bridge/types';
import type { AnnotationUI } from './useAnnotations';
export function NoteField({ ui, draftKey, label, note, change }: { ui: AnnotationUI; draftKey: string; label: string; note: string; change: (note: string, mergeKey: string) => Change }) {
  const active = ui.active!;
  useSyncExternalStore(active.lifecycle.subscribe, active.lifecycle.getVersion);
  const [mergeKey, setMergeKey] = useState(() => crypto.randomUUID());
  const draft = ui.drafts!.read(draftKey), value = draft && 'note' in draft ? draft.note : note;
  return <label className="note-field">{label}<textarea aria-label={label} value={value} rows={3} disabled={active.store.editingDisabled}
    onFocus={() => setMergeKey(crypto.randomUUID())} onChange={e => ui.drafts!.write(draftKey, change(e.target.value, mergeKey))}
    onBlur={() => { void ui.drafts!.submit(draftKey).catch(() => {}); }} placeholder="记录观察与想法…" /></label>;
}
export function NotesEditor({ ui, media }: { ui: AnnotationUI; media: MediaDescriptor | null }) {
  const [channel, setChannel] = useState(0);
  if (!media || !ui.active) return <p className="subtle-label">选择音频后编辑备注</p>;
  const c = Math.min(channel, media.channelCount - 1);
  return <div className="notes-editor"><p className="object-caption">{media.displayName}</p><NoteField ui={ui} draftKey={`media-note:${media.id}`} label="音频备注" note={media.note} change={(note, mergeKey) => ({ type: 'updateMediaNote', mediaId: media.id, note, mergeKey })} />
    <label className="channel-note-selector">备注通道<select aria-label="备注通道" value={c} onChange={e => setChannel(+e.target.value)}>{media.channelNotes.map((_, i) => <option key={i} value={i}>通道 {i + 1}</option>)}</select></label>
    <NoteField key={`${media.id}:${c}`} ui={ui} draftKey={`channel-note:${media.id}:${c}`} label={`通道 ${c + 1} 备注`} note={media.channelNotes[c]} change={(note, mergeKey) => ({ type: 'updateChannelNote', mediaId: media.id, channelIndex: c, note, mergeKey })} />
  </div>;
}
