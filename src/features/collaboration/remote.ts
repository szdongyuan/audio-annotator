import { createContext, useContext, useRef, useState } from 'react';
import type { AuthorSnapshot } from '../../bridge/collaboration';
import type { Annotation, Category, MediaDescriptor } from '../../bridge/types';
import type { ActiveProject } from '../project/useProjectLifecycle';
import type { PlaybackUI } from '../playback/usePlayback';
import type { WorkspaceUI } from '../spectrogram/useWorkspace';
import type { CollaborationUI } from './useCollaboration';

// These identities are deliberately not Selection/ObjectRef IDs.
export type RemoteTarget = { owner: ActiveProject; authorId: string } & (
  { scope: 'region'; annotationId: string } |
  { scope: 'file'; mediaId: string } |
  { scope: 'channel'; mediaId: string; channelIndex: number }
);
export interface RemoteValue { author: AuthorSnapshot; media: MediaDescriptor; category: Category | undefined; note: string; annotation?: Annotation; channelIndex?: number }
export const remoteKey = (authorId: string, annotationId: string) => `${authorId}:${annotationId}`;
export function foreignAuthors(ui: CollaborationUI | null | undefined): AuthorSnapshot[] {
  if (!ui?.active?.collaboration || ui.controller?.owner !== ui.active) return [];
  return (ui.controller.status?.snapshot?.authors ?? []).filter(a => a.identity.authorId !== ui.active!.collaboration!.actor?.authorId && ui.controller!.visible(a.identity.authorId));
}
/** Resolve at action time against the current verified state, including retained last-good layers. */
export function resolveRemote(ui: CollaborationUI | null | undefined, target: RemoteTarget): RemoteValue | null {
  if (!ui?.active || ui.active !== target.owner || ui.controller?.owner !== target.owner || target.authorId === ui.active.collaboration?.actor?.authorId) return null;
  const author = ui.controller.status?.snapshot?.authors.find(a => a.identity.authorId === target.authorId), payload = author?.layer?.payload;
  if (!author || !payload) return null;
  const annotation = target.scope === 'region' ? payload.annotations.find(a => a.id === target.annotationId) : undefined;
  if (target.scope === 'region' && !annotation) return null;
  const mediaId = target.scope === 'region' ? annotation!.region.mediaId : target.mediaId;
  const media = ui.active.store.snapshot.document.media.find(m => m.id === mediaId);
  if (!media) return null;
  const labels = payload.mediaLabels.find(m => m.mediaId === mediaId);
  const channelIndex = target.scope === 'region' ? annotation!.region.channelIndex : target.scope === 'channel' ? target.channelIndex : undefined;
  if (channelIndex !== undefined && (channelIndex < 0 || channelIndex >= media.channelCount)) return null;
  if (target.scope !== 'region' && !labels) return null;
  const categoryId = annotation ? annotation.categoryId : channelIndex === undefined ? labels!.categoryId : labels!.channelCategoryIds[channelIndex];
  return { author, media, annotation, channelIndex, category: payload.categories.find(c => c.id === categoryId), note: annotation ? annotation.note : channelIndex === undefined ? labels!.note : labels!.channelNotes[channelIndex] };
}
export function useRemoteInspection(ui: CollaborationUI | null | undefined, workspace: WorkspaceUI, playback: PlaybackUI) {
  const [target, setTarget] = useState<RemoteTarget | null>(null);
  const current = useRef({ ui, workspace, playback }); current.current = { ui, workspace, playback };
  const inspect = (next: RemoteTarget) => { if (resolveRemote(current.current.ui, next)) setTarget(next); };
  const play = (captured: RemoteTarget) => {
    const value = resolveRemote(current.current.ui, captured);
    if (value?.annotation && !captured.owner.store.editingDisabled) current.current.playback.playSelection(value.annotation.region);
  };
  const locate = async (captured: RemoteTarget) => {
    const value = resolveRemote(current.current.ui, captured), w = current.current.workspace;
    if (!value || captured.owner.store.editingDisabled) return;
    if(w.revealMedia&&!await w.revealMedia(value.media.id))return;
    if(current.current.ui?.active!==captured.owner)return;
    if (value.media.id !== w.state.activeMediaId && value.media.id !== w.state.compareMediaId) w.selectPane('primary', value.media.id);
    if (value.annotation) w.locate(value.annotation.region);
    else if (value.channelIndex !== undefined) w.patch(value.media.id, { visibleChannels: [...new Set([...w.view(value.media.id).visibleChannels, value.channelIndex])].sort((a, b) => a - b) });
  };
  return { inspect, play, locate, close: () => setTarget(null), selected: target && target.owner === ui?.active ? target : null, value: target ? resolveRemote(ui, target) : null };
}
export const RemoteContext = createContext<ReturnType<typeof useRemoteInspection> | null>(null);
export const useRemoteContext = () => useContext(RemoteContext);
