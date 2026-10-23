import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { menuPosition, type MenuItem } from './menuModel';
import './menu.css';
type Anchor = { x: number; y: number };
function Panel({ items, anchor, parentLeft, close, back, navigate }: { items: MenuItem[]; anchor: Anchor; parentLeft?: number; close: () => void; back?: () => void; navigate?: (direction: number) => void }) {
  const ref = useRef<HTMLDivElement>(null), buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const [index, setIndex] = useState(() => items.findIndex(i => !i.disabled)), [child, setChild] = useState<{ index: number; anchor: Anchor; left: number } | null>(null);
  const [position, setPosition] = useState({ left: anchor.x, top: anchor.y });
  useLayoutEffect(() => {
    const box = ref.current!.getBoundingClientRect();
    setPosition(menuPosition(anchor, box, { width: innerWidth, height: innerHeight }, parentLeft));
    (buttons.current[index] ?? ref.current)?.focus();
  }, [anchor.x, anchor.y, parentLeft]);
  const focus = (next: number) => { if (!Number.isInteger(next) || next < 0) return; setIndex(next); buttons.current[next]?.focus(); };
  const open = (i: number) => { const b = buttons.current[i]?.getBoundingClientRect(); if (b && items[i].children && !items[i].disabled) setChild({ index: i, anchor: { x: b.right, y: b.top }, left: b.left }); };
  const activate = (i: number) => { const item = items[i]; if (!item || item.disabled) return; if (item.children) open(i); else { close(); item.action?.(); } };
  return <div ref={ref} role="menu" tabIndex={-1} className="app-menu" style={position} onKeyDown={e => {
    e.stopPropagation();
    if (['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'Enter', ' ', 'Escape', 'Home', 'End', 'Tab'].includes(e.key)) e.preventDefault();
    if (e.key === 'Escape' || e.key === 'ArrowLeft') { if (back) back(); else if (e.key === 'ArrowLeft' && navigate) navigate(-1); else close(); }
    else if (e.key === 'Tab') close();
    else if (e.key === 'Enter' || e.key === ' ') activate(index);
    else if (e.key === 'ArrowRight') { if (items[index]?.children) open(index); else navigate?.(1); }
    else if (e.key === 'Home' || e.key === 'End') { const enabled = items.map((v, i) => v.disabled ? -1 : i).filter(i => i >= 0); focus(e.key === 'Home' ? enabled[0] : enabled.at(-1)!); }
    else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      for (let n = 1; n <= items.length; n++) { const next = (index + (e.key === 'ArrowDown' ? n : -n) + items.length * 2) % items.length; if (!items[next].disabled) { setChild(null); focus(next); break; } }
    }
  }}>
    {items.map((item, i) => <button key={item.id} ref={el => { buttons.current[i] = el; }} role="menuitem" title={item.title} aria-label={item.label} aria-disabled={!!item.disabled} aria-haspopup={item.children ? 'menu' : undefined} aria-expanded={item.children ? child?.index === i : undefined} tabIndex={i === index ? 0 : -1} className={i === index ? 'is-current' : ''}
      onPointerEnter={() => { if (item.disabled) return; focus(i); if (item.children) open(i); else setChild(null); }} onClick={() => activate(i)}><span>{item.checked ? '✓ ' : ''}{item.label}</span>{item.children && <span aria-hidden="true">›</span>}</button>)}
    {child && items[child.index]?.children && <Panel items={items[child.index].children!} anchor={child.anchor} parentLeft={child.left} close={close} back={() => { setChild(null); focus(child.index); }} />}
  </div>;
}
export function Menu({ items, anchor, onClose, onNavigate, panelKey, returnFocus }: { items: MenuItem[]; anchor: Anchor; onClose: () => void; onNavigate?: (direction: number) => void; panelKey?: string; returnFocus?: HTMLElement | null }) {
  const restore = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  if (returnFocus) restore.current = returnFocus;
  const close = useRef(onClose); close.current = onClose;
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (!(e.target instanceof Element && e.target.closest('[data-app-menu]'))) { e.preventDefault(); e.stopImmediatePropagation(); if (e.key === 'Escape') close.current(); } };
    const resize = () => close.current();
    window.addEventListener('keydown', key, true); window.addEventListener('resize', resize); window.addEventListener('blur', resize);
    return () => { window.removeEventListener('keydown', key, true); window.removeEventListener('resize', resize); window.removeEventListener('blur', resize); restore.current?.focus(); };
  }, []);
  return createPortal(<div data-app-menu data-testid="menu-shield" className="menu-shield" onContextMenu={e => { e.preventDefault(); e.stopPropagation(); }} onPointerDown={e => { e.stopPropagation(); if (e.target === e.currentTarget) { e.preventDefault(); onClose(); } }} onWheel={e => e.stopPropagation()}>
    <Panel key={panelKey} items={items} anchor={anchor} close={onClose} navigate={onNavigate} />
  </div>, document.body);
}
