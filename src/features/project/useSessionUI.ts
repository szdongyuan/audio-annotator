import { useEffect, useRef } from 'react';
import type { PlaybackUI } from '../playback/usePlayback';
import type { ActiveProject, ProjectLifecycleUI } from './useProjectLifecycle';
import { validSessionCues, type SessionUI } from './session';

/** Run after owner-reset effects. Do not acknowledge pre-restoration render state. */
export function useSessionUI(project: ProjectLifecycleUI | undefined, ui: SessionUI, apply: (ui: SessionUI) => void, playback: PlaybackUI, excluded: readonly string[], ready: boolean) {
  const owner = project?.active ?? null;
  const applied = useRef<ActiveProject | null>(null), pending = useRef<SessionUI | null>(null);
  useEffect(() => {
    if (!owner) { applied.current = null; pending.current = null; return; }
    if (!ready || applied.current === owner) return;
    const next = owner.restoredUI ?? { ...ui, inspectorTab: 'region', cues: {} };
    const validated = { ...next, cues: validSessionCues(next.cues, owner.store.snapshot.document, excluded) };
    applied.current = owner; pending.current = validated;
    apply(validated); playback.restoreCues(owner, validated.cues);
    // The owner is restored once, after recovery and visibility are ready.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner, ready]);
  useEffect(() => {
    if (!owner || !ready || applied.current !== owner) return;
    if (pending.current && JSON.stringify(pending.current) !== JSON.stringify(ui)) return;
    pending.current = null;
    project?.acknowledgeSessionUI?.(owner, ui, excluded);
  });
}
