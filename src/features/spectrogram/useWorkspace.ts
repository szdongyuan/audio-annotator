import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { AnalysisSettings, MediaView, ViewState, Region, MediaDescriptor } from '../../bridge/types';
import type { ActiveProject } from '../project/useProjectLifecycle';
import { changeView, defaultView, toggleLinked } from './workspace';
const blank = (): ViewState => ({ media: {}, activeMediaId: null, compareMediaId: null, linkedTime: false });
const noop = () => () => {};
function reconcile(value: ViewState, media: MediaDescriptor[]): ViewState {
  const ids = new Set(media.map(m => m.id));
  const activeMediaId = value.activeMediaId && ids.has(value.activeMediaId) ? value.activeMediaId : media[0]?.id ?? null;
  const compareMediaId = value.compareMediaId && ids.has(value.compareMediaId) && value.compareMediaId !== activeMediaId ? value.compareMediaId : null;
  return { ...value, media: Object.fromEntries(Object.entries(value.media).filter(([id]) => ids.has(id))), activeMediaId, compareMediaId, linkedTime: !!compareMediaId && value.linkedTime };
}
/** View drafts share the project's close/save flush and serialized mutation queue. */
export function useWorkspace(active: ActiveProject | null, selectedId: string | null) {
  const snapshot = useSyncExternalStore(active?.store.subscribe ?? noop, () => active?.store.snapshot);
  const [state, setState] = useState<ViewState>(() => active?.store.snapshot.document.viewState ?? blank());
  const current = useRef(state), timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const binding = useRef<ActiveProject | null>(active);
  const draftKey = 'spectrogram-view';
  const submit = async () => {
    if (!active || !active.store.drafts.has(draftKey)) return;
    clearTimeout(timer.current);
    const value = reconcile(JSON.parse(active.store.drafts.get(draftKey)!) as ViewState, active.store.snapshot.document.media);
    active.store.setDraft(draftKey, JSON.stringify(value));
    await active.queue.enqueue({ type: 'updateViewState', viewState: value }, { draftKey });
  };
  useEffect(() => {
    binding.current = active;
    current.current = active?.store.snapshot.document.viewState ?? blank(); setState(current.current);
    const unregister = active?.lifecycle.registerDraft(draftKey, submit);
    return () => { clearTimeout(timer.current); unregister?.(); binding.current = null; };
    // The runtime owner, not projectId, defines lifecycle (including Save As).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
  useEffect(() => {
    if (!active || !snapshot) return;
    const pending = active.store.drafts.get(draftKey);
    const next = reconcile(pending ? JSON.parse(pending) as ViewState : snapshot.document.viewState, snapshot.document.media);
    current.current = next; setState(next);
    if (pending && JSON.stringify(next) !== pending && !active.store.editingDisabled) active.store.setDraft(draftKey, JSON.stringify(next));
  }, [active, snapshot]);
  const update = (next: ViewState) => {
    if (!active || binding.current !== active || active.store.editingDisabled) return;
    current.current = next; setState(next);
    active.store.setDraft(draftKey, JSON.stringify(next));
    clearTimeout(timer.current); timer.current = setTimeout(() => { void submit().catch(() => {}); }, 180);
  };
  useEffect(() => {
    if (!active || !selectedId || !active.store.snapshot.document.media.some(m => m.id === selectedId) || selectedId === current.current.activeMediaId) return;
    let next: ViewState = { ...current.current, activeMediaId: selectedId };
    if (next.compareMediaId === selectedId) next.compareMediaId = current.current.activeMediaId;
    if (next.linkedTime) next = toggleLinked(next, active.store.snapshot.document.media, true);
    update(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, selectedId]);
  const media = active?.store.snapshot.document.media ?? [];
  const view = (id: string) => state.media[id] ?? defaultView(media.find(m => m.id === id)!);
  return {
    state, view,
    locate: (region: Region) => {
      const target = media.find(m => m.id === region.mediaId); if (!target) return;
      const margin = (region.endSeconds - region.startSeconds) * .25;
      const frequencyMargin = (region.highHz - region.lowHz) * .25;
      const next = changeView(current.current, media, target.id, { visibleChannels: [region.channelIndex], startSeconds: Math.max(0, region.startSeconds - margin), endSeconds: Math.min(durationOf(target), region.endSeconds + margin), lowHz: Math.max(0, region.lowHz - frequencyMargin), highHz: Math.min(target.sampleRate / 2, region.highHz + frequencyMargin) });
      update(next);
    },
    patch: (id: string, patch: Partial<MediaView>) => update(changeView(current.current, media, id, patch)),
    compare: (id: string | null) => {
      let next = { ...current.current, compareMediaId: id };
      if (!id) next = toggleLinked(next, media, false);
      else if (next.linkedTime) next = toggleLinked(next, media, true);
      update(next);
    },
    link: (linked: boolean) => update(toggleLinked(current.current, media, linked)),
    settings: (mediaId: string, settings: AnalysisSettings) => {
      if (!active || active.store.editingDisabled) return;
      void active.queue.enqueue({ type: 'updateAnalysis', mediaId, settings }).catch(() => {});
    },
  };
}
const durationOf = (media: MediaDescriptor) => media.frameCount / media.sampleRate;
export type WorkspaceUI = ReturnType<typeof useWorkspace>;
