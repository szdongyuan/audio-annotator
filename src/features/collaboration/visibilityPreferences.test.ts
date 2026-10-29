import { afterEach, expect, it, vi } from 'vitest';
import { readVisibility, writeVisibility, visibilityKey } from './visibilityPreferences';

const project = '11111111-1111-4111-8111-111111111111';
const actor = '22222222-2222-4222-8222-222222222222';
const value = { filter: { mode: 'custom' as const, authorIds: [actor] }, hiddenCategoryNames: [' Bird ', 'Noise', 'Bird'], includeOwnCategories: true };
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

it('round trips separate versioned local filters bound to project and actor, including null', () => {
 writeVisibility(project, actor, value);
 expect(readVisibility(project, actor)).toEqual({ ...value, hiddenCategoryNames: ['Bird', 'Noise'] });
 expect(readVisibility(actor, actor)).toBeNull(); expect(readVisibility(project, null)).toBeNull();
 writeVisibility(project, null, { ...value, filter: { mode: 'mine' } });
 expect(readVisibility(project, null)?.filter).toEqual({ mode: 'mine' });
 expect(readVisibility(project, actor)?.filter).toEqual(value.filter);
});
it('rejects malformed, invalid and oversized storage, unavailable storage and quota errors', () => {
 for (const raw of ['{', 'x'.repeat(262145), JSON.stringify({ version: 2, entries: [] }), JSON.stringify({ version: 1, entries: [{ projectId: project, actorId: actor, ...value, filter: { mode: 'unknown' } }] })]) {
  localStorage.setItem(visibilityKey, raw); expect(readVisibility(project, actor)).toBeNull();
 }
 const unavailable = { getItem: () => { throw Error('denied'); }, setItem: () => { throw Error('quota'); } };
 expect(readVisibility(project, actor, unavailable)).toBeNull(); expect(() => writeVisibility(project, actor, value, unavailable)).not.toThrow();
 vi.stubGlobal('localStorage', unavailable); expect(readVisibility(project, actor)).toBeNull(); expect(() => writeVisibility(project, actor, value)).not.toThrow();
});
it('bounds owners, names, IDs and total bytes; invalid identities never write', () => {
 const large = { ...value, hiddenCategoryNames: Array.from({ length: 1000 }, (_, i) => String(i).padEnd(100, 'x')), filter: { mode: 'custom' as const, authorIds: Array(1000).fill(actor) } };
 for (let i = 0; i < 40; i++) {
  writeVisibility(`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`, actor, large);
  expect(localStorage.getItem(visibilityKey)!.length).toBeLessThanOrEqual(262144);
 }
 const entries = JSON.parse(localStorage.getItem(visibilityKey)!).entries;
 expect(entries.length).toBeLessThanOrEqual(32); expect(entries.at(-1).hiddenCategoryNames).toHaveLength(512); expect(entries.at(-1).filter.authorIds).toEqual([actor]);
 const before = localStorage.getItem(visibilityKey); writeVisibility('bad', actor, value); expect(localStorage.getItem(visibilityKey)).toBe(before);
});
it('keeps even a single owner with heavily escaped category names within the storage bound', () => {
 const names = Array.from({ length: 512 }, (_, i) => `${i}${'\u0001'.repeat(95)}`);
 writeVisibility(project, actor, { ...value, hiddenCategoryNames: names });
 expect(localStorage.getItem(visibilityKey)!.length).toBeLessThanOrEqual(262144);
 expect(readVisibility(project, actor)).not.toBeNull();
});
