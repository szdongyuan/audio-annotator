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
function controller(projectId = fixture.projectId, nonce = '11111111-1111-4111-8111-111111111111') {
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
const sort = (label: string) => {
  fireEvent.click(screen.getByLabelText('列表排序'));
  fireEvent.click(screen.getByRole('menuitem', { name: label }));
};
afterEach(() => { localStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('sorts root and nested folders by natural name order and keeps arrow navigation in that order', () => {
  const c = controller(), sibling = crypto.randomUUID(), select = vi.fn();
  const head = c.snapshot!;
  head.folders = [
    { id: b, parentId: null, name: 'B' },
    { id: child, parentId: a, name: '片段10' },
    { id: a, parentId: null, name: 'A' },
    { id: sibling, parentId: a, name: '片段2' },
  ];
  head.media = head.media.slice(0, 3);
  head.media[0].folderId = sibling;
  head.media[2].folderId = sibling;
  const audio = files.slice(0, 3).map((item, i) => ({ ...item, displayName: ['片段2/CH10.wav', '片段10/CH3.wav', '片段2/CH2.wav'][i] }));
  const before = JSON.stringify(head);
  const view = <MediaList {...props} media={audio} organization={c} actorId={actor} selectedId={files[1].id} onSelect={select} />;
  const ui = render(view);
  fireEvent.click(screen.getByLabelText('展开文件夹 · A'));
  const folderPaths = () => [...document.querySelectorAll('.media-folder .media-folder-select')].map(button => button.getAttribute('title'));
  expect(folderPaths()).toEqual(['A', 'A/片段2', 'A/片段10', 'B']);

  fireEvent.click(screen.getByLabelText('展开文件夹 · 片段2'));
  fireEvent.click(screen.getByLabelText('展开文件夹 · 片段10'));
  expect(rows()).toEqual([files[2].id, files[0].id, files[1].id]);
  sort('按路径降序');
  expect(folderPaths()).toEqual(['B', 'A', 'A/片段10', 'A/片段2']);
  expect(rows()).toEqual([files[1].id, files[0].id, files[2].id]);
  fireEvent.keyDown(document.body, { key: 'ArrowDown' });
  expect(select).toHaveBeenLastCalledWith(files[0].id);
  expect(JSON.stringify(c.snapshot)).toBe(before);

  ui.unmount();
  render(view);
  expect(folderPaths()).toEqual(['B', 'A', 'A/片段10', 'A/片段2']);
  expect(screen.getByLabelText('列表排序')).toHaveAttribute('title', '列表排序 · 按路径降序');
  mode('flat');
  expect(rows()).toEqual([files[1].id, files[0].id, files[2].id]);
  fireEvent.click(screen.getByLabelText('多选音频'));
  fireEvent.click(screen.getByLabelText(`选择音频 · ${audio[0].displayName}`));
  fireEvent.click(screen.getByLabelText(`选择音频 · ${audio[1].displayName}`), { shiftKey: true });
  expect(screen.getByText('已选 2')).toBeVisible();
});

it('sorts a flat list by filenames across folders and uses that order for arrows and range selection', () => {
  const c = controller(), select = vi.fn();
  const audio = files.map((m, i) => ({
    ...m, displayName: ['source-a/CH10.wav', 'source-a/CH2.wav', 'source-b/CH1.wav', 'source-b/CH2.wav', 'source-b/CH20.wav'][i],
  }));
  const originalOrganization = JSON.stringify(c.snapshot);
  const view = <MediaList {...props} media={audio} organization={c} actorId={actor} selectedId={files[2].id} onSelect={select} />;
  const ui = render(view);
  mode('flat');
  expect(rows()).toEqual(files.map(m => m.id));

  sort('按文件名升序');
  expect(rows()).toEqual([2, 1, 3, 0, 4].map(i => files[i].id));
  fireEvent.keyDown(document.body, { key: 'ArrowDown' });
  expect(select).toHaveBeenLastCalledWith(files[1].id);
  fireEvent.click(screen.getByLabelText('多选音频'));
  fireEvent.click(screen.getByLabelText(`选择音频 · ${audio[2].displayName}`));
  fireEvent.click(screen.getByLabelText(`选择音频 · ${audio[3].displayName}`), { shiftKey: true });
  expect(screen.getByText('已选 3')).toBeVisible();
  fireEvent.change(screen.getByLabelText('搜索音频'), { target: { value: 'CH2' } });
  expect(rows()).toEqual([1, 3, 4].map(i => files[i].id));
  fireEvent.change(screen.getByLabelText('搜索音频'), { target: { value: '' } });

  sort('按文件名降序');
  expect(rows()).toEqual([4, 0, 3, 1, 2].map(i => files[i].id));
  ui.unmount();
  render(view);
  expect(screen.getByLabelText('列表排序')).toHaveAttribute('title', '列表排序 · 按文件名降序');
  expect(rows()).toEqual([4, 0, 3, 1, 2].map(i => files[i].id));
  sort('按路径升序');
  expect(rows()).toEqual(files.map(m => m.id));
  expect(JSON.stringify(c.snapshot)).toBe(originalOrganization);
});

it('flattens selected directory descendants and all audio without changing organization, sources or import selection', () => {
  const c = controller(), before = JSON.stringify({ organization: c.snapshot, media: files });
  render(<MediaList {...props} organization={c} actorId={actor} />);
  fireEvent.click(screen.getByTitle('A'));
  mode('flat');
  expect(rows()).toEqual(files.slice(0, 2).map(m => m.id));
  expect(document.querySelector('.media-folder')).toBeNull();
  scope('');
  expect(rows()).toEqual(files.map(m => m.id));
  expect(c.selectedFolderId).toBe(a);
  expect(JSON.stringify({ organization: c.snapshot, media: files })).toBe(before);
  mode('tree');
  expect(screen.getByTitle('B')).toHaveTextContent('3');
  expect(screen.getByRole('button', { name: '折叠文件夹 · A' })).toBeVisible();
  expect(screen.getByRole('button', { name: '展开文件夹 · Child' })).toBeVisible();
});

it('flattens only the right-clicked folder within the tree and restores its child folders', () => {
  const c = controller(), deep = '88888888-8888-4888-8888-888888888888', inner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', onSelect = vi.fn();
  c.snapshot!.folders.push({ id: deep, parentId: child, name: 'Deep' });
  c.snapshot!.folders.push({ id: inner, parentId: deep, name: 'Audio' });
  c.snapshot!.media[2].folderId = inner;
  c.selectedFolderId = b;
  const before = JSON.stringify({ organization: c.snapshot, media: files });
  render(<MediaList {...props} organization={c} actorId={actor} selectedId={files[4].id} onSelect={onSelect} />);

  fireEvent.click(screen.getByLabelText('展开文件夹 · A'));
  fireEvent.click(screen.getByLabelText('展开文件夹 · Child'));
  fireEvent.click(screen.getByLabelText('展开文件夹 · Deep'));
  fireEvent.click(screen.getByLabelText('展开文件夹 · Audio'));
  fireEvent.click(screen.getByLabelText('展开文件夹 · B'));
  fireEvent.contextMenu(screen.getByLabelText('折叠文件夹 · Child'));
  fireEvent.click(screen.getByRole('menuitem', { name: '平铺此文件夹（含子文件夹）' }));

  expect(screen.getByLabelText('音频显示方式')).toHaveValue('tree');
  expect(screen.queryByLabelText('平铺显示范围')).toBeNull();
  expect(screen.getByTitle('A/Child')).toHaveFocus();
  expect(screen.getByTitle('A')).toBeVisible();expect(screen.getByTitle('B')).toBeVisible();
  expect(screen.queryByTitle('A/Child/Deep')).toBeNull();
  expect(rows()).toEqual([files[1].id, files[2].id, files[0].id, files[3].id, files[4].id]);
  expect(screen.getByRole('button',{name:files[1].displayName})).toHaveAttribute('aria-description','目录内路径：original-1.wav');
  const descendant=screen.getByRole('button',{name:files[2].displayName});
  expect(descendant).toHaveAttribute('aria-description','目录内路径：Deep/Audio/original-2.wav');
  expect(descendant.querySelector('.media-record-name')).toHaveTextContent('Deep/Audio');
  expect(descendant.querySelector('.media-file-name')).toHaveTextContent('original-2.wav');
  expect(screen.getByTitle('A/Child')).toHaveTextContent('平铺');
  expect(c.selectedFolderId).toBe(b);
  expect(onSelect).not.toHaveBeenCalled();
  expect(JSON.stringify({ organization: c.snapshot, media: files })).toBe(before);
  expect(readListDisplay(fixture.projectId, actor)).toMatchObject({ mode: 'tree', flattenedFolders: [child] });
  fireEvent.contextMenu(screen.getByTitle('A/Child'));
  fireEvent.click(screen.getByRole('menuitem', { name: '恢复子文件夹显示' }));
  expect(screen.getByTitle('A/Child/Deep')).toBeVisible();
  expect(screen.getByLabelText('折叠文件夹 · Deep')).toHaveAttribute('aria-expanded','true');
  expect(screen.getByLabelText('折叠文件夹 · Audio')).toHaveAttribute('aria-expanded','true');
  expect(rows()).toEqual([files[2].id, files[1].id, files[0].id, files[3].id, files[4].id]);
  expect(screen.getByRole('button',{name:files[2].displayName})).not.toHaveAttribute('aria-description');
  expect(screen.getByTitle('A/Child')).not.toHaveTextContent('平铺');
  expect(JSON.stringify({ organization: c.snapshot, media: files })).toBe(before);
});

it('distinguishes identical audio filenames with their project-relative folder paths', () => {
  const c=controller();c.snapshot!.media[0].originalFilename='same.wav';c.snapshot!.media[1].originalFilename='same.wav';
  render(<MediaList {...props} organization={c} actorId={actor}/>);
  fireEvent.click(screen.getByLabelText('文件夹操作 · A'));
  fireEvent.click(screen.getByRole('menuitem',{name:'平铺此文件夹（含子文件夹）'}));
  expect(screen.getByRole('button',{name:files[0].displayName})).toHaveAttribute('aria-description','目录内路径：same.wav');
  expect(screen.getByRole('button',{name:files[1].displayName})).toHaveAttribute('aria-description','目录内路径：Child/same.wav');
  fireEvent.change(screen.getByLabelText('搜索音频'),{target:{value:'Child/same.wav'}});
  expect(rows()).toEqual([files[1].id]);expect(screen.getByTitle('A')).toBeVisible();
});

it('sorts a locally flattened branch by displayed filenames across descendants', () => {
  const c = controller();
  c.snapshot!.media[0].originalFilename = 'CH10.wav';
  c.snapshot!.media[1].originalFilename = 'CH2.wav';
  c.snapshot!.media[2].folderId = child;
  c.snapshot!.media[2].originalFilename = 'CH1.wav';
  render(<MediaList {...props} organization={c} actorId={actor} />);
  fireEvent.click(screen.getByLabelText('文件夹操作 · A'));
  fireEvent.click(screen.getByRole('menuitem', { name: '平铺此文件夹（含子文件夹）' }));
  expect(rows()).toEqual([0, 2, 1].map(i => files[i].id));
  sort('按文件名升序');
  expect(rows()).toEqual([2, 1, 0].map(i => files[i].id));
  sort('按文件名降序');
  expect(rows()).toEqual([0, 1, 2].map(i => files[i].id));
  expect(screen.getByTitle('B')).toBeVisible();
  expect(screen.getByLabelText('音频显示方式')).toHaveValue('tree');
  sort('按路径降序');
  expect(rows()).toEqual([1, 2, 0].map(i => files[i].id));
});

it('offers folder flattening in readonly projects and flattens all audio from the root menu', () => {
  const c = controller(), before = JSON.stringify(c.snapshot);
  const readonly = new OrganizationController(c.projectId, c.runtimeNonce, false, { get: vi.fn(), apply: vi.fn() });
  readonly.snapshot = c.snapshot;
  render(<MediaList {...props} organization={readonly} actorId={actor} disabled />);

  fireEvent.click(screen.getByLabelText('文件夹操作 · A'));
  const flatten = screen.getByRole('menuitem', { name: '平铺此文件夹（含子文件夹）' });
  expect(flatten).toHaveAttribute('aria-disabled', 'false');
  fireEvent.click(flatten);
  expect(rows()).toEqual(files.slice(0, 2).map(m => m.id));
  expect(screen.getByTitle('A')).toBeVisible();expect(screen.getByTitle('B')).toBeVisible();
  expect(screen.getByLabelText('音频显示方式')).toHaveValue('tree');
  fireEvent.contextMenu(screen.getByLabelText('根目录操作'));
  fireEvent.click(screen.getByRole('menuitem', { name: '平铺全部音频' }));
  expect(screen.getByLabelText('平铺显示范围')).toHaveValue('');
  expect(rows()).toEqual(files.map(m => m.id));
  expect(JSON.stringify(readonly.snapshot)).toBe(before);
});

it('keeps per-folder flattening local to the project and identity and restores it after reopening', () => {
  const c=controller(), before=JSON.stringify(c.snapshot);
  const view=render(<MediaList {...props} organization={c} actorId={actor}/>);
  fireEvent.click(screen.getByLabelText('文件夹操作 · A'));
  fireEvent.click(screen.getByRole('menuitem',{name:'平铺此文件夹（含子文件夹）'}));
  fireEvent.click(screen.getByLabelText('文件夹操作 · B'));
  fireEvent.click(screen.getByRole('menuitem',{name:'平铺此文件夹（含子文件夹）'}));
  expect(readListDisplay(fixture.projectId,actor)?.flattenedFolders).toEqual([a,b]);
  expect(rows()).toEqual(files.map(m=>m.id));
  view.unmount();
  const restored=render(<MediaList {...props} organization={controller()} actorId={actor}/>);
  expect(screen.getByTitle('A')).toHaveTextContent('平铺');expect(screen.getByTitle('B')).toHaveTextContent('平铺');
  expect(rows()).toEqual(files.map(m=>m.id));
  restored.rerender(<MediaList {...props} organization={controller()} actorId={other}/>);
  expect(screen.getByTitle('A')).not.toHaveTextContent('平铺');expect(screen.getByTitle('B')).not.toHaveTextContent('平铺');
  expect(JSON.stringify(c.snapshot)).toBe(before);
});

it('keeps search, multiselection and arrow navigation in the visible flattened order', async () => {
  const c=controller(), select=vi.fn(), before=JSON.stringify(c.snapshot);
  const view=render(<MediaList {...props} organization={c} actorId={actor} selectedId={files[0].id} onSelect={select}/>);
  fireEvent.click(screen.getByLabelText('文件夹操作 · A'));
  fireEvent.click(screen.getByRole('menuitem',{name:'平铺此文件夹（含子文件夹）'}));
  fireEvent.click(screen.getByLabelText('展开文件夹 · B'));
  expect(rows()).toEqual(files.map(m=>m.id));
  fireEvent.keyDown(document.body,{key:'ArrowDown'});expect(select).toHaveBeenLastCalledWith(files[1].id);
  fireEvent.click(screen.getByLabelText('多选音频'));
  fireEvent.click(screen.getByLabelText(`选择音频 · ${files[0].displayName}`));
  fireEvent.click(screen.getByLabelText(`选择音频 · ${files[1].displayName}`),{shiftKey:true});
  expect(screen.getByText('已选 2')).toBeVisible();
  fireEvent.change(screen.getByLabelText('搜索音频'),{target:{value:'audio-1'}});
  expect(rows()).toEqual([files[1].id]);expect(screen.getByTitle('A')).toBeVisible();
  expect(screen.queryByTitle('A/Child')).toBeNull();
  expect(JSON.stringify(c.snapshot)).toBe(before);view.unmount();
});

it('keeps hidden subfolder expansion unchanged when arrow navigation visits a flattened audio', () => {
  const c=controller(),select=vi.fn();
  render(<MediaList {...props} organization={c} actorId={actor} selectedId={files[0].id} onSelect={select}/>);
  fireEvent.click(screen.getByLabelText('文件夹操作 · A'));
  fireEvent.click(screen.getByRole('menuitem',{name:'平铺此文件夹（含子文件夹）'}));
  fireEvent.keyDown(document.body,{key:'ArrowDown'});expect(select).toHaveBeenLastCalledWith(files[1].id);
  fireEvent.contextMenu(screen.getByTitle('A'));
  fireEvent.click(screen.getByRole('menuitem',{name:'恢复子文件夹显示'}));
  expect(screen.getByLabelText('展开文件夹 · Child')).toHaveAttribute('aria-expanded','false');
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
  const get = vi.fn(async () => ({ projectId: fixture.projectId, runtimeNonce: '11111111-1111-4111-8111-111111111111', organization: ready }));
  const loading = new OrganizationController(fixture.projectId, '11111111-1111-4111-8111-111111111111', true, { get, apply: vi.fn() });
  render(<MediaList {...props} organization={loading} actorId={actor} />);
  expect(readListDisplay(fixture.projectId, actor)).toEqual(preference);
  await act(() => loading.refresh());
  expect(screen.getByLabelText('平铺显示范围')).toHaveValue(a);
  expect(rows()).toEqual(files.slice(0, 2).map(m => m.id));
  expect(readListDisplay(fixture.projectId, actor)).toEqual(preference);
});

it('keeps local folder flattening during load and removes only folders confirmed deleted', async () => {
  const missing='99999999-9999-4999-8999-999999999999';
  const preference={mode:'tree' as const,scope:null,expanded:[a],flattenedFolders:[a,missing]};
  writeListDisplay(fixture.projectId,actor,preference);
  const ready=controller().snapshot!;
  const get=vi.fn(async()=>({projectId:fixture.projectId,runtimeNonce:'11111111-1111-4111-8111-111111111111',organization:ready}));
  const loading=new OrganizationController(fixture.projectId,'11111111-1111-4111-8111-111111111111',true,{get,apply:vi.fn()});
  render(<MediaList {...props} organization={loading} actorId={actor}/>);
  expect(readListDisplay(fixture.projectId,actor)?.flattenedFolders).toEqual([a,missing]);
  await act(()=>loading.refresh());
  expect(readListDisplay(fixture.projectId,actor)?.flattenedFolders).toEqual([a]);
  expect(screen.getByTitle('A')).toHaveTextContent('平铺');
});

it('returns focus to search if a flat context-menu target disappears', () => {
  const c = controller(), ui = render(<MediaList {...props} organization={c} actorId={actor} />);
  mode('flat'); fireEvent.contextMenu(screen.getByRole('button', { name: files[0].displayName }));
  ui.rerender(<MediaList {...props} media={files.slice(1)} organization={c} actorId={actor} />);
  expect(screen.queryByRole('menu')).toBeNull();
  expect(screen.getByLabelText('搜索音频')).toHaveFocus();
});

it('preserves search, classification, tags, hidden/recycle views, context copy and multiselect in flat mode', async () => {
  const c = controller(), recycle = new RecycleController(fixture.projectId, '11111111-1111-4111-8111-111111111111', true, {} as never);
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

it('follows flat sort within the current scope and focuses the next row', async () => {
  const c = controller(), before = JSON.stringify(c.snapshot), scroll = vi.fn();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, writable: true, value: scroll });
  function App() { const [selectedId, onSelect] = useState(files[0].id); return <MediaList {...props} organization={c} actorId={actor} selectedId={selectedId} onSelect={onSelect} />; }
  render(<App />); fireEvent.click(screen.getByTitle('A')); mode('flat');
  fireEvent.click(screen.getByLabelText('多选音频')); fireEvent.click(screen.getByLabelText(`选择音频 · ${files[0].displayName}`));
  fireEvent.keyDown(screen.getByRole('button', { name: files[0].displayName }), { key: 'ArrowDown' });
  await waitFor(() => expect(screen.getByRole('button', { name: files[1].displayName })).toHaveFocus());
  fireEvent.keyDown(screen.getByRole('button', { name: files[1].displayName }), { key: 'ArrowDown' });
  expect(screen.getByLabelText('平铺显示范围')).toHaveValue(a);
  expect(screen.queryByRole('button', { name: files[2].displayName })).toBeNull();
  scope('');
  fireEvent.keyDown(screen.getByRole('button', { name: files[1].displayName }), { key: 'ArrowDown' });
  const target = screen.getByRole('button', { name: files[2].displayName });
  expect(screen.getByLabelText('平铺显示范围')).toHaveValue('');
  expect(c.selectedFolderId).toBe(a); expect(JSON.stringify(c.snapshot)).toBe(before);
  await waitFor(() => expect(target).toHaveFocus()); expect(scroll).toHaveBeenCalledWith({ block: 'nearest' });
  fireEvent.keyDown(target, { key: 'ArrowUp' });
  await waitFor(() => expect(screen.getByRole('button', { name: files[1].displayName })).toHaveFocus());
  expect(c.selectedFolderId).toBe(a); mode('tree');
  expect(screen.getByLabelText('展开文件夹 · B')).toBeVisible();
});
