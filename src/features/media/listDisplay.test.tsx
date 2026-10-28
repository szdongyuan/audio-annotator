import { StrictMode, useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import fixture from '../../../tests/fixtures/document-v3.json';
import { MediaList } from './MediaList';
import { OrganizationController } from './organization';
import { RecycleController } from './recycle';
import { readListDisplay, writeListDisplay } from './listDisplay';

const a = '33333333-3333-4333-8333-333333333333', child = '44444444-4444-4444-8444-444444444444', b = '55555555-5555-4555-8555-555555555555';
const actor = '66666666-6666-4666-8666-666666666666', other = '77777777-7777-4777-8777-777777777777';
const files = [0, 1, 2, 3, 4].map(i => ({ ...fixture.media[0], id: `00000000-0000-4000-8000-00000000000${i}`, displayName: `audio-${i}.wav`, categoryIds: i === 0 ? ['tag'] : [], channelCategoryIds: [[]] }));
function controller(projectId = fixture.projectId, nonce = 'test') {
  const c = new OrganizationController(projectId, nonce, true, { get: vi.fn(), apply: vi.fn() });
  c.snapshot = { kind: 'audio-annotator-organization', formatVersion: 1, projectId, revision: 0, layoutRevision: 0,
    folders: [{ id: a, parentId: null, name: 'A' }, { id: child, parentId: a, name: 'Child' }, { id: b, parentId: null, name: 'B' }],
    media: files.map((m, i) => ({ mediaId: m.id, folderId: i === 0 ? a : i === 1 ? child : b, originalFilename: `original-${i}.wav` })) };
  return c;
}
const props = { media: files, annotations: [], statuses: [], selectedId: null, disabled: false, onSelect: vi.fn(), onImport: vi.fn(), onRelink: vi.fn() };
const mode = (value: string) => fireEvent.change(screen.getByLabelText('音频显示方式'), { target: { value } });
const scope = (value: string) => fireEvent.change(screen.getByLabelText('平铺显示范围'), { target: { value } });
const rows = () => [...document.querySelectorAll('.media-select')].map(row => row.getAttribute('data-media-id'));
afterEach(() => { localStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('flattens selected directory descendants and all audio without changing organization, sources or import selection', () => {
  const c = controller(), before = JSON.stringify({ organization: c.snapshot, media: files });
  render(<MediaList {...props} organization={c} actorId={actor} />);
  fireEvent.click(screen.getByTitle('A'));
  mode('flat');
  expect(rows()).toEqual([files[1].id, files[0].id]);
  expect(document.querySelector('.media-folder')).toBeNull();
  scope('');
  expect(rows()).toEqual([files[1].id, files[0].id, ...files.slice(2).map(m => m.id)]);
  expect(c.selectedFolderId).toBe(a);
  expect(JSON.stringify({ organization: c.snapshot, media: files })).toBe(before);
  mode('tree');
  expect(screen.getByTitle('B')).toHaveTextContent('3');
  expect(screen.getByRole('button', { name: '折叠文件夹 · A' })).toBeVisible();
  expect(screen.getByRole('button', { name: '展开文件夹 · Child' })).toBeVisible();
});

it('retains tree expansion and local mode/scope through remount and same-owner runtime replacement', () => {
  const c = controller(), ui = render(<MediaList {...props} organization={c} actorId={actor} />);
  fireEvent.click(screen.getByLabelText('展开文件夹 · B'));
  fireEvent.click(screen.getByTitle('A'));
  mode('flat'); scope(b);
  ui.rerender(<MediaList {...props} organization={controller(fixture.projectId, 'adopted')} actorId={actor} />);
  expect(screen.getByLabelText('音频显示方式')).toHaveValue('flat');
  expect(screen.getByLabelText('平铺显示范围')).toHaveValue(b);
  ui.unmount();
  render(<MediaList {...props} organization={controller()} actorId={actor} />);
  expect(screen.getByLabelText('平铺显示范围')).toHaveValue(b);
  mode('tree');
  expect(screen.getByLabelText('折叠文件夹 · A')).toBeVisible();
  expect(screen.getByLabelText('折叠文件夹 · B')).toBeVisible();
  expect(screen.getByLabelText('展开文件夹 · Child')).toBeVisible();
});

it('isolates project, actor and null actor without stale preference writes during owner switches', () => {
  writeListDisplay(fixture.projectId, actor, { mode: 'flat', scope: a, expanded: [a] });
  writeListDisplay(fixture.projectId, other, { mode: 'tree', scope: b, expanded: [b] });
  const ui = render(<StrictMode><MediaList {...props} organization={controller()} actorId={actor} /></StrictMode>);
  ui.rerender(<StrictMode><MediaList {...props} organization={controller()} actorId={other} /></StrictMode>);
  expect(screen.getByLabelText('音频显示方式')).toHaveValue('tree');
  expect(readListDisplay(fixture.projectId, other)).toEqual({ mode: 'tree', scope: b, expanded: [b] });
  ui.rerender(<MediaList {...props} organization={controller()} actorId={null} />);
  expect(screen.getByLabelText('音频显示方式')).toHaveValue('tree'); mode('flat');
  ui.rerender(<MediaList {...props} organization={controller(other)} actorId={actor} />);
  expect(screen.getByLabelText('音频显示方式')).toHaveValue('tree');
  expect(readListDisplay(fixture.projectId, actor)).toEqual({ mode: 'flat', scope: a, expanded: [a] });
  expect(readListDisplay(fixture.projectId, null)?.mode).toBe('flat');
});

it('falls back to all when a saved directory disappears', () => {
  writeListDisplay(fixture.projectId, actor, { mode: 'flat', scope: a, expanded: [a] });
  const c = controller(); c.snapshot = { ...c.snapshot!, folders: c.snapshot!.folders.filter(f => f.id === b), media: c.snapshot!.media.map(m => ({ ...m, folderId: m.folderId === b ? b : null })) };
  render(<MediaList {...props} organization={c} actorId={actor} />);
  expect(screen.getByLabelText('平铺显示范围')).toHaveValue('');
  expect(rows()).toHaveLength(files.length);
  expect(readListDisplay(fixture.projectId, actor)?.scope).toBeNull();
});

it('retains saved scope and expansion while organization metadata is loading', async () => {
  const preference = { mode: 'flat' as const, scope: a, expanded: [a, child] };
  writeListDisplay(fixture.projectId, actor, preference);
  const ready = controller().snapshot!;
  const get = vi.fn(async () => ({ projectId: fixture.projectId, runtimeNonce: 'test', organization: ready }));
  const loading = new OrganizationController(fixture.projectId, 'test', true, { get, apply: vi.fn() });
  render(<MediaList {...props} organization={loading} actorId={actor} />);
  expect(readListDisplay(fixture.projectId, actor)).toEqual(preference);
  await act(() => loading.refresh());
  expect(screen.getByLabelText('平铺显示范围')).toHaveValue(a);
  expect(rows()).toEqual([files[1].id, files[0].id]);
  expect(readListDisplay(fixture.projectId, actor)).toEqual(preference);
});

it('returns focus to search if a flat context-menu target disappears', () => {
  const c = controller(), ui = render(<MediaList {...props} organization={c} actorId={actor} />);
  mode('flat'); fireEvent.contextMenu(screen.getByRole('button', { name: files[0].displayName }));
  ui.rerender(<MediaList {...props} media={files.slice(1)} organization={c} actorId={actor} />);
  expect(screen.queryByRole('menu')).toBeNull();
  expect(screen.getByLabelText('搜索音频')).toHaveFocus();
});

it('preserves search, classification, tags, hidden/recycle views, context copy and multiselect in flat mode', async () => {
  const c = controller(), recycle = new RecycleController(fixture.projectId, 'test', true, {} as never);
  recycle.snapshot = { kind: 'audio-annotator-recycle', formatVersion: 1, projectId: fixture.projectId, revision: 0, trashed: [{ mediaId: files[4].id, deletedBy: actor }], recentOperations: [] };
  const writeText = vi.fn().mockResolvedValue(undefined); Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  render(<MediaList {...props} organization={c} actorId={actor} recycle={recycle} hiddenMediaIds={[files[3].id]} categories={[{ id: 'tag', name: 'Tag', color: '#ffffff' }]} />);
  mode('flat'); expect(rows()).toHaveLength(3);
  fireEvent.click(screen.getByLabelText('多选音频')); fireEvent.click(screen.getByLabelText('全选筛选结果'));
  expect(screen.getByText('已选 3')).toBeVisible();
  fireEvent.change(screen.getByLabelText('搜索音频'), { target: { value: 'Child' } }); expect(rows()).toEqual([files[1].id]);
  expect(screen.getByText('已选 0')).toBeVisible();
  fireEvent.change(screen.getByLabelText('搜索音频'), { target: { value: '' } });
  fireEvent.click(screen.getByLabelText('筛选音频'));
  fireEvent.change(screen.getByLabelText('标注状态筛选'), { target: { value: 'annotated' } }); expect(rows()).toEqual([files[0].id]);
  fireEvent.change(screen.getByLabelText('标签筛选'), { target: { value: 'tag' } }); expect(rows()).toEqual([files[0].id]);
  fireEvent.contextMenu(screen.getByRole('button', { name: files[0].displayName })); fireEvent.click(screen.getByRole('menuitem', { name: '复制文件名' }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith('original-0.wav'));
  fireEvent.change(screen.getByLabelText('标注状态筛选'), { target: { value: 'all' } });
  fireEvent.change(screen.getByLabelText('标签筛选'), { target: { value: '' } });
  fireEvent.change(screen.getByLabelText('音频列表视图'), { target: { value: 'hidden' } }); expect(rows()).toEqual([files[3].id]);
  fireEvent.change(screen.getByLabelText('音频列表视图'), { target: { value: 'trash' } }); expect(rows()).toEqual([files[4].id]);
});

it('reveals and focuses global next/previous outside flat scope without changing import destination or tree expansion', async () => {
  const c = controller(), before = JSON.stringify(c.snapshot), scroll = vi.fn();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, writable: true, value: scroll });
  function App() { const [selectedId, onSelect] = useState(files[0].id); return <MediaList {...props} organization={c} actorId={actor} selectedId={selectedId} onSelect={onSelect} />; }
  render(<App />); fireEvent.click(screen.getByTitle('A')); mode('flat');
  fireEvent.click(screen.getByLabelText('多选音频')); fireEvent.click(screen.getByLabelText(`选择音频 · ${files[0].displayName}`));
  fireEvent.keyDown(screen.getByRole('button', { name: files[0].displayName }), { key: 'ArrowDown' });
  const target = screen.getByRole('button', { name: files[2].displayName });
  expect(screen.getByLabelText('平铺显示范围')).toHaveValue('');
  expect(c.selectedFolderId).toBe(a); expect(JSON.stringify(c.snapshot)).toBe(before);
  await waitFor(() => expect(target).toHaveFocus()); expect(scroll).toHaveBeenCalledWith({ block: 'nearest' });
  scope(b); fireEvent.keyDown(target, { key: 'ArrowUp' });
  await waitFor(() => expect(screen.getByRole('button', { name: files[0].displayName })).toHaveFocus());
  expect(c.selectedFolderId).toBe(a); mode('tree');
  expect(screen.getByLabelText('展开文件夹 · B')).toBeVisible();
});
