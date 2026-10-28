import { labelText } from '../annotations/labels';
import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { AuthorSnapshot } from '../../bridge/collaboration';
import type { ActiveProject } from '../project/useProjectLifecycle';
import type { CollaborationUI } from './useCollaboration';
import { foreignAuthors, type RemoteTarget, type RemoteValue } from './remote';

export function RemoteList({ ui, inspect }: { ui: CollaborationUI; inspect: (target: RemoteTarget) => void }) {
  const owner = ui.active;
  if (!owner) return <div className="remote-list"><p className="subtle-label">没有可显示的其他作者</p></div>;
  return <RemoteAuthorList key={owner.collaboration?.runtimeNonce ?? owner.path}
    owner={owner} authors={foreignAuthors(ui)} inspect={inspect} />;
}

function RemoteAuthorList({ owner, authors, inspect }: {
  owner: ActiveProject; authors: AuthorSnapshot[]; inspect: (target: RemoteTarget) => void;
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
        <span className="remote-author-name">{author.identity.displayName}</span>
      </button></h3>
      {author.error && <p role="status">{payload ? '读取异常 · 保留上次已验证图层' : '图层不可用'}：{author.error.message}</p>}
      <div id={contentId} hidden={isCollapsed}>
        <RemoteAuthorContent author={author} owner={owner} inspect={inspect} />
      </div>
    </section>;
  })}</div>;
}

function RemoteAuthorContent({ author, owner, inspect }: {
  author: AuthorSnapshot; owner: ActiveProject; inspect: (target: RemoteTarget) => void;
}) {
  const payload = author.layer?.payload;
  const annotations = payload?.annotations.filter(a => a.categoryIds.length > 0) ?? [];
  const groups = (payload?.mediaLabels ?? []).map(media => ({
    media,
    channels: media.channelCategoryIds.flatMap((ids, index) => ids.length ? [index] : []),
  })).filter(group => group.media.categoryIds.length > 0 || group.channels.length > 0);
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
        {media.categoryIds.length > 0 && <button className="remote-list-entry"
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

export function RemoteInspector({ target, value, close, play, locate }: { target: RemoteTarget; value: RemoteValue | null; close: () => void; play: (t: RemoteTarget) => void; locate: (t: RemoteTarget) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { const previous = document.activeElement as HTMLElement | null; ref.current?.focus(); return () => { if (previous?.isConnected) previous.focus(); }; }, [target]);
  // A refresh can remove the focused Play/Locate button. Keep subsequent
  // keyboard events inside the dialog instead of falling through to the plot.
  useLayoutEffect(() => { if (ref.current && !ref.current.contains(document.activeElement)) ref.current.focus(); });
  return <div className="remote-inspector-backdrop" onPointerDown={e => { if (e.target === e.currentTarget) close(); }}><div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label="共享标注详情（只读）" className="remote-inspector" onKeyDown={e => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    if (e.key === 'Tab') {
      const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])], first = buttons[0], last = buttons.at(-1);
      if (e.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || document.activeElement === ref.current)) { e.preventDefault(); first?.focus(); }
    }
  }}>
    <h2>共享标注 · 只读</h2>{value ? <><p>{value.author.identity.displayName} · {value.categoryText}</p><p>{value.media.displayName}{value.channelIndex !== undefined ? ` · 通道 ${value.channelIndex + 1}` : ' · 文件'}</p>
      {value.annotation && <p>{value.annotation.region.startSeconds.toFixed(3)}–{value.annotation.region.endSeconds.toFixed(3)} s · {value.annotation.region.lowHz.toFixed(1)}–{value.annotation.region.highHz.toFixed(1)} Hz</p>}
      {value.author.error && <p role="status">读取异常 · 保留上次已验证图层：{value.author.error.message}</p>}<p className="remote-note">{value.note || '无备注'}</p>
      <div className="remote-actions">{value.annotation && <button className="button" onClick={() => play(target)}>播放此区域</button>}<button className="button" onClick={() => locate(target)}>定位</button></div></> : <p role="status">此共享内容已不存在或不可用。</p>}<button className="button button-quiet" onClick={close}>关闭只读详情</button>
  </div></div>;
}
