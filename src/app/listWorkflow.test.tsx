import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { useSyncExternalStore } from 'react';
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
import { inspectionClient } from '../bridge/inspection';
import { exampleClient, type ExampleEntry } from '../bridge/examples';

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
it('opens an own list target in the read-only viewer without main selection or navigation until explicit Jump', async () => {
 const {active}=setup(); render(<AppShell {...props(active)}/>); list();
 const before=active.store.snapshot.document.viewState;
 fireEvent.click(screen.getByText('bird region',{selector:'.note-summary'}));
 expect(screen.getByRole('dialog',{name:'音频查看（只读）'})).toHaveTextContent('bird region');
 expect(active.store.snapshot.document.viewState).toEqual(before);
 expect(screen.queryByLabelText('区域备注')).toBeNull();
});
it.each(['self','foreign'] as const)('opens %s Author region in the same viewer, preserves main view and selects own regions only after Jump', async source=>{
 const authorId='00000000-0000-4000-8000-000000000021',{active}=setup(fixture.projectId,authorId),controller=new CollaborationController(active),doc=active.store.snapshot.document;
 const foreignId='00000000-0000-4000-8000-000000000022';
 controller.status={snapshot:{projectId:doc.projectId,authors:[{identity:{authorId:foreignId,displayName:'Other',createdAt:doc.createdAt},error:null,layer:{payload:{annotations:structuredClone(doc.annotations),categories:doc.categories,mediaLabels:[]}}}]}} as never;
 const collaboration={active,controller} as CollaborationUI;
 const snapshot=structuredClone(active.store.snapshot); snapshot.document.projectId=crypto.randomUUID();snapshot.document.annotations=[];snapshot.document.media=[snapshot.document.media[0]];
 vi.spyOn(inspectionClient,'open').mockResolvedValue({previewId:snapshot.document.projectId,snapshot});vi.spyOn(inspectionClient,'close').mockResolvedValue();
 render(<AppShell {...ready(active)} collaboration={collaboration}/>); await settle();
 fireEvent.click(screen.getByRole('tab',{name:'作者'}));
 const before=structuredClone(active.store.snapshot.document.viewState),owner=source==='self'?authorId:foreignId;
 const section=document.querySelector<HTMLElement>(`[data-remote-author="${owner}"]`)!;
 fireEvent.click(within(section).getByText('bird region').closest('button')!);
 expect(screen.getByRole('dialog',{name:'音频查看（只读）'})).toHaveTextContent('bird region');expect(active.store.snapshot.document.viewState).toEqual(before);
 fireEvent.click(screen.getByRole('button',{name:'跳转到音频'}));await settle();
 expect(screen.queryByRole('dialog',{name:'音频查看（只读）'})).toBeNull();
 fireEvent.click(screen.getByRole('tab',{name:'区域'}));
 if(source==='self')expect(screen.getByLabelText('区域备注')).toHaveValue('bird region');
 else expect(screen.queryByLabelText('区域备注')).toBeNull();
});
function authorSetup() {
  const authorId = '00000000-0000-4000-8000-000000000021', foreignId = '00000000-0000-4000-8000-000000000022';
  const base = setup(fixture.projectId, authorId), { active } = base, doc = active.store.snapshot.document, [a, b] = doc.media;
  b.channelCount = 2; b.channelLayout = ['left', 'right']; b.channelNotes = ['target left', 'target channel'];
  b.categoryIds = [...a.categoryIds]; b.channelCategoryIds = [[], [...a.categoryIds]]; b.note = 'target file';
  doc.annotations.push({ ...structuredClone(doc.annotations[0]), id: '00000000-0000-4000-8000-000000000045', note: 'target region', region: { ...doc.annotations[0].region, mediaId: b.id, channelIndex: 1 } });
  doc.viewState.media[b.id] = { ...defaultView(b), visibleChannels: [0] };
  const controller = new CollaborationController(active);
  // Deliberate local-ID collision, with different media and geometry.
  const foreign = { ...structuredClone(doc.annotations[0]), note: 'target region', region: { ...doc.annotations[0].region, mediaId: b.id, channelIndex: 1, startSeconds: .4, endSeconds: .6 } };
  const payload = { annotations: [foreign], categories: doc.categories, mediaLabels: doc.media.map(m => ({ mediaId: m.id, note: m.note, channelNotes: m.channelNotes, categoryIds: m.categoryIds, channelCategoryIds: m.channelCategoryIds })) };
  controller.status = { snapshot: { projectId: doc.projectId, authors: [{ identity: { authorId: foreignId, displayName: 'Other', createdAt: doc.createdAt }, error: null, layer: { payload } }] } } as never;
  const collaboration = { active, controller } as CollaborationUI;
  const snapshot = structuredClone(active.store.snapshot); snapshot.document.projectId = crypto.randomUUID(); snapshot.document.annotations = []; snapshot.document.media = [snapshot.document.media[0]];
  vi.spyOn(inspectionClient, 'open').mockResolvedValue({ previewId: snapshot.document.projectId, snapshot }); vi.spyOn(inspectionClient, 'close').mockResolvedValue();
  const open = (source: 'self' | 'foreign', scope: 'file' | 'channel' | 'region') => {
    fireEvent.click(screen.getByRole('tab', { name: '作者' }));
    const section = document.querySelector<HTMLElement>(`[data-remote-author="${source === 'self' ? authorId : foreignId}"]`)!;
    fireEvent.click(within(section).getByText(`target ${scope}`).closest('button')!);
  };
  return { ...base, doc, a, b, payload, collaboration, open, privateView: () => JSON.parse(active.store.drafts.get('spectrogram-view') ?? JSON.stringify(active.store.snapshot.document.viewState)) };
}
it.each([['self', 'file'], ['self', 'channel'], ['self', 'region'], ['foreign', 'file'], ['foreign', 'channel'], ['foreign', 'region']] as const)('keeps %s Author %s navigation in its tab across panes and repeated jumps', async (source, scope) => {
  const s = authorSetup(), ui = render(<AppShell {...ready(s.active)} collaboration={s.collaboration} />);
  for (const compare of [false, true]) {
    if (compare) {
      fireEvent.change(screen.getByRole('combobox', { name: '主面板音频' }), { target: { value: s.a.id } });
      fireEvent.click(screen.getByRole('button', { name: '双文件对比' }));
    }
    for (let repeat = 0; repeat < 2; repeat++) {
      s.open(source, scope); const before = s.privateView();
      expectTab('作者'); fireEvent.click(screen.getByRole('button', { name: '关闭查看' })); await settle(); expectTab('作者');
      expect(s.privateView()).toEqual(before);
      s.open(source, scope); jump(); await settle();
      expect(screen.queryByRole('dialog', { name: '音频查看（只读）' })).toBeNull(); expectTab('作者');
      expect(screen.getByRole('combobox', { name: '主面板音频' })).toHaveValue(compare ? s.a.id : s.b.id);
      if (compare) expect(screen.getByRole('combobox', { name: '对比面板音频' })).toHaveValue(s.b.id);
      if (scope !== 'file') expect(ui.container.querySelector(`[data-testid="canvas-${s.b.id}-1"]`)).toBeInTheDocument();
      const selected = JSON.parse(ui.container.querySelector('[data-selection]')!.getAttribute('data-selection')!);
      if (source === 'self' && scope === 'region') expect(selected.object.id).toBe(s.doc.annotations[1].id);
      else expect(selected).toBeNull();
    }
  }
  fireEvent.click(screen.getAllByRole('button', { name: '重新选择当前选区' })[0]); await settle();
  expectTab(source === 'self' && scope === 'region' ? '区域' : '文件/通道');
  await act(async () => { await s.active.lifecycle.submitDrafts(); });
  expect(s.applyChange.mock.calls.length).toBeGreaterThan(0);
  expect(s.applyChange.mock.calls.every(call => call[2].type === 'updateViewState')).toBe(true);
  fireEvent.click(ui.container.querySelector('.file-heading h2')!); await settle(); expectTab('文件/通道');
});
it.each(['replaced pane', 'hidden channel', 'still visible'] as const)('coordinates an old selection during foreign navigation: %s', async mode => {
  const s = authorSetup();
  if (mode !== 'replaced pane') s.doc.viewState.compareMediaId = s.b.id;
  if (mode === 'hidden channel') s.doc.annotations[0].region.mediaId = s.b.id;
  if (mode === 'hidden channel') s.doc.annotations[0].region.channelIndex = 0;
  const ui = render(<AppShell {...ready(s.active)} collaboration={s.collaboration} />);
  fireEvent.click(screen.getByRole('button', { name: '选择频谱 A.wav 1' })); await settle();
  s.open('foreign', 'region'); jump(); await settle(); expectTab('作者');
  expect(screen.queryByRole('dialog', { name: '音频查看（只读）' })).toBeNull();
  const selected = JSON.parse(ui.container.querySelector('[data-selection]')!.getAttribute('data-selection')!);
  if (mode === 'still visible') expect(selected.object.id).toBe(s.doc.annotations[0].id);
  else expect(selected).toBeNull();
  fireEvent.click(ui.container.querySelector('.file-heading h2')!); await settle(); expectTab('文件/通道');
});
it.each(['self', 'foreign'] as const)('cancels delayed %s author requests for user and runtime changes', async source => {
  const pending = pauseReveal(), s = authorSetup();
  const ui = render(<AppShell {...ready(s.active)} collaboration={s.collaboration} />);
  for (const action of ['close viewer', 'tab', 'primary', 'channel context', 'same selection', 'gesture', 'reopen', 'project', 'identity', 'runtime'] as const) {
    s.open(source, 'region'); jump(); const request = pending.at(-1)!;
    if (action === 'close viewer') fireEvent.click(screen.getByRole('button', { name: '关闭查看' }));
    if (action === 'tab') fireEvent.click(screen.getByRole('tab', { name: '类别' }));
    if (action === 'primary') fireEvent.change(screen.getByRole('combobox', { name: '主面板音频' }), { target: { value: s.a.id } });
    if (action === 'channel context') fireEvent(ui.container.querySelector('[data-pane="primary"] .channel-pane[aria-label="通道 2"]')!, new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    if (action === 'same selection') fireEvent.click(ui.container.querySelector('.file-heading h2')!);
    if (action === 'gesture') fireEvent.click(screen.getByRole('button', { name: '开始手势 A.wav 1' }));
    if (action === 'reopen') { ui.rerender(<AppShell {...props(null)} />); ui.rerender(<AppShell {...ready(setup(fixture.projectId, 'other').active)} />); }
    if (action === 'project') ui.rerender(<AppShell {...ready(setup(crypto.randomUUID(), 'other').active)} />);
    if (action === 'identity') { s.active.collaboration!.actor = { ...s.active.collaboration!.actor!, authorId: 'replacement' }; ui.rerender(<AppShell {...ready(s.active)} collaboration={s.collaboration} />); }
    if (action === 'runtime') { s.active.collaboration!.runtimeNonce = crypto.randomUUID(); ui.rerender(<AppShell {...ready(s.active)} collaboration={s.collaboration} />); }
    await settle();
    const tab = screen.getAllByRole('tab').find(t => t.getAttribute('aria-selected') === 'true')!.textContent;
    const before = ui.container.querySelector('[data-context]')!.getAttribute('data-context');
    await release(request);
    expect(screen.getAllByRole('tab').find(t => t.getAttribute('aria-selected') === 'true')!.textContent).toBe(tab);
    expect(ui.container.querySelector('[data-context]')).toHaveAttribute('data-context', before!);
    expect(screen.getByRole('combobox', { name: '主面板音频' })).toHaveValue(s.a.id);
    // Restore the fixture owner only after proving the old completion was inert.
    s.active.collaboration!.actor = { ...s.active.collaboration!.actor!, authorId: '00000000-0000-4000-8000-000000000021' };
    ui.rerender(<AppShell {...ready(s.active)} collaboration={s.collaboration} />);
    if (screen.queryByRole('button', { name: '关闭查看' })) fireEvent.click(screen.getByRole('button', { name: '关闭查看' }));
    fireEvent.click(screen.getByRole('button', { name: '结束手势 A.wav 1' }));
    fireEvent.click(ui.container.querySelector('.file-heading h2')!); await settle(); expectTab('文件/通道');
  }
});
it.each(['self', 'foreign'] as const)('uses only current %s author geometry and rejects invalid targets during reveal', async source => {
  const pending = pauseReveal(), s = authorSetup(), ui = render(<AppShell {...ready(s.active)} collaboration={s.collaboration} />);
  const original = structuredClone(source === 'self' ? s.doc.annotations[1] : s.payload.annotations[0]);
  const update = (annotations: typeof s.doc.annotations) => {
    if (source === 'self') accept(s.active, { annotations: [s.doc.annotations[0], ...annotations] });
    else { s.payload.annotations = annotations; ui.rerender(<AppShell {...ready(s.active)} collaboration={s.collaboration} />); }
  };
  for (const mutation of ['geometry', 'deleted', 'moved media', 'invalid geometry', 'channel removed', 'media removed', 'reveal failed'] as const) {
    update([structuredClone(original)]);
    s.open(source, 'region'); jump(); const request = pending.at(-1)!;
    if (mutation === 'geometry') update([{ ...original, region: { ...original.region, startSeconds: .5, endSeconds: .7, lowHz: 500, highHz: 1000 } }]);
    if (mutation === 'deleted') update([]);
    if (mutation === 'moved media') update([{ ...original, region: { ...original.region, mediaId: s.a.id } }]);
    if (mutation === 'invalid geometry') update([{ ...original, region: { ...original.region, endSeconds: Infinity } }]);
    if (mutation === 'channel removed') accept(s.active, { media: [s.a, { ...s.b, channelCount: 1, channelNotes: ['target left'], channelCategoryIds: [[]] }] });
    if (mutation === 'media removed') accept(s.active, { media: [s.a] });
    await settle(); const before = ui.container.querySelector('[data-view]')!.getAttribute('data-view');
    await release(request, mutation !== 'reveal failed'); expectTab('作者');
    if (mutation === 'geometry') {
      expect(screen.queryByRole('dialog', { name: '音频查看（只读）' })).toBeNull();
      const view = JSON.parse(ui.container.querySelector('[data-view]')!.getAttribute('data-view')!);
      expect(view.startSeconds).toBeCloseTo(.45); expect(view.highHz).toBe(1125);
    } else {
      expect(screen.getByRole('dialog', { name: '音频查看（只读）' })).toBeInTheDocument();
      expect(ui.container.querySelector('[data-view]')).toHaveAttribute('data-view', before!);
      expect(ui.container.querySelector('[data-selection]')).toHaveAttribute('data-selection', 'null');
      fireEvent.click(screen.getByRole('button', { name: '关闭查看' }));
    }
    accept(s.active, { media: [s.a, s.b] });
    fireEvent.change(screen.getByRole('combobox', { name: '主面板音频' }), { target: { value: s.a.id } });
    fireEvent.click(ui.container.querySelector('.file-heading h2')!); await settle(); expectTab('文件/通道');
  }
});
it.each(['self', 'foreign'] as const)('rejects %s author channel and pane invalidation without applying selection or view', async source => {
  const pending = pauseReveal(true), s = authorSetup(), ui = render(<AppShell {...ready(s.active)} collaboration={s.collaboration} />);
  for (const scope of ['file', 'channel', 'region'] as const) {
    s.open(source, scope); jump(); const before = s.privateView();
    await release(pending.at(-1)!); expectTab('作者');
    expect(screen.getByRole('dialog', { name: '音频查看（只读）' })).toBeInTheDocument();
    expect(s.privateView()).toEqual(before);
    expect(ui.container.querySelector('[data-selection]')).toHaveAttribute('data-selection', 'null');
    fireEvent.click(screen.getByRole('button', { name: '关闭查看' }));
    fireEvent.click(ui.container.querySelector('.file-heading h2')!); await settle(); expectTab('文件/通道');
  }
});
it.each(['older first', 'newer first', 'newer failed'] as const)('only applies the newest author request: %s', async order => {
  const pending = pauseReveal(), s = authorSetup(), ui = render(<AppShell {...ready(s.active)} collaboration={s.collaboration} />);
  s.open('self', 'region'); jump(); s.open('foreign', 'region'); jump();
  if (order === 'older first') {
    await release(pending[0]); expect(screen.getByRole('combobox', { name: '主面板音频' })).toHaveValue(s.a.id);
    await release(pending[1]);
  } else { await release(pending[1], order !== 'newer failed'); await release(pending[0]); }
  expectTab('作者'); expect(ui.container.querySelector('[data-selection]')).toHaveAttribute('data-selection', 'null');
  expect(screen.getByRole('combobox', { name: '主面板音频' })).toHaveValue(order === 'newer failed' ? s.a.id : s.b.id);
  if (order !== 'newer failed') expect(screen.queryByRole('dialog', { name: '音频查看（只读）' })).toBeNull();
  fireEvent.click(ui.container.querySelector('.file-heading h2')!); await settle(); expectTab('文件/通道');
});
it.each(['self', 'foreign'] as const)('rejects %s author channel removed while reveal is pending and permits a later selection', async source => {
  const pending = pauseReveal(), s = authorSetup(), ui = render(<AppShell {...ready(s.active)} collaboration={s.collaboration} />);
  s.open(source, 'channel'); jump();
  accept(s.active, { media: [s.a, { ...s.b, channelCount: 1, channelNotes: ['target left'], channelCategoryIds: [[]] }] });
  const before = ui.container.querySelector('[data-view]')!.getAttribute('data-view');
  await release(pending[0]); expectTab('作者');
  expect(screen.getByRole('dialog', { name: '音频查看（只读）' })).toBeInTheDocument();
  expect(screen.getByRole('combobox', { name: '主面板音频' })).toHaveValue(s.a.id);
  expect(ui.container.querySelector('[data-view]')).toHaveAttribute('data-view', before!);
  expect(ui.container.querySelector('[data-selection]')).toHaveAttribute('data-selection', 'null');
  fireEvent.click(screen.getByRole('button', { name: '关闭查看' }));
  fireEvent.click(ui.container.querySelector('.file-heading h2')!); await settle(); expectTab('文件/通道');
});
it.each(['self', 'foreign'] as const)('reports a rejected %s author reveal once and allows retry without stale suppression', async source => {
  const pending = pauseReveal(), s = authorSetup(), ui = render(<AppShell {...ready(s.active)} collaboration={s.collaboration} />);
  s.open(source, 'region'); jump();
  await act(async () => pending[0].reject({ code: 'InvalidInput', message: 'reveal rejected', retryable: false }));
  expect(within(screen.getByRole('dialog', { name: '音频查看（只读）' })).getByRole('alert')).toHaveTextContent('reveal rejected'); expectTab('作者');
  expect(screen.getByRole('combobox', { name: '主面板音频' })).toHaveValue(s.a.id);
  fireEvent.click(ui.container.querySelector('.file-heading h2')!); await settle(); expectTab('文件/通道');
  fireEvent.click(screen.getByRole('tab', { name: '作者' })); jump(); await release(pending[1]); expectTab('作者');
  expect(screen.queryByRole('dialog', { name: '音频查看（只读）' })).toBeNull();
  fireEvent.click(ui.container.querySelector('.file-heading h2')!); await settle(); expectTab('文件/通道');
});
it('invalidates a pending own-list jump when the global identity runtime changes for the same author', async () => {
  const pending = pauseReveal(), { active } = setup();
  const identity = new IdentityController({ owner: () => active, perform: async () => null, acceptStatus: vi.fn() });
  identity.snapshot = { storeRevision: 1, runtimeNonce: crypto.randomUUID(), project: null, selectedAuthorId: 'author', profiles: [{ authorId: 'author', displayName: 'Author', createdAt: fixture.createdAt }] };
  const ui = render(<AppShell {...ready(active)} identity={identity} />);
  list(); fireEvent.click(row('other file')); jump();
  identity.snapshot = { ...identity.snapshot, runtimeNonce: crypto.randomUUID() };
  ui.rerender(<AppShell {...ready(active)} identity={identity} />);
  await release(pending[0]);
  expect(screen.getByRole('combobox', { name: '主面板音频' })).toHaveValue(active.store.snapshot.document.media[0].id);
  expectTab('列表'); identity.dispose();
});
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
  expect(screen.getByText('2 / 6 个对象 · 点击查看')).toBeInTheDocument();
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
  expect(screen.getByText('2 / 6 个对象 · 点击查看')).toBeInTheDocument();
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
  expect(screen.getByText('1 / 6 个对象 · 点击查看')).toBeInTheDocument();
  expect(screen.queryByText('bird region')).not.toBeInTheDocument();
  filters(category, '1', '  absent  ');
  expect(screen.getByText('没有符合条件的标注')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('tab', { name: '区域' })); list(); expectFilters(category, '1', '  absent  ');
  accept(active, { categories: [] }); expectFilters('*', '1', '  absent  ');
  filters('', '1', 'bird');
  accept(active, { media: doc.media.map(m => ({ ...m, channelCount: 1, channelCategoryIds: [[]], channelNotes: m.channelNotes.slice(0, 1) })), annotations: [] });
  expectFilters('', '*', 'bird');
  expect(screen.getByText('1 / 4 个对象 · 点击查看')).toBeInTheDocument();
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
        <button onClick={() => selection?.state.select(selection.state.getActiveSelection())}>重新选择当前选区</button>
        <button onClick={() => selection?.state.beginGesture()}>开始手势 {media.displayName} {channel}</button>
        <button onClick={() => selection?.state.endGesture()}>结束手势 {media.displayName} {channel}</button>
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
function jump() { fireEvent.click(screen.getByRole('button', { name: '跳转到音频' })); }
function row(note: string) { return screen.getByText(note, { selector: '.note-summary' }).closest('button')!; }
function expectTab(name: string) { expect(screen.getByRole('tab', { name })).toHaveAttribute('aria-selected', 'true'); }
async function settle() { await act(async () => {}); }

function processingSetup() {
  const base = setup(), doc = base.active.store.snapshot.document, [a, b] = doc.media;
  b.channelCount = 2; b.channelLayout = ['left', 'right']; b.channelNotes = ['', '']; b.channelCategoryIds = [[], []];
  doc.viewState.media[b.id] = { ...defaultView(b), visibleChannels: [0] };
  doc.edits = ['mask', 'gain'].map((type, index) => ({
    id: `00000000-0000-4000-8000-00000000008${index}`, enabled: true, processingVersion: 2,
    operation: type === 'mask' ? { type: 'mask' } : { type: 'gain', gainDb: -6 },
    region: { ...doc.annotations[0].region, mediaId: b.id, channelIndex: 1, startSeconds: .4, endSeconds: .6, lowHz: 500, highHz: 1000 },
  }));
  return { ...base, doc, a, b };
}
function locateProcessing(kind: 'mask' | 'gain' = 'mask') {
  fireEvent.click(screen.getByRole('tab', { name: '处理' }));
  fireEvent.click(screen.getByRole('button', { name: kind === 'mask' ? '定位屏蔽 1' : '定位增益 -6.0 dB 2' }));
}
// Exercise real inspector controls; only the native command boundary is in memory.
function acceptInspectorCommands(s: ReturnType<typeof setup>) {
  const fallback = s.applyChange.getMockImplementation()!;
  s.applyChange.mockImplementation(async (id, revision, change) => {
    const snapshot = await fallback(id, revision, change), doc = structuredClone(snapshot.document);
    if (change.type === 'updateAnnotationNote') doc.annotations.find(a => a.id === change.id)!.note = change.note;
    if (change.type === 'updateAnnotation') doc.annotations = doc.annotations.map(a => a.id === change.annotation.id ? change.annotation : a);
    if (change.type === 'updateMediaNote') doc.media.find(m => m.id === change.mediaId)!.note = change.note;
    if (change.type === 'updateChannelNote') doc.media.find(m => m.id === change.mediaId)!.channelNotes[change.channelIndex] = change.note;
    if (change.type === 'setMediaCategories') doc.media.find(m => m.id === change.mediaId)!.categoryIds = change.categoryIds;
    if (change.type === 'setChannelCategories') doc.media.find(m => m.id === change.mediaId)!.channelCategoryIds[change.channelIndex] = change.categoryIds;
    if (change.type === 'addCategory') doc.categories.push(change.category);
    if (change.type === 'updateCategory') doc.categories = doc.categories.map(c => c.id === change.category.id ? change.category : c);
    if (change.type === 'updatePlaybackMix') doc.playbackMix[change.mediaId] = change.mix;
    return { ...snapshot, document: doc };
  });
}
it.each(['region', 'file', 'channel'] as const)('keeps the inspector tab while editing %s notes and categories', async scope => {
  const s = setup(); acceptInspectorCommands(s); const doc = s.active.store.snapshot.document, a = doc.media[0], category = doc.categories[0];
  const ui = render(<AppShell {...ready(s.active)} />);
  if (scope === 'region') fireEvent.click(screen.getByRole('button', { name: '选择频谱 A.wav 1' }));
  else fireEvent.click(ui.container.querySelector(scope === 'file' ? '.file-heading h2' : '.channel-caption strong')!);
  const tab = scope === 'region' ? '区域' : '文件/通道', label = scope === 'region' ? '区域备注' : scope === 'file' ? '音频备注' : '通道 1 备注';
  fireEvent.change(screen.getByLabelText(label), { target: { value: 'updated note' } }); fireEvent.blur(screen.getByLabelText(label)); await settle(); expectTab(tab);
  expect(screen.getByLabelText(label)).toHaveValue('updated note');
  const current = s.active.store.snapshot.document;
  expect(scope === 'region' ? current.annotations[0].note : scope === 'file' ? current.media[0].note : current.media[0].channelNotes[0]).toBe('updated note');
  if (scope === 'region') fireEvent.click(within(screen.getByRole('group', { name: '区域类别' })).getByRole('checkbox', { name: category.name }));
  else {
    fireEvent.click(within(ui.container.querySelector('.notes-editor')!).getByRole('button', { name: `A.wav ${scope === 'file' ? '文件' : '通道 1'} 类别` }));
    fireEvent.click(screen.getByRole('menuitem', { name: scope === 'file' ? '文件类别' : '通道类别' }));
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: category.name }));
  }
  await settle(); expectTab(tab);
  const after = s.active.store.snapshot.document, ids = scope === 'region' ? after.annotations[0].categoryIds : scope === 'file' ? after.media[0].categoryIds : after.media[0].channelCategoryIds[0];
  const before = scope === 'region' ? doc.annotations[0].categoryIds : scope === 'file' ? a.categoryIds : a.channelCategoryIds[0];
  expect(ids.includes(category.id)).toBe(!before.includes(category.id));
});
it('keeps categories selected through add, edit, and visibility changes', async () => {
  const s = setup(); acceptInspectorCommands(s); const controller = new CollaborationController(s.active), collaboration = { active: s.active, controller } as CollaborationUI;
  function Harness() {
    useSyncExternalStore(controller.subscribe, controller.getVersion);
    return <CollaborationContext.Provider value={{ ...collaboration }}><AppShell {...ready(s.active)} /></CollaborationContext.Provider>;
  }
  render(<Harness />);
  fireEvent.click(screen.getByRole('tab', { name: '类别' }));
  fireEvent.change(screen.getByLabelText('类别名称'), { target: { value: 'new category' } }); fireEvent.click(screen.getByRole('button', { name: '添加类别' })); await settle(); expectTab('类别');
  expect(s.active.store.snapshot.document.categories.some(c => c.name === 'new category')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '编辑类别 new category' }));
  fireEvent.change(screen.getByLabelText('类别名称'), { target: { value: 'renamed category' } }); fireEvent.click(screen.getByRole('button', { name: '保存类别' })); await settle(); expectTab('类别');
  expect(s.active.store.snapshot.document.categories.some(c => c.name === 'renamed category')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '隐藏类别 renamed category' })); await settle(); expectTab('类别');
  expect(controller.hiddenCategoryNames).toContain('renamed category');
  expect(screen.getByRole('button', { name: '显示类别 renamed category' })).toHaveAttribute('aria-pressed', 'false');
  controller.dispose();
});
it('keeps mix selected through solo and mute changes', async () => {
  const s = setup(); acceptInspectorCommands(s); render(<AppShell {...ready(s.active)} />);
  fireEvent.click(screen.getByRole('tab', { name: '混合' }));
  for (const name of ['独听通道 1', '静音通道 2']) {
    fireEvent.click(screen.getByRole('button', { name })); await settle(); expectTab('混合');
    expect(screen.getByRole('button', { name })).toHaveAttribute('aria-pressed', 'true');
  }
});
it('keeps examples selected while opening and closing a real read-only preview', async () => {
  const actor = '00000000-0000-4000-8000-000000000021', s = setup(fixture.projectId, actor), doc = s.active.store.snapshot.document;
  const entry: ExampleEntry = { sampleId: actor, projectId: doc.projectId, creatorId: actor, scope: 'private', name: 'Preview sample', revision: 1, originalFilename: 'A.wav', media: doc.media[0] };
  vi.spyOn(exampleClient, 'list').mockResolvedValue({ entries: [entry], revisions: { [actor]: 1 } });
  const preview = structuredClone(s.active.store.snapshot); preview.document.media = [doc.media[0]]; preview.document.annotations = []; preview.document.edits = [];
  vi.spyOn(exampleClient, 'open').mockResolvedValue({ previewId: actor, snapshot: preview });
  const close = vi.spyOn(exampleClient, 'close').mockResolvedValue(); vi.spyOn(exampleClient, 'cancelOpen').mockResolvedValue();
  vi.spyOn(exampleClient, 'tiles').mockReturnValue({ register: vi.fn(async () => 'preview'), request: vi.fn(), retire: vi.fn(async () => {}), cancel: vi.fn(async () => {}) });
  const ui = render(<AppShell {...ready(s.active)} />); await settle();
  fireEvent.click(screen.getByRole('tab', { name: '示例' })); await settle();
  const before = ui.container.querySelector('[data-view]')!.getAttribute('data-view');
  fireEvent.click(screen.getByRole('button', { name: 'Preview sample' })); await settle(); expectTab('示例');
  expect(screen.getByRole('dialog', { name: '示例频谱：Preview sample' })).toBeInTheDocument();
  expect(screen.getByRole('combobox', { name: '示例通道' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '关闭示例' })); await settle(); expectTab('示例');
  expect(screen.queryByRole('dialog', { name: '示例频谱：Preview sample' })).toBeNull(); expect(close).toHaveBeenCalledOnce();
  expect(ui.container.querySelector('[data-view]')).toHaveAttribute('data-view', before!);
});
it.each(['geometry', 'deleted', 'moved media', 'invalid geometry', 'channel removed', 'retired', 'reveal failed', 'pane rejected'] as const)('resolves current processing targets after reveal: %s', async mutation => {
  const pending = pauseReveal(mutation === 'pane rejected'), s = processingSetup(), ui = render(<AppShell {...ready(s.active)} />);
  locateProcessing(); const original = s.doc.edits[0];
  if (mutation === 'geometry') accept(s.active, { edits: [{ ...original, region: { ...original.region, startSeconds: .5, endSeconds: .7 } }] });
  if (mutation === 'deleted') accept(s.active, { edits: [] });
  if (mutation === 'moved media') accept(s.active, { edits: [{ ...original, region: { ...original.region, mediaId: s.a.id } }] });
  if (mutation === 'invalid geometry') accept(s.active, { edits: [{ ...original, region: { ...original.region, endSeconds: Infinity } }] });
  if (mutation === 'channel removed') accept(s.active, { media: [s.a, { ...s.b, channelCount: 1, channelNotes: [''], channelCategoryIds: [[]] }] });
  if (mutation === 'retired') act(() => s.active.store.retire([s.b.id], s.active.store.snapshot));
  await settle(); const before = ui.container.querySelector('[data-view]')!.getAttribute('data-view');
  await release(pending[0], mutation !== 'reveal failed'); expectTab('处理');
  if (mutation === 'geometry') {
    const view = JSON.parse(ui.container.querySelector('[data-view]')!.getAttribute('data-view')!);
    expect(view.startSeconds).toBeCloseTo(.45); expect(view.endSeconds).toBeCloseTo(.75);
    expect(screen.getByRole('combobox', { name: '主面板音频' })).toHaveValue(s.b.id);
  } else {
    expect(ui.container.querySelector('[data-view]')).toHaveAttribute('data-view', before!);
    expect(screen.getByRole('combobox', { name: '主面板音频' })).toHaveValue(s.a.id);
  }
  expect(ui.container.querySelector('[data-selection]')).toHaveAttribute('data-selection', 'null');
  expect(ui.container.querySelector('[data-edit-id]')).toBeNull();
  fireEvent.click(ui.container.querySelector('.file-heading h2')!); await settle(); expectTab('文件/通道');
});
it.each(['tab', 'primary', 'gesture', 'same selection', 'reopen'] as const)('cancels delayed processing navigation after %s', async action => {
  const pending = pauseReveal(), s = processingSetup(), ui = render(<AppShell {...ready(s.active)} />);
  locateProcessing();
  if (action === 'tab') fireEvent.click(screen.getByRole('tab', { name: '类别' }));
  if (action === 'primary') fireEvent.change(screen.getByRole('combobox', { name: '主面板音频' }), { target: { value: s.a.id } });
  if (action === 'gesture') fireEvent.click(screen.getByRole('button', { name: '开始手势 A.wav 1' }));
  if (action === 'same selection') fireEvent.click(ui.container.querySelector('.file-heading h2')!);
  if (action === 'reopen') { ui.rerender(<AppShell {...props(null)} />); ui.rerender(<AppShell {...ready(setup().active)} />); }
  await settle(); const before = ui.container.querySelector('[data-view]')!.getAttribute('data-view');
  const selectedTab = screen.getAllByRole('tab').find(tab => tab.getAttribute('aria-selected') === 'true')!;
  await release(pending[0]); expect(selectedTab).toHaveAttribute('aria-selected', 'true');
  expect(ui.container.querySelector('[data-view]')).toHaveAttribute('data-view', before!);
  expect(screen.getByRole('combobox', { name: '主面板音频' })).toHaveValue(s.a.id);
  fireEvent.click(screen.getByRole('button', { name: '结束手势 A.wav 1' }));
  fireEvent.click(screen.getByRole('button', { name: '选择频谱 A.wav 1' })); await settle(); expectTab('区域');
});
it.each(['older first', 'newer first', 'newer failed'] as const)('only applies the newest mask/gain navigation: %s', async order => {
  const pending = pauseReveal(), s = processingSetup(); s.doc.edits[1].region = { ...s.doc.edits[1].region, mediaId: s.a.id, startSeconds: .5, endSeconds: .7 };
  const ui = render(<AppShell {...ready(s.active)} />);
  locateProcessing('mask'); locateProcessing('gain');
  if (order === 'older first') await release(pending[0]);
  await release(pending[1], order !== 'newer failed');
  const before = ui.container.querySelector('[data-view]')!.getAttribute('data-view');
  if (order !== 'older first') await release(pending[0]);
  expectTab('处理'); expect(screen.getByRole('combobox', { name: '主面板音频' })).toHaveValue(s.a.id);
  expect(ui.container.querySelector('[data-view]')).toHaveAttribute('data-view', before!);
  if (order !== 'newer failed') expect(JSON.parse(before!).startSeconds).toBeCloseTo(.45);
  expect(ui.container.querySelector('[data-selection]')).toHaveAttribute('data-selection', 'null');
  fireEvent.click(ui.container.querySelector('.file-heading h2')!); await settle(); expectTab('文件/通道');
});
it('keeps processing selected through sequential mask/gain navigation across media and clears an old hidden selection', async () => {
  const s = processingSetup(); s.doc.edits[1].region.mediaId = s.a.id;
  const ui = render(<AppShell {...ready(s.active)} />);
  fireEvent.click(screen.getByRole('button', { name: '选择频谱 A.wav 1' })); await settle(); expectTab('区域');
  for (const kind of ['mask', 'gain', 'mask'] as const) {
    locateProcessing(kind); await settle(); expectTab('处理');
    expect(screen.getByRole('combobox', { name: '主面板音频' })).toHaveValue(kind === 'mask' ? s.b.id : s.a.id);
    expect(ui.container.querySelector('[data-selection]')).toHaveAttribute('data-selection', 'null');
    expect(ui.container.querySelector('[data-edit-id]')).toBeNull();
  }
  fireEvent.click(screen.getByRole('menuitem', { name: '标注' })); fireEvent.click(screen.getByRole('menuitem', { name: '类别管理' })); await settle(); expectTab('类别');
});
it('reports a processing reveal rejection once and permits retry and normal navigation', async () => {
  const pending = pauseReveal(), s = processingSetup(), report = vi.spyOn(s.active.store, 'setError'), ui = render(<AppShell {...ready(s.active)} />);
  locateProcessing(); await act(async () => pending[0].reject({ code: 'InvalidInput', message: 'processing reveal rejected', retryable: false }));
  expect(report).toHaveBeenCalledOnce(); expect(s.active.store.error?.message).toContain('processing reveal rejected'); expectTab('处理');
  fireEvent.click(ui.container.querySelector('.file-heading h2')!); await settle(); expectTab('文件/通道');
  locateProcessing(); await release(pending[1]); expectTab('处理');
  expect(screen.getByRole('combobox', { name: '主面板音频' })).toHaveValue(s.b.id);
});
it.each([['mask', false], ['gain', false], ['mask', true], ['gain', true]] as const)('keeps processing %s navigation in its tab with comparison=%s and reveals hidden channels', async (kind, compare) => {
  const s = processingSetup(); if (compare) s.doc.viewState.compareMediaId = s.b.id;
  const ui = render(<AppShell {...ready(s.active)} />);
  for (let repeat = 0; repeat < 2; repeat++) {
    locateProcessing(kind); await settle(); expectTab('处理');
    expect(screen.getByRole('combobox', { name: '主面板音频' })).toHaveValue(compare ? s.a.id : s.b.id);
    if (compare) expect(screen.getByRole('combobox', { name: '对比面板音频' })).toHaveValue(s.b.id);
    const canvas = ui.container.querySelector(`[data-testid="canvas-${s.b.id}-1"]`)!;
    const view = JSON.parse(canvas.getAttribute('data-view')!);
    expect(view.startSeconds).toBeCloseTo(.35); expect(view.endSeconds).toBeCloseTo(.65);
    expect(view.lowHz).toBe(375); expect(view.highHz).toBe(1125);
    expect(canvas).toHaveAttribute('data-selection', 'null'); expect(ui.container.querySelector('[data-edit-id]')).toBeNull();
  }
  await act(async () => s.active.lifecycle.submitDrafts());
  expect(s.applyChange.mock.calls.length).toBeGreaterThan(0);
  expect(s.applyChange.mock.calls.every(call => call[2].type === 'updateViewState')).toBe(true);
  fireEvent.click(ui.container.querySelector('.file-heading h2')!); await settle(); expectTab('文件/通道');
});

it.each(['file', 'channel', 'region'] as const)('keeps list and locates %s with and without filters, including repeated clicks', async scope => {
  const { active } = setup(), doc = active.store.snapshot.document, media = doc.media[0];
  doc.viewState.media[media.id] = { ...defaultView(media), visibleChannels: [0] };
  const ui = render(<AppShell {...ready(active)} />);
  for (const filtered of [false, true]) {
    list();
    const category = filtered ? doc.categories[0].id : '*', channel = filtered && scope !== 'file' ? '1' : '*', query = filtered ? 'bird' : '';
    filters(category, channel, query);
    for (let i = 0; i < 2; i++) {
      fireEvent.click(row(`bird ${scope === 'channel' ? 'right' : scope}`)); jump(); await settle();
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
    list(); fireEvent.click(row(scope === 'file' ? 'bird file' : 'bird right')); jump(); await settle(); expectTab('列表');
    const title = ui.container.querySelector(scope === 'file' ? '.file-heading h2' : '.channel-caption strong')!;
    const target = scope === 'channel' ? ui.container.querySelectorAll('.channel-caption strong')[1] : title;
    fireEvent[event](target); await settle(); expectTab('文件/通道');
  }
});

// Pause only the asynchronous reveal boundary; all workspace/selection hooks remain real.
function pauseReveal(rejectPane = false) {
  const original = workspaceModule.useWorkspace, pending: { id: string; resolve: (value: boolean) => void; reject: (error: unknown) => void }[] = [];
  vi.spyOn(workspaceModule, 'useWorkspace').mockImplementation((...args) => {
    const workspace = original(...args);
    return { ...workspace, selectPane: rejectPane ? () => false : workspace.selectPane, revealMedia: async id => {
      const allowed = await new Promise<boolean>((resolve, reject) => pending.push({ id, resolve, reject }));
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
    fireEvent.click(row(note)); jump(); await settle(); expectTab('列表');
    expect(screen.getByRole('combobox', { name: '主面板音频' })).toHaveValue(a.id);
    expect(screen.getByRole('combobox', { name: '对比面板音频' })).toHaveValue(b.id);
  }
  expect(ui.container.querySelector('[data-edit-id]')).toBeNull();
  expect(applyChange.mock.calls.slice(before).every(call => call[2].type === 'updateViewState')).toBe(true);
  fireEvent.click(screen.getByRole('menuitem', { name: '标注' }));
  fireEvent.click(screen.getByRole('menuitem', { name: '类别管理' })); await settle(); expectTab('类别');
  list(); fireEvent.click(row('other region')); jump(); await settle();
  fireEvent.click(screen.getByRole('button', { name: '选择处理对象 A.wav 1' })); await settle(); expectTab('处理');
  fireEvent.click(screen.getByRole('button', { name: '定位屏蔽 1' })); await settle(); expectTab('处理');
});

it.each(['file', 'channel', 'region'] as const)('opens a cross-file %s result in primary without a comparison', async scope => {
  const { active } = setup(), b = active.store.snapshot.document.media[1];
  active.store.snapshot.document.annotations.push({ ...active.store.snapshot.document.annotations[0], id: '00000000-0000-4000-8000-000000000045', region: { ...active.store.snapshot.document.annotations[0].region, mediaId: b.id, channelIndex: 0 }, note: 'other region' });
  render(<AppShell {...ready(active)} />); list();
  fireEvent.click(row(`other ${scope}`)); jump(); await settle(); expectTab('列表');
  expect(screen.getByRole('combobox', { name: '主面板音频' })).toHaveValue(b.id);
});

it.each(['tab', 'menu', 'newer', 'close', 'project', 'identity'] as const)('invalidates delayed location on %s', async action => {
  const pending = pauseReveal(), a = setup(fixture.projectId, 'author-a'), b = setup('00000000-0000-4000-8000-000000000033', 'author-b');
  const ui = render(<AppShell {...ready(a.active)} />); list(); filters('*', '*', '');
  fireEvent.click(row('other file')); jump(); expect(pending).toHaveLength(1);
  if (action === 'tab') fireEvent.click(screen.getByRole('tab', { name: '类别' }));
  if (action === 'menu') { fireEvent.click(screen.getByRole('menuitem', { name: '标注' })); fireEvent.click(screen.getByRole('menuitem', { name: '类别管理' })); }
  if (action === 'newer') { fireEvent.click(row('bird right')); jump(); await release(pending[1]); expectTab('列表'); }
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
  list(); fireEvent.click(row(scope === 'file' ? 'bird file' : 'bird right')); jump(); await release(pending[0]); expectTab('列表');
  fireEvent.click(row(scope === 'file' ? 'bird file' : 'bird right')); jump();
  expect(pending).toHaveLength(2);
  const title = ui.container.querySelector(scope === 'file' ? '.file-heading h2' : '.channel-pane[aria-label="通道 2"] strong')!;
  fireEvent[event](title); await settle(); expectTab('文件/通道');
  await release(pending[1]); expectTab('文件/通道');
});

it('applies only the latest request when two delayed reveals settle in reverse order', async () => {
  const pending = pauseReveal(), { active } = setup();
  render(<AppShell {...ready(active)} />); list();
  fireEvent.click(row('other file')); jump(); fireEvent.click(row('bird right')); jump();
  await release(pending[1]); expectTab('列表');
  await release(pending[0]); expectTab('列表');
  expect(screen.getByRole('combobox', { name: '主面板音频' })).toHaveValue(active.store.snapshot.document.media[0].id);
  fireEvent.click(screen.getByRole('tab', { name: '文件/通道' })); expect(screen.getByLabelText('通道 2 备注')).toHaveValue('bird right');
});

it('re-resolves a delayed region from current authority and rejects deleted or invalid targets', async () => {
  const pending = pauseReveal(), { active } = setup(), doc = active.store.snapshot.document;
  const ui = render(<AppShell {...ready(active)} />); list(); fireEvent.click(row('bird region')); jump();
  const annotation = { ...doc.annotations[0], region: { ...doc.annotations[0].region, startSeconds: .5, endSeconds: 1 } };
  accept(active, { annotations: [annotation] }); await release(pending[0]); expectTab('列表');
  expect(JSON.parse(ui.container.querySelector('[data-selection]')!.getAttribute('data-selection')!).region).toEqual(annotation.region);
  fireEvent.click(ui.container.querySelector('.file-heading h2')!); list();
  fireEvent.click(row('bird region')); jump(); accept(active, { annotations: [] }); await release(pending[1]); expectTab('列表');
  fireEvent.click(row('bird right')); jump(); accept(active, { media: doc.media.map(m => ({ ...m, channelCount: 1, channelCategoryIds: [[]], channelNotes: m.channelNotes.slice(0, 1) })) });
  await release(pending[2]); expectTab('列表');
});

it('failed reveal leaves no suppression for the next real title or spectrum action', async () => {
  const pending = pauseReveal(), { active } = setup(), ui = render(<AppShell {...ready(active)} />); list();
  fireEvent.click(row('other file')); jump(); await release(pending[0], false); expectTab('列表');
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
  fireEvent.click(row('other file')); jump(); expect(hideMedia).toHaveBeenCalledWith(b.id, false);
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
  fireEvent.click(row('other file')); jump(); expect(hideMedia).toHaveBeenCalledWith(media.id, false);
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
  fireEvent.click(row('other file')); jump(); expect(pending).toHaveLength(1);
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
  list(); filters('*', '*', 'third'); fireEvent.click(row('third file')); jump(); expect(pending).toHaveLength(1);
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
  list(); fireEvent.click(row(note)); jump();
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
  list(); fireEvent.click(row('bird region')); jump();
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
  const pending = pauseReveal(), viewport = realViewport(); list(); fireEvent.click(row('bird region')); jump();
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
  list(); fireEvent.click(row('bird region')); jump();
  const context = viewport.canvas().getAttribute('data-context');
  const overlay = screen.getByLabelText('通道 1 标注图层');
  vi.spyOn(overlay, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 800, 300));
  const mapping = coordinates(viewport.view(), viewport.media.sampleRate / 2, 800, 300);
  fireEvent.contextMenu(overlay, { clientX: mapping.secondsToX(.4), clientY: mapping.hzToY(1250) });
  expect(screen.getByRole('dialog', { name: '音频查看（只读）' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '跳转到音频' }));
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
