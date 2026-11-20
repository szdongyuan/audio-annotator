import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { isNativeModal } from '../components/modal';

function openDialog(): HTMLDialogElement | null {
  const dialogs = [...document.querySelectorAll<HTMLDialogElement>('dialog[open]')].filter(isNativeModal);
  for (let i = dialogs.length - 1; i >= 0; i--) if (dialogs[i].contains(document.activeElement)) return dialogs[i];
  return dialogs.at(-1) ?? null;
}

/** Native dialogs live in the browser's top layer, above the rest of the app. */
export function DropNotice({ message }: { message: string }) {
  const [dialog, setDialog] = useState(openDialog), [, setResize] = useState(0);
  useEffect(() => {
    const sync = () => { const next = openDialog(); setDialog(old => old === next ? old : next); };
    const observer = new MutationObserver(sync);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['open'] });
    const resize = () => setResize(value => value + 1);
    window.addEventListener('resize', resize); document.addEventListener('focusin', sync); sync();
    return () => { observer.disconnect(); window.removeEventListener('resize', resize); document.removeEventListener('focusin', sync); };
  }, []);
  useEffect(() => {
    if (!dialog) return;
    const observer = new ResizeObserver(() => setResize(value => value + 1));
    observer.observe(dialog);
    return () => observer.disconnect();
  }, [dialog]);
  const active = dialog?.isConnected && dialog.open ? dialog : null;
  const rect = active?.getBoundingClientRect();
  const notice = <div className="drop-notice" role="status" aria-live="polite" style={rect ? { left: rect.left + rect.width / 2, top: rect.top + 12, bottom: 'auto', maxWidth: Math.max(0, rect.width - 24) } : undefined}>{message}</div>;
  return active ? createPortal(notice, active) : notice;
}
