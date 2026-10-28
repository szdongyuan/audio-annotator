import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import fixture from '../../tests/fixtures/document-v3.json';
import { parseProjectDocument, type ProjectDocument } from '../bridge/types';
import { ProjectStore } from './store';
import { CommandQueue, type ProjectCommands } from './commands';
import { ProjectLifecycle } from '../features/project/lifecycle';
import type { ActiveProject, ProjectLifecycleUI } from '../features/project/useProjectLifecycle';
import type { MediaUI } from '../features/media/useMedia';
import { IdentityController } from '../features/identity/controller';
import { AppShell } from './AppShell';
import * as workspaceModule from '../features/spectrogram/useWorkspace';
import { defaultView } from '../features/spectrogram/workspace';
import { CollaborationContext, type CollaborationUI } from '../features/collaboration/useCollaboration';
import { CollaborationController } from '../features/collaboration/controller';
import { coordinates } from '../features/spectrogram/coordinates';

function setup(projectId = fixture.projectId, authorId?: string) {
  const document = parseProjectDocument(structuredClone(fixture)), first = document.media[0], category = document.categories[0].id;
  document.projectId = projectId;
  first.displayName = 'A.wav'; first.note = 'bird file'; first.categoryIds = [category];
  first.channelNotes = ['bird left', 'bird right']; first.channelCategoryIds = [[], [category]];
  document.media.push({ ...first, id: '00000000-0000-4000-8000-000000000012', displayName: 'B.wav', channelCount: 1, channelLayout: ['mono'], note: 'other file', channelNotes: ['other channel'], channelCategoryIds: [[]], categoryIds: [] });
  document.annotations[0].note = 'bird region'; document.edits = [];
  const store = new ProjectStore({ document, canUndo: false, canRedo: false });
  const applyChange = vi.fn<ProjectCommands['applyChange']>(async (_id, revision, change) => ({ ...store.snapshot, document: { ...store.snapshot.document, revision: revision + 1, ...(change.type === 'updateViewState' ? { viewState: change.viewState } : {}) } }));
  const queue = new CommandQueue(store, { applyChange, getSnapshot: async () => store.snapshot, undo: async () => store.snapshot, redo: async () => store.snapshot });
  const lifecycle = new ProjectLifecycle(store, queue, { save: async (_id, revision) => revision, close: vi.fn() });
  lifecycles.push(lifecycle);
  const active: ActiveProject = { store, queue, lifecycle, path: 'same-path', ...(authorId ? { collaboration: {
    runtimeNonce: crypto.randomUUID(), actor: { authorId, displayName: 'Same name', createdAt: document.createdAt },
    projectFlavor: 'ordinary' as const, identityMode: 'profile' as const, canWriteAnnotations: true, canImportMedia: true, hiddenMediaIds: [], catalogPending: false, preferences: null,
  } } : {}) };
  return { active, applyChange };
}

const canvasMode = vi.hoisted(() => ({ real: false }));
const lifecycles: ProjectLifecycle[] = [];
afterEach(() => { lifecycles.splice(0).forEach(lifecycle => lifecycle.dispose()); vi.restoreAllMocks(); vi.unstubAllGlobals(); canvasMode.real = false; });

function props(active: ActiveProject | null, identity?: IdentityController) {
  return { project: { active, busy: false } as ProjectLifecycleUI, identity, mediaUI: {
    statuses: active?.store.snapshot.document.media.map(m => ({ mediaId: m.id, status: 'missing' })) ?? [], disabled: false,
  } as MediaUI };
}
function list() { fireEvent.click(screen.getByRole('tab', { name: '列表' })); }
function filters(category: string, channel: string, query: string) {
  fireEvent.change(screen.getByLabelText('筛选类别'), { target: { value: category } });
  fireEvent.change(screen.getByLabelText('筛选通道'), { target: { value: channel } });
  fireEvent.change(screen.getByLabelText('筛选备注'), { target: { value: query } });
}
function expectFilters(category: string, channel: string, query: string) {
  expect(screen.getByLabelText('筛选类别')).toHaveValue(category);
  expect(screen.getByLabelText('筛选通道')).toHaveValue(channel);
  expect(screen.getByLabelText('筛选备注')).toHaveValue(query);
}
function accept(active: ActiveProject, patch: Partial<ProjectDocument>) {
  act(() => active.store.accept({ ...active.store.snapshot, document: { ...active.store.snapshot.document, ...patch } }));
}

it('restores filters after tab/panel unmount and project reopen, saves defaults and starts fresh in a new app', async () => {
  const { active, applyChange } = setup(), category = active.store.snapshot.document.categories[0].id;
  const ui = render(<AppShell {...props(active)} />);
  await act(async () => {});
  const storage = vi.spyOn(Storage.prototype, 'setItem');
  list(); filters(category, '1', 'bird');
  expect(screen.getByText('2 / 6 个对象 · 点击定位')).toBeInTheDocument();
  expect(screen.getByText('bird region')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('tab', { name: '区域' })); list();
  expectFilters(category, '1', 'bird');
  fireEvent.click(screen.getByRole('button', { name: '收起属性面板' }));
  fireEvent.click(screen.getByRole('button', { name: '展开属性面板' }));
  expectFilters(category, '1', 'bird');
  ui.rerender(<AppShell {...props(null)} />);
  const reopened = setup();
  ui.rerender(<AppShell {...props(reopened.active)} />); list();
  expectFilters(category, '1', 'bird');
  expect(screen.getByText('2 / 6 个对象 · 点击定位')).toBeInTheDocument();
  filters('*', '*', '');
  ui.rerender(<AppShell {...props(null)} />); ui.rerender(<AppShell {...props(active)} />); list();
  expectFilters('*', '*', '');
  expect(applyChange).not.toHaveBeenCalled(); expect(reopened.applyChange).not.toHaveBeenCalled();
  expect(active.store.drafts.size).toBe(0); expect(storage).not.toHaveBeenCalled();
  filters(category, '1', 'bird'); ui.unmount();
  render(<AppShell {...props(active)} />); list(); expectFilters('*', '*', '');
});

it('isolates project and actor UUIDs and prefers the opened actor while global identity is changing', () => {
  const authorA = '00000000-0000-4000-8000-000000000021', authorB = '00000000-0000-4000-8000-000000000022';
  const a = setup(fixture.projectId, authorA), b = setup('00000000-0000-4000-8000-000000000031', authorA), other = setup(fixture.projectId, authorB);
  const identity = new IdentityController({ owner: () => a.active, perform: async () => null, acceptStatus: vi.fn() });
  identity.snapshot = { storeRevision: 1, runtimeNonce: crypto.randomUUID(), project: null, selectedAuthorId: authorB, profiles: [authorA, authorB].map(authorId => ({ authorId, displayName: 'Same name', createdAt: fixture.createdAt })) };
  const ui = render(<AppShell {...props(a.active, identity)} />); list(); filters('', '0', 'A');
  ui.rerender(<AppShell {...props(b.active, identity)} />); list(); expectFilters('*', '*', ''); filters('*', '*', 'B');
  ui.rerender(<AppShell {...props(other.active, identity)} />); list(); expectFilters('*', '*', ''); filters('*', '1', 'actor B');
  ui.rerender(<AppShell {...props(a.active, identity)} />); list(); expectFilters('', '0', 'A');
  ui.rerender(<AppShell {...props(b.active, identity)} />); list(); expectFilters('*', '*', 'B');
  ui.rerender(<AppShell {...props(other.active, identity)} />); list(); expectFilters('*', '1', 'actor B');
  const legacy = setup();
  ui.rerender(<AppShell {...props(legacy.active, identity)} />); list(); expectFilters('*', '1', 'actor B');
  identity.snapshot = { ...identity.snapshot, selectedAuthorId: authorA };
  ui.rerender(<AppShell {...props(legacy.active, identity)} />); expectFilters('', '0', 'A');
  for (const project of [a, b, other, legacy]) expect(project.applyChange).not.toHaveBeenCalled();
  ui.unmount(); identity.dispose();
});

it('recomputes results from current data, preserves empty filters and resets only invalid options', () => {
  const { active } = setup(), doc = active.store.snapshot.document, category = doc.categories[0].id;
  render(<AppShell {...props(active)} />); list(); filters(category, '1', 'bird');
  accept(active, { annotations: [{ ...doc.annotations[0], note: 'silent' }] });
  expect(screen.getByText('1 / 6 个对象 · 点击定位')).toBeInTheDocument();
  expect(screen.queryByText('bird region')).not.toBeInTheDocument();
  filters(category, '1', '  absent  ');
  expect(screen.getByText('没有符合条件的标注')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('tab', { name: '区域' })); list(); expectFilters(category, '1', '  absent  ');
  accept(active, { categories: [] }); expectFilters('*', '1', '  absent  ');
  filters('', '1', 'bird');
  accept(active, { media: doc.media.map(m => ({ ...m, channelCount: 1, channelCategoryIds: [[]], channelNotes: m.channelNotes.slice(0, 1) })), annotations: [] });
  expectFilters('', '*', 'bird');
  expect(screen.getByText('1 / 4 个对象 · 点击定位')).toBeInTheDocument();
  expect(screen.queryByText('bird region')).not.toBeInTheDocument();
});

vi.mock('../features/spectrogram/useTiles', () => ({ useTiles: () => ({ keys: [], completed: 0, total: 0, version: 0, phase: '', error: null, cancelled: false }) }));
vi.mock('../features/spectrogram/renderer', () => ({ drawSpectrogram: vi.fn() }));
vi.mock('../features/spectrogram/SpectrogramCanvas', async () => {
  const { useSelectionContext } = await import('../features/selection/useSelection');
  const actual = await vi.importActual<typeof import('../features/spectrogram/SpectrogramCanvas')>('../features/spectrogram/SpectrogramCanvas');
  return { SpectrogramCanvas: (props: import('react').ComponentProps<typeof actual.SpectrogramCanvas>) => {
    const { children, media, channel, view } = props, selection = useSelectionContext();
    return <div data-testid={`canvas-${media.id}-${channel}`} data-view={JSON.stringify(view)} data-context={JSON.stringify(selection?.context)} data-selection={JSON.stringify(selection?.selection)} data-gesture={selection?.gesturing}>
      {canvasMode.real ? <actual.SpectrogramCanvas {...props} /> : <>
        {children}
        <button onClick={() => selection?.selectObject('annotation', selection.active?.store.snapshot.document.annotations[0]?.id ?? null)}>选择频谱 {media.displayName} {channel}</button>
        {selection?.active?.store.snapshot.document.edits[0] && <button onClick={() => selection.selectObject('mask', selection.active!.store.snapshot.document.edits[0].id)}>选择处理对象 {media.displayName} {channel}</button>}
      </>}
    </div>;
  } };
});

function ready(active: ActiveProject) {
  const value = props(active);
  value.mediaUI.statuses = active.store.snapshot.document.media.map(m => ({ mediaId: m.id, status: 'ready' }));
  return value;
}
function row(note: string) { return screen.getByText(note, { selector: '.note-summary' }).closest('button')!; }
function expectTab(name: string) { expect(screen.getByRole('tab', { name })).toHaveAttribute('aria-selected', 'true'); }
async function settle() { await act(async () => {}); }

it.each(['file', 'channel', 'region'] as const)('keeps list and locates %s with and without filters, including repeated clicks', async scope => {
  const { active } = setup(), doc = active.store.snapshot.document, media = doc.media[0];
  doc.viewState.media[media.id] = { ...defaultView(media), visibleChannels: [0] };
  const ui = render(<AppShell {...ready(active)} />);
  for (const filtered of [false, true]) {
    list();
    const category = filtered ? doc.categories[0].id : '*', channel = filtered && scope !== 'file' ? '1' : '*', query = filtered ? 'bird' : '';
    filters(category, channel, query);
    for (let i = 0; i < 2; i++) {
      fireEvent.click(row(`bird ${scope === 'channel' ? 'right' : scope}`)); await settle();
      expectTab('列表'); expectFilters(category, channel, query);
      const canvas = ui.container.querySelector('[data-context]')!;
      expect(JSON.parse(canvas.getAttribute('data-context')!)).toEqual({ mediaId: media.id, channelIndex: scope === 'file' ? null : 1 });
      if (scope !== 'file') expect(ui.container.querySelector(`[data-testid="canvas-${media.id}-1"]`)).toBeInTheDocument();
      if (scope === 'region') {
        expect(JSON.parse(canvas.getAttribute('data-selection')!).object.id).toBe(doc.annotations[0].id);
        const view = JSON.parse(canvas.getAttribute('data-view')!);
        expect(view.startSeconds).toBeLessThanOrEqual(doc.annotations[0].region.startSeconds);
        expect(view.endSeconds).toBeGreaterThanOrEqual(doc.annotations[0].region.endSeconds);
      }
    }
  }
  if (scope === 'file') fireEvent.click(screen.getByRole('checkbox', { name: '显示通道 2' }));
  fireEvent.click(screen.getByRole('button', { name: '选择频谱 A.wav 1' })); await settle(); expectTab('区域');
});

it.each(['file', 'channel'] as const)('observes same-target %s title click and keyboard focus after list location', async scope => {
  const { active } = setup();
  const ui = render(<AppShell {...ready(active)} />);
  for (const event of ['click', 'focus'] as const) {
    list(); fireEvent.click(row(scope === 'file' ? 'bird file' : 'bird right')); await settle(); expectTab('列表');
    const title = ui.container.querySelector(scope === 'file' ? '.file-heading h2' : '.channel-caption strong')!;
    const target = scope === 'channel' ? ui.container.querySelectorAll('.channel-caption strong')[1] : title;
    fireEvent[event](target); await settle(); expectTab('文件/通道');
  }
});

// Pause only the asynchronous reveal boundary; all workspace/selection hooks remain real.
function pauseReveal() {
  const original = workspaceModule.useWorkspace, pending: { id: string; resolve: (value: boolean) => void }[] = [];
  vi.spyOn(workspaceModule, 'useWorkspace').mockImplementation((...args) => {
    const workspace = original(...args);
    return { ...workspace, revealMedia: async id => {
      const allowed = await new Promise<boolean>(resolve => pending.push({ id, resolve }));
      return allowed && workspace.revealMedia(id);
    } };
  });
  return pending;
}
async function release(request: ReturnType<typeof pauseReveal>[number], allowed = true) { await act(async () => request.resolve(allowed)); }

it('keeps comparison panes stable through same-file and cross-file list clicks, then permits menu and processing selection', async () => {
  const { active, applyChange } = setup(), doc = active.store.snapshot.document, [a, b] = doc.media;
  doc.viewState.compareMediaId = b.id;
  doc.annotations.push({ ...doc.annotations[0], id: '00000000-0000-4000-8000-000000000044', region: { ...doc.annotations[0].region, mediaId: b.id, channelIndex: 0 }, note: 'other region' });
  doc.edits = [{ ...structuredClone(fixture.edits[0]), processingVersion: 2, operation: { type: 'mask' }, region: { ...doc.annotations[0].region } }];
  const ui = render(<AppShell {...ready(active)} />); list();
  const before = applyChange.mock.calls.length;
  for (const note of ['bird file', 'bird right', 'bird region', 'other file', 'other region', 'bird region']) {
    fireEvent.click(row(note)); await settle(); expectTab('列表');
    expect(screen.getByRole('combobox', { name: '主面板音频' })).toHaveValue(a.id);
    expect(screen.getByRole('combobox', { name: '对比面板音频' })).toHaveValue(b.id);
  }
  expect(ui.container.querySelector('[data-edit-id]')).toBeNull();
  expect(applyChange.mock.calls.slice(before).every(call => call[2].type === 'updateViewState')).toBe(true);
  fireEvent.click(screen.getByRole('menuitem', { name: '标注' }));
  fireEvent.click(screen.getByRole('menuitem', { name: '类别管理' })); await settle(); expectTab('类别');
  list(); fireEvent.click(row('other region')); await settle();
  fireEvent.click(screen.getByRole('button', { name: '选择处理对象 A.wav 1' })); await settle(); expectTab('处理');
  fireEvent.click(screen.getByRole('button', { name: '定位屏蔽 1' })); await settle(); expectTab('处理');
});

it.each(['file', 'channel', 'region'] as const)('opens a cross-file %s result in primary without a comparison', async scope => {
  const { active } = setup(), b = active.store.snapshot.document.media[1];
  active.store.snapshot.document.annotations.push({ ...active.store.snapshot.document.annotations[0], id: '00000000-0000-4000-8000-000000000045', region: { ...active.store.snapshot.document.annotations[0].region, mediaId: b.id, channelIndex: 0 }, note: 'other region' });
  render(<AppShell {...ready(active)} />); list();
  fireEvent.click(row(`other ${scope}`)); await settle(); expectTab('列表');
  expect(screen.getByRole('combobox', { name: '主面板音频' })).toHaveValue(b.id);
});

it.each(['tab', 'menu', 'newer', 'close', 'project', 'identity'] as const)('invalidates delayed location on %s', async action => {
  const pending = pauseReveal(), a = setup(fixture.projectId, 'author-a'), b = setup('00000000-0000-4000-8000-000000000033', 'author-b');
  const ui = render(<AppShell {...ready(a.active)} />); list(); filters('*', '*', '');
  fireEvent.click(row('other file')); expect(pending).toHaveLength(1);
  if (action === 'tab') fireEvent.click(screen.getByRole('tab', { name: '类别' }));
  if (action === 'menu') { fireEvent.click(screen.getByRole('menuitem', { name: '标注' })); fireEvent.click(screen.getByRole('menuitem', { name: '类别管理' })); }
  if (action === 'newer') { fireEvent.click(row('bird right')); await release(pending[1]); expectTab('列表'); }
  if (action === 'close') { ui.rerender(<AppShell {...props(null)} />); ui.rerender(<AppShell {...ready(setup(fixture.projectId, 'author-a').active)} />); list(); }
  if (action === 'project') { ui.rerender(<AppShell {...ready(b.active)} />); list(); filters('*', '*', 'other'); }
  if (action === 'identity') { a.active.collaboration!.actor = { ...a.active.collaboration!.actor!, authorId: 'author-b' }; ui.rerender(<AppShell {...ready(a.active)} />); list(); filters('*', '*', 'other'); }
  await release(pending[0]);
  expectTab(action === 'tab' || action === 'menu' ? '类别' : '列表');
  expect(screen.getByRole('combobox', { name: '主面板音频' })).toHaveValue(a.active.store.snapshot.document.media[0].id);
  if (action === 'project' || action === 'identity') expectFilters('*', '*', 'other');
});

it.each([['file', 'click'], ['file', 'focus'], ['channel', 'click'], ['channel', 'focus']] as const)('same-target %s title invalidates pending reveal through %s', async (scope, event) => {
  const pending = pauseReveal(), { active } = setup(), ui = render(<AppShell {...ready(active)} />);
  list(); fireEvent.click(row(scope === 'file' ? 'bird file' : 'bird right')); await release(pending[0]); expectTab('列表');
  fireEvent.click(row(scope === 'file' ? 'bird file' : 'bird right'));
  expect(pending).toHaveLength(2);
  const title = ui.container.querySelector(scope === 'file' ? '.file-heading h2' : '.channel-pane[aria-label="通道 2"] strong')!;
  fireEvent[event](title); await settle(); expectTab('文件/通道');
  await release(pending[1]); expectTab('文件/通道');
});

it('applies only the latest request when two delayed reveals settle in reverse order', async () => {
  const pending = pauseReveal(), { active } = setup();
  render(<AppShell {...ready(active)} />); list();
  fireEvent.click(row('other file')); fireEvent.click(row('bird right'));
  await release(pending[1]); expectTab('列表');
  await release(pending[0]); expectTab('列表');
  expect(screen.getByRole('combobox', { name: '主面板音频' })).toHaveValue(active.store.snapshot.document.media[0].id);
  fireEvent.click(screen.getByRole('tab', { name: '文件/通道' })); expect(screen.getByLabelText('通道 2 备注')).toHaveValue('bird right');
});

it('re-resolves a delayed region from current authority and rejects deleted or invalid targets', async () => {
  const pending = pauseReveal(), { active } = setup(), doc = active.store.snapshot.document;
  const ui = render(<AppShell {...ready(active)} />); list(); fireEvent.click(row('bird region'));
  const annotation = { ...doc.annotations[0], region: { ...doc.annotations[0].region, startSeconds: .5, endSeconds: 1 } };
  accept(active, { annotations: [annotation] }); await release(pending[0]); expectTab('列表');
  expect(JSON.parse(ui.container.querySelector('[data-selection]')!.getAttribute('data-selection')!).region).toEqual(annotation.region);
  fireEvent.click(ui.container.querySelector('.file-heading h2')!); list();
  fireEvent.click(row('bird region')); accept(active, { annotations: [] }); await release(pending[1]); expectTab('列表');
  fireEvent.click(row('bird right')); accept(active, { media: doc.media.map(m => ({ ...m, channelCount: 1, channelCategoryIds: [[]], channelNotes: m.channelNotes.slice(0, 1) })) });
  await release(pending[2]); expectTab('列表');
});

it('failed reveal leaves no suppression for the next real title or spectrum action', async () => {
  const pending = pauseReveal(), { active } = setup(), ui = render(<AppShell {...ready(active)} />); list();
  fireEvent.click(row('other file')); await release(pending[0], false); expectTab('列表');
  fireEvent.click(ui.container.querySelector('.file-heading h2')!); await settle(); expectTab('文件/通道');
  list(); fireEvent.click(screen.getByRole('button', { name: '选择频谱 A.wav 1' })); await settle(); expectTab('区域');
});

it.each([true, false])('runs the real hidden-media reveal boundary, success=%s, with no leftover suppression', async success => {
  const { active } = setup(fixture.projectId, 'author-a'), b = active.store.snapshot.document.media[1];
  active.collaboration!.hiddenMediaIds = [b.id];
  let complete!: () => void;
  const wait = new Promise<void>(resolve => { complete = resolve; });
  const hideMedia = vi.fn(async () => { await wait; if (!success) throw new Error('reveal failed'); });
  const collaboration = { controller: null, active, hideMedia } as unknown as import('../features/collaboration/useCollaboration').CollaborationUI;
  const ui = render(<AppShell {...ready(active)} collaboration={collaboration} />); list();
  fireEvent.click(row('other file')); expect(hideMedia).toHaveBeenCalledWith(b.id, false);
  await act(async () => { complete(); await wait; }); expectTab('列表');
  expect(screen.getByRole('combobox', { name: '主面板音频' })).toHaveValue(success ? b.id : active.store.snapshot.document.media[0].id);
  fireEvent.click(ui.container.querySelector('.file-heading h2')!); await settle(); expectTab('文件/通道');
});

it('reveals a result when every media was hidden and passive workspace context appears before reveal completes', async () => {
  const { active } = setup(fixture.projectId, 'author-a'), media = active.store.snapshot.document.media[1];
  active.collaboration!.hiddenMediaIds = active.store.snapshot.document.media.map(m => m.id);
  let complete!: () => void;
  const wait = new Promise<void>(resolve => { complete = resolve; });
  const hideMedia = vi.fn(async () => { await wait; });
  const collaboration = { controller: null, active, hideMedia } as unknown as import('../features/collaboration/useCollaboration').CollaborationUI;
  const ui = render(<AppShell {...ready(active)} collaboration={collaboration} />); list();
  fireEvent.click(row('other file')); expect(hideMedia).toHaveBeenCalledWith(media.id, false);
  // Collaboration publishes its accepted visibility before the asynchronous API returns.
  active.collaboration!.hiddenMediaIds = active.collaboration!.hiddenMediaIds.filter(id => id !== media.id);
  ui.rerender(<AppShell {...ready(active)} collaboration={collaboration} />);
  await settle();
  await act(async () => { complete(); await wait; });
  expectTab('列表');
  expect(screen.getByRole('combobox', { name: '主面板音频' })).toHaveValue(media.id);
  expect(JSON.parse(ui.container.querySelector('[data-context]')!.getAttribute('data-context')!)).toEqual({ mediaId: media.id, channelIndex: null });
});

it.each(['pane', 'channel'] as const)('context-only %s interaction supersedes a pending list reveal without selecting a region', async target => {
  const pending = pauseReveal(), { active } = setup(), doc = active.store.snapshot.document, [a, b] = doc.media;
  const c = { ...b, id: '00000000-0000-4000-8000-000000000046', displayName: 'C.wav', note: 'third file' };
  doc.media.push(c); doc.viewState.compareMediaId = c.id;
  const ui = render(<AppShell {...ready(active)} />); list(); filters('*', '*', 'other');
  fireEvent.click(row('other file')); expect(pending).toHaveLength(1);
  if (target === 'pane') fireEvent.focus(screen.getByRole('combobox', { name: '对比面板音频' }));
  else fireEvent(ui.container.querySelector('[data-pane="primary"] .channel-pane[aria-label="通道 2"]')!, new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
  await settle(); expectTab('文件/通道');
  const expected = { mediaId: target === 'pane' ? c.id : a.id, channelIndex: target === 'pane' ? 0 : 1 };
  expect(JSON.parse(ui.container.querySelector('[data-context]')!.getAttribute('data-context')!)).toEqual(expected);
  expect(JSON.parse(ui.container.querySelector('[data-selection]')!.getAttribute('data-selection')!)).toBeNull();
  await release(pending[0]); expectTab('文件/通道');
  expect(screen.getByRole('combobox', { name: '主面板音频' })).toHaveValue(a.id);
  expect(screen.getByRole('combobox', { name: '对比面板音频' })).toHaveValue(c.id);
  expect(JSON.parse(ui.container.querySelector('[data-context]')!.getAttribute('data-context')!)).toEqual(expected);
  list(); expectFilters('*', '*', 'other');
});

it.each(['sidebar', 'same sidebar', 'primary selector', 'compare selector', 'workspace menu', 'single-file mode'] as const)('explicit %s navigation supersedes a pending list reveal even when context stays in the other pane', async entry => {
  const pending = pauseReveal(), { active } = setup(), doc = active.store.snapshot.document, [a, b] = doc.media;
  const c = { ...b, id: '00000000-0000-4000-8000-000000000047', displayName: 'C.wav', note: 'third file' };
  const d = { ...b, id: '00000000-0000-4000-8000-000000000048', displayName: 'D.wav', note: 'fourth file' };
  doc.media.push(c, d); doc.viewState.compareMediaId = b.id;
  const ui = render(<AppShell {...ready(active)} />);
  const changesPrimary = entry === 'sidebar' || entry === 'primary selector';
  if (changesPrimary) fireEvent.click(ui.container.querySelector('[data-pane="compare"] .file-heading h2')!);
  list(); filters('*', '*', 'third'); fireEvent.click(row('third file')); expect(pending).toHaveLength(1);
  const before = ui.container.querySelector('[data-context]')!.getAttribute('data-context');
  if (entry === 'same sidebar') fireEvent.click(screen.getByRole('button', { name: 'A.wav' }));
  if (entry === 'sidebar') fireEvent.click(screen.getByRole('button', { name: 'D.wav' }));
  if (entry === 'primary selector' || entry === 'compare selector') fireEvent.change(screen.getByRole('combobox', { name: changesPrimary ? '主面板音频' : '对比面板音频' }), { target: { value: d.id } });
  if (entry === 'workspace menu') {
    fireEvent.click(screen.getByRole('menuitem', { name: '视图' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '双文件对比' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'D.wav' }));
  }
  if (entry === 'single-file mode') fireEvent.click(screen.getByRole('button', { name: '单文件' }));
  await settle();
  expect(ui.container.querySelector('[data-context]')!.getAttribute('data-context')).toBe(before);
  await release(pending[0]);
  expect(screen.getByRole('combobox', { name: '主面板音频' })).toHaveValue(changesPrimary ? d.id : a.id);
  if (entry === 'single-file mode') expect(screen.queryByRole('combobox', { name: '对比面板音频' })).not.toBeInTheDocument();
  else expect(screen.getByRole('combobox', { name: '对比面板音频' })).toHaveValue(entry === 'compare selector' || entry === 'workspace menu' ? d.id : b.id);
  expect(ui.container.querySelector('[data-context]')!.getAttribute('data-context')).toBe(before);
  expectTab('列表'); expectFilters('*', '*', 'third');
});

function realViewport(collaborate?: (active: ActiveProject) => CollaborationUI) {
  canvasMode.real = true;
  vi.stubGlobal('PointerEvent', MouseEvent);
  vi.stubGlobal('ResizeObserver', class {
    constructor(private callback: ResizeObserverCallback) {}
    observe(target: Element) { this.callback([{ target, contentRect: new DOMRect(0, 0, 800, 300) } as ResizeObserverEntry], this as unknown as ResizeObserver); }
    unobserve() {} disconnect() {}
  });
  const { active } = setup(fixture.projectId, collaborate ? 'author-a' : undefined), media = active.store.snapshot.document.media[0];
  active.store.snapshot.document.viewState.media[media.id] = { ...defaultView(media), visibleChannels: [0], startSeconds: .2, endSeconds: .8, lowHz: 300, highHz: 4000, frequencyMix: 0 };
  const collaboration = collaborate?.(active), content = <AppShell {...ready(active)} collaboration={collaboration} />;
  const ui = render(collaboration ? <CollaborationContext.Provider value={collaboration}>{content}</CollaborationContext.Provider> : content);
  const surface = screen.getByLabelText('通道 1 频谱', { selector: '.spectrogram-surface' });
  surface.setPointerCapture = vi.fn();
  const canvas = () => screen.getByTestId(`canvas-${media.id}-0`);
  return { active, media, ui, surface, canvas, view: () => JSON.parse(canvas().getAttribute('data-view')!) };
}

it.each(['bird region', 'other file'])('real arrow-key viewport pan supersedes delayed %s location without changing context', async note => {
  const pending = pauseReveal(), viewport = realViewport();
  list(); fireEvent.click(row(note));
  const before = viewport.view(), context = viewport.canvas().getAttribute('data-context');
  fireEvent.keyDown(viewport.surface, { key: 'ArrowRight' }); await settle();
  const panned = viewport.view(); expect(panned.startSeconds).toBeGreaterThan(before.startSeconds);
  expect(viewport.canvas().getAttribute('data-context')).toBe(context);
  await release(pending[0]);
  expect(screen.getByRole('combobox', { name: '主面板音频' })).toHaveValue(viewport.media.id);
  expect(viewport.view()).toEqual(panned); expect(viewport.canvas().getAttribute('data-context')).toBe(context); expectTab('列表');
});

it.each([
  ['alt', 'started'], ['middle', 'started'], ['alt', 'moving'], ['middle', 'moving'],
  ['alt', 'completed'], ['middle', 'completed'], ['alt', 'completed without movement'], ['middle', 'completed without movement'],
] as const)('real %s pointer pan in phase %s supersedes same-media reveal permanently', async (method, phase) => {
  const pending = pauseReveal(), viewport = realViewport();
  list(); fireEvent.click(row('bird region'));
  const before = viewport.view(), context = viewport.canvas().getAttribute('data-context');
  fireEvent.pointerDown(viewport.surface, { button: method === 'alt' ? 0 : 1, altKey: method === 'alt', clientX: 400, clientY: 150 });
  expect(viewport.canvas()).toHaveAttribute('data-gesture', 'true');
  if (phase === 'moving' || phase === 'completed') fireEvent.pointerMove(viewport.surface, { clientX: 320, clientY: 120 });
  if (phase === 'completed' || phase === 'completed without movement') fireEvent.pointerUp(viewport.surface);
  await settle();
  const panned = viewport.view(), gesturing = viewport.canvas().getAttribute('data-gesture');
  if (phase === 'moving' || phase === 'completed') expect(panned.startSeconds).toBeGreaterThan(before.startSeconds);
  else expect(panned).toEqual(before);
  expect(viewport.canvas().getAttribute('data-context')).toBe(context);
  await release(pending[0]);
  expect(viewport.canvas()).toHaveAttribute('data-gesture', gesturing);
  expect(viewport.view()).toEqual(panned); expect(viewport.canvas().getAttribute('data-context')).toBe(context); expectTab('列表');
  if (gesturing === 'true') {
    fireEvent.pointerMove(viewport.surface, { clientX: 240, clientY: 90 });
    expect(viewport.view().startSeconds).toBeGreaterThan(panned.startSeconds);
    fireEvent.pointerUp(viewport.surface); expect(viewport.canvas()).toHaveAttribute('data-gesture', 'false');
  }
});

it('same-pane explicit view menu patch supersedes pending region location', async () => {
  const pending = pauseReveal(), viewport = realViewport(); list(); fireEvent.click(row('bird region'));
  fireEvent.click(screen.getByRole('menuitem', { name: '视图' })); fireEvent.click(screen.getByRole('menuitem', { name: '缩小视图' }));
  await settle(); const latest = viewport.view();
  await release(pending[0]); expect(viewport.view()).toEqual(latest); expectTab('列表');
});

it.each(['older first', 'newer first', 'newer failed'] as const)('real shared-region same-pane locate supersedes a pending list reveal: %s', async order => {
  const pending = pauseReveal(), viewport = realViewport(active => {
    const doc = active.store.snapshot.document, controller = new CollaborationController(active);
    const remote = { ...doc.annotations[0], region: { ...doc.annotations[0].region, channelIndex: 0, startSeconds: .4, endSeconds: .5, lowHz: 1000, highHz: 1500 } };
    controller.status = { snapshot: { projectId: doc.projectId, authors: [{ identity: { authorId: 'other-author', displayName: 'Other author', createdAt: doc.createdAt }, error: null, layer: { kind: 'audio-annotator-author-layer', formatVersion: 2, projectId: doc.projectId, authorId: 'other-author', revision: 1, parent: null, hash: 'verified', payload: { categories: doc.categories, annotations: [remote], mediaLabels: [] } } }] } } as never;
    return { active, controller } as CollaborationUI;
  });
  list(); fireEvent.click(row('bird region'));
  const context = viewport.canvas().getAttribute('data-context');
  const overlay = screen.getByLabelText('通道 1 标注图层');
  vi.spyOn(overlay, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 800, 300));
  const mapping = coordinates(viewport.view(), viewport.media.sampleRate / 2, 800, 300);
  fireEvent.contextMenu(overlay, { clientX: mapping.secondsToX(.45), clientY: mapping.hzToY(1250) });
  expect(screen.getByRole('dialog', { name: '共享标注详情（只读）' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '定位' }));
  expect(pending).toHaveLength(2);
  const original = viewport.view();
  const expectNoLocalSelection = () => expect(viewport.ui.container.querySelector('[data-selection]')).toHaveAttribute('data-selection', 'null');
  if (order === 'older first') {
    await release(pending[0]);
    expectNoLocalSelection(); expect(viewport.view()).toEqual(original);
    expect(viewport.canvas().getAttribute('data-context')).toBe(context);
    await release(pending[1]);
  } else {
    await release(pending[1], order !== 'newer failed');
    await release(pending[0]);
  }
  expectNoLocalSelection();
  if (order === 'newer failed') expect(viewport.view()).toEqual(original);
  else expect(viewport.view().startSeconds).toBeCloseTo(.375);
  expect(viewport.canvas().getAttribute('data-context')).toBe(context); expectTab('列表');
});
