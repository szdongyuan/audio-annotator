import { expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MediaList } from './MediaList';
import fixture from '../../../tests/fixtures/document-v3.json';
import { OrganizationController } from './organization';
const id = '33333333-3333-4333-8333-333333333333', child = '44444444-4444-4444-8444-444444444444';
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
it('blocks removal for hidden native memberships and readonly actions while allowing folder browsing', () => { const c = new OrganizationController(fixture.projectId, 'nonce', false, { get: vi.fn(), apply: vi.fn() }); c.snapshot = { kind: 'audio-annotator-organization', formatVersion: 1, projectId: fixture.projectId, revision: 0, layoutRevision: 0, folders: [{ id, parentId: null, name: '隐藏目录' }], media: [{ mediaId: fixture.media[0].id, folderId: id, originalFilename: 'a.wav' }] }; render(<MediaList organization={c} hiddenMediaIds={[fixture.media[0].id]} media={fixture.media} annotations={[]} statuses={[]} selectedId={null} disabled onSelect={vi.fn()} onImport={vi.fn()} onRelink={vi.fn()}/>); fireEvent.click(screen.getByTitle('隐藏目录')); expect(c.selectedFolderId).toBe(id); fireEvent.click(screen.getByRole('button', { name: '文件夹操作 · 隐藏目录' })); expect(screen.getByRole('menuitem', { name: '删除空文件夹…' })).toHaveAttribute('aria-disabled', 'true'); expect(screen.getByRole('menuitem', { name: '新建子文件夹…' })).toHaveAttribute('aria-disabled', 'true'); });
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
    fireEvent.click(screen.getByRole('menuitem', { name: '删除空文件夹…' }));
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
