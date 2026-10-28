import type { Annotation, MediaDescriptor } from '../../bridge/types';
import type { MediaStatus } from '../../bridge/media';

export type RandomNavigationResult =
  | { kind: 'selected'; mediaId: string }
  | { kind: 'empty' }
  | { kind: 'current-only' };

export function pickUnclassifiedMedia(
  navigationIds: readonly string[],
  media: readonly MediaDescriptor[],
  annotations: readonly Annotation[],
  statuses: readonly MediaStatus[],
  selectedId: string | null,
  random: () => number = Math.random,
): RandomNavigationResult {
  const byId = new Map(media.map(item => [item.id, item]));
  const byStatus = new Map(statuses.map(item => [item.mediaId, item.status]));
  const regionTagged = new Set(annotations
    .filter(item => item.categoryIds.length > 0)
    .map(item => item.region.mediaId));
  const eligible = navigationIds.filter(id => {
    const item = byId.get(id), status = byStatus.get(id);
    return !!item && item.categoryIds.length === 0
      && item.channelCategoryIds.every(tags => tags.length === 0)
      && !regionTagged.has(id) && status !== 'missing' && status !== 'changed';
  });
  if (eligible.length === 0) return { kind: 'empty' };
  const others = eligible.filter(id => id !== selectedId);
  if (others.length === 0) return { kind: 'current-only' };
  return { kind: 'selected', mediaId: others[Math.floor(random() * others.length)] };
}
