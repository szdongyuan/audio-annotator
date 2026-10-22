import { MousePointer2, SquareDashed, ShieldCheck, Undo2, Redo2 } from 'lucide-react';
import type { AnnotationUI, Tool } from './useAnnotations';
export function AnnotationTools({ ui }: { ui: AnnotationUI }) {
  const disabled = !ui.active || ui.active.store.editingDisabled;
  return <div className="toolbar-group tools">
    {([{ id: 'select', name: '选择', key: 'V', Icon: MousePointer2 }, { id: 'annotate', name: '标注', key: 'A', Icon: SquareDashed }, { id: 'mask', name: '屏蔽', key: 'M', Icon: ShieldCheck }] as const).map(({ id, name, key, Icon }) => <button key={id} className={`tool-button ${ui.tool === id ? 'is-current' : ''}`} aria-pressed={ui.tool === id} disabled={disabled} onClick={() => ui.setTool(id as Tool)}><Icon size={16} /><span>{name}</span><kbd>{key}</kbd></button>)}
    <span className="toolbar-divider" /><button className="icon-button" aria-label="撤销 · Ctrl Z" disabled={disabled || !ui.active?.store.snapshot.canUndo} onClick={() => ui.history('undo')}><Undo2 size={17} /></button><button className="icon-button" aria-label="重做 · Ctrl Y" disabled={disabled || !ui.active?.store.snapshot.canRedo} onClick={() => ui.history('redo')}><Redo2 size={17} /></button>
  </div>;
}
