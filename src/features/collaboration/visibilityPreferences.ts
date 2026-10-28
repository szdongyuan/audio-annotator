export type AuthorFilter = { mode: 'all' | 'mine' } | { mode: 'custom'; authorIds: string[] };
export interface VisibilityPreferences { filter: AuthorFilter; hiddenCategoryNames: string[]; includeOwnCategories: boolean }
export const visibilityKey = 'audio-annotator.annotation-visibility.v1';
type LocalStorage = Pick<Storage, 'getItem' | 'setItem'>;
interface Entry extends VisibilityPreferences { projectId: string; actorId: string | null }
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(v);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function storage(): LocalStorage | undefined { try { return window.localStorage; } catch { return undefined; } }
function sanitize(v: unknown): VisibilityPreferences | null {
 if (!object(v) || !object(v.filter) || !['all', 'mine', 'custom'].includes(String(v.filter.mode)) || !Array.isArray(v.hiddenCategoryNames) || typeof v.includeOwnCategories !== 'boolean') return null;
 let filter: AuthorFilter;
 if (v.filter.mode === 'custom') {
  if (!Array.isArray(v.filter.authorIds)) return null;
  filter = { mode: 'custom', authorIds: [...new Set(v.filter.authorIds.slice(0, 512).filter(uuid))] };
 } else filter = { mode: v.filter.mode as 'all' | 'mine' };
 const hiddenCategoryNames: string[] = [];
 let encodedLength = 0;
 for (const name of new Set(v.hiddenCategoryNames.slice(0, 512).filter((name): name is string => typeof name === 'string' && name.trim().length > 0 && name.trim().length <= 100).map(name => name.trim()))) {
  // JSON escaping can cost six characters per input character. Reserve room for IDs and owner metadata.
  const cost = JSON.stringify(name).length + 1;
  if (encodedLength + cost > 131072) break;
  encodedLength += cost; hiddenCategoryNames.push(name);
 }
 return { filter, hiddenCategoryNames, includeOwnCategories: v.includeOwnCategories };
}
function entries(target: LocalStorage | undefined): Entry[] {
 try {
  const raw = target?.getItem(visibilityKey);
  if (!raw || raw.length > 262144) return [];
  const value: unknown = JSON.parse(raw);
  if (!object(value) || value.version !== 1 || !Array.isArray(value.entries)) return [];
  return value.entries.slice(-32).flatMap((entry: unknown) => {
   if (!object(entry) || !uuid(entry.projectId) || entry.actorId !== null && !uuid(entry.actorId)) return [];
   const clean = sanitize(entry);
   return clean ? [{ projectId: entry.projectId, actorId: entry.actorId as string | null, ...clean }] : [];
  });
 } catch { return []; }
}
export function readVisibility(projectId: string, actorId: string | null, target = storage()): VisibilityPreferences | null {
 const entry = entries(target).find(e => e.projectId === projectId && e.actorId === actorId);
 return entry ? { filter: entry.filter, hiddenCategoryNames: entry.hiddenCategoryNames, includeOwnCategories: entry.includeOwnCategories } : null;
}
export function writeVisibility(projectId: string, actorId: string | null, value: VisibilityPreferences, target = storage()): void {
 if (!uuid(projectId) || actorId !== null && !uuid(actorId)) return;
 const clean = sanitize(value);
 if (!clean) return;
 const retained = [...entries(target).filter(e => e.projectId !== projectId || e.actorId !== actorId), { projectId, actorId, ...clean }].slice(-32);
 let raw = JSON.stringify({ version: 1, entries: retained });
 while (raw.length > 262144 && retained.length > 1) { retained.shift(); raw = JSON.stringify({ version: 1, entries: retained }); }
 try { target?.setItem(visibilityKey, raw); } catch { /* Optional personal display preference. */ }
}
