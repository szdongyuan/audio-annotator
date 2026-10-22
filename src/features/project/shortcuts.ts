type Shortcut = 'delete' | 'cancel' | 'select' | 'annotate' | 'mask' | 'undo' | 'redo';
export function shortcutAction(event: { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean; target: EventTarget | null }): Shortcut | null {
  if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return null;
  if (event.altKey) return null;
  const key = event.key.toLowerCase();
  if (event.ctrlKey || event.metaKey) return key === 'z' ? event.shiftKey ? 'redo' : 'undo' : key === 'y' ? 'redo' : null;
  return ({ delete: 'delete', escape: 'cancel', v: 'select', a: 'annotate', m: 'mask' } as const)[key as 'delete'] ?? null;
}
