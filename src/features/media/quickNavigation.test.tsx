import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useState } from 'react';
import fixture from '../../../tests/fixtures/document-v3.json';
import { MediaList } from './MediaList';
import { OrganizationController } from './organization';
import { RecycleController } from './recycle';
import { AppShell } from '../../app/AppShell';

afterEach(() => { localStorage.clear(); vi.unstubAllGlobals(); });
it('crosses a selected one-file leaf in tree order and reveals, focuses and scrolls the sibling audio', async () => {
 const files=[0,1].map(i=>({...fixture.media[0],id:crypto.randomUUID(),displayName:`cross-${i}.wav`}));
 const a=crypto.randomUUID(),b=crypto.randomUUID(),leaf=crypto.randomUUID();
 const c=new OrganizationController(fixture.projectId,'test',true,{} as never);
 c.snapshot={kind:'audio-annotator-organization',formatVersion:1,projectId:fixture.projectId,revision:0,layoutRevision:0,folders:[{id:a,parentId:null,name:'A'},{id:b,parentId:null,name:'B'},{id:leaf,parentId:b,name:'nested'}],media:files.map((m,i)=>({mediaId:m.id,folderId:i===0?a:leaf,originalFilename:m.displayName}))};
 const scroll=vi.fn();vi.stubGlobal('requestAnimationFrame',(callback:FrameRequestCallback)=>setTimeout(()=>callback(0),0));
 function App(){const [id,setId]=useState<string>(files[0].id);return <MediaList organization={c} media={files} annotations={[]} statuses={[]} selectedId={id} disabled={false} onSelect={setId} onImport={vi.fn()} onRelink={vi.fn()}/>;}
 render(<App/>);
 fireEvent.click(screen.getByTitle('A'));fireEvent.click(screen.getByLabelText('多选音频'));fireEvent.click(screen.getByLabelText('全选筛选结果'));
 expect(screen.getByText('已选 1')).toBeVisible();expect(screen.queryByRole('button',{name:files[1].displayName})).toBeNull();
 const first=screen.getByRole('button',{name:files[0].displayName});first.focus();fireEvent.keyDown(first,{key:'ArrowDown'});
 const second=screen.getByRole('button',{name:files[1].displayName});second.scrollIntoView=scroll;
 expect(second).toHaveAttribute('aria-pressed','true');expect(c.selectedFolderId).toBeNull();
 expect(screen.getByRole('button',{name:'折叠文件夹 · B'})).toHaveAttribute('aria-expanded','true');expect(screen.getByRole('button',{name:'折叠文件夹 · nested'})).toHaveAttribute('aria-expanded','true');
 await waitFor(()=>expect(second).toHaveFocus());expect(scroll).toHaveBeenCalledWith({block:'nearest'});
 expect(screen.getByText('已选 0')).toBeVisible(); // Existing scope changes clear batch selection.
 fireEvent.click(screen.getByLabelText(`选择音频 · ${files[1].displayName}`));fireEvent.keyDown(second,{key:'ArrowUp'});
 await waitFor(()=>expect(first).toHaveFocus());expect(first).toHaveAttribute('aria-pressed','true');expect(screen.getByText('已选 1')).toBeVisible();
});
it('keeps project-wide navigation filtered by search, classification, tags, hidden, trash and comparison', () => {
 const files=Array.from({length:8},(_,i)=>({...fixture.media[0],id:crypto.randomUUID(),displayName:i===6?'other.wav':`match-${i}.wav`,categoryIds:i===5?[]:['tag'],channelCategoryIds:[[]]}));
 const a=crypto.randomUUID(),b=crypto.randomUUID(),c=new OrganizationController(fixture.projectId,'test',true,{} as never),recycle=new RecycleController(fixture.projectId,'test',true,{} as never);
 c.snapshot={kind:'audio-annotator-organization',formatVersion:1,projectId:fixture.projectId,revision:0,layoutRevision:0,folders:[{id:a,parentId:null,name:'A'},{id:b,parentId:null,name:'B'}],media:files.map((m,i)=>({mediaId:m.id,folderId:i===0?a:b,originalFilename:m.displayName}))};
 recycle.snapshot={kind:'audio-annotator-recycle',formatVersion:1,projectId:fixture.projectId,revision:0,trashed:[{mediaId:files[3].id,deletedBy:'author'}],recentOperations:[]};
 const select=vi.fn();render(<MediaList organization={c} recycle={recycle} media={files} annotations={[]} statuses={[]} categories={[{id:'tag',name:'标签',color:'#ffffff'}]} hiddenMediaIds={[files[2].id]} navigationExcludedId={files[1].id} selectedId={files[0].id} disabled={false} onSelect={select} onImport={vi.fn()} onRelink={vi.fn()}/>);
 fireEvent.click(screen.getByTitle('A'));fireEvent.click(screen.getByLabelText('筛选音频'));
 fireEvent.change(screen.getByLabelText('搜索音频'),{target:{value:'match'}});fireEvent.change(screen.getByLabelText('标注状态筛选'),{target:{value:'annotated'}});fireEvent.change(screen.getByLabelText('标签筛选'),{target:{value:'tag'}});
 fireEvent.keyDown(document.body,{key:'ArrowDown'});expect(select).toHaveBeenLastCalledWith(files[4].id);
 fireEvent.change(screen.getByLabelText('标注状态筛选'),{target:{value:'unannotated'}});fireEvent.change(screen.getByLabelText('标签筛选'),{target:{value:''}});
 fireEvent.keyDown(document.body,{key:'ArrowDown'});expect(select).toHaveBeenLastCalledWith(files[5].id);
 fireEvent.change(screen.getByLabelText('标注状态筛选'),{target:{value:'annotated'}});fireEvent.change(screen.getByLabelText('标签筛选'),{target:{value:'tag'}});
 fireEvent.change(screen.getByLabelText('搜索音频'),{target:{value:'match-7'}});fireEvent.keyDown(document.body,{key:'ArrowUp'});expect(select).toHaveBeenLastCalledWith(files[7].id);
});
it('keeps other folder totals stable when changing the selected folder',()=>{
 const files=[0,1,2].map(i=>({...fixture.media[0],id:crypto.randomUUID(),displayName:`count-${i}.wav`})),a=crypto.randomUUID(),b=crypto.randomUUID();
 const c=new OrganizationController(fixture.projectId,'test',true,{} as never);
 c.snapshot={kind:'audio-annotator-organization',formatVersion:1,projectId:fixture.projectId,revision:0,layoutRevision:0,folders:[{id:a,parentId:null,name:'A'},{id:b,parentId:null,name:'B'}],media:files.map((m,i)=>({mediaId:m.id,folderId:i===2?b:a,originalFilename:m.displayName}))};
 render(<MediaList organization={c} media={files} annotations={[]} statuses={[]} selectedId={null} disabled={false} onSelect={vi.fn()} onImport={vi.fn()} onRelink={vi.fn()}/>);
 fireEvent.click(screen.getByTitle('A'));expect(screen.getByTitle('A')).toHaveTextContent('2');expect(screen.getByTitle('B')).toHaveTextContent('1');expect(screen.getByRole('button',{name:/全部音频/})).toHaveTextContent('3');
});
it('uses refreshed folder placement and the current project after controller replacement', async () => {
 const files=[0,1,2].map(i=>({...fixture.media[0],id:crypto.randomUUID(),displayName:`fresh-${i}.wav`})),a=crypto.randomUUID(),b=crypto.randomUUID();
 const head={kind:'audio-annotator-organization' as const,formatVersion:1 as const,projectId:fixture.projectId,revision:0,layoutRevision:0,folders:[{id:a,parentId:null,name:'A'},{id:b,parentId:null,name:'B'}],media:files.slice(0,2).map(m=>({mediaId:m.id,folderId:a,originalFilename:m.displayName}))};
 const next={...head,revision:1,media:head.media.map((m,i)=>({...m,folderId:i===0?a:b}))};
 const c=new OrganizationController(fixture.projectId,'old',true,{get:vi.fn(async()=>({runtimeNonce:'old',projectId:fixture.projectId,organization:next})),apply:vi.fn()});c.snapshot=head;
 const select=vi.fn(),props={annotations:[],statuses:[],disabled:false,onSelect:select,onImport:vi.fn(),onRelink:vi.fn()};
 const ui=render(<MediaList {...props} organization={c} media={files.slice(0,2)} selectedId={files[0].id}/>);
 fireEvent.click(screen.getByTitle('A'));await act(()=>c.refresh());fireEvent.keyDown(document.body,{key:'ArrowDown'});
 expect(select).toHaveBeenLastCalledWith(files[1].id);expect(screen.getByRole('button',{name:files[1].displayName})).toBeVisible();expect(c.selectedFolderId).toBe(a);
 const replacement=new OrganizationController('new-project','new',true,{} as never);replacement.snapshot={...head,projectId:'new-project',media:[{mediaId:files[2].id,folderId:b,originalFilename:files[2].displayName}]};
 ui.rerender(<MediaList {...props} organization={replacement} media={[files[2]]} selectedId={files[0].id}/>);
 fireEvent.click(screen.getByTitle('A'));fireEvent.keyDown(document.body,{key:'ArrowUp'});expect(select).toHaveBeenLastCalledWith(files[2].id);expect(replacement.selectedFolderId).toBe(a);
});
it('does not navigate from editing controls or dialogs, open menus, non-normal views or a disabled workspace', () => {
 const files=[0,1].map(i=>({...fixture.media[0],id:crypto.randomUUID(),displayName:`guard-${i}.wav`})),select=vi.fn();
 const props={media:files,annotations:[],statuses:[],selectedId:files[0].id,disabled:false,onSelect:select,onImport:vi.fn(),onRelink:vi.fn()};
 const ui=render(<><MediaList {...props}/><div role="dialog" tabIndex={-1}/><textarea aria-label="edit"/></>);
 for(const target of [screen.getByLabelText('搜索音频'),screen.getByLabelText('edit'),screen.getByRole('dialog')])fireEvent.keyDown(target,{key:'ArrowDown'});
 fireEvent.contextMenu(screen.getByRole('button',{name:files[0].displayName}));fireEvent.keyDown(document.body,{key:'ArrowDown'});fireEvent.keyDown(screen.getByRole('menu'),{key:'Escape'});
 for(const value of ['hidden','trash']){fireEvent.change(screen.getByLabelText('音频列表视图'),{target:{value}});fireEvent.keyDown(document.body,{key:'ArrowDown'});}
 fireEvent.change(screen.getByLabelText('音频列表视图'),{target:{value:'normal'}});ui.rerender(<MediaList {...props} disabled/>);fireEvent.keyDown(document.body,{key:'ArrowDown'});expect(select).not.toHaveBeenCalled();
});
it('moves DOM focus to the file selected by ArrowDown',async()=>{
 const files=[0,1].map(i=>({...fixture.media[0],id:crypto.randomUUID(),displayName:`focus-${i}.wav`}));
 function Container(){const [selectedId,setSelectedId]=useState<string>(files[0].id);return <MediaList media={files} annotations={[]} statuses={[]} selectedId={selectedId} disabled={false} onSelect={setSelectedId} onImport={vi.fn()} onRelink={vi.fn()}/>;}
 render(<Container/>);
 const first=screen.getByRole('button',{name:'focus-0.wav'});first.focus();fireEvent.keyDown(first,{key:'ArrowDown'});
 expect(screen.getByRole('button',{name:'focus-1.wav'})).toHaveAttribute('aria-pressed','true');
 await waitFor(()=>expect(screen.getByRole('button',{name:'focus-1.wav'})).toHaveFocus());
});
it.each(['ArrowUp','ArrowDown'])('starts %s at the corresponding edge and stops without wrapping',key=>{
 const files=[0,1].map(i=>({...fixture.media[0],id:crypto.randomUUID(),displayName:`edge-${i}.wav`})),select=vi.fn();
 function Container(){const [selectedId,setSelectedId]=useState<string|null>(null);return <MediaList media={files} annotations={[]} statuses={[]} selectedId={selectedId} disabled={false} onSelect={id=>{select(id);setSelectedId(id);}} onImport={vi.fn()} onRelink={vi.fn()}/>;}
 render(<Container/>);
 fireEvent.keyDown(document.body,{key});expect(select).toHaveBeenLastCalledWith(files[key==='ArrowUp'?1:0].id);
 fireEvent.keyDown(document.body,{key});expect(select).toHaveBeenCalledTimes(2);
 fireEvent.keyDown(document.body,{key});expect(select).toHaveBeenCalledTimes(2);
 expect(screen.getByRole('button',{name:files[key==='ArrowUp'?0:1].displayName})).toHaveAttribute('aria-pressed','true');
});
it('allows preview navigation from a clicked row during import and multiselect without changing checks',()=>{
 const files=[0,1].map(i=>({...fixture.media[0],id:crypto.randomUUID(),displayName:`nav-${i}.wav`})),select=vi.fn();
 render(<MediaList media={files} annotations={[]} statuses={[]} selectedId={files[0].id} disabled navigationDisabled={false} onSelect={select} onImport={vi.fn()} onRelink={vi.fn()}/>);
 fireEvent.click(screen.getByLabelText('多选音频'));
 const row=screen.getByRole('button',{name:'nav-0.wav'});row.focus();fireEvent.keyDown(row,{key:'ArrowDown'});
 expect(select).toHaveBeenLastCalledWith(files[1].id);expect(screen.getByText('已选 0')).toBeVisible();
});
it('navigates collapsed directory contents, skipping hidden and other-pane audio without hijacking inputs', () => {
  const files = Array.from({ length: 4 }, (_, i) => ({ ...fixture.media[0], id: crypto.randomUUID(), displayName: `音频${i}.wav` }));
  const folder = crypto.randomUUID(), controller = new OrganizationController(fixture.projectId, 'test', true, {} as never);
  controller.snapshot = { kind: 'audio-annotator-organization', formatVersion: 1, projectId: fixture.projectId, revision: 0, layoutRevision: 0, folders: [{ id: folder, parentId: null, name: '收音' }], media: files.map(m => ({ mediaId: m.id, folderId: folder, originalFilename: m.displayName })) };
  const select = vi.fn();
  function App() { const [id, setId] = useState<string>(files[0].id); return <MediaList organization={controller} media={files} annotations={[]} statuses={[]} selectedId={id} disabled={false} hiddenMediaIds={[files[2].id]} navigationExcludedId={files[1].id} onSelect={next => { select(next); setId(next); }} onImport={vi.fn()} onRelink={vi.fn()} />; }
  render(<App />); expect(screen.queryByRole('button', { name: '音频3.wav' })).toBeNull();
  fireEvent.keyDown(document.body, { key: 'ArrowDown' }); expect(select).toHaveBeenLastCalledWith(files[3].id); expect(screen.getByRole('button', { name: '音频3.wav' })).toHaveAttribute('aria-pressed', 'true');
  fireEvent.keyDown(screen.getByLabelText('搜索音频'), { key: 'ArrowUp' }); expect(select).toHaveBeenCalledTimes(1);
  fireEvent.keyDown(document.body, { key: 'ArrowUp', ctrlKey: true }); expect(select).toHaveBeenCalledTimes(1);
  fireEvent.keyDown(document.body, { key: 'ArrowUp' }); expect(select).toHaveBeenLastCalledWith(files[0].id);
});
it.each([false, true])('copies the original basename without changing selection; clipboard rejection=%s', async rejected => {
  const file = { ...fixture.media[0], displayName: '记录/audio/CH2.wav' }, select = vi.fn(), writeText = rejected ? vi.fn().mockRejectedValue(new Error('denied')) : vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  render(<MediaList media={[file]} annotations={[]} statuses={[]} selectedId={file.id} disabled={false} onSelect={select} onImport={vi.fn()} onRelink={vi.fn()} />);
  fireEvent.contextMenu(screen.getByRole('button', { name: file.displayName }), { clientX: 20, clientY: 20 }); fireEvent.click(screen.getByRole('menuitem', { name: '复制文件名' }));
  await waitFor(() => expect(writeText).toHaveBeenCalledExactlyOnceWith('CH2.wav')); expect(select).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.getByRole(rejected ? 'alert' : 'status')).toHaveTextContent(rejected ? '复制失败' : '已复制'));
});
it('persists explicit sidebar width, restores it after collapse, and resets on double-click', () => {
  const view=render(<AppShell />); let panel = screen.getByRole('complementary', { name: '音频列表' });
  vi.spyOn(panel, 'getBoundingClientRect').mockReturnValue({ width: 232 } as DOMRect);
  fireEvent.keyDown(screen.getByRole('separator', { name: '调整音频列表宽度' }), { key: 'ArrowRight' }); expect(panel).toHaveStyle({ width: '242px' });
  fireEvent.click(screen.getByRole('button', { name: '收起音频列表' })); fireEvent.click(screen.getByRole('button', { name: '展开音频列表' })); expect(panel).toHaveStyle({ width: '242px' });
  expect(localStorage.getItem('audio-annotator.media-panel-width')).toBe('242'); view.unmount(); render(<AppShell/>); panel=screen.getByRole('complementary',{name:'音频列表'}); expect(panel).toHaveStyle({width:'242px'}); fireEvent.doubleClick(screen.getByRole('separator')); expect(panel.style.width).toBe(''); expect(localStorage.getItem('audio-annotator.media-panel-width')).toBeNull();
});
it('cancels a sidebar drag without writing the preview to local storage', () => {
  vi.stubGlobal('PointerEvent', MouseEvent); render(<AppShell />);
  const panel = screen.getByRole('complementary', { name: '音频列表' }), separator = screen.getByRole('separator');
  vi.spyOn(panel, 'getBoundingClientRect').mockReturnValue({ width: 232 } as DOMRect);
  fireEvent.pointerDown(separator, { button: 0, clientX: 232 }); fireEvent.pointerMove(separator, { clientX: 310 }); expect(panel).toHaveStyle({ width: '310px' });
  act(() => { fireEvent.keyDown(window, { key: 'Escape' }); }); expect(panel.style.width).toBe(''); expect(localStorage.getItem('audio-annotator.media-panel-width')).toBeNull();
});
