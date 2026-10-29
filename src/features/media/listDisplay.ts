import { useEffect, useState } from 'react';

export const listDisplayKey = 'audio-annotator.list-display.v1';
export interface ListDisplay { mode: 'tree' | 'flat'; scope: string | null; expanded: string[] }
type LocalStorage = Pick<Storage, 'getItem' | 'setItem'>;
interface Entry extends ListDisplay { projectId: string; actorId: string | null }
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(v);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function storage(): LocalStorage | undefined { try { return window.localStorage; } catch { return undefined; } }
function sanitize(v: unknown): ListDisplay | null {
  if (!object(v) || v.mode !== 'tree' && v.mode !== 'flat' || v.scope !== null && !uuid(v.scope) || !Array.isArray(v.expanded)) return null;
  return { mode: v.mode, scope: v.scope as string | null, expanded: [...new Set(v.expanded.slice(0, 512).filter(uuid))] };
}
function entries(target: LocalStorage | undefined): Entry[] {
  try {
    const raw = target?.getItem(listDisplayKey);
    if (!raw || raw.length > 262144) return [];
    const v: unknown = JSON.parse(raw);
    if (!object(v) || v.version !== 1 || !Array.isArray(v.entries)) return [];
    return v.entries.slice(-32).flatMap((entry: unknown) => {
      if (!object(entry) || !uuid(entry.projectId) || entry.actorId !== null && !uuid(entry.actorId)) return [];
      const value = sanitize(entry);
      return value ? [{ projectId: entry.projectId, actorId: entry.actorId as string | null, ...value }] : [];
    });
  } catch { return []; }
}
export function readListDisplay(projectId: string, actorId: string | null, target = storage()): ListDisplay | null {
  const entry = entries(target).find(e => e.projectId === projectId && e.actorId === actorId);
  return entry ? { mode: entry.mode, scope: entry.scope, expanded: entry.expanded } : null;
}
export function writeListDisplay(projectId: string, actorId: string | null, value: ListDisplay, target = storage()): void {
  if (!uuid(projectId) || actorId !== null && !uuid(actorId)) return;
  const clean = sanitize(value);
  if (!clean) return;
  const next = entries(target).filter(e => e.projectId !== projectId || e.actorId !== actorId);
  next.push({ projectId, actorId, ...clean });
  const retained = next.slice(-32);
  let raw = JSON.stringify({ version: 1, entries: retained });
  while (raw.length > 262144 && retained.length > 1) {
    retained.shift();
    raw = JSON.stringify({ version: 1, entries: retained });
  }
  try { target?.setItem(listDisplayKey, raw); } catch { /* Optional local UI preference. */ }
}

/** Runtime replacement keeps this owner. Reset during render so stale state cannot write to a new owner. */
export function useListDisplay(projectId: string | undefined, actorId: string | null, initialScope: string | null) {
  const key = JSON.stringify([projectId, actorId]);
  const load = (): ListDisplay => projectId && readListDisplay(projectId, actorId) || { mode: 'tree', scope: initialScope, expanded: [] };
  const [state, setState] = useState(() => ({ key, value: load(), dirty: false }));
  if (state.key !== key) setState({ key, value: load(), dirty: false });
  useEffect(() => { if (projectId && state.key === key && state.dirty) writeListDisplay(projectId, actorId, state.value); }, [projectId, actorId, key, state]);
  const update = (action: (value: ListDisplay) => ListDisplay) => setState(old => old.key === key ? { key, value: action(old.value), dirty: true } : old);
  return [state.value, update] as const;
}
