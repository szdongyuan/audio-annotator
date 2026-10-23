import { useLayoutEffect, useRef } from 'react';
import type { CollaborationUI } from './useCollaboration';
import { foreignAuthors, type RemoteTarget, type RemoteValue } from './remote';

export function RemoteList({ ui, inspect }: { ui: CollaborationUI; inspect: (target: RemoteTarget) => void }) {
  const authors = foreignAuthors(ui), owner = ui.active!;
  return <div className="remote-list">{!authors.length && <p className="subtle-label">没有可显示的其他作者</p>}{authors.map(author => {
    const payload = author.layer?.payload, base = { owner, authorId: author.identity.authorId };
    const category = (id: string | null) => payload?.categories.find(c => c.id === id)?.name ?? '未分类';
    return <section key={author.identity.authorId} data-remote-author={author.identity.authorId}><h3>{author.identity.displayName}</h3>
      {author.error && <p role="status">{payload ? '读取异常 · 保留上次已验证图层' : '图层不可用'}：{author.error.message}</p>}
      {!payload && !author.error && <p>尚无共享标注</p>}
      {payload?.annotations.map(a => <button key={`region:${a.id}`} className="remote-list-entry" onClick={() => inspect({ ...base, scope: 'region', annotationId: a.id })}>{category(a.categoryId)} · 通道 {a.region.channelIndex + 1} · {a.region.startSeconds.toFixed(3)}–{a.region.endSeconds.toFixed(3)} s<span>{a.note || '无备注'}</span></button>)}
      {payload?.mediaLabels.map(m => <div key={`file:${m.mediaId}`}><button className="remote-list-entry" onClick={() => inspect({ ...base, scope: 'file', mediaId: m.mediaId })}>文件 · {owner.store.snapshot.document.media.find(d => d.id === m.mediaId)?.displayName} · {category(m.categoryId)}<span>{m.note || '无备注'}</span></button>{m.channelNotes.map((note, channelIndex) => <button key={channelIndex} className="remote-list-entry" onClick={() => inspect({ ...base, scope: 'channel', mediaId: m.mediaId, channelIndex })}>通道 {channelIndex + 1} · {category(m.channelCategoryIds[channelIndex])}<span>{note || '无备注'}</span></button>)}</div>)}
    </section>;
  })}</div>;
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
    <h2>共享标注 · 只读</h2>{value ? <><p>{value.author.identity.displayName} · {value.category?.name ?? '未分类'}</p><p>{value.media.displayName}{value.channelIndex !== undefined ? ` · 通道 ${value.channelIndex + 1}` : ' · 文件'}</p>
      {value.annotation && <p>{value.annotation.region.startSeconds.toFixed(3)}–{value.annotation.region.endSeconds.toFixed(3)} s · {value.annotation.region.lowHz.toFixed(1)}–{value.annotation.region.highHz.toFixed(1)} Hz</p>}
      {value.author.error && <p role="status">读取异常 · 保留上次已验证图层：{value.author.error.message}</p>}<p className="remote-note">{value.note || '无备注'}</p>
      <div className="remote-actions">{value.annotation && <button className="button" onClick={() => play(target)}>播放此区域</button>}<button className="button" onClick={() => locate(target)}>定位</button></div></> : <p role="status">此共享内容已不存在或不可用。</p>}<button className="button button-quiet" onClick={close}>关闭只读详情</button>
  </div></div>;
}
