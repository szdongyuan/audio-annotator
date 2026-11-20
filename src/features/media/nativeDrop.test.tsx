import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, render, renderHook, waitFor } from '@testing-library/react';
import { memo } from 'react';
import type { ProjectLifecycleUI } from '../project/useProjectLifecycle';
import type { MediaUI } from './useMedia';
import { useNativeDrop } from './useNativeDrop';

const api = vi.hoisted(() => ({ capture: vi.fn(), preflight: vi.fn(), listen: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: vi.fn() }));
vi.mock('@tauri-apps/api/webview', () => ({ getCurrentWebview: () => ({ onDragDropEvent: api.listen }) }));
vi.mock('../../bridge/dragDrop', () => ({ captureDropSession: api.capture, preflightDrop: api.preflight }));

const projectId = '22222222-2222-4222-8222-222222222222', nonce = '11111111-1111-4111-8111-111111111111';
const folderA = '33333333-3333-4333-8333-333333333333', folderB = '44444444-4444-4444-8444-444444444444';
let listener: (value: { payload: unknown }) => void;
const send = (payload: unknown) => act(() => listener({ payload }));
function fixture(shared = true) {
    const owner = { store: { editingDisabled: false, snapshot: { document: { projectId } } }, lifecycle: { admissionClosed: false }, ...(shared ? { collaboration: { runtimeNonce: nonce, canImportMedia: true } } : {}) };
    const project = { active: owner, busy: false, closePending: false, recovery: null } as unknown as ProjectLifecycleUI;
    const organization = shared ? { projectId, runtimeNonce: nonce, snapshot: { layoutRevision: 8, folders: [{ id: folderA }, { id: folderB }] }, selectedFolderId: folderA } : null;
    const controller = { occupied: false, startDropped: vi.fn(async () => true) };
    const source = { beginDropped: vi.fn(() => true) };
    const media = { organization, controller, source } as unknown as MediaUI;
    api.capture.mockResolvedValue({ projectId, runtimeNonce: nonce, shared });
    api.preflight.mockImplementation(async (session, paths, target) => ({ session, paths, target, kind: 'audio' }));
    return { owner, project, media, organization, controller, source };
}
beforeEach(() => {
    vi.clearAllMocks();
    api.listen.mockImplementation(async (callback: typeof listener) => { listener = callback; return vi.fn(); });
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: vi.fn(() => null) });
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 });
});
afterEach(() => { document.body.innerHTML = ''; });
const enter = () => send({ type: 'enter', position: { x: 20, y: 20 }, paths: ['D:/a.wav'] });
const drop = () => send({ type: 'drop', position: { x: 100, y: 120 }, paths: ['D:/a.wav'] });

it('converts physical coordinates and uses the actual folder at release after crossing targets', async () => {
    const s = fixture(), a = document.createElement('div'), b = document.createElement('div');
    a.dataset.dropFolder = folderA; b.dataset.dropFolder = folderB; document.body.append(a, b);
    vi.mocked(document.elementFromPoint).mockImplementation((x, y) => x === 50 && y === 60 ? b : a);
    const hook = renderHook(() => useNativeDrop(s.project, s.media)); await waitFor(() => expect(listener).toBeTypeOf('function'));
    enter(); send({ type: 'over', position: { x: 20, y: 20 } }); expect(hook.result.current.target?.folderId).toBe(folderA);
    drop(); await waitFor(() => expect(s.controller.startDropped).toHaveBeenCalledOnce());
    expect(document.elementFromPoint).toHaveBeenCalledWith(50, 60);
    expect(api.preflight).toHaveBeenCalledWith({ projectId, runtimeNonce: nonce, shared: true }, ['D:/a.wav'], { folderId: folderB, layoutRevision: 8 });
});
it('does not rerender the parent or media list for repeated native over events on the same target', async () => {
    const s=fixture(),a=document.createElement('div'),b=document.createElement('div'),root=document.createElement('div'),stale=document.createElement('div');
    a.dataset.dropFolder=folderA;b.dataset.dropFolder=folderB;root.dataset.dropFolder='';stale.dataset.dropFolder='55555555-5555-4555-8555-555555555555';document.body.append(a,b,root,stale);
    const folders=[{id:folderA},{id:folderB},...Array.from({length:9998},(_,i)=>({id:`00000000-0000-4000-8000-${(i+1).toString(16).padStart(12,'0')}`}))];s.organization!.snapshot.folders=folders;
    const indexBuild=vi.spyOn(folders,'map');let hit:Element=a,parentRenders=0,listRenders=0;vi.mocked(document.elementFromPoint).mockImplementation(()=>hit);
    const ids=Array.from({length:10000},(_,i)=>i);
    const MediaListProbe=memo(({target}:{target:{folderId:string|null}|null})=>{listRenders++;return <span data-testid="target">{target===null?'none':`${target.folderId??'root'}:${ids.reduce((n)=>n+1,0)}`}</span>;});
    function Harness(){parentRenders++;const state=useNativeDrop(s.project,s.media);return <MediaListProbe target={state.target}/>;}
    const view=render(<Harness/>);await waitFor(()=>expect(api.listen).toHaveBeenCalled());enter();expect(view.getByTestId('target')).toHaveTextContent(folderA);
    let parents=parentRenders,lists=listRenders;for(let i=0;i<100;i++)send({type:'over',position:{x:20+i,y:20}});
    expect(parentRenders).toBe(parents);expect(listRenders).toBe(lists);expect(indexBuild).toHaveBeenCalledOnce();
    hit=b;send({type:'over',position:{x:30,y:20}});expect(view.getByTestId('target')).toHaveTextContent(folderB);expect(parentRenders).toBeGreaterThan(parents);expect(listRenders).toBeGreaterThan(lists);
    hit=stale;send({type:'over',position:{x:30,y:20}});parents=parentRenders;lists=listRenders;for(let i=0;i<20;i++)send({type:'over',position:{x:30,y:20}});expect(parentRenders).toBe(parents);expect(listRenders).toBe(lists);
    hit=root;send({type:'over',position:{x:30,y:20}});expect(view.getByTestId('target')).toHaveTextContent('root:10000');parents=parentRenders;lists=listRenders;
    for(let i=0;i<20;i++)send({type:'over',position:{x:30,y:20}});expect(parentRenders).toBe(parents);expect(listRenders).toBe(lists);
});
it('falls back to the selected folder or root and imports ordinary-project audio without a target', async () => {
    const s = fixture(); const hook = renderHook(() => useNativeDrop(s.project, s.media)); await waitFor(() => expect(api.listen).toHaveBeenCalled());
    enter(); drop(); await waitFor(() => expect(api.preflight).toHaveBeenCalledTimes(1));
    expect(api.preflight.mock.calls[0][2]).toEqual({ folderId: folderA, layoutRevision: 8 });
    s.organization!.selectedFolderId = null as unknown as string; enter(); drop(); await waitFor(() => expect(api.preflight).toHaveBeenCalledTimes(2));
    expect(api.preflight.mock.calls[1][2]).toEqual({ folderId: null, layoutRevision: 8 }); hook.unmount();
    const n = fixture(false); renderHook(() => useNativeDrop(n.project, n.media)); await waitFor(() => expect(api.listen).toHaveBeenCalledTimes(2));
    enter(); drop(); await waitFor(() => expect(n.controller.startDropped).toHaveBeenCalledOnce()); expect(api.preflight.mock.calls[2][2]).toBeNull();
});
it.each(['zip', 'folder'] as const)('routes dropped %s to the existing preview', async kind => {
    const s = fixture(); api.preflight.mockImplementation(async (session, paths, target) => ({ session, paths, target, kind }));
    renderHook(() => useNativeDrop(s.project, s.media)); await waitFor(() => expect(api.listen).toHaveBeenCalled()); enter(); drop();
    await waitFor(() => expect(s.source.beginDropped).toHaveBeenCalledOnce()); expect(s.controller.startDropped).not.toHaveBeenCalled();
});
it('invalidates a delayed capture when a same-ID project is closed and reopened', async () => {
    const s = fixture(); let resolve!: (value: unknown) => void; api.capture.mockReturnValue(new Promise(r => { resolve = r; }));
    const hook = renderHook(({ project }) => useNativeDrop(project, s.media), { initialProps: { project: s.project } }); await waitFor(() => expect(api.listen).toHaveBeenCalled());
    enter(); drop(); const replacement = { ...s.owner, store: { ...s.owner.store } }; hook.rerender({ project: { ...s.project, active: replacement } as unknown as ProjectLifecycleUI });
    await act(async () => { resolve({ projectId, runtimeNonce: nonce, shared: true }); });
    expect(api.preflight).not.toHaveBeenCalled(); expect(s.controller.startDropped).not.toHaveBeenCalled();
});
it('ignores a delayed preflight after owner replacement and requires a fresh enter after switching', async () => {
    const s = fixture(); let resolve!: (value: unknown) => void;
    api.preflight.mockImplementation((session, paths, target) => new Promise(r => { resolve = () => r({ session, paths, target, kind: 'audio' }); }));
    const hook = renderHook(({ project }) => useNativeDrop(project, s.media), { initialProps: { project: s.project } }); await waitFor(() => expect(api.listen).toHaveBeenCalled());
    enter(); drop(); await waitFor(() => expect(resolve).toBeTypeOf('function'));
    hook.rerender({ project: { ...s.project, active: { ...s.owner } } as unknown as ProjectLifecycleUI });
    await act(async () => resolve(null)); expect(s.controller.startDropped).not.toHaveBeenCalled();
    send({ type: 'over', position: { x: 20, y: 20 } }); drop(); expect(api.preflight).toHaveBeenCalledTimes(1);
});
it('rejects missing project, busy importer and modal, and cancels on leave', async () => {
    const s = fixture(), hook = renderHook(({ project }) => useNativeDrop(project, s.media), { initialProps: { project: { ...s.project, active: null } as ProjectLifecycleUI } }); await waitFor(() => expect(api.listen).toHaveBeenCalled());
    enter(); expect(hook.result.current.message).toContain('打开或新建');
    hook.rerender({ project: s.project }); s.controller.occupied = true; enter(); expect(hook.result.current.message).toContain('已有导入'); s.controller.occupied = false;
    const dialog = document.createElement('div'); dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal','true'); document.body.append(dialog); enter(); expect(hook.result.current.message).toContain('关闭当前窗口'); dialog.remove();
    enter(); send({ type: 'leave' }); drop(); expect(api.preflight).not.toHaveBeenCalled();
});
it('reports native source validation and readonly errors without starting an importer', async () => {
    const s=fixture(); api.preflight.mockRejectedValueOnce({message:'项目分享包请使用「导入分享文件…」入口'});
    const hook=renderHook(()=>useNativeDrop(s.project,s.media));await waitFor(()=>expect(api.listen).toHaveBeenCalled());
    enter();drop();await waitFor(()=>expect(hook.result.current.message).toContain('导入分享文件'));expect(s.controller.startDropped).not.toHaveBeenCalled();
    s.owner.collaboration!.canImportMedia=false;enter();expect(hook.result.current.message).toContain('只读');
});
it('rejects a second enter without cancelling the first released preflight', async () => {
    const s=fixture();let resolve!:(value:unknown)=>void;
    api.preflight.mockImplementationOnce((session,paths,target)=>new Promise(r=>{resolve=()=>r({session,paths,target,kind:'audio'});}));
    const hook=renderHook(()=>useNativeDrop(s.project,s.media));await waitFor(()=>expect(api.listen).toHaveBeenCalled());
    enter();drop();await waitFor(()=>expect(resolve).toBeTypeOf('function'));enter();expect(hook.result.current.message).toContain('已有导入');drop();
    expect(api.preflight).toHaveBeenCalledOnce();await act(async()=>resolve(null));await waitFor(()=>expect(s.controller.startDropped).toHaveBeenCalledOnce());
});
it('retires old-owner busy state without letting its late completion clear a newer preflight', async () => {
    const a=fixture();let finishA!:(value:unknown)=>void,finishB!:(value:unknown)=>void;
    api.preflight.mockImplementationOnce((session,paths,target)=>new Promise(r=>{finishA=()=>r({session,paths,target,kind:'audio'});}));
    const hook=renderHook(({project,media})=>useNativeDrop(project,media),{initialProps:{project:a.project,media:a.media}});await waitFor(()=>expect(api.listen).toHaveBeenCalled());
    enter();drop();await waitFor(()=>expect(finishA).toBeTypeOf('function'));
    const b=fixture();api.preflight.mockImplementationOnce((session,paths,target)=>new Promise(r=>{finishB=()=>r({session,paths,target,kind:'audio'});}));
    hook.rerender({project:b.project,media:b.media});enter();drop();await waitFor(()=>expect(finishB).toBeTypeOf('function'));
    await act(async()=>finishA(null));enter();expect(hook.result.current.message).toContain('已有导入');drop();expect(api.preflight).toHaveBeenCalledTimes(2);
    await act(async()=>finishB(null));await waitFor(()=>expect(b.controller.startDropped).toHaveBeenCalledOnce());expect(a.controller.startDropped).not.toHaveBeenCalled();
});
it('rejects a hit on a deleted folder instead of falling back to the selected folder', async () => {
    const s=fixture(),stale=document.createElement('div');stale.dataset.dropFolder='55555555-5555-4555-8555-555555555555';document.body.append(stale);
    vi.mocked(document.elementFromPoint).mockReturnValue(stale);const hook=renderHook(()=>useNativeDrop(s.project,s.media));await waitFor(()=>expect(api.listen).toHaveBeenCalled());
    enter();drop();expect(hook.result.current.message).toContain('目标文件夹已变化');expect(api.preflight).not.toHaveBeenCalled();
});
it('allows nonmodal dialog popovers and blocks actual modal dialogs', async () => {
    const s=fixture(),popover=document.createElement('div');popover.setAttribute('role','dialog');document.body.append(popover);
    const hook=renderHook(()=>useNativeDrop(s.project,s.media));await waitFor(()=>expect(api.listen).toHaveBeenCalled());enter();drop();await waitFor(()=>expect(s.controller.startDropped).toHaveBeenCalledOnce());
    popover.setAttribute('aria-modal','true');enter();expect(hook.result.current.message).toContain('关闭当前窗口');expect(api.preflight).toHaveBeenCalledOnce();
});
it('allows the inline category deletion alert while still blocking a modal alertdialog',async()=>{
    const s=fixture(),inline=document.createElement('div');inline.className='category-confirm';inline.setAttribute('role','alertdialog');inline.setAttribute('aria-label','删除类别确认');inline.innerHTML='<p>删除类别？</p><button>确认删除类别</button><button>取消</button>';document.body.append(inline);
    const hook=renderHook(()=>useNativeDrop(s.project,s.media));await waitFor(()=>expect(api.listen).toHaveBeenCalled());enter();drop();await waitFor(()=>expect(s.controller.startDropped).toHaveBeenCalledOnce());
    inline.setAttribute('aria-modal','true');enter();expect(hook.result.current.message).toContain('关闭当前窗口');expect(api.preflight).toHaveBeenCalledOnce();
});
it('allows an open nonmodal native dialog but rejects a native modal dialog',async()=>{
    const s=fixture(),dialog=document.createElement('dialog');dialog.setAttribute('open','');document.body.append(dialog);
    const hook=renderHook(()=>useNativeDrop(s.project,s.media));await waitFor(()=>expect(api.listen).toHaveBeenCalled());enter();drop();await waitFor(()=>expect(s.controller.startDropped).toHaveBeenCalledOnce());
    const original=dialog.matches.bind(dialog);vi.spyOn(dialog,'matches').mockImplementation(selector=>selector===':modal'||original(selector));
    enter();expect(hook.result.current.message).toContain('关闭当前窗口');expect(api.preflight).toHaveBeenCalledOnce();
});
