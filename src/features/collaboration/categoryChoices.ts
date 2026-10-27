import { useRef } from 'react';
import type { Category } from '../../bridge/types';
import type { ActiveProject } from '../project/useProjectLifecycle';
import { useCollaborationContext, type CollaborationUI } from './useCollaboration';

export interface CategoryChoice extends Category { authorName?: string }
/** Author layers remain independent; shared vocabulary is offered without rewriting their IDs. */
export function categoryChoices(owner: ActiveProject | null, collaboration: CollaborationUI | null, includeUsed = false): CategoryChoice[] {
  if (!owner) return [];
  const result: CategoryChoice[] = [...owner.store.snapshot.document.categories], names = new Set(result.map(c=>c.name.trim()));
  if (collaboration?.active !== owner || collaboration.controller?.owner !== owner) return result;
  // Visibility filters affect frames, not the project's available vocabulary.
  const authors = [...(collaboration.controller.status?.snapshot?.authors ?? [])].sort((a,b)=>a.identity.authorId.localeCompare(b.identity.authorId));
  for (const author of authors) if (author.identity.authorId !== owner.collaboration?.actor?.authorId) for (const c of author.layer?.payload.categories ?? []) {
    if (!includeUsed && names.has(c.name.trim())) continue;
    names.add(c.name.trim()); result.push({...c,id:`shared:${author.identity.authorId}:${c.id}`,authorName:author.identity.displayName});
  }
  return result;
}
/** Call inside the owner's serialized edit operation, after submitting drafts. */
export async function ensureCategory(owner: ActiveProject, id: string, choices: () => CategoryChoice[]): Promise<string | undefined> {
  const own = owner.store.snapshot.document.categories.find(c=>c.id===id); if (own) return own.id;
  const source = choices().find(c=>c.id===id); if (!source?.authorName) return;
  const existing = owner.store.snapshot.document.categories.find(c=>c.name.trim()===source.name.trim()); if (existing) return existing.id;
  const category = {id:crypto.randomUUID(),name:source.name.trim(),color:source.color};
  await owner.queue.enqueue({type:'addCategory',category},{owner:'annotations'}); return category.id;
}
export function useCategoryChoices(owner: ActiveProject | null) {
  const collaboration = useCollaborationContext(), current = useRef({owner,collaboration}); current.current={owner,collaboration};
  const choices = categoryChoices(owner,collaboration);
  const resolve = async(id:string) => owner && current.current.owner===owner ? ensureCategory(owner,id,()=>categoryChoices(owner,current.current.collaboration,true)) : undefined;
  return {choices,resolve};
}
