import { afterEach, expect, it, vi } from 'vitest';
import { listDisplayKey, readListDisplay, writeListDisplay } from './listDisplay';

const project = '11111111-1111-4111-8111-111111111111';
const actor = '22222222-2222-4222-8222-222222222222';
const folder = '33333333-3333-4333-8333-333333333333';
const preference = { mode: 'flat' as const, scope: folder, expanded: [folder] };
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

it('round trips mode, scope and tree expansion per project and actor, including null actor', () => {
  writeListDisplay(project, actor, preference);
  expect(readListDisplay(project, actor)).toEqual(preference);
  expect(readListDisplay(project, null)).toBeNull();
  expect(readListDisplay(actor, actor)).toBeNull();
  writeListDisplay(project, null, { ...preference, mode: 'tree', scope: null, expanded: [] });
  expect(readListDisplay(project, actor)).toEqual(preference);
  expect(readListDisplay(project, null)?.mode).toBe('tree');
});

it('rejects malformed, oversized, wrong-version and invalid records', () => {
  for (const raw of ['{', 'x'.repeat(262145), JSON.stringify({ version: 2, entries: [] }), JSON.stringify({ version: 1, entries: [{ projectId: project, actorId: actor, ...preference, scope: 'bad' }] })]) {
    localStorage.setItem(listDisplayKey, raw);
    expect(readListDisplay(project, actor)).toBeNull();
  }
});

it('bounds retained owners and expanded folders and rejects invalid owner identities', () => {
  writeListDisplay(project, actor, { ...preference, expanded: Array(1000).fill(folder) });
  expect(readListDisplay(project, actor)?.expanded).toEqual([folder]);
  for (let i = 0; i < 40; i++) writeListDisplay(`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, actor, preference);
  const stored = JSON.parse(localStorage.getItem(listDisplayKey)!);
  expect(stored.entries).toHaveLength(32);
  const before = localStorage.getItem(listDisplayKey);
  writeListDisplay('bad', actor, preference);
  expect(localStorage.getItem(listDisplayKey)).toBe(before);
});

it('tolerates unavailable and quota-exhausted local storage', () => {
  const unavailable = { getItem: () => { throw Error('denied'); }, setItem: () => { throw Error('quota'); } };
  expect(readListDisplay(project, actor, unavailable)).toBeNull();
  expect(() => writeListDisplay(project, actor, preference, unavailable)).not.toThrow();
  vi.stubGlobal('localStorage', unavailable);
  expect(readListDisplay(project, actor)).toBeNull();
  expect(() => writeListDisplay(project, actor, preference)).not.toThrow();
});

it('keeps a fully populated bounded store readable as more owners are added', () => {
  const expanded = Array.from({ length: 600 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
  for (let i = 0; i < 32; i++) {
    writeListDisplay(`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, actor, { ...preference, expanded });
    expect(localStorage.getItem(listDisplayKey)!.length).toBeLessThanOrEqual(262144);
  }
  expect(readListDisplay('00000000-0000-4000-8000-000000000031', actor)?.expanded).toHaveLength(512);
});
