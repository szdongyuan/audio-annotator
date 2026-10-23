import { Undo2, Redo2 } from 'lucide-react';
import type { AnnotationUI } from './useAnnotations';
export function AnnotationTools({ ui }: { ui: AnnotationUI }) {
  const disabled = !ui.active || ui.active.store.editingDisabled;
  return <div className="toolbar-group tools">
    <span className="toolbar-divider" /><button className="icon-button" aria-label="撤销 · Ctrl Z" disabled={disabled || !ui.active?.store.snapshot.canUndo} onClick={() => ui.history('undo')}><Undo2 size={17} /></button><button className="icon-button" aria-label="重做 · Ctrl Y" disabled={disabled || !ui.active?.store.snapshot.canRedo} onClick={() => ui.history('redo')}><Redo2 size={17} /></button>
  </div>;
}
