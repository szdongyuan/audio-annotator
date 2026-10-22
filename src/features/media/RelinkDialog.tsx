import type { MediaDescriptor } from '../../bridge/types';
export function RelinkDialog({ media, disabled, onChoose, onVerify, onClose }: { media: MediaDescriptor | null; disabled: boolean; onChoose: () => void; onVerify: () => void; onClose: () => void }) {
  if (!media) return null;
  return <div className="dialog-backdrop"><section className="project-dialog" role="dialog" aria-modal="true" aria-labelledby="relink-title">
    <h2 id="relink-title">重新关联音频</h2><p>{media.displayName}</p><p>选择移动后的原始文件。将重新校验原文件 SHA-256、采样率、帧数与通道，匹配后才更新路径。</p><p className="media-source-path">{media.sourceRef}</p>
    <div className="dialog-actions"><button className="button" onClick={onClose}>取消</button><button className="button" disabled={disabled} onClick={onVerify}>校验现有路径</button><button className="button button-accent" disabled={disabled} onClick={onChoose}>选择文件…</button></div>
  </section></div>;
}
