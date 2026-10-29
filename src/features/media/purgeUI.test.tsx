import { beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { MediaList } from './MediaList';
import { RecycleController } from './recycle';
import { OrganizationController } from './organization';
import type { PurgeCommands, PurgePreview, PurgeResult, PurgeCleanupPage } from '../../bridge/purge';
import { useRecycle } from './useRecycle';
import * as recycleBridge from '../../bridge/recycle';
import { ProjectStore } from '../../app/store';
import { CommandQueue } from '../../app/commands';
import { ProjectLifecycle } from '../project/lifecycle';
import type { ActiveProject } from '../project/useProjectLifecycle';
import { parseProjectDocument } from '../../bridge/types';
import fixture from '../../../tests/fixtures/document-v3.json';

const native = vi.hoisted(() => ({ preview: vi.fn(), commit: vi.fn(), retryCleanup: vi.fn(), cleanupPage: vi.fn(), cancel: vi.fn() }));
vi.mock('../../bridge/purge', async importOriginal => ({ ...await importOriginal<object>(), createPurgeClient: () => native }));
const nonce = '11111111-1111-4111-8111-111111111111', previewId = '22222222-2222-4222-8222-222222222222';
const media = [0, 1, 2].map(i => ({ ...fixture.media[0], id: `00000000-0000-4000-8000-00000000000${i + 1}`, displayName: `audio-${i}.wav` }));
let operationId = nonce;
const result = (): PurgeResult => ({ operationId, projectId: fixture.projectId, runtimeNonce: nonce, status: 'committed-pending-cleanup', removedIds: [media[0].id], retained: [{ mediaId: media[1].id, reason: 'other-author-annotation' }, { mediaId: media[2].id, reason: 'not-in-recycle' }], deletedAudioBytes: 128, cleanupPendingCount: 2, cleanupFailedCount: 1 });
const page = (offset = 0): PurgeCleanupPage => ({ operationId, projectId: fixture.projectId, runtimeNonce: nonce, total: 2, offset, limit: 50, items: [{ cleanupId: 'audio-path', mediaId: media[0].id, displayName: 'audio-0.wav', kind: 'audio', status: 'failed', error: { code: 'SaveFailed', message: 'Windows sharing violation', retryable: true } }, { cleanupId: 'opaque-history', mediaId: null, displayName: '旧作者历史', kind: 'history', status: 'pending', error: null }] });
beforeEach(() => {
    vi.resetAllMocks();
    native.preview.mockImplementation(async (op: string, selection: Parameters<PurgeCommands['preview']>[1]): Promise<PurgePreview> => {
        operationId = op;
        const targets = selection.kind === 'all' ? media : media.filter(m => selection.mediaIds.includes(m.id));
        return { operationId: op, previewId, projectId: fixture.projectId, runtimeNonce: nonce, requestedCount: targets.length, eligibleCount: targets.length, retainedCount: 0, otherAuthorRetainedCount: 0, audioBytes: 4096, requiresFormatUpgrade: true, items: targets.map(m => ({ mediaId: m.id, displayName: m.displayName, reason: null })) };
    });
    native.commit.mockImplementation(async () => result());
    native.retryCleanup.mockImplementation(async () => ({ ...result(), status: 'complete', cleanupPendingCount: 0, cleanupFailedCount: 0 }));
    native.cleanupPage.mockImplementation(async () => page());
    native.cancel.mockResolvedValue(undefined);
});
function setup(writable = true, adopted = media) {
    const head: recycleBridge.Recycle = { kind: 'audio-annotator-recycle' as const, formatVersion: 1 as const, projectId: fixture.projectId, revision: 0, trashed: media.map(m => ({ mediaId: m.id, deletedBy: nonce })), recentOperations: [] };
    const recycleApi = { get: vi.fn(async () => ({ projectId: fixture.projectId, runtimeNonce: nonce, recycle: head })), apply: vi.fn() };
    const recycle = new RecycleController(fixture.projectId, nonce, writable, recycleApi); recycle.snapshot = head;
    const props = { recycle, media: adopted, annotations: [], statuses: [], selectedId: null, disabled: false, onSelect: vi.fn(), onImport: vi.fn(), onRelink: vi.fn() };
    const view = render(<MediaList {...props} />);
    fireEvent.change(screen.getByLabelText('音频列表视图'), { target: { value: 'trash' } });
    return { ...view, props, recycle, recycleApi };
}
const clear = () => fireEvent.click(screen.getByRole('button', { name: '清空回收站…' }));
const confirm = () => fireEvent.click(screen.getByRole('button', { name: '确认永久删除' }));

it('previews a single context target and uses one final irreversible confirmation', async () => {
    setup();
    fireEvent.contextMenu(screen.getByRole('button', { name: 'audio-0.wav' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '永久删除…' }));
    const dialog = await screen.findByRole('dialog', { name: '永久删除音频' });
    expect(native.preview.mock.calls[0].slice(1)).toEqual([{ kind: 'selected', mediaIds: [media[0].id] }, 0, 50]);
    expect(within(dialog).getByText(/请求 1.*可删除 1.*保留 0/)).toBeVisible();
    expect(within(dialog).getByText(/预计音频文件字节：4096/)).toBeVisible();
    expect(within(dialog).getByText(/备注不影响删除权限.*备注一起删除/)).toBeVisible();
    expect(within(dialog).getByText(/旧版将无法打开/)).toBeVisible();
    expect(within(dialog).getByText(/不可恢复/)).toBeVisible();
    expect(within(dialog).getByText(/项目内副本.*原始音频.*ZIP/)).toBeVisible();
    expect(native.commit).not.toHaveBeenCalled();
    confirm(); await screen.findByText('已从项目移除：1');
    expect(native.commit).toHaveBeenCalledWith(previewId, operationId);
});

it('fixes batch targets and sends all regardless of filters or adopted media', async () => {
    const s = setup(true, [media[0]]);
    fireEvent.click(screen.getByRole('button', { name: 'audio-0.wav' }));
    fireEvent.click(screen.getByRole('button', { name: '永久删除…' }));
    await screen.findByRole('button', { name: '确认永久删除' });
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    fireEvent.change(screen.getByLabelText('搜索音频'), { target: { value: 'no-match' } });
    clear(); await screen.findByRole('button', { name: '确认永久删除' });
    expect(native.preview.mock.calls.at(-1)?.slice(1)).toEqual([{ kind: 'all' }, 0, 50]);
    expect(screen.getByText(/整个项目回收站.*不受当前目录.*筛选/)).toBeVisible();
    expect(screen.getByText(/请求 3.*可删除 3.*保留 0/)).toBeVisible();
    s.unmount();
});

it('disables empty, readonly and busy entrypoints, but global unadopted trash stays clearable', async () => {
    const s = setup(false);
    expect(screen.getByRole('button', { name: '清空回收站…' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'audio-0.wav' }));
    expect(screen.getByRole('button', { name: '永久删除…' })).toBeDisabled();
    s.rerender(<MediaList {...s.props} disabled />);
    expect(screen.getByRole('button', { name: '清空回收站…' })).toBeDisabled();
    s.unmount();
    const empty = setup(true, []);
    expect(screen.getByRole('button', { name: '清空回收站…' })).toBeEnabled();
    empty.recycle.snapshot = { ...empty.recycle.snapshot!, trashed: [] };
    empty.rerender(<MediaList {...empty.props} />);
    expect(screen.getByRole('button', { name: '清空回收站…' })).toBeDisabled();
});

it('shows native reasons with no commit or format warning when none are eligible', async () => {
    setup(); native.preview.mockImplementationOnce(async (op: string) => ({ operationId: op, previewId, projectId: fixture.projectId, runtimeNonce: nonce, requestedCount: 2, eligibleCount: 0, retainedCount: 2, otherAuthorRetainedCount: 1, audioBytes: 0, requiresFormatUpgrade: false, items: [{ mediaId: media[0].id, displayName: 'audio-0.wav', reason: 'other-author-annotation' }, { mediaId: media[1].id, displayName: 'audio-1.wav', reason: 'not-in-recycle' }] }));
    clear(); const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('他人有标注，保留：1');
    expect(within(dialog).getByText('已不在回收站，保留：1')).toBeVisible();
    expect(within(dialog).queryByRole('button', { name: '确认永久删除' })).toBeNull();
    expect(within(dialog).queryByText(/旧版将无法打开/)).toBeNull();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull(); expect(native.commit).not.toHaveBeenCalled();
});

it('scopes Delete to recycle rows, leaving editable targets and outside handlers alone', async () => {
    setup(); const search = screen.getByLabelText('搜索音频'), listener = vi.fn();
    window.addEventListener('keydown', listener);
    const editable = new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true });
    fireEvent(search, editable); expect(editable.defaultPrevented).toBe(false); expect(listener).toHaveBeenCalledOnce();
    const row = screen.getByRole('button', { name: 'audio-0.wav' }); row.focus(); fireEvent.keyDown(row, { key: 'Delete' });
    await screen.findByRole('button', { name: '确认永久删除' });
    expect(native.preview.mock.calls[0][1]).toEqual({ kind: 'selected', mediaIds: [media[0].id] });
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(row).toHaveFocus(); expect(native.commit).not.toHaveBeenCalled();
    window.removeEventListener('keydown', listener);
});

it('preserves partial committed summary across page/retry errors, then retries only the original operation', async () => {
    setup(); clear(); await screen.findByRole('button', { name: '确认永久删除' }); confirm();
    await screen.findByText('已从项目移除：1');
    expect(screen.getByText('他人有标注，保留：1')).toBeVisible(); expect(screen.getByText('已不在回收站，保留：1')).toBeVisible();
    expect(screen.getByText('已删除音频字节：128')).toBeVisible(); expect(screen.getByText(/待清理：2.*其中失败：1/)).toBeVisible();
    native.cleanupPage.mockRejectedValueOnce({ code: 'SaveFailed', message: 'NAS offline', retryable: true });
    fireEvent.click(screen.getByRole('button', { name: '查看待清理项' })); await screen.findByText(/NAS offline/);
    expect(screen.getByText('已从项目移除：1')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '刷新待清理项' })); await screen.findByText(/Windows sharing violation/);
    expect(screen.getByText(/旧作者历史/)).toBeVisible();
    native.retryCleanup.mockRejectedValueOnce({ code: 'SaveFailed', message: 'still occupied', retryable: true });
    fireEvent.click(screen.getByRole('button', { name: '重试清理' })); await screen.findByText(/still occupied/);
    expect(screen.queryByRole('button', { name: '确认永久删除' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '重试清理' }));
    await screen.findByText(/待清理：0.*其中失败：0/);
    expect(native.retryCleanup.mock.calls).toEqual([[operationId], [operationId]]);
    expect(native.preview).toHaveBeenCalledOnce(); expect(native.commit).toHaveBeenCalledOnce(); expect(screen.queryByRole('button', { name: '撤销' })).toBeNull();
});

it('exposes reopened committed cleanup readonly and excludes precommit maintenance', async () => {
    const s = setup(false);
    s.recycle.purge.maintenance = { total: 2, items: [{ operationId: nonce, status: 'rollback-pending', committed: false, cleanupPendingCount: null, cleanupFailedCount: null, deletedAudioBytes: null }, { operationId: previewId, status: 'committed-pending-cleanup', committed: true, cleanupPendingCount: 2, cleanupFailedCount: 1, deletedAudioBytes: 128 }] };
    operationId = previewId;
    s.rerender(<MediaList {...s.props} />);
    fireEvent.click(screen.getByRole('button', { name: /查看待清理操作/ }));
    expect(screen.getByRole('button', { name: '重试清理' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '查看待清理项' })); await screen.findByText(/Windows sharing violation/);
    expect(native.preview).not.toHaveBeenCalled(); expect(native.retryCleanup).not.toHaveBeenCalled();
});

it('closes during a pending page read and does not restore focus across owner replacement', async () => {
    const s = setup(); clear(); await screen.findByRole('button', { name: '确认永久删除' }); confirm(); await screen.findByText('已从项目移除：1');
    let release!: (value: PurgeCleanupPage) => void;
    native.cleanupPage.mockImplementationOnce(() => new Promise<PurgeCleanupPage>(r => { release = r; }));
    fireEvent.click(screen.getByRole('button', { name: '查看待清理项' }));
    expect(s.recycle.purge.pending).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '关闭' })); expect(screen.queryByRole('dialog')).toBeNull();
    clear(); await screen.findByRole('button', { name: '确认永久删除' });
    const fresh = new RecycleController(fixture.projectId, previewId, true, s.recycleApi); fresh.snapshot = s.recycle.snapshot;
    const focus = document.createElement('input'); document.body.append(focus); focus.focus();
    s.rerender(<MediaList {...s.props} recycle={fresh} />);
    expect(focus).toHaveFocus(); expect(screen.queryByRole('dialog')).toBeNull();
    await act(async () => release(page())); expect(focus).toHaveFocus(); focus.remove();
});

it('keeps a known committed operation recoverable when its summary is lost', async () => {
    setup(); clear(); await screen.findByRole('button', { name: '确认永久删除' });
    native.commit.mockImplementationOnce(async () => { throw { code: 'SaveFailed', message: 'summary unavailable', retryable: true, details: { purgeCommitted: true, operationId, projectId: fixture.projectId, runtimeNonce: nonce } }; });
    confirm(); await screen.findByText(/永久删除已提交/);
    expect(screen.queryByRole('button', { name: '确认永久删除' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    expect(screen.getByRole('button', { name: '清空回收站…' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /查看待清理操作/ }));
    fireEvent.click(screen.getByRole('button', { name: '重试清理' }));
    await screen.findByText(/待清理：0.*其中失败：0/);
    expect(native.retryCleanup).toHaveBeenCalledWith(operationId); expect(native.commit).toHaveBeenCalledOnce(); expect(native.preview).toHaveBeenCalledOnce();
});

it('pages at most fifty native preview and cleanup items and adjusts a retired last page', async () => {
    setup();
    const targets = Array.from({ length: 51 }, (_, i) => ({ mediaId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, displayName: `item-${i}`, reason: null }));
    native.preview.mockImplementation(async (op: string, _selection: unknown, offset: number, limit: number) => {
        operationId = op;
        return { operationId: op, previewId, projectId: fixture.projectId, runtimeNonce: nonce, requestedCount: 51, eligibleCount: 51, retainedCount: 0, otherAuthorRetainedCount: 0, audioBytes: 99999, requiresFormatUpgrade: false, items: targets.slice(offset, offset + limit) };
    });
    clear(); const preview = await screen.findByRole('list', { name: '永久删除预览' });
    expect(within(preview).getAllByRole('listitem')).toHaveLength(50); expect(screen.getByText(/请求 51.*可删除 51/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '下一页预览' })); await screen.findByText(/item-50/);
    expect(within(preview).getAllByRole('listitem')).toHaveLength(1);
    expect(native.preview.mock.calls[1]).toEqual([operationId, { kind: 'all' }, 50, 50]);
    confirm(); await screen.findByText('已从项目移除：1');
    let shrunk = false;
    native.cleanupPage.mockImplementation(async (_op: string, offset: number) => ({ ...page(), total: shrunk ? 1 : 51, offset, items: offset === 50 ? shrunk ? [] : [{ ...page().items[0], displayName: 'last cleanup' }] : Array.from({ length: shrunk ? 1 : 50 }, (_, i) => ({ ...page().items[0], cleanupId: `cleanup-${i}`, displayName: `cleanup-${i}` })) }));
    fireEvent.click(screen.getByRole('button', { name: '查看待清理项' }));
    const cleanup = await screen.findByRole('list', { name: '待清理项' }); expect(within(cleanup).getAllByRole('listitem')).toHaveLength(50);
    fireEvent.click(screen.getByRole('button', { name: '下一页待清理项' })); await screen.findByText(/last cleanup/);
    native.retryCleanup.mockImplementationOnce(async () => { shrunk = true; return { ...result(), cleanupPendingCount: 1, cleanupFailedCount: 1 }; });
    fireEvent.click(screen.getByRole('button', { name: '重试清理' })); await screen.findByText(/cleanup-0/);
    expect(within(cleanup).getAllByRole('listitem')).toHaveLength(1); expect(screen.getByRole('button', { name: '上一页待清理项' })).toBeDisabled();
    expect(native.cleanupPage.mock.calls.at(-1)).toEqual([operationId, 0, 50]);
});

it('retains selected directories and refreshes organization/recycle after commit so an empty folder can be deleted', async () => {
    const s = setup();
    const head = { kind: 'audio-annotator-organization' as const, formatVersion: 1 as const, projectId: fixture.projectId, revision: 0, layoutRevision: 0, folders: [{ id: nonce, parentId: null, name: 'retained folder' }], media: media.map(m => ({ mediaId: m.id, folderId: nonce, originalFilename: m.displayName })) };
    const organizationApi = { get: vi.fn(async () => ({ projectId: fixture.projectId, runtimeNonce: nonce, organization: { ...head, revision: 1, media: [] } })), apply: vi.fn() };
    const organization = new OrganizationController(fixture.projectId, nonce, true, organizationApi); organization.snapshot = head; organization.select(nonce);
    s.rerender(<MediaList {...s.props} organization={organization} />);
    s.recycleApi.get.mockResolvedValueOnce({ projectId: fixture.projectId, runtimeNonce: nonce, recycle: { ...s.recycle.snapshot!, revision: 1, trashed: [] } });
    clear(); await screen.findByRole('button', { name: '确认永久删除' }); confirm();
    await waitFor(() => expect(organizationApi.get).toHaveBeenCalledOnce()); expect(s.recycleApi.get).toHaveBeenCalledOnce();
    s.rerender(<MediaList {...s.props} organization={organization} media={[]} />);
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    expect(organization.selectedFolderId).toBe(nonce); expect(screen.getByRole('button', { name: /^retained folder/ })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: '文件夹操作 · retained folder' }));
    expect(screen.getByRole('menuitem', { name: '删除文件夹…' })).toHaveAttribute('aria-disabled', 'false');
});

it('preserves raw native cleanup diagnostics in addition to the summary message', async () => {
    setup(); clear(); await screen.findByRole('button', { name: '确认永久删除' }); confirm(); await screen.findByText('已从项目移除：1');
    native.cleanupPage.mockImplementationOnce(async () => ({ ...page(), items: [{ ...page().items[0], error: { code: 'SaveFailed', message: 'Could not remove file', retryable: true, details: { io: 'Access is denied. (os error 5)' } } }, page().items[1]] }));
    fireEvent.click(screen.getByRole('button', { name: '查看待清理项' }));
    await screen.findByText(/Could not remove file/);
    fireEvent.click(screen.getByText('诊断详情'));
    expect(screen.getByText(/Access is denied.*os error 5/)).toBeVisible();
});


it('replaces the recycle binding on author changes even when owner and runtime are reused', async () => {
    const store = new ProjectStore({ document: parseProjectDocument(structuredClone(fixture)), canUndo: false, canRedo: false });
    const queue = new CommandQueue(store, { applyChange: vi.fn(), getSnapshot: vi.fn(), undo: vi.fn(), redo: vi.fn() });
    const lifecycle = new ProjectLifecycle(store, queue, { save: vi.fn(), close: vi.fn() });
    const owner: ActiveProject = { store, queue, lifecycle, path: 'shared', collaboration: { runtimeNonce: nonce, projectFlavor: 'default', identityMode: 'profile', actor: { authorId: nonce, displayName: 'Alice', createdAt: '2026-10-23T00:00:00Z' }, preferences: null, canWriteAnnotations: true, canImportMedia: true, hiddenMediaIds: [], catalogPending: false } };
    const client = { get: vi.fn(async () => ({ projectId: fixture.projectId, runtimeNonce: nonce, recycle: { kind: 'audio-annotator-recycle' as const, formatVersion: 1 as const, projectId: fixture.projectId, revision: 0, trashed: [], recentOperations: [] } })), apply: vi.fn() };
    const spy = vi.spyOn(recycleBridge, 'createRecycleClient').mockReturnValue(client);
    const hook = renderHook(() => useRecycle(owner));
    await waitFor(() => expect(hook.result.current).not.toBeNull());
    const old = hook.result.current;
    owner.collaboration!.actor = { ...owner.collaboration!.actor!, authorId: previewId };
    hook.rerender();
    await waitFor(() => expect(hook.result.current).not.toBe(old));
    expect(hook.result.current?.runtimeNonce).toBe(nonce);
    hook.unmount(); lifecycle.dispose(); spy.mockRestore();
});

it('keeps the selected batch fixed while preview is pending and blocks competing mutations', async () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'audio-0.wav' }));
    fireEvent.click(screen.getByLabelText('选择音频 · audio-1.wav'));
    const read = native.preview.getMockImplementation()!;
    let release!: (v: PurgePreview) => void;
    native.preview.mockImplementationOnce(() => new Promise<PurgePreview>(resolve => { release = resolve; }));
    fireEvent.click(screen.getByRole('button', { name: '永久删除…' }));
    expect(screen.getByRole('button', { name: '清空回收站…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '恢复' })).toBeDisabled();
    fireEvent.click(screen.getByLabelText('选择音频 · audio-2.wav'));
    const call = native.preview.mock.calls[0];
    expect(call[1]).toEqual({ kind: 'selected', mediaIds: [media[0].id, media[1].id] });
    await act(async () => release(await read(...call)));
    confirm(); await screen.findByText('已从项目移除：1');
    expect(native.commit).toHaveBeenCalledWith(previewId, operationId); expect(native.preview).toHaveBeenCalledOnce();
});

it('menu, dialog, contenteditable, and outside Delete never create an extra preview; outside click cancels', async () => {
    const s = setup();
    const outside = document.createElement('button'); document.body.append(outside);
    fireEvent.keyDown(outside, { key: 'Delete' }); expect(native.preview).not.toHaveBeenCalled();
    const editable = document.createElement('div'); editable.contentEditable = 'true'; editable.setAttribute('contenteditable', 'true');
    s.container.querySelector('.media-list-content')!.append(editable);
    const key = new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }); fireEvent(editable, key);
    expect(key.defaultPrevented).toBe(false); expect(native.preview).not.toHaveBeenCalled(); editable.remove();
    const row = screen.getByRole('button', { name: 'audio-0.wav' });
    fireEvent.contextMenu(row); fireEvent.keyDown(screen.getByRole('menu'), { key: 'Delete' }); expect(native.preview).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' }); row.focus(); fireEvent.keyDown(row, { key: 'Delete' });
    await screen.findByRole('button', { name: '确认永久删除' });
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Delete' }); expect(native.preview).toHaveBeenCalledOnce(); expect(native.commit).not.toHaveBeenCalled();
    fireEvent.pointerDown(screen.getByRole('dialog').parentElement!);
    expect(screen.queryByRole('dialog')).toBeNull(); expect(row).toHaveFocus(); expect(native.commit).not.toHaveBeenCalled(); outside.remove();
});

it('confirms global other-author and state-change counts even when reasons are outside the current page', async () => {
    setup();
    const targets = Array.from({ length: 53 }, (_, i) => ({ mediaId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, displayName: `global-item-${i}`, reason: i === 50 || i === 51 ? 'other-author-annotation' as const : i === 52 ? 'not-in-recycle' as const : null }));
    native.preview.mockImplementation(async (op: string, _selection: unknown, offset: number, limit: number): Promise<PurgePreview> => {
        operationId = op;
        return { operationId: op, previewId, projectId: fixture.projectId, runtimeNonce: nonce, requestedCount: 53, eligibleCount: 50, retainedCount: 3, otherAuthorRetainedCount: 2, audioBytes: 4096, requiresFormatUpgrade: false, items: targets.slice(offset, offset + limit) };
    });
    clear();
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByRole('button', { name: '确认永久删除' });
    expect(within(dialog).getByText('他人有标注，保留：2')).toBeVisible();
    expect(within(dialog).getByText('已不在回收站，保留：1')).toBeVisible();
    expect(within(dialog).queryByText(/global-item-50/)).toBeNull();
    expect(native.preview).toHaveBeenCalledOnce();
    fireEvent.click(within(dialog).getByRole('button', { name: '下一页预览' }));
    await within(dialog).findByText(/global-item-50/);
    expect(within(dialog).getByText('他人有标注，保留：2')).toBeVisible();
    expect(within(dialog).getByText('已不在回收站，保留：1')).toBeVisible();
    expect(native.commit).not.toHaveBeenCalled();
});
