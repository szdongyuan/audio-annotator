import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { AnalysisSettings, MediaView, ViewState, Region, MediaDescriptor } from '../../bridge/types';
import type { ActiveProject } from '../project/useProjectLifecycle';
import { clampSplit } from './CompareSplitter';
import { analysisKey, changeView, defaultView, defaultSettings, toggleLinked } from './workspace';
import { displayPatch, useLocalSettings } from '../settings/localSettings';
const blank = (): ViewState => ({ media: {}, activeMediaId: null, compareMediaId: null, linkedTime: false, compareLayout: 'horizontal', compareSplit: .5 });
const noop = () => () => {};
function reconcile(value: ViewState, media: MediaDescriptor[],hidden:readonly string[]=[]): ViewState {
  const ids = new Set(media.map(m => m.id)),visible=media.filter(m=>!hidden.includes(m.id)),visibleIds=new Set(visible.map(m=>m.id));
  const activeMediaId = value.activeMediaId && visibleIds.has(value.activeMediaId) ? value.activeMediaId : visible.find(m=>m.id !== value.compareMediaId)?.id ?? visible[0]?.id ?? null;
  const compareMediaId = value.compareMediaId && visibleIds.has(value.compareMediaId) && value.compareMediaId !== activeMediaId ? value.compareMediaId : null;
  return { ...value, media: Object.fromEntries(Object.entries(value.media).filter(([id]) => ids.has(id))), activeMediaId, compareMediaId, linkedTime: !!compareMediaId && value.linkedTime };
}
/** View drafts share the project's close/save flush and serialized mutation queue. */
export type PanePosition = 'primary' | 'compare';
export function useWorkspace(active: ActiveProject | null,hidden:readonly string[]=[],reveal?:(id:string)=>Promise<void>) {
  const local = useLocalSettings();
  const hiddenKey=hidden.join('|'),hiddenRef=useRef(hidden),seenHidden=useRef(hiddenKey);if(seenHidden.current!==hiddenKey){seenHidden.current=hiddenKey;hiddenRef.current=hidden;}
  const snapshot = useSyncExternalStore(active?.store.subscribe ?? noop, () => active?.store.snapshot);
  const [state, setState] = useState<ViewState>(() => active?.store.snapshot.document.viewState ?? blank());
  const current = useRef(state), timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const binding = useRef<ActiveProject | null>(active);
  const reconciledSource = useRef<{ owner: ActiveProject; value: string } | null>(null);
  const resolveView = (value: ViewState, media: MediaDescriptor[]) => {
    // A null saved primary is an unresolved default, not a request to switch on
    // every catalog append. Retain its resolved pane only for unchanged authority.
    const sameSource = reconciledSource.current?.owner === active && reconciledSource.current.value === JSON.stringify(value);
    return reconcile(sameSource && value.activeMediaId === null ? { ...value, activeMediaId: current.current.activeMediaId } : value, media, hiddenRef.current);
  };
  const [duplicatePane, setDuplicatePane] = useState<PanePosition | null>(null);
  const duplicateTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const draftKey = 'spectrogram-view';
  const submit = async () => {
    if (!active || !active.store.drafts.has(draftKey)) return;
    clearTimeout(timer.current);
    const value = reconcile(JSON.parse(active.store.drafts.get(draftKey)!) as ViewState, active.store.snapshot.document.media,hiddenRef.current);
    active.store.setDraft(draftKey, JSON.stringify(value));
    await active.queue.enqueue({ type: 'updateViewState', viewState: value }, { draftKey });
  };
  useEffect(() => {
    binding.current = active;hiddenRef.current=hidden;
    reconciledSource.current = null;
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
    const source = pending ? JSON.parse(pending) as ViewState : snapshot.document.viewState;
    const next = resolveView(source, snapshot.document.media);
    reconciledSource.current = { owner: active, value: JSON.stringify(source) };
    current.current = next; setState(next);
    if (pending && JSON.stringify(next) !== pending && !active.store.editingDisabled) active.store.setDraft(draftKey, JSON.stringify(next));
  }, [active, snapshot,hiddenKey]);
  const update = (next: ViewState) => {
    if (!active || binding.current !== active || active.store.editingDisabled) return;
    current.current = next; setState(next);
    active.store.setDraft(draftKey, JSON.stringify(next));
    clearTimeout(timer.current); timer.current = setTimeout(() => { void submit().catch(() => {}); }, 180);
  };
  const selectPane = (pane: PanePosition, id: string | null) => {
    if (!active || binding.current !== active || active.store.editingDisabled) return false;
    const media = active.store.snapshot.document.media;
    if (id === null && pane === 'primary' || id !== null && (!media.some(m => m.id === id)||hiddenRef.current.includes(id))) return false;
    // Menu callbacks may outlive a render or run before snapshot effects settle.
    const pending = active.store.drafts.get(draftKey);
    const latest = resolveView(pending ? JSON.parse(pending) as ViewState : active.store.snapshot.document.viewState, media);
    const other: PanePosition = pane === 'primary' ? 'compare' : 'primary';
    if (id && id === (other === 'primary' ? latest.activeMediaId : latest.compareMediaId)) {
      clearTimeout(duplicateTimer.current); setDuplicatePane(other);
      duplicateTimer.current = setTimeout(() => setDuplicatePane(null), 1200);
      return false;
    }
    const key = pane === 'primary' ? 'activeMediaId' : 'compareMediaId';
    if (latest[key] === id){current.current=latest;setState(latest);return true;}
    let next = { ...latest, [key]: id };
    if (!next.compareMediaId) next = toggleLinked(next, media, false);
    else if (next.linkedTime) next = toggleLinked(next, media, true);
    update(next); return true;
  };
  const media = active?.store.snapshot.document.media ?? [];
  const hiddenForView=hiddenRef.current;
  const visibleMedia=useMemo(()=>{const excluded=new Set(hiddenForView);return media.filter(m=>!excluded.has(m.id));},[media,hiddenForView]);
  const projectId = active?.store.snapshot.document.projectId ?? '';
  const view = (id: string) => ({ ...(state.media[id] ?? defaultView(media.find(m => m.id === id)!)), ...local?.value.display, ...local?.override(projectId,id).display });
  const analysis = (id: string) => local?.override(projectId,id).analysis ?? local?.value.analysis ?? active?.store.snapshot.document.analysis[id] ?? defaultSettings;
  const renderAnalysis = (id:string) => active?.store.snapshot.document.analysis[id] ?? defaultSettings;
  const submittedAnalysis = useMemo(()=>new Map<string,string>(),[active]);
  const visibleAnalysis = [state.activeMediaId,state.compareMediaId].filter((id):id is string=>!!id&&media.some(m=>m.id===id));
  const analysisIntent = JSON.stringify(visibleAnalysis.map(id=>[id,analysisKey(analysis(id))]));
  useEffect(()=>{
    if(!active || binding.current!==active || active.store.editingDisabled || !local?.value.analysis || active.queue.unresolvedFailures.length) return;
    // Materialize personal defaults only for visible files. The renderer keeps
    // the accepted native settings until ACK, so stale-config tiles are never requested.
    for(const id of visibleAnalysis){
      const desired=analysis(id),key=analysisKey(desired);
      if(analysisKey(renderAnalysis(id))===key){submittedAnalysis.delete(id);continue;}
      if(submittedAnalysis.get(id)===key)continue;
      submittedAnalysis.set(id,key);
      void active.queue.enqueue({type:'updateAnalysis',mediaId:id,settings:desired},{owner:`media:${id}`}).catch(()=>{});
    }
  },[active,analysisIntent,snapshot,active?.store.editingDisabled,local,submittedAnalysis]);
  return {
    state, view, analysis, renderAnalysis, selectPane, duplicatePane,visibleMedia,
    hasGlobalSettings: !!local && (!!local.value.analysis || Object.keys(local.value.display).length > 0),
    followGlobal: (id: string) => { if (active && binding.current === active && !active.store.editingDisabled) local?.follow(projectId,id,['display','analysis']); },
    revealMedia:async(id:string)=>{if(!active||binding.current!==active)return false;if(hiddenRef.current.includes(id)){if(!reveal)return false;try{await reveal(id);}catch{return false;}if(binding.current!==active)return false;hiddenRef.current=hiddenRef.current.filter(hidden=>hidden!==id);}return true;},
    layout: (compareLayout: ViewState['compareLayout']) => update({ ...current.current, compareLayout }),
    split: (compareSplit: number) => update({ ...current.current, compareSplit: clampSplit(compareSplit) }),
    locate: (region: Region) => {
      const target = media.find(m => m.id === region.mediaId); if (!target) return;
      const margin = (region.endSeconds - region.startSeconds) * .25;
      const frequencyMargin = (region.highHz - region.lowHz) * .25;
      const next = changeView(current.current, media, target.id, { visibleChannels: [region.channelIndex], startSeconds: Math.max(0, region.startSeconds - margin), endSeconds: Math.min(durationOf(target), region.endSeconds + margin), lowHz: Math.max(0, region.lowHz - frequencyMargin), highHz: Math.min(target.sampleRate / 2, region.highHz + frequencyMargin) });
      update(next);
    },
    patch: (id: string, patch: Partial<MediaView>) => {
      if (!active || binding.current !== active || active.store.editingDisabled || !media.some(m=>m.id===id)) return;
      const display = displayPatch(patch);
      if (local && Object.keys(display).some(key=>key in local.value.display) && !local.patchMedia(projectId,id,{display})) return;
      update(changeView(current.current, media, id, patch));
    },
    compare: (id: string | null) => selectPane('compare', id),
    link: (linked: boolean) => update(toggleLinked(current.current, media, linked)),
    settings: (mediaId: string, settings: AnalysisSettings) => {
      if (!active || binding.current !== active || active.store.editingDisabled) return;
      if (local?.value.analysis) { local.patchMedia(projectId,mediaId,{analysis:settings}); return; }
      void active.queue.enqueue({ type: 'updateAnalysis', mediaId, settings }).catch(() => {});
    },
  };
}
const durationOf = (media: MediaDescriptor) => media.frameCount / media.sampleRate;
export type WorkspaceUI = ReturnType<typeof useWorkspace>;
