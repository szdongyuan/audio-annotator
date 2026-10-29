/** Shared by the workspace and the focused inspection dialog. */
export function isResetViewShortcut(event: { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean; target: EventTarget | null }) {
 return !!(event.ctrlKey || event.metaKey) && event.key === '0' && !event.altKey && !event.shiftKey && !(event.target instanceof Element && event.target.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"])'));
}
