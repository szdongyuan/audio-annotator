import type { SpectralEdit } from '../../bridge/types';
import type { MaskUI } from './useMasks';
export function EditList({ ui, onLocate }: { ui: MaskUI; onLocate: (edit: SpectralEdit) => void }) {
  const doc = ui.active?.store.snapshot.document;
  return <div className="edit-list">{!doc?.edits.length && <p className="selection-empty">暂无处理</p>}{doc?.edits.map((edit, index) => {
    const label = edit.operation.type === 'mask' ? '屏蔽' : `增益 ${edit.operation.gainDb > 0 ? '+' : ''}${edit.operation.gainDb.toFixed(1)} dB`;
    return <div className="edit-item" key={edit.id}>
      <button className="edit-locate" aria-label={`定位${label} ${index + 1}`} onClick={() => onLocate(edit)}>
        <strong>{label} {index + 1} · 通道 {edit.region.channelIndex + 1}</strong>
        <span>{doc.media.find(media => media.id === edit.region.mediaId)?.displayName}</span>
        <small>{edit.region.startSeconds.toFixed(3)}–{edit.region.endSeconds.toFixed(3)} 秒<br />{Math.round(edit.region.lowHz)}–{Math.round(edit.region.highHz)} Hz</small>
      </button>
      <div><label><input type="checkbox" aria-label={`启用${label} ${index + 1}`} disabled={ui.active!.store.editingDisabled} checked={edit.enabled} onChange={e => ui.command({ type: 'setEditEnabled', id: edit.id, enabled: e.target.checked })} />启用</label>
        <button className="text-button danger-button" aria-label={`删除${label} ${index + 1}`} disabled={ui.active!.store.editingDisabled} onClick={() => ui.remove(edit.id)}>删除</button>
      </div>
    </div>;
  })}</div>;
}
