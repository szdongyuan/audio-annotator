import { useMemo } from 'react';
import type { MediaUI } from '../media/useMedia';
import type { ActiveProject } from '../project/useProjectLifecycle';
/** Reuses the verified relink workflow, including its owned prepared-media failure ledger. */
export function MediaAssociation({ active, media }: { active: ActiveProject | null; media: MediaUI }) {
  const files = active?.store.snapshot.document.media;
  const missing = useMemo(() => {
    const unavailable = new Set(media.statuses.filter(s => s.status === 'missing' || s.status === 'changed').map(s => s.mediaId));
    return files?.filter(m => unavailable.has(m.id)) ?? [];
  }, [files, media.statuses]);
  if (!missing.length) return null;
  return <section className="media-association" aria-label="待关联音频"><strong>{missing.length} 个音频需要关联</strong><p>选择原始文件，指纹与音频信息一致后恢复频谱和试听。</p>{missing.map(m => <button className="button" disabled={media.disabled} key={m.id} onClick={() => media.setRelink(m)}>关联 {m.displayName}</button>)}</section>;
}
