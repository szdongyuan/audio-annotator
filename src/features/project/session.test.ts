import { beforeEach, expect, it } from 'vitest';
import fixture from '../../../tests/fixtures/document-v3.json';
import { defaultSessionUI, matchingSessionUI, readSession, sessionKey, SessionStore, type ProjectSession } from './session';
import type { OpenedProject } from '../../bridge/projects';

const actorId = '11111111-1111-4111-8111-111111111111';
const record = (): ProjectSession => ({ version: 1, path: 'C:/project/project.json', projectId: fixture.projectId, actorId: null, readOnly: false, ui: { ...defaultSessionUI(), inspectorTab: 'list', cues: { [fixture.media[0].id]: .4 } } });
const opened = (): OpenedProject => ({ path: record().path, snapshot: { document: structuredClone(fixture) as never, canUndo: false, canRedo: false }, persistedRevision: 0, recovery: null });
beforeEach(() => localStorage.clear());

it('round trips a bounded local record and strips fields outside transient UI', () => {
  localStorage.setItem(sessionKey, JSON.stringify({ ...record(), runtimeNonce: 'old', ui: { ...record().ui, activeMediaId: 'stale', volume: 0, selection: {}, history: [], draft: 'never' } }));
  expect(readSession()).toEqual(record());
});

it('rejects malformed, excessive, unknown-version and unavailable storage without throwing', () => {
  for (const value of ['{', JSON.stringify({ ...record(), version: 2 }), JSON.stringify({ ...record(), path: 'x'.repeat(4097) }), JSON.stringify({ ...record(), projectId: 'bad' }), 'x'.repeat(65537)]) {
    localStorage.setItem(sessionKey, value); expect(readSession()).toBeNull();
  }
  expect(readSession({ getItem: () => { throw Error('denied'); } } as never)).toBeNull();
});

it('binds transient restoration to both project and actor, including null actors', () => {
  expect(matchingSessionUI(record(), opened())).toEqual(record().ui);
  expect(matchingSessionUI({ ...record(), projectId: actorId }, opened())).toBeNull();
  expect(matchingSessionUI({ ...record(), actorId }, opened())).toBeNull();
  const pending = opened(); pending.recovery = { primary: null, candidates: [] };
  expect(matchingSessionUI(record(), pending)).toBeNull();
});

it('drops missing, hidden, deleted and out-of-range cues while retaining valid visible coordinates', () => {
  const o = opened(), media = o.snapshot!.document.media[0];
  const r = record(); r.ui.cues = { [media.id]: .4, [actorId]: 1 };
  expect(matchingSessionUI(r, o)?.cues).toEqual({ [media.id]: .4 });
  expect(matchingSessionUI(r, o, [media.id])?.cues).toEqual({});
  for (const seconds of [-1, Infinity, NaN, media.frameCount / media.sampleRate]) {
    r.ui.cues = { [media.id]: seconds }; expect(matchingSessionUI(r, o)?.cues).toEqual({});
  }
});
it('keeps writes bounded too and falls back from an inspector absent in the current project', () => {
  localStorage.setItem(sessionKey, JSON.stringify(record()));
  const store = new SessionStore();
  store.adopt({ ...opened(), path: 'x'.repeat(4097) });
  expect(localStorage.getItem(sessionKey)).toBe(JSON.stringify(record()));
  const ui = matchingSessionUI({ ...record(), ui: { ...record().ui, inspectorTab: 'authors' } }, opened());
  expect(ui?.inspectorTab).toBe('region');
  const cues = Object.fromEntries(Array.from({ length: 140 }, (_, i) => [`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, i]));
  localStorage.setItem(sessionKey, JSON.stringify({ ...record(), ui: { ...record().ui, cues } }));
  expect(Object.keys(readSession()!.ui.cues)).toHaveLength(128);
});
