import { labelText } from '../annotations/labels';
import { useId, useState } from 'react';
import type { ActiveProject } from '../project/useProjectLifecycle';
import type { CollaborationUI } from './useCollaboration';
import { authorsForInspector, useInspectionDocument, type InspectorAuthor, type RemoteTarget } from './remote';
import { AuthorFilter } from './AuthorFilter';
import type { CollaborationController } from './controller';
import { Eye, EyeOff } from 'lucide-react';

export function RemoteList({ ui, inspect }: { ui: CollaborationUI; inspect: (target: RemoteTarget) => void }) {
  const owner = ui.active;
  useInspectionDocument(owner);
  if (!owner || ui.controller?.owner !== owner) return <div className="remote-list"><p className="subtle-label">没有可显示的其他作者</p></div>;
  return <><AuthorFilter controller={ui.controller!} compact/><RemoteAuthorList key={owner.collaboration?.runtimeNonce ?? owner.path}
    owner={owner} controller={ui.controller!} authors={authorsForInspector(ui)} inspect={inspect} /></>;
}

function RemoteAuthorList({ owner, controller, authors, inspect }: {
  owner: ActiveProject; controller: CollaborationController; authors: InspectorAuthor[]; inspect: (target: RemoteTarget) => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const listId = useId();
  const toggle = (id: string) => setCollapsed(previous => {
    const next = new Set(previous);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  return <div className="remote-list">{!authors.length && <p className="subtle-label">没有可显示的其他作者</p>}{authors.map(author => {
    const id = author.identity.authorId, payload = author.layer?.payload;
    const contentId = `${listId}-${id}`, isCollapsed = collapsed.has(id);
    return <section key={id} data-remote-author={id}>
      <h3><button type="button" className="remote-author-toggle"
        aria-expanded={!isCollapsed} aria-controls={contentId} onClick={() => toggle(id)}>
        <span aria-hidden="true">{isCollapsed ? '▸' : '▾'}</span>
        <span className="remote-author-name">{author.identity.displayName}{id === owner.collaboration?.actor?.authorId ? '（我）' : ''}</span>
      </button><button type="button" className="visibility-toggle" aria-label={`${controller.visible(id) ? '隐藏' : '显示'}作者 ${author.identity.displayName}`} aria-pressed={controller.visible(id)} onClick={() => controller.setAuthorVisible(id, !controller.visible(id))}>{controller.visible(id) ? <Eye size={14} aria-hidden="true"/> : <EyeOff size={14} aria-hidden="true"/>}</button></h3>
      {author.error && <p role="status">{payload ? '读取异常 · 保留上次已验证图层' : '图层不可用'}：{author.error.message}</p>}
      <div id={contentId} hidden={isCollapsed}>
        <RemoteAuthorContent author={author} owner={owner} controller={controller} inspect={inspect} />
      </div>
    </section>;
  })}</div>;
}

function RemoteAuthorContent({ author, owner, controller, inspect }: {
  author: InspectorAuthor; owner: ActiveProject; controller: CollaborationController; inspect: (target: RemoteTarget) => void;
}) {
  if (!controller.visible(author.identity.authorId)) return <p className="subtle-label">作者已隐藏</p>;
  const payload = author.layer?.payload;
  const visible = (ids: string[]) => controller.contentVisible(author.identity.authorId, payload?.categories ?? [], ids);
  const annotations = payload?.annotations.filter(a => a.categoryIds.length > 0 && visible(a.categoryIds)) ?? [];
  const groups = (payload?.mediaLabels ?? []).map(media => ({
    media,
    channels: media.channelCategoryIds.flatMap((ids, index) => ids.length && visible(ids) ? [index] : []),
  })).filter(group => group.media.categoryIds.length > 0 && visible(group.media.categoryIds) || group.channels.length > 0);
  const base = { owner, authorId: author.identity.authorId };
  const category = (ids: string[]) => labelText(payload?.categories ?? [], ids);
  if (!annotations.length && !groups.length) return <p className="subtle-label">暂无已分类内容</p>;
  return <>
    {annotations.map(a => <button key={`region:${a.id}`} className="remote-list-entry"
      onClick={() => inspect({ ...base, scope: 'region', annotationId: a.id })}>
      {category(a.categoryIds)} · 通道 {a.region.channelIndex + 1} · {a.region.startSeconds.toFixed(3)}–{a.region.endSeconds.toFixed(3)} s
      <span>{a.note || '无备注'}</span>
    </button>)}
    {groups.map(({ media, channels }) => {
      const name = owner.store.snapshot.document.media.find(m => m.id === media.mediaId)?.displayName;
      return <div key={`file:${media.mediaId}`}>
        {media.categoryIds.length > 0 && visible(media.categoryIds) && <button className="remote-list-entry"
          onClick={() => inspect({ ...base, scope: 'file', mediaId: media.mediaId })}>
          文件 · {name} · {category(media.categoryIds)}<span>{media.note || '无备注'}</span>
        </button>}
        {channels.map(channelIndex => <button key={channelIndex} className="remote-list-entry"
          onClick={() => inspect({ ...base, scope: 'channel', mediaId: media.mediaId, channelIndex })}>
          通道 {channelIndex + 1} · {name} · {category(media.channelCategoryIds[channelIndex])}
          <span>{media.channelNotes[channelIndex] || '无备注'}</span>
        </button>)}
      </div>;
    })}
  </>;
}
