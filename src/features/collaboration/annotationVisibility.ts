import type { Category } from '../../bridge/types';
import type { ActiveProject } from '../project/useProjectLifecycle';
import type { Selection } from '../selection/state';
import type { CollaborationUI } from './useCollaboration';

/** One display predicate for results, painted frames and hit routing. It never resolves or edits content. */
export function contentVisible(ui: CollaborationUI | null | undefined, owner: ActiveProject | null, authorId: string | null, categories: readonly Category[], ids: readonly string[]): boolean {
 const controller = ui?.controller;
 if (!owner || ui?.active !== owner || controller?.owner !== owner) return true;
 return controller.contentVisible?.(authorId, categories, ids) ?? controller.visible(authorId);
}
export function ownContentVisible(ui: CollaborationUI | null | undefined, owner: ActiveProject | null, ids: readonly string[]): boolean {
 return contentVisible(ui, owner, owner?.collaboration?.actor?.authorId ?? null, owner?.store.snapshot.document.categories ?? [], ids);
}
export function ownSelectionVisible(ui: CollaborationUI | null | undefined, owner: ActiveProject | null, selection: Selection | null): boolean {
 if (selection?.object?.kind !== 'annotation') return true;
 const annotation = owner?.store.snapshot.document.annotations.find(a => a.id === selection.object?.id);
 return !!annotation && ownContentVisible(ui, owner, annotation.categoryIds);
}
