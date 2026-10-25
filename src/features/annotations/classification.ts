import { annotationDisabled } from '../collaboration/capabilities';
import type { Annotation, ProjectDocument } from '../../bridge/types';
import type { ActiveProject } from '../project/useProjectLifecycle';
import { normalizeError } from '../../bridge/client';
import type { MenuItem } from '../../components/menu/menuModel';

export type ClassificationTarget = { mediaId: string; channelIndex: number | null };
export type VisiblePane = { mediaId: string; channels: number[] };
export function resolveClassification(doc: ProjectDocument, target: ClassificationTarget) {
  const media = doc.media.find(m => m.id === target.mediaId);
  return media && (target.channelIndex === null || Number.isInteger(target.channelIndex) && target.channelIndex >= 0 && target.channelIndex < media.channelCount) ? media : null;
}
export function reconcileContext(doc: ProjectDocument, context: ClassificationTarget | null, panes: VisiblePane[]): ClassificationTarget | null {
  const available = panes.filter(p => doc.media.some(m => m.id === p.mediaId));
  const pane = available.find(p => p.mediaId === context?.mediaId) ?? available[0];
  if (!pane) return null;
  const media = doc.media.find(m => m.id === pane.mediaId)!;
  const channels = pane.channels.filter(c => Number.isInteger(c) && c >= 0 && c < media.channelCount);
  const channelIndex = context?.mediaId === pane.mediaId && (context.channelIndex === null || channels.includes(context.channelIndex)) ? context.channelIndex : channels[0] ?? null;
  return { mediaId: pane.mediaId, channelIndex };
}
export function classifyTarget(owner: ActiveProject, target: ClassificationTarget, categoryId: string | null, current: () => boolean) {
  if (!current() || annotationDisabled(owner)) return Promise.resolve();
  const captured = { ...target };
  return owner.lifecycle.enqueueEdit(async () => {
    await owner.lifecycle.submitDrafts();
    const doc = owner.store.snapshot.document;
    if (!current() || !resolveClassification(doc, captured) || categoryId !== null && !doc.categories.some(c => c.id === categoryId)) return;
    const change = captured.channelIndex === null
      ? { type: 'setMediaCategory' as const, mediaId: captured.mediaId, categoryId }
      : { type: 'setChannelCategory' as const, mediaId: captured.mediaId, channelIndex: captured.channelIndex, categoryId };
    await owner.queue.enqueue(change, { owner: 'annotations' });
  }).catch(cause => owner.store.setError(normalizeError(cause)));
}
export function classificationMenu(doc: ProjectDocument, target: ClassificationTarget | null, classify: (target: ClassificationTarget, category: string | null) => void, label: string, disabled = false): MenuItem {
  const media = target && resolveClassification(doc, target);
  const value = media && target ? target.channelIndex === null ? media.categoryId : media.channelCategoryIds[target.channelIndex] : null;
  return { id: label, label, disabled: disabled || !media, children: [{ id: 'none', name: '未分类' }, ...doc.categories].map(c => ({ id: c.id, label: c.name, checked: value === (c.id === 'none' ? null : c.id), action: () => { if (target) classify(target, c.id === 'none' ? null : c.id); } })) };
}
type ResultBase = { mediaId: string; categoryId: string | null; note: string };
export type ClassificationResult = ResultBase & ({ scope: 'file' } | { scope: 'channel'; channelIndex: number } | { scope: 'region'; annotation: Annotation });
export function classificationResults(doc: ProjectDocument): ClassificationResult[] {
  return [
    ...doc.media.flatMap(m => [{ scope: 'file' as const, mediaId: m.id, categoryId: m.categoryId, note: m.note }, ...m.channelCategoryIds.map((categoryId, channelIndex) => ({ scope: 'channel' as const, mediaId: m.id, channelIndex, categoryId, note: m.channelNotes[channelIndex] }))]),
    ...doc.annotations.map(annotation => ({ scope: 'region' as const, mediaId: annotation.region.mediaId, categoryId: annotation.categoryId, note: annotation.note, annotation })),
  ];
}
export function categoryReferences(doc: ProjectDocument, id: string) {
  return { files: doc.media.filter(m => m.categoryId === id).length, channels: doc.media.reduce((n, m) => n + m.channelCategoryIds.filter(c => c === id).length, 0), regions: doc.annotations.filter(a => a.categoryId === id).length };
}
