import { useEffect, useRef, type ComponentPropsWithoutRef } from 'react';

// Keep the closing pointer's release/click shield alive after the layer unmounts.
// Dismiss on pointerdown only: a drag beginning inside is never an outside click.
function consumePointerSequence(event: PointerEvent) {
  event.preventDefault(); event.stopImmediatePropagation();
  let timer: ReturnType<typeof setTimeout>;
  const stop = (e: Event) => { e.preventDefault(); e.stopImmediatePropagation(); };
  const cleanup = () => {
    clearTimeout(timer); window.removeEventListener('pointerup', release, true);
    window.removeEventListener('pointercancel', cleanup, true); window.removeEventListener('click', click, true);
    window.removeEventListener('blur', cleanup); window.removeEventListener('pointerdown', cleanup, true);
  };
  const release = (e: PointerEvent) => { if (e.pointerId !== event.pointerId) return; stop(e); timer = setTimeout(cleanup, 0); };
  const click = (e: MouseEvent) => { stop(e); cleanup(); };
  window.addEventListener('pointerup', release, true); window.addEventListener('pointercancel', cleanup, true); window.addEventListener('click', click, true);
  window.addEventListener('blur', cleanup); window.addEventListener('pointerdown', cleanup, true);
}
const blockedByDialog = (node: HTMLElement | null) => [...document.querySelectorAll('dialog[open], [role="dialog"][aria-modal="true"], [role="alertdialog"]')].some(dialog => dialog !== node && !dialog.contains(node));
export function useDismissibleLayer<T extends HTMLElement>(onClose: () => void, triggerSelector?: string) {
  const ref = useRef<T>(null), close = useRef(onClose); close.current = onClose;
  useEffect(() => {
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const pointer = (event: PointerEvent) => {
      const node = ref.current, target = event.target;
      if (!node || !(target instanceof Element)) return;
      if (blockedByDialog(node)) return;
      // Native dialogs target their backdrop clicks at the dialog itself.
      const rect = node.getBoundingClientRect();
      const backdrop = node.tagName === 'DIALOG' && target === node && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom);
      if (!backdrop && node.contains(target) || triggerSelector && target.closest(triggerSelector)) return;
      consumePointerSequence(event); close.current();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (blockedByDialog(ref.current)) return;
      event.preventDefault(); event.stopImmediatePropagation(); close.current();
      if (trigger?.isConnected) trigger.focus();
    };
    window.addEventListener('pointerdown', pointer, true); window.addEventListener('keydown', key, true);
    return () => { window.removeEventListener('pointerdown', pointer, true); window.removeEventListener('keydown', key, true); };
  }, [triggerSelector]);
  return ref;
}
export function DismissibleLayer({ onClose, triggerSelector, ...props }: ComponentPropsWithoutRef<'section'> & { onClose: () => void; triggerSelector?: string }) {
  const ref = useDismissibleLayer<HTMLElement>(onClose, triggerSelector);
  return <section {...props} ref={ref} />;
}
