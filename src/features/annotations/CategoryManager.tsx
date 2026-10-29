import { annotationDisabled } from '../collaboration/capabilities';
import { useEffect, useRef, useState } from 'react';
import type { Category } from '../../bridge/types';
import type { AnnotationUI } from './useAnnotations';
import { categoryReferences } from './classification';
import { CategoryVisibility } from '../collaboration/CategoryVisibility';
export function CategoryManager({ ui }: { ui: AnnotationUI }) {
  const [editing, setEditing] = useState<Category | null>(null), [name, setName] = useState(''), [color, setColor] = useState('#e6a65d'), [pendingDelete, setPendingDelete] = useState<Category | null>(null);
  const [pending, setPending] = useState(false), [error, setError] = useState<string | null>(null);
  const submission = useRef<object | null>(null), owner = useRef(ui.active); owner.current = ui.active;
  useEffect(() => { submission.current = null; setPending(false); setError(null); setEditing(null); setName(''); return () => { submission.current = null; }; }, [ui.active]);
  if (!ui.active) return null;
  const doc = ui.active.store.snapshot.document, disabled = annotationDisabled(ui.active) || pending;
  const duplicate = doc.categories.some(c => c.id !== editing?.id && c.name.trim() === name.trim());
  const shared = (ui.categories ?? []).filter((c, i, all) => c.authorName && !doc.categories.some(own => own.name.trim() === c.name.trim()) && all.findIndex(other => other.name.trim() === c.name.trim()) === i);
  const count = categoryReferences(doc, pendingDelete?.id ?? '');
  return <div className="category-manager"><CategoryVisibility owner={ui.active}/><div className="category-rows">{doc.categories.map(c => <div key={c.id} className="category-row"><i style={{ background: c.color }} /><span>{c.name}</span><CategoryVisibility owner={ui.active!} name={c.name}/><button aria-label={`编辑类别 ${c.name}`} disabled={disabled} onClick={() => { setEditing(c); setName(c.name); setColor(c.color); }}>编辑</button><button aria-label={`删除类别 ${c.name}`} disabled={disabled} onClick={() => setPendingDelete(c)}>删除</button></div>)}</div>
    {!!shared.length && <section className="shared-categories" aria-label="共享类别"><h3>共享类别</h3>{shared.map(c=><div className="shared-category-row" key={c.id} title={`来自 ${c.authorName}`}><i style={{background:c.color}}/><span>{c.name}</span><CategoryVisibility owner={ui.active!} name={c.name}/><button className="text-button" disabled={disabled} aria-label={`采用共享类别 ${c.name}`} onClick={()=>void ui.adoptCategory(c.id)}>采用</button></div>)}</section>}
    <form className="category-form" aria-busy={pending} onSubmit={e => {
      e.preventDefault(); if (submission.current || disabled || !name.trim() || duplicate) return;
      const token = {}, capturedOwner = ui.active; submission.current = token; setPending(true); setError(null);
      void Promise.resolve((ui.submitCommand ?? ui.command)({ type: editing ? 'updateCategory' : 'addCategory', category: { id: editing?.id ?? crypto.randomUUID(), name: name.trim(), color } })).then(result => {
        if (submission.current !== token || owner.current !== capturedOwner) return;
        if (result === false) setError(capturedOwner?.store.error?.message ?? '类别未保存，请修改名称后重试。');
        else { setEditing(null); setName(''); }
      }).catch(() => { if (submission.current === token) setError('类别未保存，请重试。'); }).finally(() => { if (submission.current === token) { submission.current = null; setPending(false); } });
    }}><label>{editing ? '修改类别' : '新建类别'}<input aria-label="类别名称" value={name} disabled={disabled} maxLength={100} onChange={e => { setName(e.target.value); setError(null); }} placeholder="例如：鸟鸣、噪声" /></label><div><input aria-label="类别颜色" type="color" value={color} disabled={disabled} onChange={e => setColor(e.target.value)} /><button className="button" disabled={disabled || !name.trim() || duplicate}>{pending ? '保存中…' : editing ? '保存类别' : '添加类别'}</button>{editing && <button type="button" className="button button-quiet" disabled={pending} onClick={() => { setEditing(null); setName(''); }}>取消</button>}</div>{duplicate && <p role="alert" className="inline-error">类别名称已存在</p>}{error && <p role="alert" className="inline-error">{error}</p>}</form>
    {pendingDelete && <div className="category-confirm" role="alertdialog" aria-label="删除类别确认"><p>删除“{pendingDelete.name}”？{count.files} 个文件、{count.channels} 个通道、{count.regions} 个区域将移除此标签，其他标签及备注保留。</p><button className="button" disabled={disabled} onClick={() => { ui.command({ type: 'removeCategory', id: pendingDelete.id }); setPendingDelete(null); }}>确认删除类别</button><button className="button button-quiet" onClick={() => setPendingDelete(null)}>取消</button></div>}
  </div>;
}
