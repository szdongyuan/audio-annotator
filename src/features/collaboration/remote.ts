import { labelText } from '../annotations/labels';
import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { AuthorSnapshot } from '../../bridge/collaboration';
import type { Annotation, Category, MediaDescriptor } from '../../bridge/types';
import type { ActiveProject } from '../project/useProjectLifecycle';
import type { PlaybackUI } from '../playback/usePlayback';
import type { WorkspaceUI } from '../spectrogram/useWorkspace';
import type { CollaborationUI } from './useCollaboration';
import { validRegion } from '../selection/state';

// These identities are deliberately not Selection/ObjectRef IDs.
export type RemoteTarget = { owner: ActiveProject; authorId: string } & (
  { scope: 'region'; annotationId: string } |
  { scope: 'file'; mediaId: string } |
  { scope: 'channel'; mediaId: string; channelIndex: number }
);
// Own content is a presentation snapshot, never a fabricated published layer.
export type InspectorAuthor = Pick<AuthorSnapshot, 'identity' | 'error'> & { layer: { payload: NonNullable<AuthorSnapshot['layer']>['payload'] } | null };
export interface RemoteValue { author: InspectorAuthor; media: MediaDescriptor; category: Category | undefined; categoryText: string; note: string; annotation?: Annotation; channelIndex?: number }
export const remoteKey = (authorId: string, annotationId: string) => `${authorId}:${annotationId}`;
const noSubscription = () => () => {};
export function useInspectionDocument(owner: ActiveProject | null | undefined) {
  return useSyncExternalStore(owner?.store.subscribe ?? noSubscription, () => owner?.store.snapshot ?? null);
}
function currentAuthor(owner: ActiveProject): InspectorAuthor | null {
  const identity = owner.collaboration?.actor;
  if (!identity) return null;
  const { categories, annotations, media } = owner.store.snapshot.document;
  return { identity, error: null, layer: { payload: { categories, annotations, mediaLabels: media.map(({ id, note, channelNotes, categoryIds, channelCategoryIds }) => ({ mediaId: id, note, channelNotes, categoryIds, channelCategoryIds })) } } };
}
export function authorsForInspector(ui: CollaborationUI | null | undefined): InspectorAuthor[] {
  if (!ui?.active?.collaboration || ui.controller?.owner !== ui.active) return [];
  const own = currentAuthor(ui.active);
  return [...(own ? [own] : []), ...(ui.controller.status?.snapshot?.authors ?? []).filter(a => a.identity.authorId !== own?.identity.authorId)];
}
export function foreignAuthors(ui: CollaborationUI | null | undefined): AuthorSnapshot[] {
  if (!ui?.active?.collaboration || ui.controller?.owner !== ui.active) return [];
  return (ui.controller.status?.snapshot?.authors ?? []).filter(a => a.identity.authorId !== ui.active!.collaboration!.actor?.authorId && ui.controller!.visible(a.identity.authorId));
}
/** Resolve at action time against the current verified state, including retained last-good layers. */
export function resolveRemote(ui: CollaborationUI | null | undefined, target: RemoteTarget): RemoteValue | null {
  if (!ui?.active || ui.active !== target.owner || ui.controller?.owner !== target.owner) return null;
  const author = target.authorId === ui.active.collaboration?.actor?.authorId ? currentAuthor(ui.active)
    : ui.controller.status?.snapshot?.authors.find(a => a.identity.authorId === target.authorId), payload = author?.layer?.payload;
  if (!author || !payload) return null;
  const annotation = target.scope === 'region' ? payload.annotations.find(a => a.id === target.annotationId) : undefined;
  if (target.scope === 'region' && !annotation) return null;
  const mediaId = target.scope === 'region' ? annotation!.region.mediaId : target.mediaId;
  const media = ui.active.store.snapshot.document.media.find(m => m.id === mediaId);
  if (!media) return null;
  if (annotation && !validRegion(ui.active.store.snapshot.document, annotation.region)) return null;
  const labels = payload.mediaLabels.find(m => m.mediaId === mediaId);
  const channelIndex = target.scope === 'region' ? annotation!.region.channelIndex : target.scope === 'channel' ? target.channelIndex : undefined;
  if (channelIndex !== undefined && (channelIndex < 0 || channelIndex >= media.channelCount)) return null;
  if (target.scope !== 'region' && !labels) return null;
  const categoryIds = annotation ? annotation.categoryIds : channelIndex === undefined ? labels!.categoryIds : labels!.channelCategoryIds[channelIndex];
  return { author, media, annotation, channelIndex, category: payload.categories.find(c => categoryIds.includes(c.id)), categoryText: labelText(payload.categories, categoryIds), note: annotation ? annotation.note : channelIndex === undefined ? labels!.note : labels!.channelNotes[channelIndex] };
}
export function useRemoteInspection(ui: CollaborationUI | null | undefined, workspace: WorkspaceUI, playback: PlaybackUI) {
  useInspectionDocument(ui?.active);
  const [target, setTarget] = useState<RemoteTarget | null>(null);
  const current = useRef({ ui, workspace, playback }); current.current = { ui, workspace, playback };
  const intent = useRef(0);
  useEffect(() => () => { intent.current++; }, []);
  const inspect = (next: RemoteTarget) => { if (resolveRemote(current.current.ui, next)) { intent.current++; setTarget(next); } };
  const locate = async (captured: RemoteTarget) => {
    const before = resolveRemote(current.current.ui, captured), sequence = ++intent.current;
    const actor = captured.owner.collaboration?.actor?.authorId, runtime = captured.owner.collaboration?.runtimeNonce;
    if (!before || captured.owner.store.editingDisabled) return false;
    if(workspace.revealMedia&&!await current.current.workspace.revealMedia(before.media.id))return false;
    const value = resolveRemote(current.current.ui, captured), w = current.current.workspace;
    if (!value || intent.current !== sequence || captured.owner.store.editingDisabled || captured.owner.collaboration?.actor?.authorId !== actor || captured.owner.collaboration?.runtimeNonce !== runtime || value.media.id !== before.media.id) return false;
    if (value.media.id !== w.state.activeMediaId && value.media.id !== w.state.compareMediaId && w.selectPane('primary', value.media.id) === false) return false;
    if (value.annotation) w.locate(value.annotation.region);
    else if (value.channelIndex !== undefined) w.patch(value.media.id, { visibleChannels: [...new Set([...w.view(value.media.id).visibleChannels, value.channelIndex])].sort((a, b) => a - b) });
    return true;
  };
  return { inspect, locate, close: () => { intent.current++; setTarget(null); }, selected: target && target.owner === ui?.active ? target : null, value: target ? resolveRemote(ui, target) : null };
}
export const RemoteContext = createContext<ReturnType<typeof useRemoteInspection> | null>(null);
export const useRemoteContext = () => useContext(RemoteContext);
