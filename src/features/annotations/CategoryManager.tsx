import { useState } from 'react';
import type { Category } from '../../bridge/types';
import type { AnnotationUI } from './useAnnotations';
export function CategoryManager({ ui }: { ui: AnnotationUI }) {
  const [editing, setEditing] = useState<Category | null>(null), [name, setName] = useState(''), [color, setColor] = useState('#e6a65d'), [pendingDelete, setPendingDelete] = useState<Category | null>(null);
  if (!ui.active) return null;
  const doc = ui.active.store.snapshot.document, disabled = ui.active.store.editingDisabled;
  const duplicate = doc.categories.some(c => c.id !== editing?.id && c.name.trim() === name.trim());
  const count = doc.annotations.filter(a => a.categoryId === pendingDelete?.id).length;
  return <div className="category-manager"><div className="category-rows">{doc.categories.map(c => <div key={c.id} className="category-row"><i style={{ background: c.color }} /><span>{c.name}</span><button aria-label={`编辑类别 ${c.name}`} disabled={disabled} onClick={() => { setEditing(c); setName(c.name); setColor(c.color); }}>编辑</button><button aria-label={`删除类别 ${c.name}`} disabled={disabled} onClick={() => setPendingDelete(c)}>删除</button></div>)}</div>
    <form className="category-form" onSubmit={e => { e.preventDefault(); if (!name.trim() || duplicate) return; ui.command({ type: editing ? 'updateCategory' : 'addCategory', category: { id: editing?.id ?? crypto.randomUUID(), name: name.trim(), color } }); setEditing(null); setName(''); }}><label>{editing ? '修改类别' : '新建类别'}<input aria-label="类别名称" value={name} disabled={disabled} maxLength={100} onChange={e => setName(e.target.value)} placeholder="例如：鸟鸣、噪声" /></label><div><input aria-label="类别颜色" type="color" value={color} disabled={disabled} onChange={e => setColor(e.target.value)} /><button className="button" disabled={disabled || !name.trim() || duplicate}>{editing ? '保存类别' : '添加类别'}</button>{editing && <button type="button" className="button button-quiet" onClick={() => { setEditing(null); setName(''); }}>取消</button>}</div>{duplicate && <p role="alert" className="inline-error">类别名称已存在</p>}</form>
    {pendingDelete && <div className="category-confirm" role="alertdialog" aria-label="删除类别确认"><p>删除“{pendingDelete.name}”？{count} 个区域将设为未分类，备注保留。</p><button className="button" disabled={disabled} onClick={() => { ui.command({ type: 'removeCategory', id: pendingDelete.id }); setPendingDelete(null); }}>确认删除类别</button><button className="button button-quiet" onClick={() => setPendingDelete(null)}>取消</button></div>}
  </div>;
}
