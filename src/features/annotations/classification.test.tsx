import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import fixture from '../../../tests/fixtures/document-v2.json';
import { parseProjectDocument, type Change } from '../../bridge/types';
import { ProjectStore } from '../../app/store';
import { CommandQueue } from '../../app/commands';
import { ProjectLifecycle } from '../project/lifecycle';
import { useAnnotations } from './useAnnotations';
import { AnnotationList } from './AnnotationList';
import { CategoryManager } from './CategoryManager';
import { classificationResults, reconcileContext } from './classification';
import { ClassificationControl } from './ClassificationControl';
function setup() {
 const store = new ProjectStore({ document: parseProjectDocument(structuredClone(fixture)), canUndo: true, canRedo: false });
 const applyChange = vi.fn(async (_id: string, revision: number, change: Change) => {
  const doc = structuredClone(store.snapshot.document), m = doc.media[0]; doc.revision = revision + 1;
  if (change.type === 'setMediaCategory') m.categoryId = change.categoryId;
  if (change.type === 'setChannelCategory') m.channelCategoryIds[change.channelIndex] = change.categoryId;
  if (change.type === 'updateMediaNote') m.note = change.note;
  if (change.type === 'updateChannelNote') m.channelNotes[change.channelIndex] = change.note;
  return { ...store.snapshot, document: doc };
 });
 const queue = new CommandQueue(store, { applyChange, getSnapshot: async () => store.snapshot, undo: async () => store.snapshot, redo: async () => store.snapshot });
 const saved: typeof store.snapshot[] = [];
 const lifecycle = new ProjectLifecycle(store, queue, { save: async (_id, r) => { saved.push(structuredClone(store.snapshot)); return r; }, close: async () => {} });
 return { store, queue, lifecycle, applyChange, saved, active: { store, queue, lifecycle, path: '' } };
}
it('drains file and channel notes before independent categories and immediate save without a rectangle', async () => {
 const s = setup(), hook = renderHook(() => useAnnotations(s.active)), m = s.store.snapshot.document.media[0], cat = s.store.snapshot.document.categories[0].id;
 const originalRegion = structuredClone(s.store.snapshot.document.annotations);
 act(() => {
  hook.result.current.drafts!.write('media-note', { type: 'updateMediaNote', mediaId: m.id, note: 'file note', mergeKey: null });
  hook.result.current.drafts!.write('channel-note', { type: 'updateChannelNote', mediaId: m.id, channelIndex: 0, note: 'channel note', mergeKey: null });
  hook.result.current.classify({ mediaId: m.id, channelIndex: null }, cat);
  hook.result.current.classify({ mediaId: m.id, channelIndex: 0 }, null);
 });
 await s.lifecycle.save();
 expect(s.saved.at(-1)!.document.media[0]).toMatchObject({ categoryId: cat, channelCategoryIds: [null, m.channelCategoryIds[1]], note: 'file note', channelNotes: ['channel note', m.channelNotes[1]] });
 expect(s.saved.at(-1)!.document.annotations).toEqual(originalRegion);
 hook.unmount(); s.lifecycle.dispose();
});
it('rechecks target and category after a pending draft and refuses retained callbacks after owner replacement', async () => {
 const s = setup(), other = setup(), hook = renderHook(({ active }) => useAnnotations(active), { initialProps: { active: s.active } });
 const m = s.store.snapshot.document.media[0], cat = s.store.snapshot.document.categories[0].id;
 let release!: () => void;
 const unregister = s.lifecycle.registerDraft('gate', async () => { await new Promise<void>(resolve => { release = resolve; }); });
 s.store.setDraft('gate', 'pending');
 act(() => { void hook.result.current.classify({ mediaId: m.id, channelIndex: 0 }, cat); });
 await waitFor(() => expect(release).toBeTypeOf('function'));
 const old = hook.result.current.classify;
 hook.rerender({ active: other.active });
 release(); s.store.clearDraftIfUnchanged('gate', 'pending'); unregister();
 await s.lifecycle.save();
 old({ mediaId: m.id, channelIndex: null }, cat);
 expect(s.applyChange).not.toHaveBeenCalled(); expect(other.applyChange).not.toHaveBeenCalled();
 hook.unmount(); s.lifecycle.dispose(); other.lifecycle.dispose();
});
it('reconciles hidden comparison panes and hidden channels with first visible fallback', () => {
 const doc = parseProjectDocument(structuredClone(fixture)), id = doc.media[0].id;
 expect(reconcileContext(doc, { mediaId: 'gone', channelIndex: 1 }, [{ mediaId: id, channels: [1] }])).toEqual({ mediaId: id, channelIndex: 1 });
 expect(reconcileContext(doc, { mediaId: id, channelIndex: 0 }, [{ mediaId: id, channels: [1] }])).toEqual({ mediaId: id, channelIndex: 1 });
 expect(reconcileContext(doc, { mediaId: id, channelIndex: 1 }, [{ mediaId: id, channels: [] }])).toEqual({ mediaId: id, channelIndex: null });
});
it('filters three explicit scopes and locates file/channel without inventing regions', () => {
 const doc = parseProjectDocument(structuredClone(fixture)), cat = doc.categories[0].id, m = doc.media[0]; m.categoryId = cat; m.channelCategoryIds[0] = cat;
 const locate = vi.fn(); render(<AnnotationList doc={doc} selectedId={null} onLocate={locate} />);
 fireEvent.change(screen.getByLabelText('筛选类别'), { target: { value: cat } });
 const results = classificationResults(doc).filter(r => r.categoryId === cat);
 expect(results.map(r => r.scope)).toEqual(['file', 'channel', 'region']);
 fireEvent.click(screen.getByRole('button', { name: /整个文件/ })); expect(locate).toHaveBeenLastCalledWith(expect.objectContaining({ scope: 'file', mediaId: m.id }));
 fireEvent.click(screen.getByRole('button', { name: /整个通道 1/ })); expect(locate).toHaveBeenLastCalledWith(expect.objectContaining({ scope: 'channel', channelIndex: 0 }));
 expect(results.filter(r => r.scope !== 'region').every(r => !('region' in r))).toBe(true);
});
it('shows counts for file, channel and region references before atomic deletion', () => {
 const doc = parseProjectDocument(structuredClone(fixture)), cat = doc.categories[0], m = doc.media[0]; m.categoryId = cat.id; m.channelCategoryIds[0] = cat.id;
 const command = vi.fn(); render(<CategoryManager ui={{ active: { store: { snapshot: { document: doc }, editingDisabled: false } }, command } as never} />);
 fireEvent.click(screen.getByLabelText(`删除类别 ${cat.name}`));
 expect(screen.getByRole('alertdialog')).toHaveTextContent('1 个文件、1 个通道、1 个区域');
 fireEvent.click(screen.getByText('确认删除类别')); expect(command).toHaveBeenCalledExactlyOnceWith({ type: 'removeCategory', id: cat.id });
});
it.each(['click', 'contextMenu'] as const)('compact category %s uses a captured channel target', async event => {
 const s = setup(), hook = renderHook(() => useAnnotations(s.active)), m = s.store.snapshot.document.media[0];
 render(<ClassificationControl ui={hook.result.current} target={{ mediaId: m.id, channelIndex: 1 }} />);
 fireEvent[event](screen.getByRole('button', { name: `${m.displayName} 通道 2 类别` }));
 fireEvent.click(screen.getByRole('menuitem', { name: '通道类别' })); fireEvent.click(screen.getByRole('menuitem', { name: '未分类' }));
 await waitFor(() => expect(s.applyChange).toHaveBeenCalledWith(expect.anything(), expect.anything(), { type: 'setChannelCategory', mediaId: m.id, channelIndex: 1, categoryId: null }));
 hook.unmount(); s.lifecycle.dispose();
});
import { useSelection } from '../selection/useSelection';
import { workspaceMenus } from '../../app/WorkspaceActions';
import { defaultView } from '../spectrogram/workspace';
it('keeps explicit file/channel Locate context on a primary switch and reconciles removed comparison panes', () => {
 const s = setup(), first = s.store.snapshot.document.media[0], second = { ...first, id: 'second' };
 s.store.snapshot.document.media.push(second);
 const hook = renderHook(({ primary, panes }) => useSelection(s.active, primary, panes), { initialProps: { primary: first.id, panes: [{ mediaId: first.id, channels: [1] }] } });
 expect(hook.result.current.context).toEqual({ mediaId: first.id, channelIndex: 1 });
 act(() => hook.result.current.state.interact({ mediaId: second.id, channelIndex: null }));
 hook.rerender({ primary: second.id, panes: [{ mediaId: second.id, channels: [0, 1] }] });
 expect(hook.result.current.context).toEqual({ mediaId: second.id, channelIndex: null });
 hook.rerender({ primary: second.id, panes: [{ mediaId: second.id, channels: [1] }, { mediaId: first.id, channels: [0] }] });
 act(() => hook.result.current.state.interact({ mediaId: first.id, channelIndex: 0 }));
 hook.rerender({ primary: second.id, panes: [{ mediaId: second.id, channels: [1] }] });
 expect(hook.result.current.context).toEqual({ mediaId: second.id, channelIndex: 1 });
 hook.unmount(); s.lifecycle.dispose();
});
it('main menus target the comparison file and its visible channel without a rectangle; no channels disables channel menu', () => {
 const doc = parseProjectDocument(structuredClone(fixture)), primary = doc.media[0], comparison = { ...primary, id: 'comparison' }; doc.media.push(comparison);
 const classify = vi.fn(); let channels = [1];
 const menus = () => workspaceMenus({ project: { active: { store: { snapshot: { document: doc }, editingDisabled: false } } }, mediaUI: { selectedId: primary.id }, selection: { selection: null, context: { mediaId: comparison.id, channelIndex: null } }, annotations: { classify }, workspace: { state: {}, view: () => ({ ...defaultView(comparison), visibleChannels: channels }) }, playback: { options: {} } } as unknown as Parameters<typeof workspaceMenus>[0]);
 const file = menus().find(m => m.id === 'annotation')!.items.find(i => i.label === '当前文件分类')!;
 const channel = menus().find(m => m.id === 'annotation')!.items.find(i => i.label === '当前通道分类')!;
 file.children![1].action!(); channel.children![1].action!();
 expect(classify.mock.calls).toEqual([[{ mediaId: comparison.id, channelIndex: null }, doc.categories[0].id], [{ mediaId: comparison.id, channelIndex: 1 }, doc.categories[0].id]]);
 channels = []; expect(menus().find(m => m.id === 'annotation')!.items.find(i => i.label === '当前通道分类')!.disabled).toBe(true);
});
it.each(['category', 'media', 'channel'] as const)('revalidates removed %s after draft drain before enqueue', async missing => {
 const s = setup(), hook = renderHook(() => useAnnotations(s.active)), m = s.store.snapshot.document.media[0], cat = s.store.snapshot.document.categories[0].id;
 let release!: () => void;
 const unregister = s.lifecycle.registerDraft('gate', async () => { await new Promise<void>(resolve => { release = resolve; }); s.store.clearDraftIfUnchanged('gate', 'pending'); }); s.store.setDraft('gate', 'pending');
 act(() => { void hook.result.current.classify({ mediaId: m.id, channelIndex: 1 }, cat); });
 await waitFor(() => expect(release).toBeTypeOf('function'));
 if (missing === 'category') s.store.snapshot.document.categories = [];
 if (missing === 'media') s.store.snapshot.document.media = [];
 if (missing === 'channel') m.channelCount = 1;
 release(); await s.lifecycle.save(); expect(s.applyChange).not.toHaveBeenCalled();
 unregister(); hook.unmount(); s.lifecycle.dispose();
});
it('retains classification failure with annotation ownership and blocks save until explicit retry', async () => {
 const s = setup(), hook = renderHook(() => useAnnotations(s.active)), m = s.store.snapshot.document.media[0];
 s.applyChange.mockRejectedValueOnce({ code: 'InvalidInput', message: 'classification failed', retryable: true });
 await act(async () => { await hook.result.current.classify({ mediaId: m.id, channelIndex: 0 }, null); });
 expect(s.queue.unresolvedFailures).toHaveLength(1); expect(s.queue.unresolvedFailures[0].owner).toBe('annotations');
 await expect(s.lifecycle.save()).rejects.toBeDefined(); expect(s.saved).toHaveLength(0);
 await s.queue.retry(s.queue.unresolvedFailures[0].id); await s.lifecycle.save(); expect(s.saved).toHaveLength(1);
 hook.unmount(); s.lifecycle.dispose();
});
it('keeps an open region menu through unrelated accepted document edits while its channel stays visible', async () => {
 const s = setup(), m = s.store.snapshot.document.media[0];
 const hook = renderHook(() => useSelection(s.active, m.id, [{ mediaId: m.id, channels: [0,1] }]));
 act(() => hook.result.current.openMenu({ x: 10, y: 20, target: null, overlaps: [], mediaId: m.id, channelIndex: 0 }));
 expect(hook.result.current.menu).toMatchObject({ mediaId: m.id });
 await act(async () => { s.store.accept({ ...s.store.snapshot, document: { ...s.store.snapshot.document, revision: 1 } }); hook.rerender(); });
 expect(hook.result.current.menu).not.toBeNull();
 hook.unmount(); s.lifecycle.dispose();
});
it('right clicking the title beside a category opens the same captured submenu', async () => {
 const s = setup(), hook = renderHook(() => useAnnotations(s.active)), m = s.store.snapshot.document.media[0];
 render(<ClassificationControl ui={hook.result.current} target={{ mediaId: m.id, channelIndex: null }}><h2>文件标题</h2></ClassificationControl>);
 fireEvent.contextMenu(screen.getByText('文件标题'));
 fireEvent.click(screen.getByRole('menuitem', { name: '文件类别' })); fireEvent.click(screen.getByRole('menuitem', { name: '鸟声' }));
 await waitFor(() => expect(s.applyChange).toHaveBeenCalledWith(expect.anything(), expect.anything(), { type: 'setMediaCategory', mediaId: m.id, categoryId: s.store.snapshot.document.categories[0].id }));
 hook.unmount(); s.lifecycle.dispose();
});
import { FilePane } from '../spectrogram/FilePane';
import { SelectionContext } from '../selection/useSelection';
import { defaultSettings } from '../spectrogram/workspace';
it('interacting with comparison file header controls sets its visible context even outside the plot', () => {
 const s = setup(), first = s.store.snapshot.document.media[0], other = { ...first, id: 'other', displayName: 'other.wav' }; s.store.snapshot.document.media.push(other);
 const hook = renderHook(() => useSelection(s.active, first.id, [{ mediaId: first.id, channels: [0,1] }, { mediaId: other.id, channels: [1] }]));
 render(<SelectionContext.Provider value={hook.result.current}><FilePane active={s.active} media={other} settings={defaultSettings} view={{ ...defaultView(other), visibleChannels: [1] }} status="missing" timeLimit={2} onView={vi.fn()} onSettings={vi.fn()} onRelink={vi.fn()} /></SelectionContext.Provider>);
 fireEvent.pointerDown(screen.getByLabelText('other.wav 分析设置'));
 expect(hook.result.current.context).toEqual({ mediaId: other.id, channelIndex: 1 });
 hook.unmount(); s.lifecycle.dispose();
});
