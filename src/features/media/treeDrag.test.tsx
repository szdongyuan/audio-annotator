import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import fixture from '../../../tests/fixtures/document-v3.json';
import { MediaList } from './MediaList';
import { OrganizationController } from './organization';
import { RecycleController } from './recycle';
import { ProjectLifecycle } from '../project/lifecycle';
import { ProjectStore } from '../../app/store';
import { CommandQueue } from '../../app/commands';
import { collaborationClient, type CollaborationStatus } from '../../bridge/collaboration';
import type { ActiveProject } from '../project/useProjectLifecycle';

const nonce = '11111111-1111-4111-8111-111111111111', folder = '33333333-3333-4333-8333-333333333333';
class TestPointerEvent extends MouseEvent { pointerId: number; constructor(type: string, options: PointerEventInit = {}) { super(type, options); this.pointerId = options.pointerId ?? 1; } }
beforeEach(() => {
    vi.stubGlobal('PointerEvent', TestPointerEvent);
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: vi.fn(() => null) });
});
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });
function setup(writable = true, firstFolder: string | null = null, lifecycle?: ProjectLifecycle, owner?: ActiveProject) {
    const media = [0, 1, 2].map(i => ({ ...fixture.media[0], id: `00000000-0000-4000-8000-00000000000${i + 1}`, displayName: `${i + 1}.wav` }));
    const head = { kind: 'audio-annotator-organization' as const, formatVersion: 1 as const, projectId: fixture.projectId, revision: 4, layoutRevision: 4, folders: [{ id: folder, parentId: null as string | null, name: '目标' }], media: media.map((item, index) => ({ mediaId: item.id, folderId: index === 0 ? firstFolder : null, originalFilename: item.displayName })) };
    const bin = { kind: 'audio-annotator-recycle' as const, formatVersion: 1 as const, projectId: fixture.projectId, revision: 1, trashed: [] as { mediaId: string; deletedBy: string }[], recentOperations: [] };
    const orgApi = { get: vi.fn(async () => ({ runtimeNonce: nonce, projectId: fixture.projectId, organization: head })), apply: vi.fn(async (_project: string, _revision: number, op: { mediaIds?: string[]; folderId?: string | null }) => ({ runtimeNonce: nonce, projectId: fixture.projectId, organization: { ...head, revision: 5, layoutRevision: 5, media: head.media.map(m => op.mediaIds?.includes(m.mediaId) ? { ...m, folderId: op.folderId ?? null } : m) } })) };
    const recycleApi = { get: vi.fn(async () => ({ runtimeNonce: nonce, projectId: fixture.projectId, recycle: bin })), apply: vi.fn() };
    const organization = new OrganizationController(fixture.projectId, nonce, writable, orgApi as never, owner); organization.snapshot = head;
    const recycle = new RecycleController(fixture.projectId, nonce, writable, recycleApi, owner); recycle.snapshot = bin;
    const onSelect = vi.fn();
    const view = render(<MediaList organization={organization} recycle={recycle} lifecycle={lifecycle} media={media} annotations={[]} statuses={[]} selectedId={media[0].id} disabled={false} onSelect={onSelect} onImport={vi.fn()} onRelink={vi.fn()} />);
    if (firstFolder) fireEvent.click(screen.getByRole('button', { name: '展开文件夹 · 目标' }));
    const destination = screen.getByTitle('目标').closest('[data-drop-folder]')!;
    const root = screen.getByRole('button', { name: /全部音频/ }).closest('[data-drop-folder]')!;
    const point = (target: Element | null) => vi.mocked(document.elementFromPoint).mockReturnValue(target);
    const start = (index = 0) => { const row = screen.getByRole('button', { name: media[index].displayName }); fireEvent.pointerDown(row, { button: 0, pointerId: 1, clientX: 0, clientY: 0 }); return row; };
    const move = (row: HTMLElement, target: Element | null = destination) => { point(target); fireEvent.pointerMove(row, { pointerId: 1, clientX: 12, clientY: 12 }); };
    const end = (row: HTMLElement) => fireEvent.pointerUp(row, { pointerId: 1, clientX: 12, clientY: 12 });
    return { media, head, bin, orgApi, recycleApi, organization, recycle, onSelect, destination, root, point, start, move, end, view };
}
function realLifecycle() {
    const store=new ProjectStore({document:structuredClone(fixture) as never,canUndo:false,canRedo:false});
    const queue=new CommandQueue(store,{getSnapshot:vi.fn(),applyChange:vi.fn(),undo:vi.fn(),redo:vi.fn()});
    const lifecycle=new ProjectLifecycle(store,queue,{save:async(_id,revision)=>revision,close:async()=>{}});
    const owner={store,queue,lifecycle,collaboration:{runtimeNonce:nonce}} as unknown as ActiveProject;
    return {store,queue,lifecycle,owner};
}
it('preserves ordinary click and modifier selection below threshold', () => {
    const s = setup(), row = s.start(); fireEvent.pointerMove(row, { pointerId: 1, clientX: 2, clientY: 2 }); fireEvent.pointerUp(row, { pointerId: 1, clientX: 2, clientY: 2 }); fireEvent.click(row);
    expect(s.onSelect).toHaveBeenCalledWith(s.media[0].id); expect(s.orgApi.apply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: s.media[1].displayName }), { ctrlKey: true });
    expect(screen.getByRole('checkbox', { name: `选择音频 · ${s.media[1].displayName}` })).toBeChecked();
});
it('moves a checked batch atomically without changing playback selection and focuses the target', async () => {
    const s = setup(); fireEvent.click(screen.getByRole('button', { name: '多选音频' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '选择音频 · 1.wav' })); fireEvent.click(screen.getByRole('checkbox', { name: '选择音频 · 2.wav' }));
    const row = s.start(); s.move(row); expect(s.destination).toHaveClass('is-drop-target'); expect(screen.getByText(/移动 2 个音频到/)).toBeVisible();
    s.end(row); fireEvent.click(row);
    await waitFor(() => expect(s.orgApi.apply).toHaveBeenCalledOnce());
    expect(s.orgApi.apply).toHaveBeenCalledWith(fixture.projectId, 4, { type: 'moveMediaBatch', mediaIds: [s.media[0].id, s.media[1].id], folderId: folder });
    expect(s.onSelect).not.toHaveBeenCalled(); expect(screen.getByRole('button', { name: '1.wav' })).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => expect(screen.getByTitle('目标')).toHaveFocus());
});
it('moves only an unchecked row despite other checked rows', async () => {
    const s = setup(); fireEvent.click(screen.getByRole('button', { name: '多选音频' })); fireEvent.click(screen.getByRole('checkbox', { name: '选择音频 · 1.wav' }));
    const row = s.start(2); s.move(row); s.end(row);
    await waitFor(() => expect(s.orgApi.apply).toHaveBeenCalledWith(fixture.projectId, 4, { type: 'moveMediaBatch', mediaIds: [s.media[2].id], folderId: folder }));
});
it('clears a previous success notice when the next gesture starts', async () => {
    const s=setup(),row=s.start();s.move(row);s.end(row);await waitFor(()=>expect(screen.getByText('已移动 1 个音频')).toBeVisible());
    const next=s.start(1);expect(screen.queryByText('已移动 1 个音频')).toBeNull();fireEvent.pointerUp(next,{pointerId:1,clientX:0,clientY:0});
});
it('expires a completed-move notice', async () => {
    vi.useFakeTimers();
    try {
        const s=setup(),row=s.start();s.move(row);await act(async()=>{s.end(row);});
        expect(screen.getByText('已移动 1 个音频')).toBeVisible();act(()=>vi.advanceTimersByTime(4000));expect(screen.queryByText('已移动 1 个音频')).toBeNull();
    } finally { vi.useRealTimers(); }
});
it('moves from a folder to the root and focuses the root row', async () => {
    const s = setup(true, folder), row = s.start(); s.move(row, s.root); s.end(row);
    await waitFor(() => expect(s.orgApi.apply).toHaveBeenCalledWith(fixture.projectId, 4, { type: 'moveMediaBatch', mediaIds: [s.media[0].id], folderId: null }));
    await waitFor(() => expect(s.root.querySelector('.media-folder-select')).toHaveFocus()); expect(s.onSelect).not.toHaveBeenCalled();
});
it('moves a file from a locally flattened folder to the root without changing its displayed audio selection', async () => {
    const s=setup(true,folder);
    fireEvent.click(screen.getByLabelText('文件夹操作 · 目标'));
    fireEvent.click(screen.getByRole('menuitem',{name:'平铺此文件夹（含子文件夹）'}));
    expect(screen.getByLabelText('音频显示方式')).toHaveValue('tree');
    const row=s.start();s.move(row,s.root);s.end(row);
    await waitFor(()=>expect(s.orgApi.apply).toHaveBeenCalledWith(fixture.projectId,4,{type:'moveMediaBatch',mediaIds:[s.media[0].id],folderId:null}));
    expect(s.onSelect).not.toHaveBeenCalled();expect(screen.getByTitle('目标')).toHaveTextContent('平铺');
});
it.each(['folder','root'] as const)('keeps flat mode and offers the destination scope when a pending move to %s completes',async destination=>{
    const s=setup(true,destination==='root'?folder:null),target=destination==='root'?null:folder;
    let resolve!:(value:Awaited<ReturnType<typeof s.orgApi.apply>>)=>void;s.orgApi.apply.mockImplementationOnce(()=>new Promise(r=>resolve=r));
    const row=s.start();s.move(row,destination==='root'?s.root:s.destination);s.end(row);await waitFor(()=>expect(resolve).toBeTypeOf('function'));
    fireEvent.change(screen.getByRole('combobox',{name:'音频显示方式'}),{target:{value:'flat'}});
    const scope=screen.getByRole('combobox',{name:'平铺显示范围'}),focus=document.activeElement;
    expect(scope).toHaveValue('');
    const moved={...s.head,revision:5,layoutRevision:5,media:s.head.media.map(m=>m.mediaId===s.media[0].id?{...m,folderId:target}:m)};
    await act(async()=>resolve({runtimeNonce:nonce,projectId:fixture.projectId,organization:moved}));
    await waitFor(()=>expect(screen.getByRole('button',{name:'查看目标'})).toBeVisible());expect(document.activeElement).toBe(focus);expect(screen.getByRole('combobox',{name:'音频显示方式'})).toHaveValue('flat');expect(scope).toHaveValue('');
    expect(s.organization.selectedFolderId).toBeNull();expect(s.onSelect).not.toHaveBeenCalled();
    expect(screen.getByRole('button',{name:'1.wav'})).toHaveAttribute('aria-pressed','true');expect(screen.getByText(destination==='root'?/已移动 1 个音频到「全部音频」/:/已移动 1 个音频到「目标」/)).toBeVisible();
    fireEvent.click(screen.getByRole('button',{name:'查看目标'}));await waitFor(()=>expect(scope).toHaveFocus());expect(scope).toHaveValue(target??'');
});
it('preserves an explicitly changed flat scope and offers to reveal the completed destination',async()=>{
    const s=setup(true,folder);let resolve!:(value:Awaited<ReturnType<typeof s.orgApi.apply>>)=>void;s.orgApi.apply.mockImplementationOnce(()=>new Promise(r=>resolve=r));
    const row=s.start();s.move(row,s.root);s.end(row);await waitFor(()=>expect(resolve).toBeTypeOf('function'));
    fireEvent.change(screen.getByRole('combobox',{name:'音频显示方式'}),{target:{value:'flat'}});const scope=screen.getByRole('combobox',{name:'平铺显示范围'});fireEvent.change(scope,{target:{value:folder}});
    const moved={...s.head,revision:5,layoutRevision:5,media:s.head.media.map(m=>m.mediaId===s.media[0].id?{...m,folderId:null}:m)};
    await act(async()=>resolve({runtimeNonce:nonce,projectId:fixture.projectId,organization:moved}));await waitFor(()=>expect(screen.getByRole('button',{name:'查看目标'})).toBeVisible());
    expect(scope).toHaveValue(folder);expect(screen.getByText(/已移动 1 个音频到「全部音频」/)).toBeVisible();expect(screen.queryByRole('button',{name:'1.wav'})).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'查看目标'}));await waitFor(()=>expect(scope).toHaveFocus());expect(scope).toHaveValue('');expect(screen.getByRole('button',{name:'1.wav'})).toHaveAttribute('aria-pressed','true');expect(s.onSelect).not.toHaveBeenCalled();
});
it('keeps the flat search and current scope after a delayed move until the user views the destination',async()=>{
    const s=setup();let resolve!:(value:Awaited<ReturnType<typeof s.orgApi.apply>>)=>void;s.orgApi.apply.mockImplementationOnce(()=>new Promise(r=>resolve=r));
    const row=s.start();s.move(row);s.end(row);await waitFor(()=>expect(resolve).toBeTypeOf('function'));
    fireEvent.change(screen.getByRole('combobox',{name:'音频显示方式'}),{target:{value:'flat'}});const scope=screen.getByRole('combobox',{name:'平铺显示范围'}),search=screen.getByRole('textbox',{name:'搜索音频'});
    search.focus();fireEvent.keyDown(search,{key:'2'});fireEvent.change(search,{target:{value:'2.wav'}});
    const moved={...s.head,revision:5,layoutRevision:5,media:s.head.media.map(m=>m.mediaId===s.media[0].id?{...m,folderId:folder}:m)};
    await act(async()=>resolve({runtimeNonce:nonce,projectId:fixture.projectId,organization:moved}));await waitFor(()=>expect(screen.getByRole('button',{name:'查看目标'})).toBeVisible());
    expect(scope).toHaveValue('');expect(search).toHaveFocus();expect(search).toHaveValue('2.wav');expect(screen.getByRole('button',{name:'2.wav'})).toBeVisible();expect(s.onSelect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button',{name:'查看目标'}));await waitFor(()=>expect(scope).toHaveFocus());expect(scope).toHaveValue(folder);expect(search).toHaveValue('');expect(screen.getByRole('button',{name:'1.wav'})).toHaveAttribute('aria-pressed','true');
});
it.each(['hidden','inert','modal','focus rejected'] as const)('keeps the flat scope when destination focus is unavailable because of %s',async mode=>{
    const s=setup(),outside=document.createElement('button'),modal=document.createElement('section');outside.textContent='其他控件';let focus:ReturnType<typeof vi.spyOn>|undefined;
    try {
        let resolve!:(value:Awaited<ReturnType<typeof s.orgApi.apply>>)=>void;s.orgApi.apply.mockRejectedValueOnce({code:'RevisionConflict',message:'stale',retryable:true}).mockImplementationOnce(()=>new Promise(r=>resolve=r));
        const row=s.start();s.move(row);s.end(row);fireEvent.change(screen.getByRole('combobox',{name:'音频显示方式'}),{target:{value:'flat'}});
        await waitFor(()=>expect(screen.getByRole('button',{name:'核对并重试'})).toBeEnabled());fireEvent.click(screen.getByRole('button',{name:'核对并重试'}));await waitFor(()=>expect(resolve).toBeTypeOf('function'));
        const scope=screen.getByRole('combobox',{name:'平铺显示范围'});expect(scope).toHaveValue('');
        if(mode==='hidden')s.view.container.style.display='none';
        else if(mode==='inert')s.view.container.inert=true;
        else if(mode==='modal'){modal.setAttribute('role','dialog');modal.setAttribute('aria-modal','true');modal.append(outside);document.body.append(modal);}
        else focus=vi.spyOn(scope,'focus').mockImplementation(()=>{});
        if(mode!=='modal')document.body.append(outside);outside.focus();
        const moved={...s.head,revision:5,layoutRevision:5,media:s.head.media.map(m=>m.mediaId===s.media[0].id?{...m,folderId:folder}:m)};
        await act(async()=>resolve({runtimeNonce:nonce,projectId:fixture.projectId,organization:moved}));await waitFor(()=>expect(s.view.container.textContent).toContain('查看目标'));
        expect(scope).toHaveValue('');expect(outside).toHaveFocus();s.view.container.style.display='';s.view.container.inert=false;modal.remove();outside.remove();focus?.mockRestore();
        fireEvent.click(screen.getByRole('button',{name:'查看目标'}));await waitFor(()=>expect(scope).toHaveFocus());expect(scope).toHaveValue(folder);
    } finally {s.view.container.style.display='';s.view.container.inert=false;modal.remove();outside.remove();focus?.mockRestore();}
});
it('switches to the destination scope after a flat retry when automatic focus is available',async()=>{
    const s=setup();let resolve!:(value:Awaited<ReturnType<typeof s.orgApi.apply>>)=>void;s.orgApi.apply.mockRejectedValueOnce({code:'RevisionConflict',message:'stale',retryable:true}).mockImplementationOnce(()=>new Promise(r=>resolve=r));
    const row=s.start();s.move(row);s.end(row);fireEvent.change(screen.getByRole('combobox',{name:'音频显示方式'}),{target:{value:'flat'}});
    await waitFor(()=>expect(screen.getByRole('button',{name:'核对并重试'})).toBeEnabled());fireEvent.click(screen.getByRole('button',{name:'核对并重试'}));await waitFor(()=>expect(resolve).toBeTypeOf('function'));
    const scope=screen.getByRole('combobox',{name:'平铺显示范围'}),moved={...s.head,revision:5,layoutRevision:5,media:s.head.media.map(m=>m.mediaId===s.media[0].id?{...m,folderId:folder}:m)};
    await act(async()=>resolve({runtimeNonce:nonce,projectId:fixture.projectId,organization:moved}));await waitFor(()=>expect(scope).toHaveFocus());await waitFor(()=>expect(scope).toHaveValue(folder));expect(screen.queryByRole('button',{name:'查看目标'})).toBeNull();
});
it('keeps the flat scope if user input arrives after completion but before its focus frame',async()=>{
    let frame:FrameRequestCallback|undefined;const raf=vi.spyOn(window,'requestAnimationFrame').mockImplementation(callback=>{frame=callback;return 1;}),s=setup();
    try {
        let resolve!:(value:Awaited<ReturnType<typeof s.orgApi.apply>>)=>void;s.orgApi.apply.mockRejectedValueOnce({code:'RevisionConflict',message:'stale',retryable:true}).mockImplementationOnce(()=>new Promise(r=>resolve=r));
        const row=s.start();s.move(row);s.end(row);fireEvent.change(screen.getByRole('combobox',{name:'音频显示方式'}),{target:{value:'flat'}});
        await waitFor(()=>expect(screen.getByRole('button',{name:'核对并重试'})).toBeEnabled());fireEvent.click(screen.getByRole('button',{name:'核对并重试'}));await waitFor(()=>expect(resolve).toBeTypeOf('function'));
        const scope=screen.getByRole('combobox',{name:'平铺显示范围'}),search=screen.getByRole('textbox',{name:'搜索音频'}),moved={...s.head,revision:5,layoutRevision:5,media:s.head.media.map(m=>m.mediaId===s.media[0].id?{...m,folderId:folder}:m)};
        await act(async()=>resolve({runtimeNonce:nonce,projectId:fixture.projectId,organization:moved}));await waitFor(()=>expect(frame).toBeTypeOf('function'));const oldFrame=frame!;
        fireEvent.pointerDown(search,{button:0});search.focus();fireEvent.change(search,{target:{value:'2.wav'}});act(()=>oldFrame(0));
        expect(scope).toHaveValue('');expect(search).toHaveFocus();expect(search).toHaveValue('2.wav');expect(screen.getByRole('button',{name:'查看目标'})).toBeVisible();
        fireEvent.click(screen.getByRole('button',{name:'查看目标'}));act(()=>frame!(0));expect(scope).toHaveFocus();expect(scope).toHaveValue(folder);
    } finally {raf.mockRestore();}
});
it('keeps a tree search that hides the destination and reveals it only on request',async()=>{
    const s=setup();let resolve!:(value:Awaited<ReturnType<typeof s.orgApi.apply>>)=>void;s.orgApi.apply.mockImplementationOnce(()=>new Promise(r=>resolve=r));
    const row=s.start();s.move(row);s.end(row);await waitFor(()=>expect(resolve).toBeTypeOf('function'));const search=screen.getByRole('textbox',{name:'搜索音频'});fireEvent.change(search,{target:{value:'不匹配'}});
    const moved={...s.head,revision:5,layoutRevision:5,media:s.head.media.map(m=>m.mediaId===s.media[0].id?{...m,folderId:folder}:m)};
    await act(async()=>resolve({runtimeNonce:nonce,projectId:fixture.projectId,organization:moved}));await waitFor(()=>expect(screen.getByRole('button',{name:'查看目标'})).toBeVisible());
    expect(search).toHaveValue('不匹配');expect(screen.getByText(/已移动 1 个音频到「目标」/)).toBeVisible();fireEvent.click(screen.getByRole('button',{name:'查看目标'}));
    await waitFor(()=>expect(screen.getByTitle('目标')).toHaveFocus());expect(search).toHaveValue('');expect(screen.getByRole('combobox',{name:'音频显示方式'})).toHaveValue('tree');expect(s.onSelect).not.toHaveBeenCalled();
});
it('preserves a search focused and typed after a delayed root move was dispatched',async()=>{
    const s=setup(true,folder);let resolve!:(value:Awaited<ReturnType<typeof s.orgApi.apply>>)=>void;s.orgApi.apply.mockImplementationOnce(()=>new Promise(r=>resolve=r));
    const row=s.start();s.move(row,s.root);s.end(row);await waitFor(()=>expect(resolve).toBeTypeOf('function'));
    const search=screen.getByRole('textbox',{name:'搜索音频'});fireEvent.pointerDown(search,{button:0});search.focus();fireEvent.keyDown(search,{key:'x'});fireEvent.change(search,{target:{value:'不匹配'}});
    const moved={...s.head,revision:5,layoutRevision:5,media:s.head.media.map(m=>m.mediaId===s.media[0].id?{...m,folderId:null}:m)};
    await act(async()=>resolve({runtimeNonce:nonce,projectId:fixture.projectId,organization:moved}));await waitFor(()=>expect(screen.getByRole('button',{name:'查看目标'})).toBeVisible());
    expect(search).toHaveFocus();expect(search).toHaveValue('不匹配');expect(s.root.querySelector('.media-folder-select')).not.toHaveFocus();expect(screen.getByText(/已移动 1 个音频到「全部音频」/)).toBeVisible();
    fireEvent.click(screen.getByRole('button',{name:'查看目标'}));await waitFor(()=>expect(s.root.querySelector('.media-folder-select')).toHaveFocus());expect(search).toHaveValue('');expect(s.onSelect).not.toHaveBeenCalled();
});
it('does not treat the initiating post-release click as a new focus intent',async()=>{
    const s=setup();let resolve!:(value:Awaited<ReturnType<typeof s.orgApi.apply>>)=>void;s.orgApi.apply.mockImplementationOnce(()=>new Promise(r=>resolve=r));
    const row=s.start();s.move(row);s.end(row);fireEvent.click(row);await waitFor(()=>expect(resolve).toBeTypeOf('function'));
    const moved={...s.head,revision:5,layoutRevision:5,media:s.head.media.map(m=>m.mediaId===s.media[0].id?{...m,folderId:folder}:m)};
    await act(async()=>resolve({runtimeNonce:nonce,projectId:fixture.projectId,organization:moved}));await waitFor(()=>expect(screen.getByTitle('目标')).toHaveFocus());
    expect(screen.queryByRole('button',{name:'查看目标'})).toBeNull();expect(s.onSelect).not.toHaveBeenCalled();
});
it('offers the destination after a hidden media panel becomes visible',async()=>{
    const s=setup(),outside=document.createElement('button');outside.textContent='其他控件';document.body.append(outside);
    try {
        let resolve!:(value:Awaited<ReturnType<typeof s.orgApi.apply>>)=>void;s.orgApi.apply.mockImplementationOnce(()=>new Promise(r=>resolve=r));
        const row=s.start();s.move(row);s.end(row);await waitFor(()=>expect(resolve).toBeTypeOf('function'));s.view.container.style.display='none';outside.focus();
        const moved={...s.head,revision:5,layoutRevision:5,media:s.head.media.map(m=>m.mediaId===s.media[0].id?{...m,folderId:folder}:m)};
        await act(async()=>resolve({runtimeNonce:nonce,projectId:fixture.projectId,organization:moved}));await waitFor(()=>expect(s.view.container.textContent).toContain('查看目标'));expect(outside).toHaveFocus();
        s.view.container.style.display='';expect(screen.getByRole('button',{name:'查看目标'})).toBeVisible();fireEvent.click(screen.getByRole('button',{name:'查看目标'}));await waitFor(()=>expect(screen.getByTitle('目标')).toHaveFocus());
    } finally {outside.remove();}
});
it.each(['inert','modal'] as const)('does not steal focus from an active %s and offers the destination afterward',async mode=>{
    const s=setup(),modal=document.createElement('section'),outside=document.createElement('button');outside.textContent='活动控件';
    try {
        let resolve!:(value:Awaited<ReturnType<typeof s.orgApi.apply>>)=>void;s.orgApi.apply.mockImplementationOnce(()=>new Promise(r=>resolve=r));
        const row=s.start();s.move(row);s.end(row);await waitFor(()=>expect(resolve).toBeTypeOf('function'));
        if(mode==='modal'){modal.setAttribute('role','dialog');modal.setAttribute('aria-modal','true');modal.append(outside);document.body.append(modal);}else{document.body.append(outside);s.view.container.inert=true;}outside.focus();
        const moved={...s.head,revision:5,layoutRevision:5,media:s.head.media.map(m=>m.mediaId===s.media[0].id?{...m,folderId:folder}:m)};
        await act(async()=>resolve({runtimeNonce:nonce,projectId:fixture.projectId,organization:moved}));await waitFor(()=>expect(s.view.container.textContent).toContain('查看目标'));expect(outside).toHaveFocus();
        s.view.container.inert=false;modal.remove();outside.remove();fireEvent.click(screen.getByRole('button',{name:'查看目标'}));await waitFor(()=>expect(screen.getByTitle('目标')).toHaveFocus());
    } finally {s.view.container.inert=false;modal.remove();outside.remove();}
});
it('keeps a destination action if an apparently available row does not accept focus',async()=>{
    const s=setup(),button=screen.getByTitle('目标'),focus=vi.spyOn(button,'focus').mockImplementation(()=>{});
    try {
        const row=s.start();s.move(row);s.end(row);await waitFor(()=>expect(screen.getByRole('button',{name:'查看目标'})).toBeVisible());expect(button).not.toHaveFocus();
        focus.mockRestore();fireEvent.click(screen.getByRole('button',{name:'查看目标'}));await waitFor(()=>expect(button).toHaveFocus());
    } finally {focus.mockRestore();}
});
it('identifies the full destination path when a search hides a nested target',async()=>{
    const s=setup(),parent='44444444-4444-4444-8444-444444444444';
    const nested={...s.head,folders:[{id:parent,parentId:null,name:'上级'},{id:folder,parentId:parent,name:'目标'}]};s.organization.snapshot=nested;act(()=>s.organization.select(null));
    fireEvent.click(screen.getByRole('button',{name:'展开文件夹 · 上级'}));const target=screen.getByTitle('上级/目标').closest('[data-drop-folder]')!;
    let resolve!:(value:Awaited<ReturnType<typeof s.orgApi.apply>>)=>void;s.orgApi.apply.mockImplementationOnce(()=>new Promise(r=>resolve=r));
    const row=s.start();s.move(row,target);s.end(row);await waitFor(()=>expect(resolve).toBeTypeOf('function'));fireEvent.change(screen.getByRole('textbox',{name:'搜索音频'}),{target:{value:'不匹配'}});
    const moved={...nested,revision:5,layoutRevision:5,media:nested.media.map(m=>m.mediaId===s.media[0].id?{...m,folderId:folder}:m)};
    await act(async()=>resolve({runtimeNonce:nonce,projectId:fixture.projectId,organization:moved}));await waitFor(()=>expect(screen.getByRole('button',{name:'查看目标'})).toBeVisible());
    expect(screen.getByText(/已移动 1 个音频到「上级\/目标」/)).toBeVisible();fireEvent.click(screen.getByRole('button',{name:'查看目标'}));await waitFor(()=>expect(screen.getByTitle('上级/目标')).toHaveFocus());
});
it('clears an earlier actionable destination prompt when a new pointer gesture starts',async()=>{
    const s=setup();let resolve!:(value:Awaited<ReturnType<typeof s.orgApi.apply>>)=>void;s.orgApi.apply.mockImplementationOnce(()=>new Promise(r=>resolve=r));
    const row=s.start();s.move(row);s.end(row);await waitFor(()=>expect(resolve).toBeTypeOf('function'));const search=screen.getByRole('textbox',{name:'搜索音频'});fireEvent.change(search,{target:{value:'不匹配'}});
    const moved={...s.head,revision:5,layoutRevision:5,media:s.head.media.map(m=>m.mediaId===s.media[0].id?{...m,folderId:folder}:m)};
    await act(async()=>resolve({runtimeNonce:nonce,projectId:fixture.projectId,organization:moved}));await waitFor(()=>expect(screen.getByRole('button',{name:'查看目标'})).toBeVisible());
    fireEvent.change(search,{target:{value:''}});const next=screen.getByRole('button',{name:'1.wav'});fireEvent.pointerDown(next,{button:0,pointerId:1,clientX:0,clientY:0});
    expect(screen.queryByRole('button',{name:'查看目标'})).toBeNull();fireEvent.pointerCancel(next,{pointerId:1});
});
it('does not move rows shown in the recycle view', async () => {
    const s = setup(); s.bin.trashed.push({ mediaId: s.media[0].id, deletedBy: nonce }); await act(() => s.recycle.refresh(true));
    fireEvent.change(screen.getByRole('combobox', { name: '音频列表视图' }), { target: { value: 'trash' } });
    const row = s.start(); s.move(row); s.end(row); await act(async () => {}); expect(s.orgApi.apply).not.toHaveBeenCalled();
});
it.each(['outside', 'escape', 'lost capture', 'blur', 'readonly'] as const)('cancels %s without changing playback or submitting', async mode => {
    const s = setup(mode !== 'readonly'), row = s.start(); s.move(row, mode === 'outside' ? null : s.destination);
    if (mode === 'escape') fireEvent.keyDown(window, { key: 'Escape' });
    else if (mode === 'lost capture') fireEvent.lostPointerCapture(row, { pointerId: 1 });
    else if (mode === 'blur') fireEvent.blur(window);
    s.end(row); await act(async () => {}); expect(s.orgApi.apply).not.toHaveBeenCalled(); expect(s.onSelect).not.toHaveBeenCalled(); expect(s.destination).not.toHaveClass('is-drop-target');
});
it('validates a true no-op through native and keeps the current focus and selection', async () => {
    const s=setup(),row=s.start();row.focus();s.orgApi.apply.mockResolvedValueOnce({runtimeNonce:nonce,projectId:fixture.projectId,organization:s.head});
    s.move(row,s.root);s.end(row);await waitFor(()=>expect(s.orgApi.apply).toHaveBeenCalledOnce());
    expect(s.orgApi.apply).toHaveBeenCalledWith(fixture.projectId,4,{type:'moveMediaBatch',mediaIds:[s.media[0].id],folderId:null});
    expect(row).toHaveFocus();expect(s.onSelect).not.toHaveBeenCalled();expect(screen.queryByText('已移动 1 个音频')).toBeNull();
});
it('still detects a remote move when the drag began at its destination', async () => {
    const s=setup(),remote={...s.head,revision:5,layoutRevision:5,media:s.head.media.map(m=>m.mediaId===s.media[0].id?{...m,folderId:folder}:m)};
    s.orgApi.apply.mockRejectedValueOnce({code:'RevisionConflict',message:'远程目录已变化',retryable:true});s.orgApi.get.mockResolvedValue({runtimeNonce:nonce,projectId:fixture.projectId,organization:remote});
    const row=s.start();s.move(row,s.root);s.end(row);await waitFor(()=>expect(screen.getByRole('button',{name:'核对并重试'})).toBeVisible());
    expect(s.orgApi.apply.mock.calls[0][1]).toBe(4);expect(screen.getByText(/远程目录已变化/)).toBeVisible();
});
it('checks fresh recycle state for a drag that began at its destination', async () => {
    const s=setup();s.orgApi.apply.mockRejectedValueOnce({code:'InvalidInput',message:'音频已进入回收站',retryable:false});
    s.recycleApi.get.mockResolvedValue({runtimeNonce:nonce,projectId:fixture.projectId,recycle:{...s.bin,trashed:[{mediaId:s.media[0].id,deletedBy:nonce}]}});
    const row=s.start();s.move(row,s.root);s.end(row);await waitFor(()=>expect(screen.getByRole('button',{name:'重新刷新'})).toBeVisible());
    expect(screen.getByText(/部分音频已进入回收站/)).toBeVisible();expect(s.orgApi.apply).toHaveBeenCalledOnce();
});
it('retains a stale hit target and source IDs for a blocked review', async () => {
    const s=setup(),row=s.start();s.move(row);s.organization.snapshot={...s.head,revision:5,layoutRevision:5,folders:[]};s.end(row);
    expect(screen.getByText(/目标文件夹已不存在/)).toBeVisible();expect(screen.getByRole('button',{name:'重新刷新'})).toBeVisible();expect(s.orgApi.apply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('查看要移动的音频'));await waitFor(()=>expect(screen.getByText('1.wav',{selector:'li'})).toBeVisible());
});
it.each(['lostpointercapture','pointerup'] as const)('clears a removed captured row on document %s', type => {
    const s=setup(),row=s.start();s.move(row);expect(s.destination).toHaveClass('is-drop-target');
    s.view.rerender(<MediaList organization={s.organization} recycle={s.recycle} media={s.media.slice(1)} annotations={[]} statuses={[]} selectedId={null} disabled={false} onSelect={s.onSelect} onImport={vi.fn()} onRelink={vi.fn()}/>);
    expect(row.isConnected).toBe(false);
    if(type==='lostpointercapture')fireEvent.lostPointerCapture(document,{pointerId:99});else fireEvent.pointerUp(document,{pointerId:99});
    expect(s.destination).toHaveClass('is-drop-target');
    if(type==='lostpointercapture')fireEvent.lostPointerCapture(document,{pointerId:1});else fireEvent.pointerUp(document,{pointerId:1});
    expect(s.destination).not.toHaveClass('is-drop-target');expect(screen.queryByText(/移动 1 个音频到/)).toBeNull();expect(s.orgApi.apply).not.toHaveBeenCalled();
});
it.each(['escape','lost capture'] as const)('suppresses the subsequent source click after %s cancellation', mode => {
    const s=setup(),row=s.start(1);s.move(row);
    if(mode==='escape')fireEvent.keyDown(window,{key:'Escape'});else fireEvent.lostPointerCapture(row,{pointerId:1});
    s.end(row);fireEvent.click(row);expect(s.onSelect).not.toHaveBeenCalled();expect(s.orgApi.apply).not.toHaveBeenCalled();
});
it('uses the drag-start revision and requires explicit retry after a conflict even when all moved remotely', async () => {
    const s = setup();
    const changed = { ...s.head, revision: 5, layoutRevision: 5 }, remote = { ...changed, revision: 6, layoutRevision: 6, media: s.head.media.map(m => m.mediaId === s.media[0].id ? { ...m, folderId: folder } : m) };
    s.orgApi.apply.mockRejectedValueOnce({ code: 'RevisionConflict', message: 'stale', retryable: true }); s.orgApi.get.mockResolvedValueOnce({ runtimeNonce: nonce, projectId: fixture.projectId, organization: changed });
    const row = s.start(); await act(() => s.organization.refresh()); s.orgApi.get.mockResolvedValue({ runtimeNonce: nonce, projectId: fixture.projectId, organization: remote }); s.move(row); s.end(row);
    await waitFor(() => expect(screen.getByRole('button', { name: '核对并重试' })).toBeVisible());
    expect(s.orgApi.apply).toHaveBeenCalledTimes(1); expect(s.orgApi.apply.mock.calls[0][1]).toBe(4); expect(s.recycleApi.get).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '核对并重试' })); await waitFor(() => expect(s.orgApi.apply).toHaveBeenCalledTimes(2));
    expect(s.orgApi.apply.mock.calls[1][1]).toBe(6);
});
it.each([{view:'flat',kind:'conflict'},{view:'flat',kind:'unknown'},{view:'hidden',kind:'conflict'}] as const)('keeps a captured $kind batch retryable after switching to $view',async ({view,kind})=>{
    const s=setup();fireEvent.click(screen.getByRole('button',{name:'多选音频'}));fireEvent.click(screen.getByRole('checkbox',{name:'选择音频 · 1.wav'}));fireEvent.click(screen.getByRole('checkbox',{name:'选择音频 · 2.wav'}));
    let reject!:(error:unknown)=>void;s.orgApi.apply.mockImplementationOnce(()=>new Promise((_resolve,j)=>reject=j));
    const row=s.start();s.move(row);s.end(row);await waitFor(()=>expect(reject).toBeTypeOf('function'));
    if(view==='flat')fireEvent.change(screen.getByRole('combobox',{name:'音频显示方式'}),{target:{value:'flat'}});
    else fireEvent.change(screen.getByRole('combobox',{name:'音频列表视图'}),{target:{value:view}});
    await act(async()=>reject(kind==='conflict'?{code:'RevisionConflict',message:'远程目录变化',retryable:true}:new Error('response lost')));
    await waitFor(()=>expect(screen.getByRole('button',{name:'核对并重试'})).toBeEnabled());expect(s.orgApi.apply).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button',{name:'核对并重试'}));await waitFor(()=>expect(s.orgApi.apply).toHaveBeenCalledTimes(2));
    expect(s.orgApi.apply.mock.calls[1][1]).toBe(4);expect(s.orgApi.apply.mock.calls[1][2]).toEqual({type:'moveMediaBatch',mediaIds:[s.media[0].id,s.media[1].id],folderId:folder});expect(s.onSelect).not.toHaveBeenCalled();
    if(view==='flat'){const scope=screen.getByRole('combobox',{name:'平铺显示范围'});await waitFor(()=>expect(scope).toHaveFocus());expect(scope).toHaveValue(folder);}
});
it('requires returning from the recycle view before retrying the captured batch',async()=>{
    const s=setup();fireEvent.click(screen.getByRole('button',{name:'多选音频'}));fireEvent.click(screen.getByRole('checkbox',{name:'选择音频 · 1.wav'}));fireEvent.click(screen.getByRole('checkbox',{name:'选择音频 · 2.wav'}));
    let reject!:(error:unknown)=>void;s.orgApi.apply.mockImplementationOnce(()=>new Promise((_resolve,j)=>reject=j));const row=s.start();s.move(row);s.end(row);await waitFor(()=>expect(reject).toBeTypeOf('function'));
    fireEvent.change(screen.getByRole('combobox',{name:'音频列表视图'}),{target:{value:'trash'}});await act(async()=>reject({code:'RevisionConflict',message:'远程目录变化',retryable:true}));
    await waitFor(()=>expect(screen.getByRole('button',{name:'核对并重试'})).toBeDisabled());expect(screen.getByText(/请返回正常音频视图后重试/)).toBeVisible();expect(s.orgApi.apply).toHaveBeenCalledOnce();
    fireEvent.change(screen.getByRole('combobox',{name:'音频列表视图'}),{target:{value:'normal'}});expect(screen.getByRole('button',{name:'核对并重试'})).toBeEnabled();
    fireEvent.click(screen.getByRole('button',{name:'核对并重试'}));await waitFor(()=>expect(s.orgApi.apply).toHaveBeenCalledTimes(2));expect(s.orgApi.apply.mock.calls[1][2]).toEqual({type:'moveMediaBatch',mediaIds:[s.media[0].id,s.media[1].id],folderId:folder});expect(s.onSelect).not.toHaveBeenCalled();
});
it('explains when another operation temporarily prevents retrying a captured batch',async()=>{
    const s=setup();s.orgApi.apply.mockRejectedValueOnce({code:'RevisionConflict',message:'stale',retryable:true});const row=s.start();s.move(row);s.end(row);
    await waitFor(()=>expect(screen.getByRole('button',{name:'核对并重试'})).toBeEnabled());
    s.view.rerender(<MediaList organization={s.organization} recycle={s.recycle} media={s.media} annotations={[]} statuses={[]} selectedId={s.media[0].id} disabled navigationDisabled={false} onSelect={s.onSelect} onImport={vi.fn()} onRelink={vi.fn()}/>);
    expect(screen.getByRole('button',{name:'核对并重试'})).toBeDisabled();expect(screen.getByText(/等待当前音频或回收站操作完成/)).toBeVisible();
});
it('keeps a batch review valid through slow coalesced polls and in-flight unchanged reads',async()=>{
    const s=setup();s.orgApi.apply.mockRejectedValueOnce({code:'RevisionConflict',message:'stale',retryable:true});
    let verifyOrg!:(v:{runtimeNonce:string;projectId:string;organization:typeof s.head})=>void,verifyBin!:(v:{runtimeNonce:string;projectId:string;recycle:typeof s.bin})=>void;
    s.orgApi.get.mockImplementationOnce(()=>new Promise(r=>verifyOrg=r));s.recycleApi.get.mockImplementationOnce(()=>new Promise(r=>verifyBin=r));
    const row=s.start();s.move(row);s.end(row);await waitFor(()=>expect(verifyOrg).toBeTypeOf('function'));await waitFor(()=>expect(verifyBin).toBeTypeOf('function'));
    for(let i=0;i<8;i++){void s.organization.refresh();void s.recycle.refresh();}expect(s.orgApi.get).toHaveBeenCalledTimes(1);expect(s.recycleApi.get).toHaveBeenCalledTimes(1);
    await act(async()=>{verifyOrg({runtimeNonce:nonce,projectId:fixture.projectId,organization:s.head});verifyBin({runtimeNonce:nonce,projectId:fixture.projectId,recycle:s.bin});});
    await waitFor(()=>expect(screen.getByRole('button',{name:'核对并重试'})).toBeVisible());
    let pollOrg!:(v:{runtimeNonce:string;projectId:string;organization:typeof s.head})=>void,pollBin!:(v:{runtimeNonce:string;projectId:string;recycle:typeof s.bin})=>void;
    s.orgApi.get.mockImplementationOnce(()=>new Promise(r=>pollOrg=r));s.recycleApi.get.mockImplementationOnce(()=>new Promise(r=>pollBin=r));
    let a!:Promise<void>,b!:Promise<void>;act(()=>{a=s.organization.refresh();b=s.recycle.refresh();});
    fireEvent.click(screen.getByRole('button',{name:'核对并重试'}));await waitFor(()=>expect(s.orgApi.apply).toHaveBeenCalledTimes(2));
    await act(async()=>{pollOrg({runtimeNonce:nonce,projectId:fixture.projectId,organization:s.head});pollBin({runtimeNonce:nonce,projectId:fixture.projectId,recycle:s.bin});await Promise.all([a,b]);});
});
it('requires another batch review after a later poll reports a recycle change',async()=>{
    const s=setup();s.orgApi.apply.mockRejectedValueOnce({code:'RevisionConflict',message:'stale',retryable:true});
    const row=s.start();s.move(row);s.end(row);await waitFor(()=>expect(screen.getByRole('button',{name:'核对并重试'})).toBeVisible());
    s.recycleApi.get.mockResolvedValue({runtimeNonce:nonce,projectId:fixture.projectId,recycle:{...s.bin,revision:2,trashed:[{mediaId:s.media[0].id,deletedBy:nonce}]}});
    await act(()=>s.recycle.refresh());fireEvent.click(screen.getByRole('button',{name:'核对并重试'}));
    await waitFor(()=>expect(screen.getByText(/部分音频已进入回收站/)).toBeVisible());expect(s.orgApi.apply).toHaveBeenCalledOnce();
});
it('discards delayed batch review reads after controller owner replacement',async()=>{
    const s=setup();s.orgApi.apply.mockRejectedValueOnce({code:'RevisionConflict',message:'stale',retryable:true});
    let resolveOrg!:(v:{runtimeNonce:string;projectId:string;organization:typeof s.head})=>void,resolveBin!:(v:{runtimeNonce:string;projectId:string;recycle:typeof s.bin})=>void;
    s.orgApi.get.mockImplementationOnce(()=>new Promise(r=>resolveOrg=r));s.recycleApi.get.mockImplementationOnce(()=>new Promise(r=>resolveBin=r));
    const row=s.start();s.move(row);s.end(row);await waitFor(()=>expect(resolveOrg).toBeTypeOf('function'));await waitFor(()=>expect(resolveBin).toBeTypeOf('function'));
    const c=new OrganizationController(fixture.projectId,nonce,true,{get:vi.fn(),apply:vi.fn()});c.snapshot=s.head;
    const recycle=new RecycleController(fixture.projectId,nonce,true,{get:vi.fn(),apply:vi.fn()});recycle.snapshot=s.bin;
    s.view.rerender(<MediaList organization={c} recycle={recycle} media={s.media} annotations={[]} statuses={[]} selectedId={s.media[0].id} disabled={false} onSelect={s.onSelect} onImport={vi.fn()} onRelink={vi.fn()}/>);
    s.organization.dispose();s.recycle.dispose();await act(async()=>{resolveOrg({runtimeNonce:nonce,projectId:fixture.projectId,organization:s.head});resolveBin({runtimeNonce:nonce,projectId:fixture.projectId,recycle:s.bin});});
    expect(screen.queryByRole('button',{name:'核对并重试'})).toBeNull();expect(s.orgApi.apply).toHaveBeenCalledOnce();
});
it('blocks a slow batch review when an organization mutation starts during polling',async()=>{
    const s=setup();s.orgApi.apply.mockRejectedValueOnce({code:'RevisionConflict',message:'stale',retryable:true});
    let verify!:(v:{runtimeNonce:string;projectId:string;organization:typeof s.head})=>void,write!:(v:{runtimeNonce:string;projectId:string;organization:typeof s.head})=>void;
    s.orgApi.get.mockImplementationOnce(()=>new Promise(r=>verify=r));s.orgApi.apply.mockImplementationOnce(()=>new Promise(r=>write=r));
    const row=s.start();s.move(row);s.end(row);await waitFor(()=>expect(verify).toBeTypeOf('function'));
    let pending!:Promise<boolean>;act(()=>{pending=s.organization.submit({expectedRevision:4,operation:{type:'renameFolder',id:folder,name:'新目标'}});});
    for(let i=0;i<5;i++)void s.organization.refresh();expect(s.orgApi.get).toHaveBeenCalledTimes(1);
    await act(async()=>verify({runtimeNonce:nonce,projectId:fixture.projectId,organization:s.head}));await waitFor(()=>expect(screen.getByRole('button',{name:'重新刷新'})).toBeVisible());
    expect(screen.queryByRole('button',{name:'核对并重试'})).toBeNull();await act(async()=>{write({runtimeNonce:nonce,projectId:fixture.projectId,organization:{...s.head,revision:5,layoutRevision:5}});await pending;});
});
it('recognizes an uncertain response only when both fresh reads prove the move completed', async () => {
    const s = setup(), remote = { ...s.head, revision: 5, layoutRevision: 5, media: s.head.media.map(m => m.mediaId === s.media[0].id ? { ...m, folderId: folder } : m) };
    s.orgApi.apply.mockRejectedValueOnce(new Error('response lost')); s.orgApi.get.mockResolvedValue({ runtimeNonce: nonce, projectId: fixture.projectId, organization: remote });
    const row = s.start(); s.move(row); s.end(row);
    await waitFor(() => expect(screen.getByText('已移动 1 个音频')).toBeVisible()); expect(s.recycleApi.get).toHaveBeenCalledOnce(); expect(screen.queryByRole('button', { name: '核对并重试' })).toBeNull();
});
it.each(['SaveFailed','ProjectLocked'] as const)('preserves a definite %s rejection even when fresh state matches the target', async code => {
    const s=setup(),remote={...s.head,revision:5,layoutRevision:5,media:s.head.media.map(m=>m.mediaId===s.media[0].id?{...m,folderId:folder}:m)};
    s.orgApi.apply.mockRejectedValueOnce({code,message:`native ${code}`,retryable:true});s.orgApi.get.mockResolvedValue({runtimeNonce:nonce,projectId:fixture.projectId,organization:remote});
    const row=s.start();s.move(row);s.end(row);await waitFor(()=>expect(screen.getByRole('button',{name:'核对并重试'})).toBeVisible());
    expect(screen.getByText(new RegExp(`native ${code}`))).toBeVisible();expect(screen.queryByText('已移动 1 个音频')).toBeNull();expect(s.orgApi.apply).toHaveBeenCalledOnce();
});
it.each(['read failed', 'recycled', 'target removed'] as const)('blocks retry when %s', async mode => {
    const s = setup(); s.orgApi.apply.mockRejectedValueOnce({ code: 'RevisionConflict', message: 'stale', retryable: true });
    if (mode === 'read failed') s.recycleApi.get.mockRejectedValueOnce(new Error('offline'));
    if (mode === 'recycled') s.recycleApi.get.mockResolvedValue({ runtimeNonce: nonce, projectId: fixture.projectId, recycle: { ...s.bin, trashed: [{ mediaId: s.media[0].id, deletedBy: nonce }] } });
    if (mode === 'target removed') s.orgApi.get.mockResolvedValue({ runtimeNonce: nonce, projectId: fixture.projectId, organization: { ...s.head, revision: 5, folders: [] } });
    const row = s.start(); s.move(row); s.end(row);
    await waitFor(() => expect(screen.getByRole('button', { name: '重新刷新' })).toBeVisible()); expect(screen.queryByRole('button', { name: '核对并重试' })).toBeNull(); expect(s.orgApi.apply).toHaveBeenCalledOnce();
});
it('does not claim an uncertain move succeeded when its recycle read was superseded', async () => {
    const s=setup(),remote={...s.head,revision:5,layoutRevision:5,media:s.head.media.map(m=>m.mediaId===s.media[0].id?{...m,folderId:folder}:m)};
    s.orgApi.apply.mockRejectedValueOnce(new Error('response lost'));s.orgApi.get.mockResolvedValue({runtimeNonce:nonce,projectId:fixture.projectId,organization:remote});
    let resolve!:(value:{runtimeNonce:string;projectId:string;recycle:typeof s.bin})=>void;
    s.recycleApi.get.mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));
    const row=s.start();s.move(row);s.end(row);await waitFor(()=>expect(resolve).toBeTypeOf('function'));
    await act(()=>s.recycle.refresh(true));await act(async()=>resolve({runtimeNonce:nonce,projectId:fixture.projectId,recycle:s.bin}));
    await waitFor(()=>expect(screen.getByRole('button',{name:'重新刷新'})).toBeVisible());expect(screen.queryByText('已移动 1 个音频')).toBeNull();expect(s.orgApi.apply).toHaveBeenCalledOnce();
});
it('issues a fresh recycle read after the first organization read fails while the old recycle read is pending',async()=>{
    const s=setup(),remote={...s.head,revision:5,layoutRevision:5,media:s.head.media.map(m=>m.mediaId===s.media[0].id?{...m,folderId:folder}:m)};
    s.orgApi.apply.mockRejectedValueOnce(new Error('response lost'));s.orgApi.get.mockRejectedValueOnce(new Error('offline')).mockResolvedValue({runtimeNonce:nonce,projectId:fixture.projectId,organization:remote});
    let oldBin!:(v:{runtimeNonce:string;projectId:string;recycle:typeof s.bin})=>void;
    s.recycleApi.get.mockImplementationOnce(()=>new Promise(r=>oldBin=r)).mockResolvedValue({runtimeNonce:nonce,projectId:fixture.projectId,recycle:{...s.bin,revision:2,trashed:[{mediaId:s.media[0].id,deletedBy:nonce}]}});
    const row=s.start();s.move(row);s.end(row);await waitFor(()=>expect(screen.getByRole('button',{name:'重新刷新'})).toBeVisible());
    fireEvent.click(screen.getByRole('button',{name:'重新刷新'}));await waitFor(()=>expect(s.recycleApi.get).toHaveBeenCalledTimes(2));
    await waitFor(()=>expect(screen.getByText(/部分音频已进入回收站/)).toBeVisible());expect(screen.queryByText('已移动 1 个音频')).toBeNull();
    await act(async()=>oldBin({runtimeNonce:nonce,projectId:fixture.projectId,recycle:s.bin}));expect(s.recycle.snapshot?.revision).toBe(2);expect(screen.queryByText('已移动 1 个音频')).toBeNull();
});
it('issues a fresh organization read after recycle fails and blocks retry if the old read later reveals a deleted target',async()=>{
    const s=setup(),reviewed={...s.head,revision:5,layoutRevision:5},newer={...reviewed,revision:6,layoutRevision:6,folders:[]};
    s.orgApi.apply.mockRejectedValueOnce({code:'RevisionConflict',message:'stale',retryable:true});
    let oldOrg!:(v:{runtimeNonce:string;projectId:string;organization:typeof s.head})=>void;
    s.orgApi.get.mockImplementationOnce(()=>new Promise(r=>oldOrg=r)).mockResolvedValueOnce({runtimeNonce:nonce,projectId:fixture.projectId,organization:reviewed}).mockResolvedValue({runtimeNonce:nonce,projectId:fixture.projectId,organization:newer});
    s.recycleApi.get.mockRejectedValueOnce(new Error('offline')).mockResolvedValue({runtimeNonce:nonce,projectId:fixture.projectId,recycle:s.bin});
    const row=s.start();s.move(row);s.end(row);await waitFor(()=>expect(screen.getByRole('button',{name:'重新刷新'})).toBeVisible());
    fireEvent.click(screen.getByRole('button',{name:'重新刷新'}));await waitFor(()=>expect(screen.getByRole('button',{name:'核对并重试'})).toBeVisible());expect(s.orgApi.get).toHaveBeenCalledTimes(2);
    await act(async()=>oldOrg({runtimeNonce:nonce,projectId:fixture.projectId,organization:newer}));expect(s.organization.snapshot?.revision).toBe(6);
    fireEvent.click(screen.getByRole('button',{name:'核对并重试'}));await waitFor(()=>expect(screen.getByText(/目标文件夹已不存在/)).toBeVisible());expect(s.orgApi.apply).toHaveBeenCalledOnce();
});
it('does not reuse an abandoned recycle read after cancel and a new uncertain move',async()=>{
    const s=setup(),remote={...s.head,revision:5,layoutRevision:5,media:s.head.media.map(m=>m.mediaId===s.media[0].id?{...m,folderId:folder}:m)};
    s.orgApi.apply.mockRejectedValueOnce(new Error('first response lost')).mockRejectedValueOnce(new Error('second response lost'));
    s.orgApi.get.mockRejectedValueOnce(new Error('offline')).mockResolvedValue({runtimeNonce:nonce,projectId:fixture.projectId,organization:remote});
    let oldBin!:(v:{runtimeNonce:string;projectId:string;recycle:typeof s.bin})=>void;
    s.recycleApi.get.mockImplementationOnce(()=>new Promise(r=>oldBin=r)).mockResolvedValue({runtimeNonce:nonce,projectId:fixture.projectId,recycle:{...s.bin,revision:2,trashed:[{mediaId:s.media[0].id,deletedBy:nonce}]}});
    const first=s.start();s.move(first);s.end(first);await waitFor(()=>expect(screen.getByRole('button',{name:'重新刷新'})).toBeVisible());fireEvent.click(screen.getByRole('button',{name:'取消'}));
    const second=s.start();s.move(second);s.end(second);await waitFor(()=>expect(s.recycleApi.get).toHaveBeenCalledTimes(2));
    await waitFor(()=>expect(screen.getByText(/部分音频已进入回收站/)).toBeVisible());expect(screen.queryByText('已移动 1 个音频')).toBeNull();
    await act(async()=>oldBin({runtimeNonce:nonce,projectId:fixture.projectId,recycle:s.bin}));expect(s.recycle.snapshot?.revision).toBe(2);expect(screen.queryByText('已移动 1 个音频')).toBeNull();
});
it.each(['organization','recycle'] as const)('releases a failed pair’s stalled %s gate so ordinary polling continues without retry',async kind=>{
    const s=setup();s.orgApi.apply.mockRejectedValueOnce({code:'RevisionConflict',message:'stale',retryable:true});
    let oldOrg!:(value:{runtimeNonce:string;projectId:string;organization:typeof s.head})=>void,oldBin!:(value:{runtimeNonce:string;projectId:string;recycle:typeof s.bin})=>void;
    if(kind==='organization'){
        s.orgApi.get.mockImplementationOnce(()=>new Promise(r=>oldOrg=r)).mockResolvedValue({runtimeNonce:nonce,projectId:fixture.projectId,organization:{...s.head,revision:5,layoutRevision:5}});
        s.recycleApi.get.mockRejectedValueOnce(new Error('offline'));
    }else{
        s.recycleApi.get.mockImplementationOnce(()=>new Promise(r=>oldBin=r)).mockResolvedValue({runtimeNonce:nonce,projectId:fixture.projectId,recycle:{...s.bin,revision:2}});
        s.orgApi.get.mockRejectedValueOnce(new Error('offline'));
    }
    const row=s.start();s.move(row);s.end(row);await waitFor(()=>expect(screen.getByRole('button',{name:'重新刷新'})).toBeVisible());
    if(kind==='organization'){
        await act(()=>s.organization.refresh());expect(s.orgApi.get).toHaveBeenCalledTimes(2);expect(s.organization.snapshot?.revision).toBe(5);
        await act(async()=>oldOrg({runtimeNonce:nonce,projectId:fixture.projectId,organization:{...s.head,revision:6,layoutRevision:6}}));expect(s.organization.snapshot?.revision).toBe(6);
    }else{
        await act(()=>s.recycle.refresh());expect(s.recycleApi.get).toHaveBeenCalledTimes(2);expect(s.recycle.snapshot?.revision).toBe(2);
        await act(async()=>oldBin({runtimeNonce:nonce,projectId:fixture.projectId,recycle:{...s.bin,revision:3}}));expect(s.recycle.snapshot?.revision).toBe(3);
    }
    expect(s.orgApi.apply).toHaveBeenCalledOnce();expect(screen.getByRole('button',{name:'重新刷新'})).toBeVisible();
});
it.each(['organization','recycle'] as const)('blocks an uncertain move while a newer forced %s refresh is still in flight',async kind=>{
    const s=setup(),moved={...s.head,revision:5,layoutRevision:5,media:s.head.media.map(m=>m.mediaId===s.media[0].id?{...m,folderId:folder}:m)};
    const newer={...moved,revision:6,layoutRevision:6,folders:[]},newBin={...s.bin,revision:2,trashed:[{mediaId:s.media[0].id,deletedBy:nonce}]};
    s.orgApi.apply.mockRejectedValueOnce(new Error('response lost'));
    let orgRead!:(value:{runtimeNonce:string;projectId:string;organization:typeof s.head})=>void,binRead!:(value:{runtimeNonce:string;projectId:string;recycle:typeof s.bin})=>void;
    let forceOrg!:(value:{runtimeNonce:string;projectId:string;organization:typeof s.head})=>void,forceBin!:(value:{runtimeNonce:string;projectId:string;recycle:typeof s.bin})=>void;
    s.orgApi.get.mockImplementationOnce(()=>new Promise(r=>orgRead=r));s.recycleApi.get.mockImplementationOnce(()=>new Promise(r=>binRead=r));
    if(kind==='organization')s.orgApi.get.mockImplementationOnce(()=>new Promise(r=>forceOrg=r)).mockResolvedValue({runtimeNonce:nonce,projectId:fixture.projectId,organization:newer});
    else {s.orgApi.get.mockResolvedValue({runtimeNonce:nonce,projectId:fixture.projectId,organization:moved});s.recycleApi.get.mockImplementationOnce(()=>new Promise(r=>forceBin=r)).mockResolvedValue({runtimeNonce:nonce,projectId:fixture.projectId,recycle:newBin});}
    const row=s.start();s.move(row);s.end(row);await waitFor(()=>expect(orgRead).toBeTypeOf('function'));await waitFor(()=>expect(binRead).toBeTypeOf('function'));
    if(kind==='organization')await act(async()=>orgRead({runtimeNonce:nonce,projectId:fixture.projectId,organization:moved}));
    else await act(async()=>binRead({runtimeNonce:nonce,projectId:fixture.projectId,recycle:s.bin}));
    let forced!:Promise<void>;act(()=>{forced=kind==='organization'?s.organization.refreshAfterVerified():s.recycle.refresh(true);});
    if(kind==='organization')await act(async()=>binRead({runtimeNonce:nonce,projectId:fixture.projectId,recycle:s.bin}));
    else await act(async()=>orgRead({runtimeNonce:nonce,projectId:fixture.projectId,organization:moved}));
    await waitFor(()=>expect(screen.getByRole('button',{name:'重新刷新'})).toBeVisible());expect(screen.queryByText('已移动 1 个音频')).toBeNull();
    await act(async()=>{if(kind==='organization')forceOrg({runtimeNonce:nonce,projectId:fixture.projectId,organization:newer});else forceBin({runtimeNonce:nonce,projectId:fixture.projectId,recycle:newBin});await forced;});
    fireEvent.click(screen.getByRole('button',{name:'重新刷新'}));await waitFor(()=>expect(screen.getByText(kind==='organization'?/目标文件夹已不存在/:/部分音频已进入回收站/)).toBeVisible());
    expect(s.orgApi.apply).toHaveBeenCalledOnce();expect(screen.queryByText('已移动 1 个音频')).toBeNull();
});
it.each(['success','no-op','conflict','unknown-committed','unknown-uncommitted'] as const)('retains a %s result received during a same-owner transition',async outcome=>{
    const s=setup(),moved={...s.head,revision:5,layoutRevision:5,media:s.head.media.map(m=>m.mediaId===s.media[0].id?{...m,folderId:folder}:m)};
    let resolve!:(value:Awaited<ReturnType<typeof s.orgApi.apply>>)=>void,reject!:(error:unknown)=>void;
    s.orgApi.apply.mockImplementationOnce(()=>new Promise((r,j)=>{resolve=r;reject=j;}));
    const row=s.start();s.move(row,outcome==='no-op'?s.root:s.destination);s.end(row);await waitFor(()=>expect(resolve).toBeTypeOf('function'));
    const props={organization:s.organization,recycle:s.recycle,media:s.media,annotations:[],statuses:[],selectedId:s.media[0].id,disabled:false,onSelect:s.onSelect,onImport:vi.fn(),onRelink:vi.fn()};
    s.view.rerender(<MediaList {...props} navigationDisabled/>);
    await act(async()=>{
        if(outcome==='success')resolve({runtimeNonce:nonce,projectId:fixture.projectId,organization:moved});
        else if(outcome==='no-op')resolve({runtimeNonce:nonce,projectId:fixture.projectId,organization:s.head});
        else if(outcome==='conflict')reject({code:'RevisionConflict',message:'远程目录变化',retryable:true});
        else reject(new Error('response lost'));
    });
    expect(screen.getByText(/项目暂不可编辑/)).toBeVisible();expect(screen.getByRole('button',{name:'重新刷新'})).toBeDisabled();expect(s.onSelect).not.toHaveBeenCalled();
    if(outcome==='success'||outcome==='unknown-committed'||outcome==='conflict')s.orgApi.get.mockResolvedValue({runtimeNonce:nonce,projectId:fixture.projectId,organization:moved});
    s.view.rerender(<MediaList {...props} navigationDisabled={false}/>);fireEvent.click(screen.getByRole('button',{name:'重新刷新'}));
    if(outcome==='success'||outcome==='unknown-committed'){
        await waitFor(()=>expect(screen.getByText('已移动 1 个音频')).toBeVisible());await waitFor(()=>expect(screen.getByTitle('目标')).toHaveFocus());
    }else if(outcome==='no-op')await waitFor(()=>expect(screen.getByText('音频已在目标文件夹，未作更改')).toBeVisible());
    else {
        await waitFor(()=>expect(screen.getByRole('button',{name:'核对并重试'})).toBeVisible());expect(s.orgApi.apply).toHaveBeenCalledOnce();
        if(outcome==='conflict')expect(screen.getByText(/远程目录变化/)).toBeVisible();
        fireEvent.click(screen.getByRole('button',{name:'核对并重试'}));await waitFor(()=>expect(s.orgApi.apply).toHaveBeenCalledTimes(2));
        expect(s.orgApi.apply.mock.calls[1][2]).toEqual({type:'moveMediaBatch',mediaIds:[s.media[0].id],folderId:folder});
    }
    expect(s.recycleApi.get).toHaveBeenCalled();expect(s.onSelect).not.toHaveBeenCalled();
});
it.each(['success','conflict','unknown'] as const)('retains an accepted %s result while real lifecycle admission is closed before editing is disabled',async outcome=>{
    const p=realLifecycle(),status=vi.spyOn(collaborationClient,'status').mockResolvedValue({runtimeNonce:nonce,projectId:fixture.projectId,busy:false} as CollaborationStatus);
    let releaseDraft!:()=>void,entered=false,saving!:Promise<void>,transition:Promise<unknown>|undefined;
    const gate=new Promise<void>(resolve=>releaseDraft=resolve);
    p.lifecycle.registerDraft('held',async()=>{entered=true;await gate;p.store.clearDraftIfUnchanged('held','draft');});
    act(()=>{p.store.setDraft('held','draft');saving=p.lifecycle.save();});await waitFor(()=>expect(entered).toBe(true));
    const s=setup(true,null,p.lifecycle,p.owner),moved={...s.head,revision:5,layoutRevision:5,media:s.head.media.map(m=>m.mediaId===s.media[0].id?{...m,folderId:folder}:m)};
    try {
        let resolve!:(value:Awaited<ReturnType<typeof s.orgApi.apply>>)=>void,reject!:(error:unknown)=>void;
        s.orgApi.apply.mockImplementationOnce(()=>new Promise((r,j)=>{resolve=r;reject=j;}));const row=s.start();s.move(row);s.end(row);await waitFor(()=>expect(resolve).toBeTypeOf('function'));
        act(()=>{transition=p.lifecycle.transition(async()=>{throw {code:'SaveFailed',message:'transition failed',retryable:true};}).catch(error=>error);});
        expect(p.lifecycle.admissionClosed).toBe(true);expect(p.store.editingDisabled).toBe(false);
        await act(async()=>{if(outcome==='success')resolve({runtimeNonce:nonce,projectId:fixture.projectId,organization:moved});else if(outcome==='conflict')reject({code:'RevisionConflict',message:'远程目录变化',retryable:true});else reject(new Error('response lost'));});
        await waitFor(()=>expect(screen.getByText(/项目暂不可编辑/)).toBeVisible());expect(screen.getByRole('button',{name:'重新刷新'})).toBeDisabled();
        expect(screen.queryByText('已移动 1 个音频')).toBeNull();expect(s.orgApi.get).not.toHaveBeenCalled();expect(s.recycleApi.get).not.toHaveBeenCalled();expect(s.onSelect).not.toHaveBeenCalled();
        s.orgApi.get.mockResolvedValue({runtimeNonce:nonce,projectId:fixture.projectId,organization:moved});
        await act(async()=>{releaseDraft();await saving;expect(await transition).toMatchObject({code:'SaveFailed',message:'transition failed'});});
        expect(p.lifecycle.admissionClosed).toBe(false);expect(p.store.editingDisabled).toBe(false);expect(screen.getByRole('button',{name:'重新刷新'})).toBeEnabled();
        fireEvent.click(screen.getByRole('button',{name:'重新刷新'}));
        if(outcome==='conflict'){
            await waitFor(()=>expect(screen.getByRole('button',{name:'核对并重试'})).toBeVisible());expect(screen.getByText(/远程目录变化/)).toBeVisible();expect(s.orgApi.apply).toHaveBeenCalledOnce();
        }else{
            await waitFor(()=>expect(screen.getByText('已移动 1 个音频')).toBeVisible());await waitFor(()=>expect(screen.getByTitle('目标')).toHaveFocus());
        }
        expect(s.recycleApi.get).toHaveBeenCalled();expect(s.onSelect).not.toHaveBeenCalled();
    } finally {
        releaseDraft();await saving.catch(()=>{});await transition?.catch(()=>{});s.view.unmount();p.lifecycle.dispose();status.mockRestore();
    }
});
it('retains a committed result while a real transition drains its accepted edit and deferred draft',async()=>{
    const p=realLifecycle(),status=vi.spyOn(collaborationClient,'status').mockResolvedValue({runtimeNonce:nonce,projectId:fixture.projectId,busy:false} as CollaborationStatus),s=setup(true,null,p.lifecycle,p.owner);
    let releaseDraft!:()=>void,transition:Promise<unknown>|undefined;
    p.lifecycle.registerDraft('held',async()=>{await new Promise<void>(resolve=>releaseDraft=resolve);p.store.clearDraftIfUnchanged('held','draft');});
    try {
        let resolve!:(value:Awaited<ReturnType<typeof s.orgApi.apply>>)=>void;s.orgApi.apply.mockImplementationOnce(()=>new Promise(r=>resolve=r));
        const row=s.start();s.move(row);s.end(row);await waitFor(()=>expect(resolve).toBeTypeOf('function'));
        act(()=>{p.store.setDraft('held','draft');transition=p.lifecycle.transition(async()=>{throw {code:'SaveFailed',message:'transition failed',retryable:true};}).catch(error=>error);});
        const moved={...s.head,revision:5,layoutRevision:5,media:s.head.media.map(m=>m.mediaId===s.media[0].id?{...m,folderId:folder}:m)};
        await act(async()=>resolve({runtimeNonce:nonce,projectId:fixture.projectId,organization:moved}));await waitFor(()=>expect(releaseDraft).toBeTypeOf('function'));
        expect(p.lifecycle.admissionClosed).toBe(true);expect(p.store.editingDisabled).toBe(false);expect(screen.getByText(/项目暂不可编辑/)).toBeVisible();expect(screen.queryByText('已移动 1 个音频')).toBeNull();
        s.orgApi.get.mockResolvedValue({runtimeNonce:nonce,projectId:fixture.projectId,organization:moved});await act(async()=>{releaseDraft();expect(await transition).toMatchObject({code:'SaveFailed'});});
        fireEvent.click(screen.getByRole('button',{name:'重新刷新'}));await waitFor(()=>expect(screen.getByText('已移动 1 个音频')).toBeVisible());expect(s.onSelect).not.toHaveBeenCalled();
    } finally {releaseDraft?.();await transition?.catch(()=>{});s.view.unmount();p.lifecycle.dispose();status.mockRestore();}
});
it('disables a ready retry during live lifecycle admission and restores it after a failed transition',async()=>{
    const p=realLifecycle(),s=setup(true,null,p.lifecycle);let releaseDraft!:()=>void;
    p.lifecycle.registerDraft('held',async()=>{await new Promise<void>(resolve=>releaseDraft=resolve);p.store.clearDraftIfUnchanged('held','draft');});
    try {
        s.orgApi.apply.mockRejectedValueOnce({code:'RevisionConflict',message:'stale',retryable:true});const row=s.start();s.move(row);s.end(row);await waitFor(()=>expect(screen.getByRole('button',{name:'核对并重试'})).toBeEnabled());
        let transition!:Promise<unknown>;act(()=>{p.store.setDraft('held','draft');transition=p.lifecycle.transition(async()=>{throw {code:'SaveFailed',message:'transition failed',retryable:true};}).catch(error=>error);});
        await waitFor(()=>expect(releaseDraft).toBeTypeOf('function'));expect(p.store.editingDisabled).toBe(false);expect(screen.getByRole('button',{name:'核对并重试'})).toBeDisabled();
        fireEvent.click(screen.getByRole('button',{name:'核对并重试'}));expect(s.orgApi.apply).toHaveBeenCalledOnce();
        await act(async()=>{releaseDraft();expect(await transition).toMatchObject({code:'SaveFailed'});});expect(screen.getByRole('button',{name:'核对并重试'})).toBeEnabled();
        fireEvent.click(screen.getByRole('button',{name:'核对并重试'}));await waitFor(()=>expect(s.orgApi.apply).toHaveBeenCalledTimes(2));
    } finally {releaseDraft?.();s.view.unmount();p.lifecycle.dispose();}
});
it('checks live admission at retry even before a lifecycle notification causes a render',async()=>{
    const state={admissionClosed:false,registerBackgroundGuard:()=>()=>{}},lifecycle=state as unknown as ProjectLifecycle,s=setup(true,null,lifecycle);
    s.orgApi.apply.mockRejectedValueOnce({code:'RevisionConflict',message:'stale',retryable:true});const row=s.start();s.move(row);s.end(row);
    await waitFor(()=>expect(screen.getByRole('button',{name:'核对并重试'})).toBeEnabled());state.admissionClosed=true;
    fireEvent.click(screen.getByRole('button',{name:'核对并重试'}));expect(s.orgApi.apply).toHaveBeenCalledOnce();
    state.admissionClosed=false;fireEvent.click(screen.getByRole('button',{name:'核对并重试'}));await waitFor(()=>expect(s.orgApi.apply).toHaveBeenCalledTimes(2));
});
it('interrupts in-flight reconciliation as soon as real lifecycle admission closes',async()=>{
    const p=realLifecycle(),s=setup(true,null,p.lifecycle);let releaseDraft!:()=>void,finishRead!:(value:{runtimeNonce:string;projectId:string;organization:typeof s.head})=>void,transition:Promise<unknown>|undefined;
    p.lifecycle.registerDraft('held',async()=>{await new Promise<void>(resolve=>releaseDraft=resolve);p.store.clearDraftIfUnchanged('held','draft');});
    try {
        s.orgApi.apply.mockRejectedValueOnce({code:'RevisionConflict',message:'stale',retryable:true});s.orgApi.get.mockImplementationOnce(()=>new Promise(r=>finishRead=r));
        const row=s.start();s.move(row);s.end(row);await waitFor(()=>expect(finishRead).toBeTypeOf('function'));expect(screen.getByText(/正在核对目录和回收站/)).toBeVisible();
        act(()=>{p.store.setDraft('held','draft');transition=p.lifecycle.transition(async()=>{throw {code:'SaveFailed',message:'transition failed',retryable:true};}).catch(error=>error);});
        await waitFor(()=>expect(releaseDraft).toBeTypeOf('function'));expect(p.store.editingDisabled).toBe(false);expect(screen.getByText(/项目暂不可编辑/)).toBeVisible();expect(screen.getByRole('button',{name:'重新刷新'})).toBeDisabled();
        await act(async()=>finishRead({runtimeNonce:nonce,projectId:fixture.projectId,organization:{...s.head,revision:9,layoutRevision:9}}));expect(s.organization.snapshot?.revision).toBe(4);
        await act(async()=>{releaseDraft();expect(await transition).toMatchObject({code:'SaveFailed'});});fireEvent.click(screen.getByRole('button',{name:'重新刷新'}));
        await waitFor(()=>expect(screen.getByRole('button',{name:'核对并重试'})).toBeVisible());expect(s.orgApi.apply).toHaveBeenCalledOnce();
    } finally {releaseDraft?.();await transition?.catch(()=>{});s.view.unmount();p.lifecycle.dispose();}
});
it('retains a confirmed earlier success when the destination changes again before recheck',async()=>{
    const s=setup(),moved={...s.head,revision:5,layoutRevision:5,media:s.head.media.map(m=>m.mediaId===s.media[0].id?{...m,folderId:folder}:m)},changed={...s.head,revision:6,layoutRevision:6};
    let resolve!:(value:Awaited<ReturnType<typeof s.orgApi.apply>>)=>void;s.orgApi.apply.mockImplementationOnce(()=>new Promise(r=>resolve=r));
    const row=s.start();s.move(row);s.end(row);await waitFor(()=>expect(resolve).toBeTypeOf('function'));
    const props={organization:s.organization,recycle:s.recycle,media:s.media,annotations:[],statuses:[],selectedId:s.media[0].id,disabled:false,onSelect:s.onSelect,onImport:vi.fn(),onRelink:vi.fn()};
    s.view.rerender(<MediaList {...props} navigationDisabled/>);await act(async()=>resolve({runtimeNonce:nonce,projectId:fixture.projectId,organization:moved}));
    s.orgApi.get.mockResolvedValue({runtimeNonce:nonce,projectId:fixture.projectId,organization:changed});s.view.rerender(<MediaList {...props} navigationDisabled={false}/>);fireEvent.click(screen.getByRole('button',{name:'重新刷新'}));
    await waitFor(()=>expect(screen.getByRole('button',{name:'核对并重试'})).toBeVisible());expect(screen.getByText(/移动已完成/)).toBeVisible();expect(screen.queryByText('已移动 1 个音频')).toBeNull();expect(s.orgApi.apply).toHaveBeenCalledOnce();
});
it.each(['organization','recycle'] as const)('releases a stalled %s read after cancelling review and ignores its late response',async kind=>{
    const s=setup();s.orgApi.apply.mockRejectedValueOnce({code:'RevisionConflict',message:'stale',retryable:true});
    let finishOrg!:(value:{runtimeNonce:string;projectId:string;organization:typeof s.head})=>void,finishBin!:(value:{runtimeNonce:string;projectId:string;recycle:typeof s.bin})=>void;
    if(kind==='organization')s.orgApi.get.mockImplementationOnce(()=>new Promise(r=>finishOrg=r)).mockResolvedValue({runtimeNonce:nonce,projectId:fixture.projectId,organization:{...s.head,revision:5,layoutRevision:5}});
    else s.recycleApi.get.mockImplementationOnce(()=>new Promise(r=>finishBin=r)).mockResolvedValue({runtimeNonce:nonce,projectId:fixture.projectId,recycle:{...s.bin,revision:2}});
    const row=s.start();s.move(row);s.end(row);await waitFor(()=>expect(screen.getByText(/正在核对目录和回收站/)).toBeVisible());
    fireEvent.click(screen.getByRole('button',{name:'取消'}));
    if(kind==='organization'){
        await act(()=>s.organization.refresh());expect(s.orgApi.get).toHaveBeenCalledTimes(2);expect(s.organization.snapshot?.revision).toBe(5);
        await act(async()=>finishOrg({runtimeNonce:nonce,projectId:fixture.projectId,organization:{...s.head,revision:9,layoutRevision:9}}));expect(s.organization.snapshot?.revision).toBe(5);
    }else{
        await act(()=>s.recycle.refresh());expect(s.recycleApi.get).toHaveBeenCalledTimes(2);expect(s.recycle.snapshot?.revision).toBe(2);
        await act(async()=>finishBin({runtimeNonce:nonce,projectId:fixture.projectId,recycle:{...s.bin,revision:9}}));expect(s.recycle.snapshot?.revision).toBe(2);
    }
    expect(screen.queryByText(/正在核对目录和回收站/)).toBeNull();expect(s.onSelect).not.toHaveBeenCalled();
});
it.each(['resolve','reject'] as const)('retains a batch when edit authority is temporarily interrupted and the review reads %s',async result=>{
    const s=setup();s.orgApi.apply.mockRejectedValueOnce({code:'RevisionConflict',message:'stale',retryable:true});
    fireEvent.click(screen.getByRole('button',{name:'多选音频'}));fireEvent.click(screen.getByRole('checkbox',{name:'选择音频 · 1.wav'}));fireEvent.click(screen.getByRole('checkbox',{name:'选择音频 · 2.wav'}));
    let resolve!:(value:{runtimeNonce:string;projectId:string;organization:typeof s.head})=>void,reject!:(error:Error)=>void;
    s.orgApi.get.mockImplementationOnce(()=>new Promise((r,j)=>{resolve=r;reject=j;}));
    const row=s.start();s.move(row);s.end(row);await waitFor(()=>expect(resolve).toBeTypeOf('function'));
    const props={organization:s.organization,recycle:s.recycle,media:s.media,annotations:[],statuses:[],selectedId:s.media[0].id,disabled:false,onSelect:s.onSelect,onImport:vi.fn(),onRelink:vi.fn()};
    s.view.rerender(<MediaList {...props} navigationDisabled/>);
    await act(async()=>{if(result==='resolve')resolve({runtimeNonce:nonce,projectId:fixture.projectId,organization:s.head});else reject(new Error('offline'));});
    expect(screen.getByText(/项目暂不可编辑/)).toBeVisible();expect(screen.queryByText(/正在核对目录和回收站/)).toBeNull();
    s.view.rerender(<MediaList {...props} navigationDisabled={false}/>);fireEvent.click(screen.getByRole('button',{name:'重新刷新'}));
    await waitFor(()=>expect(screen.getByRole('button',{name:'核对并重试'})).toBeVisible());
    fireEvent.click(screen.getByText('查看要移动的音频'));await waitFor(()=>expect(screen.getByText('1.wav',{selector:'li'})).toBeVisible());expect(screen.getByText('2.wav',{selector:'li'})).toBeVisible();
    fireEvent.click(screen.getByRole('button',{name:'核对并重试'}));await waitFor(()=>expect(s.orgApi.apply).toHaveBeenCalledTimes(2));
    expect(s.orgApi.apply.mock.calls[1][2]).toEqual({type:'moveMediaBatch',mediaIds:[s.media[0].id,s.media[1].id],folderId:folder});expect(s.onSelect).not.toHaveBeenCalled();
});
it('retires both pending review reads immediately when editing is interrupted',async()=>{
    const s=setup();s.orgApi.apply.mockRejectedValueOnce({code:'RevisionConflict',message:'stale',retryable:true});
    let org!:(value:{runtimeNonce:string;projectId:string;organization:typeof s.head})=>void,bin!:(value:{runtimeNonce:string;projectId:string;recycle:typeof s.bin})=>void;
    s.orgApi.get.mockImplementationOnce(()=>new Promise(r=>org=r)).mockResolvedValue({runtimeNonce:nonce,projectId:fixture.projectId,organization:{...s.head,revision:5,layoutRevision:5}});
    s.recycleApi.get.mockImplementationOnce(()=>new Promise(r=>bin=r)).mockResolvedValue({runtimeNonce:nonce,projectId:fixture.projectId,recycle:{...s.bin,revision:2}});
    const row=s.start();s.move(row);s.end(row);await waitFor(()=>expect(org).toBeTypeOf('function'));await waitFor(()=>expect(bin).toBeTypeOf('function'));
    const props={organization:s.organization,recycle:s.recycle,media:s.media,annotations:[],statuses:[],selectedId:s.media[0].id,disabled:false,onSelect:s.onSelect,onImport:vi.fn(),onRelink:vi.fn()};
    s.view.rerender(<MediaList {...props} navigationDisabled/>);expect(screen.getByText(/项目暂不可编辑/)).toBeVisible();expect(screen.queryByText(/正在核对目录和回收站/)).toBeNull();
    await act(async()=>{await Promise.all([s.organization.refresh(),s.recycle.refresh()]);});expect(s.orgApi.get).toHaveBeenCalledTimes(2);expect(s.recycleApi.get).toHaveBeenCalledTimes(2);
    await act(async()=>{org({runtimeNonce:nonce,projectId:fixture.projectId,organization:{...s.head,revision:9,layoutRevision:9}});bin({runtimeNonce:nonce,projectId:fixture.projectId,recycle:{...s.bin,revision:9}});});
    expect(s.organization.snapshot?.revision).toBe(5);expect(s.recycle.snapshot?.revision).toBe(2);
    s.view.rerender(<MediaList {...props} navigationDisabled={false}/>);fireEvent.click(screen.getByRole('button',{name:'重新刷新'}));await waitFor(()=>expect(screen.getByRole('button',{name:'核对并重试'})).toBeVisible());
});
it('releases the background guard on owner replacement and unregisters it on unmount',()=>{
    const guards=new Set<()=>boolean>(),unregister=vi.fn(),lifecycle={registerBackgroundGuard:(guard:()=>boolean)=>{guards.add(guard);return()=>{guards.delete(guard);unregister();};}} as unknown as ProjectLifecycle;
    const s=setup(true,null,lifecycle),guard=[...guards][0];expect(guard()).toBe(true);const row=s.start();s.move(row);expect(guard()).toBe(false);
    const organization=new OrganizationController(fixture.projectId,nonce,true,{get:vi.fn(),apply:vi.fn()});organization.snapshot=s.head;
    const recycle=new RecycleController(fixture.projectId,nonce,true,{get:vi.fn(),apply:vi.fn()});recycle.snapshot=s.bin;
    s.view.rerender(<MediaList organization={organization} recycle={recycle} lifecycle={lifecycle} media={s.media} annotations={[]} statuses={[]} selectedId={s.media[0].id} disabled={false} onSelect={s.onSelect} onImport={vi.fn()} onRelink={vi.fn()}/>);
    expect(guard()).toBe(true);expect(s.destination).not.toHaveClass('is-drop-target');s.view.unmount();expect(unregister).toHaveBeenCalledOnce();expect(guards.size).toBe(0);
});
it('clears pointer intent when the same owner temporarily loses editing authority',()=>{
    const guards=new Set<()=>boolean>(),lifecycle={registerBackgroundGuard:(guard:()=>boolean)=>{guards.add(guard);return()=>guards.delete(guard);}} as unknown as ProjectLifecycle;
    const s=setup(true,null,lifecycle),guard=[...guards][0],row=s.start();s.move(row);expect(guard()).toBe(false);
    s.view.rerender(<MediaList organization={s.organization} recycle={s.recycle} lifecycle={lifecycle} media={s.media} annotations={[]} statuses={[]} selectedId={s.media[0].id} disabled={false} navigationDisabled onSelect={s.onSelect} onImport={vi.fn()} onRelink={vi.fn()}/>);
    expect(guard()).toBe(true);expect(s.destination).not.toHaveClass('is-drop-target');s.end(row);expect(s.orgApi.apply).not.toHaveBeenCalled();
});
it('requires another explicit review after purge state changes following a verified conflict read', async () => {
    const s=setup();s.orgApi.apply.mockRejectedValueOnce({code:'RevisionConflict',message:'stale',retryable:true});
    const row=s.start();s.move(row);s.end(row);await waitFor(()=>expect(screen.getByRole('button',{name:'核对并重试'})).toBeVisible());
    act(()=>s.recycle.purge.cancel());fireEvent.click(screen.getByRole('button',{name:'核对并重试'}));
    await waitFor(()=>expect(s.recycleApi.get).toHaveBeenCalledTimes(2));expect(s.orgApi.apply).toHaveBeenCalledOnce();
    await waitFor(()=>expect(screen.getByRole('button',{name:'核对并重试'})).toBeVisible());
});
it('discards a late mutation response when the project controller is replaced', async () => {
    const s = setup(); let resolve!:(value:Awaited<ReturnType<typeof s.orgApi.apply>>)=>void; s.orgApi.apply.mockImplementationOnce(() => new Promise(r => { resolve=r; }));
    const row=s.start();s.move(row);s.end(row);await waitFor(()=>expect(resolve).toBeTypeOf('function'));
    const replacement=new OrganizationController(fixture.projectId,nonce,true,{get:vi.fn(),apply:vi.fn()});replacement.snapshot=s.head;
    const replacementRecycle=new RecycleController(fixture.projectId,nonce,true,{get:vi.fn(),apply:vi.fn()});replacementRecycle.snapshot=s.bin;
    s.view.rerender(<MediaList organization={replacement} recycle={replacementRecycle} media={s.media} annotations={[]} statuses={[]} selectedId={s.media[0].id} disabled={false} onSelect={s.onSelect} onImport={vi.fn()} onRelink={vi.fn()}/>);
    await act(async()=>resolve({runtimeNonce:nonce,projectId:fixture.projectId,organization:{...s.head,revision:5}}));
    expect(screen.queryByText('已移动 1 个音频')).toBeNull();expect(screen.queryByRole('button',{name:'核对并重试'})).toBeNull();
});
it.each(['success','conflict','unknown'] as const)('does not apply a late %s result across a lifecycle replacement with the same controllers',async outcome=>{
    const guard=()=>()=>{},first={registerBackgroundGuard:guard} as unknown as ProjectLifecycle,next={registerBackgroundGuard:guard} as unknown as ProjectLifecycle;
    const s=setup(true,null,first);let resolve!:(value:Awaited<ReturnType<typeof s.orgApi.apply>>)=>void,reject!:(error:unknown)=>void;
    s.orgApi.apply.mockImplementationOnce(()=>new Promise((r,j)=>{resolve=r;reject=j;}));const row=s.start();s.move(row);s.end(row);await waitFor(()=>expect(resolve).toBeTypeOf('function'));
    s.view.rerender(<MediaList organization={s.organization} recycle={s.recycle} lifecycle={next} media={s.media} annotations={[]} statuses={[]} selectedId={s.media[0].id} disabled={false} onSelect={s.onSelect} onImport={vi.fn()} onRelink={vi.fn()}/>);
    await act(async()=>{if(outcome==='success')resolve({runtimeNonce:nonce,projectId:fixture.projectId,organization:{...s.head,revision:5}});else if(outcome==='conflict')reject({code:'RevisionConflict',message:'stale',retryable:true});else reject(new Error('response lost'));});
    expect(screen.queryByText('已移动 1 个音频')).toBeNull();expect(screen.queryByRole('button',{name:'重新刷新'})).toBeNull();expect(screen.queryByRole('button',{name:'核对并重试'})).toBeNull();expect(s.onSelect).not.toHaveBeenCalled();
});
it.each(['lifecycle','recycle'] as const)('does not focus a previous owner’s target when its completion frame runs after a %s replacement',async replacement=>{
    let frame:FrameRequestCallback|undefined;const raf=vi.spyOn(window,'requestAnimationFrame').mockImplementation(callback=>{frame=callback;return 1;});
    try {
        const guard=()=>()=>{},first={registerBackgroundGuard:guard} as unknown as ProjectLifecycle,next={registerBackgroundGuard:guard} as unknown as ProjectLifecycle;
        const s=setup(true,null,first),row=s.start();s.move(row);s.end(row);await waitFor(()=>expect(frame).toBeTypeOf('function'));
        const recycle=new RecycleController(fixture.projectId,nonce,true,{get:vi.fn(),apply:vi.fn()});recycle.snapshot=s.bin;
        s.view.rerender(<MediaList organization={s.organization} recycle={replacement==='recycle'?recycle:s.recycle} lifecycle={replacement==='lifecycle'?next:first} media={s.media} annotations={[]} statuses={[]} selectedId={s.media[0].id} disabled={false} onSelect={s.onSelect} onImport={vi.fn()} onRelink={vi.fn()}/>);
        const root=screen.getByRole('button',{name:/全部音频/});root.focus();act(()=>frame!(0));expect(root).toHaveFocus();expect(screen.getByTitle('目标')).not.toHaveFocus();
    } finally {raf.mockRestore();}
});
it('replays queued destination focus when a same-owner lifecycle transition fails',async()=>{
    let frame:FrameRequestCallback|undefined,releaseDraft!:()=>void,transition:Promise<unknown>|undefined;
    const raf=vi.spyOn(window,'requestAnimationFrame').mockImplementation(callback=>{frame=callback;return 1;}),p=realLifecycle(),s=setup(true,null,p.lifecycle);
    p.lifecycle.registerDraft('held',async()=>{await new Promise<void>(resolve=>releaseDraft=resolve);p.store.clearDraftIfUnchanged('held','draft');});
    try {
        const row=s.start();s.move(row);s.end(row);await waitFor(()=>expect(frame).toBeTypeOf('function'));
        act(()=>{p.store.setDraft('held','draft');transition=p.lifecycle.transition(async()=>{throw {code:'SaveFailed',message:'transition failed',retryable:true};}).catch(error=>error);});
        await waitFor(()=>expect(releaseDraft).toBeTypeOf('function'));expect(p.lifecycle.admissionClosed).toBe(true);expect(p.store.editingDisabled).toBe(false);
        const root=screen.getByRole('button',{name:/全部音频/});root.focus();const firstFrame=frame!;act(()=>firstFrame(0));expect(root).toHaveFocus();expect(screen.getByTitle('目标')).not.toHaveFocus();
        await act(async()=>{releaseDraft();expect(await transition).toMatchObject({code:'SaveFailed'});});
        expect(frame).not.toBe(firstFrame);act(()=>frame!(0));expect(screen.getByTitle('目标')).toHaveFocus();
    } finally {releaseDraft?.();await transition?.catch(()=>{});s.view.unmount();p.lifecycle.dispose();raf.mockRestore();}
});
it.each(['owner','pointer','keyboard','unmount'] as const)('cancels deferred destination focus on %s during a lifecycle transition',async change=>{
    let frame:FrameRequestCallback|undefined,releaseDraft!:()=>void,transition:Promise<unknown>|undefined;
    const raf=vi.spyOn(window,'requestAnimationFrame').mockImplementation(callback=>{frame=callback;return 1;}),p=realLifecycle(),s=setup(true,null,p.lifecycle);
    p.lifecycle.registerDraft('held',async()=>{await new Promise<void>(resolve=>releaseDraft=resolve);p.store.clearDraftIfUnchanged('held','draft');});
    try {
        const row=s.start();s.move(row);s.end(row);await waitFor(()=>expect(frame).toBeTypeOf('function'));
        act(()=>{p.store.setDraft('held','draft');transition=p.lifecycle.transition(async()=>{throw {code:'SaveFailed',message:'transition failed',retryable:true};}).catch(error=>error);});
        await waitFor(()=>expect(releaseDraft).toBeTypeOf('function'));const oldFrame=frame!;act(()=>oldFrame(0));
        if(change==='owner'){
            const replacement=new OrganizationController(fixture.projectId,nonce,true,{get:vi.fn(),apply:vi.fn()});replacement.snapshot=s.head;
            const recycle=new RecycleController(fixture.projectId,nonce,true,{get:vi.fn(),apply:vi.fn()});recycle.snapshot=s.bin;
            s.view.rerender(<MediaList organization={replacement} recycle={recycle} media={s.media} annotations={[]} statuses={[]} selectedId={s.media[0].id} disabled={false} onSelect={s.onSelect} onImport={vi.fn()} onRelink={vi.fn()}/>);
        }else if(change==='pointer')fireEvent.pointerDown(document.body);
        else if(change==='keyboard')fireEvent.keyDown(document.body,{key:'Tab'});
        else s.view.unmount();
        const focus=change==='unmount'?document.body:screen.getByRole('button',{name:/全部音频/});if(change!=='unmount')focus.focus();
        await act(async()=>{releaseDraft();expect(await transition).toMatchObject({code:'SaveFailed'});});
        act(()=>frame!(0));if(change!=='unmount'){expect(focus).toHaveFocus();expect(screen.getByTitle('目标')).not.toHaveFocus();}else expect(screen.queryByTitle('目标')).toBeNull();
        if(change==='pointer'||change==='keyboard')expect(screen.getByRole('button',{name:'查看目标'})).toBeVisible();
    } finally {releaseDraft?.();await transition?.catch(()=>{});s.view.unmount();p.lifecycle.dispose();raf.mockRestore();}
});
