import { menuIsOpen } from '../../components/menu/menuModel';

type MediaNavigationEvent = {
  key: string;
  target: EventTarget | null;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  isComposing?: boolean;
  defaultPrevented?: boolean;
  repeat?: boolean;
};

function mediaNavigationAllowed(event: MediaNavigationEvent): boolean {
  if (menuIsOpen() || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false;
  if (event.target instanceof Element && event.target.closest('input,textarea,select,[role="dialog"],[role="alertdialog"],[role="separator"],[role="tablist"],[role="menu"],[role="menubar"],[role="slider"],[contenteditable]:not([contenteditable="false"])')) return false;
  return true;
}

export function mediaNavigationDirection(event: MediaNavigationEvent): -1 | 1 | null {
  if (!mediaNavigationAllowed(event)) return null;
  return event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : null;
}

export function mediaRandomShortcut(event: MediaNavigationEvent): boolean {
  return !event.defaultPrevented && !event.repeat && event.key.toLowerCase() === 'r'
    && mediaNavigationAllowed(event)
    && !(event.target instanceof Element && event.target.closest('[role="checkbox"]'));
}
