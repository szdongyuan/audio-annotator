import { expect, it, vi } from 'vitest';
import { StrictMode } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MediaList } from './MediaList';
import fixture from '../../../tests/fixtures/document-v3.json';
import { OrganizationController } from './organization';
import { RecycleController } from './recycle';
const id = '33333333-3333-4333-8333-333333333333', child = '44444444-4444-4444-8444-444444444444';
it.each(['empty', 'parent', 'root'] as const)('confirms recursive %s removal, cancels safely, and recovers focus after removing the trigger', async mode => {
 const parent=crypto.randomUUID(),file=fixture.media[0];
 const head={kind:'audio-annotator-organization' as const,formatVersion:1 as const,projectId:fixture.projectId,revision:3,layoutRevision:1,folders:[...(mode==='parent'?[{id:parent,parentId:null,name:'保留父目录'}]:[]),{id,parentId:mode==='parent'?parent:null,name:'待删除目录'},{id:child,parentId:id,name:'深层目录'}],media:mode==='empty'?[]:[{mediaId:file.id,folderId:child,originalFilename:'原名.wav'}]};
 const next={...head,revision:4,layoutRevision:2,folders:head.folders.filter(f=>f.id===parent),media:head.media.map(m=>({...m,folderId:mode==='parent'?parent:null}))};
 const api={get:vi.fn(),apply:vi.fn(async()=>({runtimeNonce:'test',projectId:fixture.projectId,organization:next}))};
 const c=new OrganizationController(fixture.projectId,'test',true,api);c.snapshot=head;c.selectedFolderId=child;
 const recycle=new RecycleController(fixture.projectId,'test',true,{} as never);
 recycle.snapshot={kind:'audio-annotator-recycle',formatVersion:1,projectId:fixture.projectId,revision:1,trashed:[{mediaId:file.id,deletedBy:'author'}],recentOperations:[]};
 render(<div className="app-root"><MediaList organization={c} recycle={recycle} media={[]} annotations={[]} statuses={[]} selectedId={null} disabled={false} onSelect={vi.fn()} onImport={vi.fn()} onRelink={vi.fn()}/></div>);
 if(mode==='parent')fireEvent.click(screen.getByRole('button',{name:'展开文件夹 · 保留父目录'}));
 const trigger=screen.getByRole('button',{name:'文件夹操作 · 待删除目录'});
 for(const confirm of [false,true]) {
  fireEvent.click(trigger);const remove=screen.getByRole('menuitem',{name:'删除文件夹…'});expect(remove).toHaveAttribute('aria-disabled','false');fireEvent.click(remove);
  const dialog=screen.getByRole('dialog',{name:'删除文件夹'});expect(dialog).toHaveTextContent('2 个文件夹');expect(dialog).toHaveTextContent('不会删除音频文件');
  if(mode!=='empty'){expect(dialog).toHaveTextContent('1 个已在共享回收站的音频');expect(dialog).toHaveTextContent(mode==='parent'?'保留父目录':'全部音频');expect(dialog).toHaveTextContent('恢复后');}
  if(!confirm){fireEvent.click(screen.getByRole('button',{name:'取消'}));expect(api.apply).not.toHaveBeenCalled();expect(trigger).toHaveFocus();}
  else await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'确认'}));});
 }
 expect(api.apply).toHaveBeenCalledWith(fixture.projectId,3,{type:'removeFolder',id});expect(screen.queryByRole('dialog')).toBeNull();expect(c.selectedFolderId).toBeNull();expect(trigger.isConnected).toBe(false);expect(screen.getByRole('button',{name:'根目录操作'})).toHaveFocus();
});
it.each(['mixed','unknown','unavailable','wrong-owner','readonly'] as const)('fails closed for %s descendant membership state', mode => {
 const file=fixture.media[0],other=crypto.randomUUID(),c=new OrganizationController(fixture.projectId,'test',mode!=='readonly',{} as never);
 c.snapshot={kind:'audio-annotator-organization',formatVersion:1,projectId:fixture.projectId,revision:1,layoutRevision:1,folders:[{id,parentId:null,name:'阻止目录'},{id:child,parentId:id,name:'深层目录'}],media:[{mediaId:file.id,folderId:child,originalFilename:'a.wav'},...(mode==='mixed'?[{mediaId:other,folderId:child,originalFilename:'hidden.wav'}]:[])]};
 const recycle=new RecycleController(fixture.projectId,mode==='wrong-owner'?'old-owner':'test',true,{} as never);
 if(mode!=='unknown')recycle.snapshot={kind:'audio-annotator-recycle',formatVersion:1,projectId:fixture.projectId,revision:1,trashed:[{mediaId:file.id,deletedBy:'author'}],recentOperations:[]};
 if(mode==='unavailable')recycle.error={code:'SaveFailed',message:'offline',retryable:true};
 render(<MediaList organization={c} recycle={recycle} media={[]} hiddenMediaIds={[other]} annotations={[]} statuses={[]} selectedId={null} disabled={false} onSelect={vi.fn()} onImport={vi.fn()} onRelink={vi.fn()}/>);
 fireEvent.click(screen.getByRole('button',{name:'文件夹操作 · 阻止目录'}));const remove=screen.getByRole('menuitem',{name:/删除文件夹/});expect(remove).toHaveAttribute('aria-disabled','true');
 if(mode==='mixed'){expect(remove.title).toContain('1 个未进入共享回收站');expect(remove.title).toContain('隐藏');}
 if(['unknown','unavailable','wrong-owner'].includes(mode))expect(remove).toHaveTextContent('回收站状态不可用');
 fireEvent.click(remove);expect(screen.queryByRole('dialog')).toBeNull();
});
it('retains the removal dialog and draft after a restored-member rejection', async()=>{
 const file=fixture.media[0],api={get:vi.fn(),apply:vi.fn().mockRejectedValue({code:'InvalidInput',message:'音频已恢复，无法删除目录',retryable:false})};
 const c=new OrganizationController(fixture.projectId,'test',true,api);c.snapshot={kind:'audio-annotator-organization',formatVersion:1,projectId:fixture.projectId,revision:8,layoutRevision:3,folders:[{id,parentId:null,name:'待删除目录'},{id:child,parentId:id,name:'子目录'}],media:[{mediaId:file.id,folderId:child,originalFilename:'a.wav'}]};
 const recycle=new RecycleController(fixture.projectId,'test',true,{} as never);recycle.snapshot={kind:'audio-annotator-recycle',formatVersion:1,projectId:fixture.projectId,revision:1,trashed:[{mediaId:file.id,deletedBy:'author'}],recentOperations:[]};
 render(<MediaList organization={c} recycle={recycle} media={[]} annotations={[]} statuses={[]} selectedId={null} disabled={false} onSelect={vi.fn()} onImport={vi.fn()} onRelink={vi.fn()}/>);
 fireEvent.click(screen.getByRole('button',{name:'文件夹操作 · 待删除目录'}));fireEvent.click(screen.getByRole('menuitem',{name:'删除文件夹…'}));await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'确认'}));});
 expect(screen.getByRole('dialog')).toHaveTextContent('音频已恢复');expect(c.snapshot.folders).toHaveLength(2);expect(api.apply).toHaveBeenCalledWith(fixture.projectId,8,{type:'removeFolder',id});expect(screen.getByRole('button',{name:'确认'})).toBeEnabled();
});
it.each(['ctrl','shift','context','hidden','trash'])('keeps an explicitly chosen out-of-scope audio in batch selection via %s', entry => {
 const c=new OrganizationController(fixture.projectId,'test',true,{} as never),select=vi.fn();
 const files=[0,1,2,3].map(i=>({...fixture.media[0],id:crypto.randomUUID(),displayName:`batch-entry-${i}.wav`}));
 c.snapshot={kind:'audio-annotator-organization',formatVersion:1,projectId:fixture.projectId,revision:0,layoutRevision:0,folders:[{id,parentId:null,name:'A'},{id:child,parentId:null,name:'B'}],media:files.map((m,i)=>({mediaId:m.id,folderId:i===0?id:child,originalFilename:m.displayName}))};
 const recycle=new RecycleController(fixture.projectId,'test',true,{} as never);
 recycle.snapshot={kind:'audio-annotator-recycle',formatVersion:1,projectId:fixture.projectId,revision:0,trashed:entry==='trash'?files.map(m=>({mediaId:m.id,deletedBy:'author'})):[],recentOperations:[]};
 render(<StrictMode><MediaList organization={c} recycle={recycle} hiddenMediaIds={entry==='hidden'?files.map(m=>m.id):[]} media={files} annotations={[]} statuses={[]} selectedId={files[0].id} disabled={false} onSelect={select} onImport={vi.fn()} onRelink={vi.fn()}/></StrictMode>);
 if(entry==='hidden'||entry==='trash')fireEvent.change(screen.getByLabelText('音频列表视图'),{target:{value:entry}});
 fireEvent.click(screen.getByTitle('A'));fireEvent.click(screen.getByRole('button',{name:'展开文件夹 · B'}));const row=screen.getByRole('button',{name:files[1].displayName});
 if(entry==='context'){fireEvent.contextMenu(row);fireEvent.click(screen.getByRole('menuitem',{name:'选择多个音频'}));}else fireEvent.click(row,{ctrlKey:entry==='ctrl',shiftKey:entry==='shift'});
 expect(c.selectedFolderId).toBe(child);expect(screen.getByLabelText(`选择音频 · ${files[1].displayName}`)).toBeChecked();expect(screen.getByText('已选 1')).toBeVisible();expect(screen.queryByRole('button',{name:files[0].displayName})).toBeNull();expect(select).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button',{name:files[3].displayName}),{shiftKey:true});
 for(const file of files.slice(1))expect(screen.getByLabelText(`选择音频 · ${file.displayName}`)).toBeChecked();
 fireEvent.keyDown(screen.getByRole('button',{name:files[1].displayName}),{key:'a',ctrlKey:true});expect(screen.getByText('已选 3')).toBeVisible();
});
it('discloses audio in another nested folder without selecting its import target or audio', () => {
 const c=new OrganizationController(fixture.projectId,'test',true,{} as never),leaf=crypto.randomUUID(),select=vi.fn();
 const files=[0,1].map(i=>({...fixture.media[0],id:crypto.randomUUID(),displayName:`disclosure-${i}.wav`}));
 c.snapshot={kind:'audio-annotator-organization',formatVersion:1,projectId:fixture.projectId,revision:0,layoutRevision:0,folders:[{id,parentId:null,name:'当前目录'},{id:child,parentId:null,name:'record000045'},{id:leaf,parentId:child,name:'audio'}],media:files.map((m,i)=>({mediaId:m.id,folderId:i===0?id:leaf,originalFilename:m.displayName}))};
 render(<MediaList organization={c} media={files} annotations={[]} statuses={[]} selectedId={files[0].id} disabled={false} onSelect={select} onImport={vi.fn()} onRelink={vi.fn()}/>);
 fireEvent.click(screen.getByTitle('当前目录'));fireEvent.click(screen.getByRole('button',{name:'展开文件夹 · record000045'}));fireEvent.click(screen.getByRole('button',{name:'展开文件夹 · audio'}));
 expect(screen.getByTitle('record000045/audio')).toHaveTextContent('1');expect(screen.getByRole('button',{name:files[1].displayName})).toBeVisible();
 expect(c.selectedFolderId).toBe(id);expect(select).not.toHaveBeenCalled();expect(screen.getByRole('button',{name:files[0].displayName})).toHaveAttribute('aria-pressed','true');
 fireEvent.click(screen.getByRole('button',{name:'折叠文件夹 · audio'}));expect(screen.queryByRole('button',{name:files[1].displayName})).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'展开文件夹 · audio'}));expect(screen.getByRole('button',{name:files[1].displayName})).toBeVisible();
});
it.each(['batch','search','classification','tag'])('retains selected-folder scope for %s while ordinary disclosure shows sibling and root audio', mode => {
 const c=new OrganizationController(fixture.projectId,'test',true,{} as never);
 const files=[0,1,2].map(i=>({...fixture.media[0],id:crypto.randomUUID(),displayName:`scope-${i}.wav`,categoryIds:['tag'],channelCategoryIds:[[]]}));
 c.snapshot={kind:'audio-annotator-organization',formatVersion:1,projectId:fixture.projectId,revision:0,layoutRevision:0,folders:[{id,parentId:null,name:'A'},{id:child,parentId:null,name:'B'}],media:files.map((m,i)=>({mediaId:m.id,folderId:i===0?id:i===1?child:null,originalFilename:m.displayName}))};
 render(<MediaList organization={c} media={files} categories={[{id:'tag',name:'标签',color:'#ffffff'}]} annotations={[]} statuses={[]} selectedId={files[0].id} disabled={false} onSelect={vi.fn()} onImport={vi.fn()} onRelink={vi.fn()}/>);
 fireEvent.click(screen.getByTitle('A'));fireEvent.click(screen.getByRole('button',{name:'展开文件夹 · B'}));
 for(const file of files)expect(screen.getByRole('button',{name:file.displayName})).toBeVisible();
 if(mode==='batch')fireEvent.keyDown(screen.getByRole('button',{name:files[0].displayName}),{key:'a',ctrlKey:true});
 else if(mode==='search')fireEvent.change(screen.getByLabelText('搜索音频'),{target:{value:'scope'}});
 else {fireEvent.click(screen.getByLabelText('筛选音频'));fireEvent.change(screen.getByLabelText(mode==='tag'?'标签筛选':'标注状态筛选'),{target:{value:mode==='tag'?'tag':'annotated'}});}
 expect(screen.getByRole('button',{name:files[0].displayName})).toBeVisible();
 for(const file of files.slice(1))expect(screen.queryByRole('button',{name:file.displayName})).toBeNull();
 if(mode==='batch'){expect(screen.getByText('已选 1')).toBeVisible();fireEvent.click(screen.getByRole('button',{name:'完成'}));}
 else {if(mode==='search')fireEvent.click(screen.getByLabelText('筛选音频'));fireEvent.click(screen.getByLabelText('搜索整个项目'));}
 for(const file of files)expect(screen.getByRole('button',{name:file.displayName})).toBeVisible();
 expect(c.selectedFolderId).toBe(id);
});
it.each(['hidden', 'unloaded'] as const)('explains why a zero-visible folder with %s content cannot be deleted', kind => {
 const c=new OrganizationController(fixture.projectId,'test',true,{} as never),recycle=new RecycleController(fixture.projectId,'test',true,{} as never),file=fixture.media[0];
 c.snapshot={kind:'audio-annotator-organization',formatVersion:1,projectId:fixture.projectId,revision:0,layoutRevision:0,folders:[{id,parentId:null,name:'零可见目录'}],media:[{mediaId:file.id,folderId:id,originalFilename:'a.wav'}]};
 recycle.snapshot={kind:'audio-annotator-recycle',formatVersion:1,projectId:fixture.projectId,revision:0,trashed:[],recentOperations:[]};
 render(<MediaList organization={c} recycle={recycle} media={kind==='unloaded'?[]:[file]} hiddenMediaIds={kind==='hidden'?[file.id]:[]} annotations={[]} statuses={[]} selectedId={null} disabled={false} onSelect={vi.fn()} onImport={vi.fn()} onRelink={vi.fn()}/>);
 expect(screen.getByTitle('零可见目录')).toHaveTextContent('0');fireEvent.click(screen.getByRole('button',{name:'文件夹操作 · 零可见目录'}));
 const remove=screen.getByRole('menuitem',{name:'删除文件夹…（仍有关联音频）'});
 expect(remove).toHaveAttribute('aria-disabled','true');expect(remove.title).toContain('当前列表视图');
 fireEvent.click(remove);expect(screen.queryByRole('dialog')).toBeNull();
});
it('keeps FolderEdit conflict message, retry button and typed input through succeeding and failing polls',async()=>{
 const head={kind:'audio-annotator-organization' as const,formatVersion:1 as const,projectId:fixture.projectId,revision:0,layoutRevision:0,folders:[{id,parentId:null,name:'原目录'}],media:[]};
 const next={...head,revision:1,layoutRevision:1,folders:[{id,parentId:null,name:'远程目录'}]};
 const api={get:vi.fn(async()=>({runtimeNonce:'nonce',projectId:fixture.projectId,organization:next})),apply:vi.fn(async()=>({runtimeNonce:'nonce',projectId:fixture.projectId,organization:{...next,revision:2,layoutRevision:2,folders:[{id,parentId:null,name:'我的输入'}]}}))};
 const c=new OrganizationController(fixture.projectId,'nonce',true,api);c.snapshot=head;
 render(<MediaList organization={c} media={[]} annotations={[]} statuses={[]} selectedId={null} disabled={false} onSelect={vi.fn()} onImport={vi.fn()} onRelink={vi.fn()}/>);
 fireEvent.click(screen.getByRole('button',{name:'文件夹操作 · 原目录'}));fireEvent.click(screen.getByRole('menuitem',{name:'重命名文件夹…'}));fireEvent.change(screen.getByLabelText('文件夹名称'),{target:{value:'我的输入'}});
 api.apply.mockRejectedValueOnce({code:'RevisionConflict',message:'conflict',retryable:true});await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'确认'}));});
 for(const offline of [false,true]){if(offline)api.get.mockRejectedValueOnce({code:'SaveFailed',message:'poll offline',retryable:true});await act(()=>c.refresh());expect(screen.getByRole('alert')).toHaveTextContent('保留输入');expect(screen.getByRole('button',{name:'核对并重试'})).toBeEnabled();expect(screen.getByLabelText('文件夹名称')).toHaveValue('我的输入');expect(api.apply).toHaveBeenCalledTimes(1);}
 await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'核对并重试'}));});expect(screen.queryByRole('dialog')).toBeNull();expect(api.apply).toHaveBeenLastCalledWith(fixture.projectId,1,{type:'renameFolder',id,name:'我的输入'});
});
it('reveals matching folder ancestors and retains selected media while changing folder placement', async () => { const c = new OrganizationController(fixture.projectId, 'nonce', true, { get: vi.fn(), apply: vi.fn() }); c.snapshot = { kind: 'audio-annotator-organization', formatVersion: 1, projectId: fixture.projectId, revision: 1, layoutRevision: 1, folders: [{ id, parentId: null, name: '来源' }, { id: child, parentId: id, name: '故障记录' }], media: [{ mediaId: fixture.media[0].id, folderId: child, originalFilename: 'a.wav' }] }; const select = vi.fn(); render(<MediaList organization={c} media={fixture.media} annotations={[]} statuses={[]} selectedId={fixture.media[0].id} disabled={false} onSelect={select} onImport={vi.fn()} onRelink={vi.fn()}/>); expect(screen.getByRole('button', { name: /全部音频/ })).toBeVisible(); fireEvent.change(screen.getByLabelText('搜索音频'), { target: { value: '故障记录' } }); expect(screen.getByRole('button', { name: fixture.media[0].displayName })).toHaveAttribute('aria-pressed', 'true'); expect(screen.getByTitle('来源')).toBeVisible(); expect(select).not.toHaveBeenCalled(); });
it('hands stable menu focus to modal before inert and restores it on Escape and outside dismissal', () => { const c = new OrganizationController(fixture.projectId, 'nonce', true, { get: vi.fn(), apply: vi.fn() }); c.snapshot = { kind: 'audio-annotator-organization', formatVersion: 1, projectId: fixture.projectId, revision: 0, layoutRevision: 0, folders: [], media: [] }; const focus = HTMLElement.prototype.focus; const guarded = vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (this: HTMLElement, options?: FocusOptions) { if (!this.closest<HTMLElement>('.app-root')?.inert)
    focus.call(this, options); }); try {
    render(<div className="app-root"><MediaList organization={c} media={[]} annotations={[]} statuses={[]} selectedId={null} disabled={false} onSelect={vi.fn()} onImport={vi.fn()} onRelink={vi.fn()}/></div>);
    const trigger = screen.getByRole('button', { name: '根目录操作' });
    for (const dismiss of ['Escape', 'outside']) {
        fireEvent.click(trigger);
        fireEvent.click(screen.getByRole('menuitem', { name: '新建子文件夹…' }));
        expect(screen.getByRole('dialog', { name: '新建文件夹' })).toHaveFocus();
        expect(document.querySelector<HTMLElement>('.app-root')?.inert).toBe(true);
        if (dismiss === 'Escape')
            fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
        else
            fireEvent.pointerDown(document.querySelector('.dialog-backdrop')!);
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(trigger).toHaveFocus();
    }
}
finally {
    guarded.mockRestore();
} });
it('blocks removal for hidden native memberships and readonly actions while allowing folder browsing', () => { const c = new OrganizationController(fixture.projectId, 'nonce', false, { get: vi.fn(), apply: vi.fn() }); c.snapshot = { kind: 'audio-annotator-organization', formatVersion: 1, projectId: fixture.projectId, revision: 0, layoutRevision: 0, folders: [{ id, parentId: null, name: '隐藏目录' }], media: [{ mediaId: fixture.media[0].id, folderId: id, originalFilename: 'a.wav' }] }; render(<MediaList organization={c} hiddenMediaIds={[fixture.media[0].id]} media={fixture.media} annotations={[]} statuses={[]} selectedId={null} disabled onSelect={vi.fn()} onImport={vi.fn()} onRelink={vi.fn()}/>); fireEvent.click(screen.getByTitle('隐藏目录')); expect(c.selectedFolderId).toBe(id); fireEvent.click(screen.getByRole('button', { name: '文件夹操作 · 隐藏目录' })); expect(screen.getByRole('menuitem', { name: /删除文件夹/ })).toHaveAttribute('aria-disabled', 'true'); expect(screen.getByRole('menuitem', { name: '新建子文件夹…' })).toHaveAttribute('aria-disabled', 'true'); });
it('retires open folder drafts and menus when the organization owner is replaced', () => { const make = () => { const c = new OrganizationController(fixture.projectId, 'nonce', true, { get: vi.fn(), apply: vi.fn() }); c.snapshot = { kind: 'audio-annotator-organization', formatVersion: 1, projectId: fixture.projectId, revision: 0, layoutRevision: 0, folders: [], media: [] }; return c; }; const c = make(), props = { media: [], annotations: [], statuses: [], selectedId: null, disabled: false, onSelect: vi.fn(), onImport: vi.fn(), onRelink: vi.fn() }; const view = render(<MediaList {...props} organization={c}/>); fireEvent.click(screen.getByRole('button', { name: '根目录操作' })); fireEvent.click(screen.getByRole('menuitem', { name: '新建子文件夹…' })); fireEvent.change(screen.getByLabelText('文件夹名称'), { target: { value: '旧项目草稿' } }); view.rerender(<MediaList {...props} organization={make()}/>); expect(screen.queryByRole('dialog')).toBeNull(); expect(screen.queryByRole('menu')).toBeNull(); });
it('keeps selected folder open and separates disclosure from import-target and audio selection', () => { const c = new OrganizationController(fixture.projectId, 'nonce', true, { get: vi.fn(), apply: vi.fn() }); c.snapshot = { kind: 'audio-annotator-organization', formatVersion: 1, projectId: fixture.projectId, revision: 0, layoutRevision: 0, folders: [{ id, parentId: null, name: '记录' }, { id: child, parentId: null, name: '其他' }], media: [{ mediaId: fixture.media[0].id, folderId: id, originalFilename: 'a.wav' }] }; const select = vi.fn(); render(<MediaList organization={c} media={fixture.media} annotations={[]} statuses={[]} selectedId={fixture.media[0].id} disabled={false} onSelect={select} onImport={vi.fn()} onRelink={vi.fn()}/>); fireEvent.click(screen.getByTitle('记录')); fireEvent.click(screen.getByTitle('记录')); expect(screen.getByRole('button', { name: fixture.media[0].displayName })).toBeVisible(); fireEvent.click(screen.getByRole('button', { name: '展开文件夹 · 其他' })); expect(c.selectedFolderId).toBe(id); fireEvent.click(screen.getByRole('button', { name: '折叠文件夹 · 记录' })); expect(c.selectedFolderId).toBe(id); expect(select).not.toHaveBeenCalled(); });

it.each(['重命名文件夹…', '移动文件夹…'])('retires a remotely deleted folder menu before stale %s can act', async action => {
    const head = { kind: 'audio-annotator-organization' as const, formatVersion: 1 as const, projectId: fixture.projectId, revision: 1, layoutRevision: 1, folders: [{ id, parentId: null, name: '即将删除' }], media: [] };
    const apply = vi.fn(), api = { get: vi.fn(async () => ({ runtimeNonce: 'nonce', projectId: fixture.projectId, organization: { ...head, revision: 2, layoutRevision: 2, folders: [] } })), apply };
    const c = new OrganizationController(fixture.projectId, 'nonce', true, api);
    c.snapshot = head;
    render(<MediaList organization={c} media={[]} annotations={[]} statuses={[]} selectedId={null} disabled={false} onSelect={vi.fn()} onImport={vi.fn()} onRelink={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '文件夹操作 · 即将删除' }));
    const staleAction = screen.getByRole('menuitem', { name: action });
    const errors: unknown[] = [];
    const capture = (event: ErrorEvent) => { errors.push(event.error); event.preventDefault(); };
    window.addEventListener('error', capture);
    try {
        await act(() => c.refresh());
        fireEvent.click(staleAction);
        expect(errors).toEqual([]);
        expect(screen.queryByRole('menu')).toBeNull();
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(screen.getByRole('button', { name: '根目录操作' })).toHaveFocus();
        expect(apply).not.toHaveBeenCalled();
    } finally {
        window.removeEventListener('error', capture);
    }
});

it('retires a media menu when its target leaves the local list and restores connected root focus', () => {
    const c = new OrganizationController(fixture.projectId, 'nonce', true, { get: vi.fn(), apply: vi.fn() });
    c.snapshot = { kind: 'audio-annotator-organization', formatVersion: 1, projectId: fixture.projectId, revision: 1, layoutRevision: 1, folders: [], media: [{ mediaId: fixture.media[0].id, folderId: null, originalFilename: 'a.wav' }] };
    const onRelink = vi.fn(), props = { organization: c, annotations: [], statuses: [], selectedId: null, disabled: false, onSelect: vi.fn(), onImport: vi.fn(), onRelink };
    const view = render(<MediaList {...props} media={fixture.media} />);
    fireEvent.contextMenu(screen.getByRole('button', { name: fixture.media[0].displayName }));
    const staleAction = screen.getByRole('menuitem', { name: '重新关联…' });
    view.rerender(<MediaList {...props} media={[]} />);
    fireEvent.click(staleAction);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(onRelink).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '根目录操作' })).toHaveFocus();
});
it.each(['重命名文件夹…', '移动文件夹…'])('revalidates %s against the controller snapshot at action time', action => {
    const c = new OrganizationController(fixture.projectId, 'nonce', true, { get: vi.fn(), apply: vi.fn() });
    c.snapshot = { kind: 'audio-annotator-organization', formatVersion: 1, projectId: fixture.projectId, revision: 1, layoutRevision: 1, folders: [{ id, parentId: null, name: '已删除目标' }], media: [] };
    render(<MediaList organization={c} media={[]} annotations={[]} statuses={[]} selectedId={null} disabled={false} onSelect={vi.fn()} onImport={vi.fn()} onRelink={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '文件夹操作 · 已删除目标' }));
    const staleAction = screen.getByRole('menuitem', { name: action });
    // Model publication becoming visible to the controller immediately before its UI notification.
    c.snapshot = { ...c.snapshot, revision: 2, layoutRevision: 2, folders: [] };
    fireEvent.click(staleAction);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getByRole('button', { name: '根目录操作' })).toHaveFocus();
});

it.each([
    ['delete', 'Escape'], ['delete', 'outside'], ['move', 'Escape'], ['move', 'outside']
] as const)('restores connected root focus after remote %s removes an open dialogs trigger and %s closes it', async (change, dismiss) => {
    const head: import('../../bridge/organization').Organization = { kind: 'audio-annotator-organization', formatVersion: 1, projectId: fixture.projectId, revision: 1, layoutRevision: 1, folders: [{ id, parentId: null, name: '编辑目标' }, { id: child, parentId: null, name: '远端父目录' }], media: [] };
    const next = { ...head, revision: 2, layoutRevision: 2, folders: change === 'delete' ? [head.folders[1]] : [{ ...head.folders[0], parentId: child }, head.folders[1]] };
    const api = { get: vi.fn(async () => ({ runtimeNonce: 'nonce', projectId: fixture.projectId, organization: next })), apply: vi.fn() };
    const c = new OrganizationController(fixture.projectId, 'nonce', true, api);
    c.snapshot = head;
    const focus = HTMLElement.prototype.focus;
    const guarded = vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function(this: HTMLElement, options?: FocusOptions) { if (!this.closest<HTMLElement>('.app-root')?.inert) focus.call(this, options); });
    try {
        render(<div className="app-root"><MediaList organization={c} media={[]} annotations={[]} statuses={[]} selectedId={null} disabled={false} onSelect={vi.fn()} onImport={vi.fn()} onRelink={vi.fn()} /></div>);
        const previous = screen.getByRole('button', { name: '文件夹操作 · 编辑目标' });
        fireEvent.click(previous);
        fireEvent.click(screen.getByRole('menuitem', { name: '重命名文件夹…' }));
        await act(() => c.refresh());
        expect(previous.isConnected).toBe(false);
        expect(screen.getByRole('dialog')).toBeInTheDocument();
        if (dismiss === 'Escape') fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
        else fireEvent.pointerDown(document.querySelector('.dialog-backdrop')!);
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(document.querySelector<HTMLElement>('.app-root')?.inert).toBe(false);
        expect(screen.getByRole('button', { name: '根目录操作' })).toHaveFocus();
        expect(api.apply).not.toHaveBeenCalled();
    } finally { guarded.mockRestore(); }
});

it('restores root focus after successful deletion removes the dialogs own return trigger', async () => {
    const head: import('../../bridge/organization').Organization = { kind: 'audio-annotator-organization', formatVersion: 1, projectId: fixture.projectId, revision: 1, layoutRevision: 1, folders: [{ id, parentId: null, name: '删除目标' }], media: [] };
    const api = { get: vi.fn(), apply: vi.fn(async () => ({ runtimeNonce: 'nonce', projectId: fixture.projectId, organization: { ...head, revision: 2, layoutRevision: 2, folders: [] } })) };
    const c = new OrganizationController(fixture.projectId, 'nonce', true, api);
    c.snapshot = head;
    render(<div className="app-root"><MediaList organization={c} media={[]} annotations={[]} statuses={[]} selectedId={null} disabled={false} onSelect={vi.fn()} onImport={vi.fn()} onRelink={vi.fn()} /></div>);
    const previous = screen.getByRole('button', { name: '文件夹操作 · 删除目标' });
    fireEvent.click(previous);
    fireEvent.click(screen.getByRole('menuitem', { name: '删除文件夹…' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '确认' })); });
    expect(api.apply).toHaveBeenCalledWith(fixture.projectId, 1, { type: 'removeFolder', id });
    expect(previous.isConnected).toBe(false);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.querySelector<HTMLElement>('.app-root')?.inert).toBe(false);
    expect(screen.getByRole('button', { name: '根目录操作' })).toHaveFocus();
});
it('uses the surviving search control when owner replacement removes both dialog trigger and shared root', () => {
    const c = new OrganizationController(fixture.projectId, 'nonce', true, { get: vi.fn(), apply: vi.fn() });
    c.snapshot = { kind: 'audio-annotator-organization', formatVersion: 1, projectId: fixture.projectId, revision: 1, layoutRevision: 1, folders: [{ id, parentId: null, name: '旧身份目录' }], media: [] };
    const props = { media: [], annotations: [], statuses: [], selectedId: null, disabled: false, onSelect: vi.fn(), onImport: vi.fn(), onRelink: vi.fn() };
    const view = render(<div className="app-root"><MediaList {...props} organization={c} /></div>);
    const previous = screen.getByRole('button', { name: '文件夹操作 · 旧身份目录' });
    fireEvent.click(previous);
    fireEvent.click(screen.getByRole('menuitem', { name: '移动文件夹…' }));
    view.rerender(<div className="app-root"><MediaList {...props} organization={null} /></div>);
    expect(previous.isConnected).toBe(false);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.querySelector<HTMLElement>('.app-root')?.inert).toBe(false);
    expect(screen.getByRole('textbox', { name: '搜索音频' })).toHaveFocus();
});
it('media rows expose metadata in a title and all row actions only in their context menu',()=>{
 const m=fixture.media[0],hide=vi.fn(),relink=vi.fn();const ui=render(<MediaList media={[m]} annotations={[]} statuses={[{mediaId:m.id,status:'missing'}]} selectedId={m.id} disabled={false} onSelect={vi.fn()} onImport={vi.fn()} onHide={hide} onRelink={relink}/>);
 const row=ui.container.querySelector('.media-card')!;expect(row.querySelectorAll('button')).toHaveLength(1);expect(row.querySelectorAll('small')).toHaveLength(0);expect(screen.getByRole('button',{name:m.displayName}).title).toContain('通道');
 fireEvent.contextMenu(row);fireEvent.click(screen.getByRole('menuitem',{name:'重新关联…'}));expect(relink).toHaveBeenCalledWith(m);ui.unmount();
});
it('compact media context actions are reachable with the keyboard context key',()=>{
 const m=fixture.media[0];render(<MediaList media={[m]} annotations={[]} statuses={[]} selectedId={m.id} disabled={false} onSelect={vi.fn()} onImport={vi.fn()} onHide={vi.fn()} onRelink={vi.fn()}/>);const row=screen.getByRole('button',{name:m.displayName});row.focus();fireEvent.keyDown(row,{key:'F10',shiftKey:true});expect(screen.getByRole('menuitem',{name:'复制文件名'})).toHaveFocus();fireEvent.keyDown(screen.getByRole('menu'),{key:'ArrowDown'});expect(screen.getByRole('menuitem',{name:'从我的列表隐藏'})).toHaveFocus();
});
