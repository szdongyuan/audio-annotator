import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { AnalysisSettings, MediaView, ViewState, Region, MediaDescriptor } from '../../bridge/types';
import type { ActiveProject } from '../project/useProjectLifecycle';
import { clampSplit } from './CompareSplitter';
import { changeView, defaultView, toggleLinked } from './workspace';
const blank = (): ViewState => ({ media: {}, activeMediaId: null, compareMediaId: null, linkedTime: false, compareLayout: 'horizontal', compareSplit: .5 });
const noop = () => () => {};
function reconcile(value: ViewState, media: MediaDescriptor[]): ViewState {
  const ids = new Set(media.map(m => m.id));
  const activeMediaId = value.activeMediaId && ids.has(value.activeMediaId) ? value.activeMediaId : media[0]?.id ?? null;
  const compareMediaId = value.compareMediaId && ids.has(value.compareMediaId) && value.compareMediaId !== activeMediaId ? value.compareMediaId : null;
  return { ...value, media: Object.fromEntries(Object.entries(value.media).filter(([id]) => ids.has(id))), activeMediaId, compareMediaId, linkedTime: !!compareMediaId && value.linkedTime };
}
/** View drafts share the project's close/save flush and serialized mutation queue. */
export type PanePosition = 'primary' | 'compare';
export function useWorkspace(active: ActiveProject | null) {
  const snapshot = useSyncExternalStore(active?.store.subscribe ?? noop, () => active?.store.snapshot);
  const [state, setState] = useState<ViewState>(() => active?.store.snapshot.document.viewState ?? blank());
  const current = useRef(state), timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const binding = useRef<ActiveProject | null>(active);
  const [duplicatePane, setDuplicatePane] = useState<PanePosition | null>(null);
  const duplicateTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
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
    setDuplicatePane(null);
    current.current = active?.store.snapshot.document.viewState ?? blank(); setState(current.current);
    const unregister = active?.lifecycle.registerDraft(draftKey, submit);
    return () => { clearTimeout(timer.current); clearTimeout(duplicateTimer.current); unregister?.(); binding.current = null; };
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
  const selectPane = (pane: PanePosition, id: string | null) => {
    if (!active || binding.current !== active || active.store.editingDisabled) return false;
    const media = active.store.snapshot.document.media;
    if (id === null && pane === 'primary' || id !== null && !media.some(m => m.id === id)) return false;
    // Menu callbacks may outlive a render or run before snapshot effects settle.
    const pending = active.store.drafts.get(draftKey);
    const latest = reconcile(pending ? JSON.parse(pending) as ViewState : active.store.snapshot.document.viewState, media);
    const other: PanePosition = pane === 'primary' ? 'compare' : 'primary';
    if (id && id === (other === 'primary' ? latest.activeMediaId : latest.compareMediaId)) {
      clearTimeout(duplicateTimer.current); setDuplicatePane(other);
      duplicateTimer.current = setTimeout(() => setDuplicatePane(null), 1200);
      return false;
    }
    const key = pane === 'primary' ? 'activeMediaId' : 'compareMediaId';
    if (latest[key] === id) return true;
    let next = { ...latest, [key]: id };
    if (!next.compareMediaId) next = toggleLinked(next, media, false);
    else if (next.linkedTime) next = toggleLinked(next, media, true);
    update(next); return true;
  };
  const media = active?.store.snapshot.document.media ?? [];
  const view = (id: string) => state.media[id] ?? defaultView(media.find(m => m.id === id)!);
  return {
    state, view, selectPane, duplicatePane,
    layout: (compareLayout: ViewState['compareLayout']) => update({ ...current.current, compareLayout }),
    split: (compareSplit: number) => update({ ...current.current, compareSplit: clampSplit(compareSplit) }),
    locate: (region: Region) => {
      const target = media.find(m => m.id === region.mediaId); if (!target) return;
      const margin = (region.endSeconds - region.startSeconds) * .25;
      const frequencyMargin = (region.highHz - region.lowHz) * .25;
      const next = changeView(current.current, media, target.id, { visibleChannels: [region.channelIndex], startSeconds: Math.max(0, region.startSeconds - margin), endSeconds: Math.min(durationOf(target), region.endSeconds + margin), lowHz: Math.max(0, region.lowHz - frequencyMargin), highHz: Math.min(target.sampleRate / 2, region.highHz + frequencyMargin) });
      update(next);
    },
    patch: (id: string, patch: Partial<MediaView>) => update(changeView(current.current, media, id, patch)),
    compare: (id: string | null) => selectPane('compare', id),
    link: (linked: boolean) => update(toggleLinked(current.current, media, linked)),
    settings: (mediaId: string, settings: AnalysisSettings) => {
      if (!active || active.store.editingDisabled) return;
      void active.queue.enqueue({ type: 'updateAnalysis', mediaId, settings }).catch(() => {});
    },
  };
}
const durationOf = (media: MediaDescriptor) => media.frameCount / media.sampleRate;
export type WorkspaceUI = ReturnType<typeof useWorkspace>;
