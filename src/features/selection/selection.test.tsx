import { expect, it } from 'vitest';
import { drawRegion } from '../annotations/selection';
import { gestureKind, exceedsThreshold } from './gestures';
import { SelectionState } from './state';
import { parseProjectDocument } from '../../bridge/types';
import fixture from '../../../tests/fixtures/document-v2.json';
it('requires more than four CSS pixels and gives pan priority over handles', () => {
  expect(exceedsThreshold({ x: 10, y: 10 }, { x: 14, y: 10 })).toBe(false);
  expect(exceedsThreshold({ x: 10, y: 10 }, { x: 14.1, y: 10 })).toBe(true);
  expect(gestureKind(0, true, 'nw', true)).toBe('pan');
  expect(gestureKind(1, false, undefined, true)).toBe('pan');
  expect(gestureKind(0, false, undefined, false)).toBe('draw');
  expect(gestureKind(0, false, undefined, true)).toBe('move');
  expect(gestureKind(0, false, 'nw', true)).toBe('resize');
  expect(drawRegion('m', 0, { seconds: 2, hz: 300 }, { seconds: 1, hz: 100 }, 3, 500)).toMatchObject({ startSeconds: 1, endSeconds: 2, lowHz: 100, highHz: 300 });
});
it('keeps temporary selection out of documents, restores cancellation and reconciles saved geometry/removal', () => {
  const doc = parseProjectDocument(structuredClone(fixture)), a = doc.annotations[0], state = new SelectionState();
  state.select({ region: a.region, object: { kind: 'annotation', id: a.id } });
  const before = state.getSnapshot(); state.beginGesture(); state.select({ region: { ...a.region, lowHz: 1 }, object: null }); state.cancel();
  expect(state.getSnapshot()).toBe(before);
  const updated = { ...doc, annotations: [{ ...a, region: { ...a.region, lowHz: 123 } }] };
  state.reconcile(updated); expect(state.getSnapshot()?.region.lowHz).toBe(123);
  state.reconcile({ ...doc, annotations: [] }); expect(state.getSnapshot()).toBeNull();
});
it('binding a completed old action does not steal a newer selection', () => {
  const a = parseProjectDocument(structuredClone(fixture)).annotations[0], state = new SelectionState();
  state.select({ region: a.region, object: null }); const target = state.getSnapshot()!;
  state.select({ region: { ...a.region, lowHz: 1 }, object: null });
  expect(state.bind(target, { kind: 'annotation', id: 'new' })).toBe(false);
  expect(state.getSnapshot()?.object).toBeNull();
});
it.each(['annotation', 'mask'] as const)('cancel restores latest %s geometry after an authority update during a drag', kind => {
  const doc = parseProjectDocument(structuredClone(fixture)), state = new SelectionState();
  const object = kind === 'annotation' ? doc.annotations[0] : doc.edits[0];
  state.select({ region: object.region, object: { kind, id: object.id } }); state.beginGesture();
  const region = { ...object.region, lowHz: object.region.lowHz + 100 };
  const updated = structuredClone(doc);
  if (kind === 'annotation') updated.annotations[0].region = region; else updated.edits[0].region = region;
  state.reconcile(updated); expect(state.getSnapshot()?.region).toEqual(region);
  state.cancel(); expect(state.getSnapshot()?.region).toEqual(region);
});
it('cancel cannot resurrect a deleted prior object when another object was selected by the drag', () => {
  const doc = parseProjectDocument(structuredClone(fixture)), a = doc.annotations[0], b = doc.edits[0], state = new SelectionState();
  state.select({ region: a.region, object: { kind: 'annotation', id: a.id } }); state.beginGesture();
  state.select({ region: b.region, object: { kind: 'mask', id: b.id } });
  state.reconcile({ ...doc, annotations: [] }); expect(state.getSnapshot()?.object?.id).toBe(b.id);
  state.cancel(); expect(state.getSnapshot()).toBeNull();
});
it('cancel preserves the identity and geometry of a valid temporary prior through unrelated authority updates', () => {
  const doc = parseProjectDocument(structuredClone(fixture)), a = doc.annotations[0], b = doc.edits[0], state = new SelectionState();
  const temporary = { region: { ...a.region }, object: null };
  state.select(temporary); state.beginGesture(); state.select({ region: b.region, object: { kind: 'mask', id: b.id } });
  state.reconcile({ ...doc, annotations: [{ ...a, region: { ...a.region, lowHz: a.region.lowHz + 100 } }] });
  state.cancel(); expect(state.getSnapshot()).toBe(temporary); expect(state.getSnapshot()?.region).toEqual(a.region);
});
it('cancel clears a temporary prior whose channel became invalid during the drag', () => {
  const doc = parseProjectDocument(structuredClone(fixture)), a = doc.annotations[0], b = doc.edits[0], state = new SelectionState();
  state.select({ region: { ...a.region, channelIndex: 1 }, object: null }); state.beginGesture();
  state.select({ region: { ...b.region, channelIndex: 0 }, object: null });
  state.reconcile({ ...doc, media: doc.media.map(m => ({ ...m, channelCount: 1 })) });
  state.cancel(); expect(state.getSnapshot()).toBeNull();
});

it('separates the active target from its retained candidate and rejects late binding after deactivation', () => {
  const doc = parseProjectDocument(structuredClone(fixture)), state = new SelectionState();
  const target = { region: doc.annotations[0].region, object: null };
  state.select(target); expect(state.getActiveSelection()).toBe(target);
  state.deactivate(); expect(state.getActiveSelection()).toBeNull(); expect(state.getCandidate()).toBe(target);
  expect(state.bind(target, { kind: 'mask', id: 'late' })).toBe(false);
  state.reconcile(doc); expect(state.getActiveSelection()).toBeNull(); expect(state.getCandidate()).toBe(target);
  state.beginGesture(); state.select({ region: doc.edits[0].region, object: null }); state.cancel();
  expect(state.getActiveSelection()).toBeNull(); expect(state.getCandidate()).toBe(target);
});

it('reconciles an inactive saved target without reactivating it and invalidates it on deletion', () => {
  const doc = parseProjectDocument(structuredClone(fixture)), state = new SelectionState(), a = doc.annotations[0];
  state.select({ region: a.region, object: { kind: 'annotation', id: a.id } }); state.deactivate();
  state.reconcile({ ...doc, annotations: [{ ...a, region: { ...a.region, lowHz: 200 } }] });
  expect(state.getActiveSelection()).toBeNull(); expect(state.getCandidate()?.region.lowHz).toBe(200);
  state.reconcile({ ...doc, annotations: [] }); expect(state.getCandidate()).toBeNull();
});

it('cancelling a gesture restores the prior selection interaction context as well as its active state', () => {
  const doc = parseProjectDocument(structuredClone(fixture)), state = new SelectionState(), a = doc.annotations[0];
  state.select({ region: a.region, object: null }); state.beginGesture();
  state.select({ region: { ...a.region, channelIndex: 0 }, object: null }); state.cancel();
  expect(state.getContext()).toEqual({ mediaId: a.region.mediaId, channelIndex: a.region.channelIndex });
  expect(state.getActiveSelection()?.region).toBe(a.region);
});

it('active context follows authoritative channel changes while inactive reconciliation keeps the current interaction context', () => {
  const doc = parseProjectDocument(structuredClone(fixture)), state = new SelectionState(), a = doc.annotations[0];
  state.select({ region: a.region, object: { kind: 'annotation', id: a.id } });
  state.reconcile({ ...doc, annotations: [{ ...a, region: { ...a.region, channelIndex: 0 } }] });
  expect(state.getContext()?.channelIndex).toBe(0);
  state.deactivate(); state.reconcile(doc);
  expect(state.getContext()?.channelIndex).toBe(0); expect(state.getActiveSelection()).toBeNull();
});
