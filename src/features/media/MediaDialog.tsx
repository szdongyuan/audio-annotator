import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
/** Capture the stable menu trigger before applying inert; restore it after removing inert. */
export function MediaDialog({ title, returnFocus, resolveReturnFocus, onClose, busy = false, className = '', children }: {
    title: string;
    className?: string;
    returnFocus?: HTMLElement | null;
    resolveReturnFocus?: (previous: HTMLElement | null) => HTMLElement | null;
    onClose: () => void;
    busy?: boolean;
    children: ReactNode;
}) {
    const ref = useRef<HTMLElement>(null), previous = useRef(returnFocus ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null));
    const resolveFocus = useRef(resolveReturnFocus);
    resolveFocus.current = resolveReturnFocus;
    useLayoutEffect(() => {
        const root = document.querySelector<HTMLElement>('.app-root'), was = root?.inert;
        if (root) root.inert = true;
        ref.current?.focus();
        return () => {
            if (root) root.inert = was ?? false;
            // The original row can disappear while the dialog is open.
            const target = resolveFocus.current ? resolveFocus.current(previous.current) : previous.current;
            if (target?.isConnected) target.focus();
        };
    }, []);
    useEffect(() => { ref.current?.focus(); }, []);
    return createPortal(<div className="dialog-backdrop" onPointerDown={e => { if (e.target === e.currentTarget && !busy) {
        e.preventDefault();
        onClose(); } }}><section ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title} className={`project-dialog source-import-dialog ${className}`} onKeyDown={e => { e.stopPropagation(); if (e.key === 'Escape' && !busy)
        onClose(); if (e.key === 'Tab') {
        const items = [...(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary') ?? [])].filter(e => !e.closest('details:not([open])') || e.tagName === 'SUMMARY');
        const first = items[0], last = items.at(-1);
        if (e.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) {
            e.preventDefault();
            last?.focus();
        }
        else if (!e.shiftKey && (document.activeElement === last || document.activeElement === ref.current)) {
            e.preventDefault();
            first?.focus();
        }
    } }}>{children}</section></div>, document.body);
}
