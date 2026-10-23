export type MenuItem = { id: string; label: string; title?: string; disabled?: boolean; checked?: boolean; action?: () => void; children?: MenuItem[] };
export function menuPosition(anchor: { x: number; y: number }, size: { width: number; height: number }, viewport: { width: number; height: number }, parentLeft?: number) {
  const x = parentLeft !== undefined && anchor.x + size.width > viewport.width - 4 ? parentLeft - size.width : anchor.x;
  return { left: Math.max(4, Math.min(x, viewport.width - size.width - 4)), top: Math.max(4, Math.min(anchor.y, viewport.height - size.height - 4)) };
}
export const menuIsOpen = () => !!document.querySelector('[data-app-menu], .project-menu[open]');
