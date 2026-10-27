import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import fixture from '../../../tests/fixtures/document-v3.json';
import { ProjectStore } from '../../app/store';
import { CommandQueue } from '../../app/commands';
import { ProjectLifecycle } from '../project/lifecycle';
import { parseProjectDocument, type Change } from '../../bridge/types';
import { useAnnotations } from './useAnnotations';
import { CategoryManager } from './CategoryManager';
it('holds category text and prevents duplicate submits until acknowledgement', async () => {
  let finish!: (value: unknown) => void; const command = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  const owner = { store: { snapshot: { document: structuredClone(fixture) }, editingDisabled: false } };
  render(<CategoryManager ui={{ active: owner, command } as never} />);
  fireEvent.change(screen.getByLabelText('类别名称'), { target: { value: '长批次分类' } });
  const form = document.querySelector('.category-form')!; fireEvent.submit(form); fireEvent.submit(form);
  expect(command).toHaveBeenCalledTimes(1); expect(screen.getByLabelText('类别名称')).toHaveValue('长批次分类'); expect(screen.getByLabelText('类别名称')).toBeDisabled();
  await act(async () => finish(false)); expect(screen.getByLabelText('类别名称')).toHaveValue('长批次分类'); expect(screen.getByLabelText('类别名称')).toBeEnabled();
});
it('rejects a stale queued duplicate before it enters the failed-command ledger', async () => {
  const store = new ProjectStore({ document: parseProjectDocument(structuredClone(fixture)), canUndo: false, canRedo: false });
  const apply = vi.fn(async (_id: string, revision: number, change: Change) => { const doc = structuredClone(store.snapshot.document); doc.revision = revision + 1; if (change.type === 'addCategory') { if (doc.categories.some(c => c.name === change.category.name)) throw new Error('Empty or duplicate category name'); doc.categories.push(change.category); } return { document: doc, canUndo: true, canRedo: false }; });
  const queue = new CommandQueue(store, { applyChange: apply, getSnapshot: async () => store.snapshot, undo: async () => store.snapshot, redo: async () => store.snapshot }), lifecycle = new ProjectLifecycle(store, queue, { save: async (_, r) => r, close: async () => {} });
  const active = { store, queue, lifecycle, path: '' }, hook = renderHook(() => useAnnotations(active));
  await act(async () => { const first = hook.result.current.submitCommand({ type: 'addCategory', category: { id: crypto.randomUUID(), name: '导入中类别', color: '#ffffff' } }); const second = hook.result.current.submitCommand({ type: 'addCategory', category: { id: crypto.randomUUID(), name: '导入中类别', color: '#ffffff' } }); await Promise.all([first, second]); });
  await waitFor(() => expect(apply).toHaveBeenCalledTimes(1)); expect(queue.unresolvedFailures).toHaveLength(0); expect(store.snapshot.document.categories.filter(c => c.name === '导入中类别')).toHaveLength(1); expect(store.error?.message).toContain('已存在');
  hook.unmount(); lifecycle.dispose();
});
