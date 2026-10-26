import type { Category } from '../../bridge/types';

export function labelText(categories: Category[], ids: string[]) {
  return ids.map(id => categories.find(c => c.id === id)?.name).filter(Boolean).join(' · ') || '未分类';
}
export function labelColor(categories: Category[], ids: string[], fallback = '#777') {
  return categories.find(c => ids.includes(c.id))?.color ?? fallback;
}
/** Toggle against the latest accepted set inside the command queue. */
export function toggleLabel(ids: string[], id: string | null): string[] {
  return id === null ? [] : ids.includes(id) ? ids.filter(value => value !== id) : [...ids, id];
}
