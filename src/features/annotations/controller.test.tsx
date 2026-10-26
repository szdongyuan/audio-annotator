import { act, renderHook, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import fixture from '../../../tests/fixtures/document-v3.json';
import { parseProjectDocument, type Change } from '../../bridge/types';
import { ProjectStore } from '../../app/store';
import { CommandQueue } from '../../app/commands';
import { ProjectLifecycle } from '../project/lifecycle';
import { useAnnotations } from './useAnnotations';
function setup() {
  const store = new ProjectStore({ document: parseProjectDocument(fixture), canUndo: true, canRedo: false });
  const applyChange = vi.fn(async (_id: string, revision: number, change: Change) => {
    const doc = structuredClone(store.snapshot.document); doc.revision = revision + 1;
    if (change.type === 'updateAnnotationNote') doc.annotations.find(a => a.id === change.id)!.note = change.note;
    if (change.type === 'updateAnnotation') doc.annotations = doc.annotations.map(a => a.id === change.annotation.id ? change.annotation : a);
    return { ...store.snapshot, document: doc };
  });
  const undo = vi.fn(async () => store.snapshot), redo = vi.fn(async () => store.snapshot);
  const queue = new CommandQueue(store, { applyChange, undo, redo, getSnapshot: async () => store.snapshot });
  const saved: typeof store.snapshot[] = [];
  const persistence = { save: vi.fn(async (_id: string, r: number) => { saved.push(structuredClone(store.snapshot)); return r; }), close: vi.fn(async () => {}) };
  const lifecycle = new ProjectLifecycle(store, queue, persistence);
  return { store, queue, lifecycle, applyChange, undo, redo, saved, persistence, active: { store, queue, lifecycle, path: '' } };
}
it('flushes notes before building whole annotation category and geometry mutations', async () => {
  const s = setup(), hook = renderHook(() => useAnnotations(s.active)), a = s.store.snapshot.document.annotations[0];
  act(() => { hook.result.current.drafts!.write('note', { type: 'updateAnnotationNote', id: a.id, note: 'new note', mergeKey: null }); hook.result.current.mutate(a.id, { categoryIds: [] }); hook.result.current.mutate(a.id, { region: { ...a.region, lowHz: 300 } }); });
  await waitFor(() => expect(s.applyChange).toHaveBeenCalledTimes(3));
  expect(s.store.snapshot.document.annotations[0]).toMatchObject({ note: 'new note', categoryIds: [], region: { lowHz: 300 } });
  hook.unmount(); s.lifecycle.dispose();
});
it.each(['save', 'close'] as const)('%s cannot overtake already accepted UI actions waiting for a note', async kind => {
  const s = setup(), hook = renderHook(() => useAnnotations(s.active)), a = s.store.snapshot.document.annotations[0];
  let release!: () => void;
  const implementation = s.applyChange.getMockImplementation()!;
  s.applyChange.mockImplementationOnce(async (...args) => { await new Promise<void>(resolve => { release = resolve; }); return implementation(...args); });
  hook.result.current.drafts!.write('note', { type: 'updateAnnotationNote', id: a.id, note: 'pending note', mergeKey: null });
  const note = hook.result.current.drafts!.submit('note');
  await waitFor(() => expect(s.applyChange).toHaveBeenCalledOnce());
  act(() => { hook.result.current.mutate(a.id, { categoryIds: [] }); hook.result.current.mutate(a.id, { region: { ...a.region, lowHz: 400 } }); });
  const finish = s.lifecycle[kind]();
  release(); await note; await finish;
  expect(s.saved.at(-1)?.document.annotations[0]).toMatchObject({ note: 'pending note', categoryIds: [], region: { lowHz: 400 } });
  expect(s.applyChange).toHaveBeenCalledTimes(3);
  hook.unmount(); if (kind !== 'close') s.lifecycle.dispose();
});
it('retains accepted native edits through close while refusing new UI admission after transition starts', async () => {
  const s = setup(), hook = renderHook(() => useAnnotations(s.active)), a = s.store.snapshot.document.annotations[0];
  let release!: () => void;
  const implementation = s.applyChange.getMockImplementation()!;
  s.applyChange.mockImplementationOnce(async (...args) => { await new Promise<void>(resolve => { release = resolve; }); return implementation(...args); });
  act(() => { hook.result.current.mutate(a.id, { categoryIds: [] }); hook.result.current.mutate(a.id, { region: { ...a.region, lowHz: 500 } }); });
  await waitFor(() => expect(s.applyChange).toHaveBeenCalledOnce());
  const close = s.lifecycle.close();
  act(() => hook.result.current.mutate(a.id, { region: { ...a.region, lowHz: 900 } }));
  release(); await close;
  expect(s.saved.at(-1)?.document.annotations[0]).toMatchObject({ categoryIds: [], region: { lowHz: 500 } });
  expect(s.applyChange).toHaveBeenCalledTimes(2); expect(s.persistence.close).toHaveBeenCalledOnce();
  expect(s.store.editingDisabled).toBe(true); hook.unmount();
});
it('does not undo past a failed command; explicit corrected retry removes failure and enables history', async () => {
  const s = setup(), hook = renderHook(() => useAnnotations(s.active)), a = s.store.snapshot.document.annotations[0];
  s.applyChange.mockRejectedValueOnce({ code: 'InvalidInput', message: 'failed note', retryable: true });
  act(() => hook.result.current.drafts!.write('note', { type: 'updateAnnotationNote', id: a.id, note: 'failed', mergeKey: null }));
  await expect(hook.result.current.drafts!.submit('note')).rejects.toMatchObject({ code: 'InvalidInput' });
  act(() => hook.result.current.history('undo'));
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(s.undo).not.toHaveBeenCalled(); expect(s.queue.unresolvedFailures).toHaveLength(1);
  act(() => hook.result.current.drafts!.write('note', { type: 'updateAnnotationNote', id: a.id, note: 'corrected', mergeKey: null }));
  await hook.result.current.drafts!.submit('note');
  act(() => hook.result.current.history('undo')); await waitFor(() => expect(s.undo).toHaveBeenCalledOnce());
  expect(s.queue.unresolvedFailures).toHaveLength(0); hook.unmount(); s.lifecycle.dispose();
});
it('bounds blur queued behind an in-flight note preserves that newer note', async () => {
  const s = setup(), hook = renderHook(() => useAnnotations(s.active)), a = s.store.snapshot.document.annotations[0];
  let release!: () => void;
  const implementation = s.applyChange.getMockImplementation()!;
  s.applyChange.mockImplementationOnce(async (...args) => { await new Promise<void>(resolve => { release = resolve; }); return implementation(...args); });
  hook.result.current.drafts!.write('note', { type: 'updateAnnotationNote', id: a.id, note: 'in flight', mergeKey: null });
  const note = hook.result.current.drafts!.submit('note'); await waitFor(() => expect(s.applyChange).toHaveBeenCalledOnce());
  hook.result.current.drafts!.write('bounds', { type: 'updateAnnotation', annotation: { ...a, region: { ...a.region, lowHz: 200 } } });
  const bounds = hook.result.current.drafts!.submit('bounds'); release(); await note; await bounds;
  expect(s.store.snapshot.document.annotations[0]).toMatchObject({ note: 'in flight', region: { lowHz: 200 } });
  hook.unmount(); s.lifecycle.dispose();
});
