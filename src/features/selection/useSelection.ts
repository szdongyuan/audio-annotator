import { reconcileContext, type VisiblePane } from '../annotations/classification';
import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ActiveProject } from '../project/useProjectLifecycle';
import { shortcutAction } from '../project/shortcuts';
import { resolveRegion, selectionActions } from './actions';
import type { Region } from '../../bridge/types';
import { SelectionState, type Selection } from './state';
import { useCategoryChoices } from '../collaboration/categoryChoices';
export type RegionMenuTarget = { seconds?: number; x: number; y: number; target: Selection | null; overlaps: Selection[]; mediaId: string; channelIndex: number };
export function useSelection(active: ActiveProject | null, primaryId: string | null, panes?: VisiblePane[]) {
  const vocabulary = useCategoryChoices(active), vocabularyRef = useRef(vocabulary); vocabularyRef.current = vocabulary;
  const state = useMemo(() => new SelectionState(), [active]);
  const selection = useSyncExternalStore(state.subscribe, state.getActiveSelection);
  const candidate = useSyncExternalStore(state.subscribe, state.getCandidate);
  const context = useSyncExternalStore(state.subscribe, state.getContext);
  const gesturing = useSyncExternalStore(state.subscribe, state.getGesture);
  const actions = useMemo(() => active ? selectionActions(active, state, id=>vocabularyRef.current.resolve(id)) : null, [active, state]);
  const [menuState, setMenu] = useState<{ owner: ActiveProject | null; value: RegionMenuTarget; intent: number } | null>(null), [cancelVersion, setCancelVersion] = useState(0);
  const [gainState, setGain] = useState<{ owner: ActiveProject; target: Selection; trigger: HTMLElement | null } | null>(null);
  const gain = gainState?.owner === active && !active?.store.editingDisabled && state.matches(gainState.target) ? gainState : null;
  useEffect(() => { if (gainState && !gain) setGain(null); }, [gainState, gain]);
  const menu = menuState?.owner === active && (menuState.intent === state.intentVersion || menuState.value.target && state.matches(menuState.value.target)) ? menuState.value : null;
  useEffect(() => { if (menuState && !menu) setMenu(null); }, [menuState, menu]);
  const binding = useRef(active); binding.current = active;
  const cancel = () => { state.cancel(); setCancelVersion(v => v + 1); };
  useEffect(() => {
    setMenu(null);
    return active?.store.subscribe(() => {
      state.reconcile(active.store.snapshot.document);
      setMenu(current => {
        if (!current || current.owner !== active) return current;
        const target = current.value.target;
        return active.store.editingDisabled || target && !resolveRegion(active, state.follow(target)) || !active.store.snapshot.document.media.some(m => m.id === current.value.mediaId) ? null : current;
      });
    });
  }, [active, state]);
  useEffect(() => {
    // A list Locate may already have explicitly selected the new primary file.
    if (panes) return;
    if (state.getCandidate()?.region.mediaId !== primaryId) { state.endGesture(); state.select(null); }
    const retained = state.getCandidate(), explicit = state.getContext();
    state.interact(explicit?.mediaId === primaryId ? explicit : retained ? { mediaId: retained.region.mediaId, channelIndex: retained.region.channelIndex } : primaryId ? { mediaId: primaryId, channelIndex: 0 } : null);
    setMenu(null); setCancelVersion(v => v + 1);
  }, [primaryId, state]);
  const paneKey = JSON.stringify(panes);
  useEffect(() => {
    if (!active || !panes) return;
    const selected = state.getCandidate();
    if (selected && !panes.some(p => p.mediaId === selected.region.mediaId && p.channels.includes(selected.region.channelIndex))) {
      state.endGesture(); state.select(null); setCancelVersion(v => v + 1);
    }
    state.interact(reconcileContext(active.store.snapshot.document, state.getContext(), panes));
    setMenu(current => current && panes.some(p => p.mediaId === current.value.mediaId && p.channels.includes(current.value.channelIndex)) ? current : null);
  }, [active, state, paneKey, primaryId, active?.store.snapshot.document]);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!active || e.defaultPrevented || active.store.editingDisabled) return;
      const action = shortcutAction(e);
      if (action === 'cancel') { e.preventDefault(); cancel(); }
      const target = state.getActiveSelection();
      if (action === 'delete' && target && !e.repeat) { e.preventDefault(); void (target.object?.kind === 'annotation' ? actions!.remove(target) : actions!.mask(target)); }
    };
    window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler);
  }, [active, state, actions]);
  return { active, state, selection, candidate, context, gesturing, actions, categories:vocabulary.choices, cancelVersion, cancel, menu, gain,
    openGain: (target: Selection, trigger: HTMLElement | null = null) => {
      if (!active || binding.current !== active || active.store.editingDisabled || !resolveRegion(active, target)) return;
      const followed = state.follow(target); if (!state.matches(followed)) state.select(followed);
      setGain({ owner: active, target: followed, trigger });
    }, closeGain: () => setGain(null),
    withTarget: (target: Selection | null, action: (region: Region) => void) => {
      // Synchronous UI actions must re-read after any accepted native command,
      // and a retained callback must never cross a runtime replacement.
      if (!target || !active || binding.current !== active || active.store.editingDisabled) return;
      const region = resolveRegion(active, state.follow(target));
      if (region) action(region);
    },
    openMenu: (target: RegionMenuTarget) => { if (binding.current === active) setMenu({ owner: active, value: target, intent: state.intentVersion }); }, closeMenu: () => setMenu(null),
    selectObject: (kind: 'annotation' | 'mask', id: string | null) => {
      if (!id) { if (state.getActiveSelection()?.object?.kind === kind) state.select(null); return; }
      const doc = active?.store.snapshot.document, object = (kind === 'annotation' ? doc?.annotations : doc?.edits)?.find(a => a.id === id);
      if (object) { state.endGesture(); state.select({ region: object.region, object: { kind, id } }); }
    },
  };
}
export type SelectionUI = ReturnType<typeof useSelection>;
export const SelectionContext = createContext<SelectionUI | null>(null);
export const useSelectionContext = () => useContext(SelectionContext);
