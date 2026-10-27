import { menuIsOpen } from '../../components/menu/menuModel';

export function mediaNavigationDirection(event: { key: string; target: EventTarget | null; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean; isComposing?: boolean }): -1 | 1 | null {
  if (menuIsOpen() || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return null;
  if (event.target instanceof Element && event.target.closest('input,textarea,select,[role="dialog"],[role="alertdialog"],[role="separator"],[role="tablist"],[role="menu"],[role="menubar"],[role="slider"],[contenteditable]:not([contenteditable="false"])')) return null;
  return event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : null;
}
