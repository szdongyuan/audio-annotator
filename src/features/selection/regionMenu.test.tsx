import type { ComponentProps } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import fixture from '../../../tests/fixtures/document-v2.json';
import { parseProjectDocument, type Change, type Region } from '../../bridge/types';
import { RegionMenu } from './RegionMenu';
import { ProjectStore } from '../../app/store';
import { CommandQueue } from '../../app/commands';
import { ProjectLifecycle } from '../project/lifecycle';
import { useSelection, type SelectionUI } from './useSelection';
import type { Selection } from './state';
function props(target = true, ready = true) {
  const doc = parseProjectDocument(structuredClone(fixture)), a = doc.annotations[0];
  const selection = { region: a.region, object: { kind: 'annotation' as const, id: a.id } };
  const actions = { classify: vi.fn(), note: vi.fn(), mask: vi.fn(), remove: vi.fn(), toggleMask: vi.fn() };
  const ui = { active: { store: { snapshot: { document: doc }, editingDisabled: false } }, menu: { x: 10, y: 10, target: target ? selection : null, overlaps: [], mediaId: a.region.mediaId, channelIndex: a.region.channelIndex }, actions, closeMenu: vi.fn(), withTarget: (target: Selection, action: (region: Region) => void) => action(target.region) };
  return { ui, playback: { playSelection: vi.fn() }, workspace: { patch: vi.fn() }, statuses: [{ mediaId: a.region.mediaId, status: ready ? 'ready' : 'missing' }], focusNote: vi.fn() };
}
it('empty-space menu offers an actual view action on its pointer media', () => {
  const p = props(false); render(<RegionMenu {...p as unknown as ComponentProps<typeof RegionMenu>} />);
  expect(screen.getByRole('menuitem', { name: '标注类型' })).toHaveAttribute('aria-disabled', 'true');
  fireEvent.click(screen.getByRole('menuitem', { name: '重置当前视图' }));
  expect(p.workspace.patch).toHaveBeenCalledWith(p.ui.menu.mediaId, expect.objectContaining({ startSeconds: 0, lowHz: 0 }));
  expect(p.ui.actions.classify).not.toHaveBeenCalled();
});
function runtimeMenu() {
  const doc = parseProjectDocument(structuredClone(fixture)), a = doc.annotations[0];
  const store = new ProjectStore({ document: doc, canUndo: true, canRedo: false });
  const queue = new CommandQueue(store, { applyChange: async (_id: string, revision: number, change: Change) => {
    const next = structuredClone(store.snapshot.document); next.revision = revision + 1;
    if (change.type === 'updateAnnotation') next.annotations = next.annotations.map(a => a.id === change.annotation.id ? change.annotation : a);
    if (change.type === 'removeAnnotation') next.annotations = next.annotations.filter(a => a.id !== change.id);
    return { ...store.snapshot, document: next };
  }, undo: async () => store.snapshot, redo: async () => store.snapshot, getSnapshot: async () => store.snapshot });
  const lifecycle = new ProjectLifecycle(store, queue, { save: async (_id, revision) => revision, close: async () => {} });
  const owner = { store, queue, lifecycle, path: '' }, playback = { playSelection: vi.fn() }, workspace = { patch: vi.fn() };
  let ui!: SelectionUI;
  function Workspace({ active = owner }) {
    ui = useSelection(active, a.region.mediaId);
    return <RegionMenu ui={ui} playback={playback as unknown as ComponentProps<typeof RegionMenu>['playback']} workspace={workspace as unknown as ComponentProps<typeof RegionMenu>['workspace']} statuses={[{ mediaId: a.region.mediaId, status: 'ready' }]} focusNote={vi.fn()} />;
  }
  const view = render(<Workspace />), target: Selection = { region: a.region, object: { kind: 'annotation', id: a.id } };
  const open = (selection = target) => act(() => ui.openMenu({ x: 10, y: 10, target: selection, overlaps: [], mediaId: a.region.mediaId, channelIndex: a.region.channelIndex }));
  const pending = (change: Change) => {
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const work = lifecycle.enqueueEdit(async () => { await gate; await queue.enqueue(change, { owner: 'annotations' }); });
    return async () => { await act(async () => { release(); await work; }); };
  };
  return { a, owner, target, playback, workspace, open, pending, ui: () => ui, replace: () => view.rerender(<Workspace active={{ ...owner }} />), dispose: () => { view.unmount(); lifecycle.dispose(); } };
}
it.each(['play', 'zoom'] as const)('menu %s resolves geometry after an accepted pending move completes', async kind => {
  const s = runtimeMenu(), region = { ...s.a.region, startSeconds: s.a.region.startSeconds + .01, lowHz: s.a.region.lowHz + 10 };
  const finish = s.pending({ type: 'updateAnnotation', annotation: { ...s.a, region } }); s.open();
  await finish();
  if (kind === 'play') { fireEvent.click(screen.getByRole('menuitem', { name: '播放选区' })); fireEvent.click(screen.getByRole('menuitem', { name: '处理后选区' })); expect(s.playback.playSelection).toHaveBeenCalledWith(region, 'processed'); }
  else { fireEvent.click(screen.getByRole('menuitem', { name: '放大到选区' })); expect(s.workspace.patch).toHaveBeenCalledWith(region.mediaId, { startSeconds: region.startSeconds, endSeconds: region.endSeconds, lowHz: region.lowHz, highHz: region.highHz }); }
  s.dispose();
});
it('closes a menu whose object is deleted by a pending accepted action and refuses retained callbacks', async () => {
  const s = runtimeMenu(), finish = s.pending({ type: 'removeAnnotation', id: s.a.id }); s.open();
  const invoke = s.ui().withTarget;
  await finish(); expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  const action = vi.fn(); invoke(s.target, action); expect(action).not.toHaveBeenCalled(); s.dispose();
});
it('preserves temporary targets but rejects a callback owned by an earlier runtime', () => {
  const s = runtimeMenu(), temporary: Selection = { region: s.a.region, object: null }, action = vi.fn(); s.open(temporary);
  const invoke = s.ui().withTarget;
  invoke(temporary, action); expect(action).toHaveBeenCalledWith(temporary.region); action.mockClear();
  s.replace(); invoke(temporary, action); expect(action).not.toHaveBeenCalled(); s.dispose();
});
it('missing audio disables playback but classification remains possible for its stable target', () => {
  const p = props(true, false); render(<RegionMenu {...p as unknown as ComponentProps<typeof RegionMenu>} />);
  expect(screen.getByRole('menuitem', { name: '播放选区' })).toHaveAttribute('aria-disabled', 'true');
  fireEvent.click(screen.getByRole('menuitem', { name: '标注类型' })); fireEvent.click(screen.getByRole('menuitem', { name: '未分类' }));
  expect(p.ui.actions.classify).toHaveBeenCalledWith(p.ui.menu.target, null); expect(p.playback.playSelection).not.toHaveBeenCalled();
});
it('zoom uses exact physical bounds without changing objects', () => {
  const p = props(); render(<RegionMenu {...p as unknown as ComponentProps<typeof RegionMenu>} />); fireEvent.click(screen.getByRole('menuitem', { name: '放大到选区' }));
  const r = p.ui.menu.target!.region;
  expect(p.workspace.patch).toHaveBeenCalledWith(r.mediaId, { startSeconds: r.startSeconds, endSeconds: r.endSeconds, lowHz: r.lowHz, highHz: r.highHz });
  expect(p.ui.actions.classify).not.toHaveBeenCalled();
});
