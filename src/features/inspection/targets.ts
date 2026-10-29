import type { InspectionBinding } from '../../bridge/inspection';
import type { ActiveProject } from '../project/useProjectLifecycle';
import type { RemoteTarget, RemoteValue } from '../collaboration/remote';
import { labelText } from '../annotations/labels';
import { validRegion } from '../selection/state';
export type OwnInspectionTarget = { owner: ActiveProject } & (
 { scope: 'region'; annotationId: string } | { scope: 'file'; mediaId: string } | { scope: 'channel'; mediaId: string; channelIndex: number }
);
export type InspectionTarget = OwnInspectionTarget | RemoteTarget;
export function inspectionBinding(owner: ActiveProject, identityRuntime?: string): InspectionBinding | null {
 const runtimeNonce = owner.collaboration?.runtimeNonce ?? identityRuntime;
 return runtimeNonce ? { runtimeNonce, projectId: owner.store.snapshot.document.projectId } : null;
}
export function resolveOwnInspection(target: OwnInspectionTarget): RemoteValue | null {
 const doc = target.owner.store.snapshot.document;
 const annotation = target.scope === 'region' ? doc.annotations.find(a => a.id === target.annotationId) : undefined;
 if (target.scope === 'region' && (!annotation || !validRegion(doc, annotation.region))) return null;
 const media = doc.media.find(m => m.id === (target.scope === 'region' ? annotation!.region.mediaId : target.mediaId));
 if (!media) return null;
 const channelIndex = annotation?.region.channelIndex ?? (target.scope === 'channel' ? target.channelIndex : undefined);
 if (channelIndex !== undefined && (!Number.isInteger(channelIndex) || channelIndex < 0 || channelIndex >= media.channelCount)) return null;
 const categoryIds = annotation?.categoryIds ?? (channelIndex === undefined ? media.categoryIds : media.channelCategoryIds[channelIndex]);
 return { media, annotation, channelIndex, category: doc.categories.find(c => categoryIds.includes(c.id)), categoryText: labelText(doc.categories, categoryIds),
  note: annotation ? annotation.note : channelIndex === undefined ? media.note : media.channelNotes[channelIndex],
  author: { identity: target.owner.collaboration?.actor ?? { authorId: 'local', displayName: '我', createdAt: doc.createdAt }, layer: null, error: null } };
}
export const inspectionTargetKey = (target: InspectionTarget) => JSON.stringify(['authorId' in target ? target.authorId : null, target.scope, target.scope === 'region' ? target.annotationId : target.mediaId, target.scope === 'channel' ? target.channelIndex : null]);
