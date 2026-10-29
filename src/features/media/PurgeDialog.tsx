import { useSyncExternalStore } from 'react';
import { MediaDialog } from './MediaDialog';
import type { PurgeController } from './purge';

const reasonLabel = { 'other-author-annotation': '他人有标注，保留', 'not-in-recycle': '已不在回收站，保留' };
const kindLabel = { audio: '音频', catalog: '音频目录记录', history: '作者历史', metadata: '项目元数据' };

export function PurgeDialog({ controller: c, all, trigger, resolveReturnFocus, onClose, onCommitted }: {
    controller: PurgeController;
    all: boolean;
    trigger: HTMLElement | null;
    resolveReturnFocus: (previous: HTMLElement | null) => HTMLElement | null;
    onClose: () => void;
    onCommitted: () => void;
}) {
    useSyncExternalStore(c.subscribe, c.getVersion);
    const p = c.preview, r = c.result, committed = c.committed;
    const inventory = c.maintenance.items.find(i => i.operationId === c.operationId && i.committed);
    const pendingCount = r?.cleanupPendingCount ?? inventory?.cleanupPendingCount;
    const failedCount = r?.cleanupFailedCount ?? inventory?.cleanupFailedCount;
    const bytes = r?.deletedAudioBytes ?? inventory?.deletedAudioBytes;
    const write = async (action: () => Promise<boolean>) => {
        await action();
        if (c.committed) onCommitted();
    };
    return <MediaDialog title={committed || r ? '永久删除结果' : '永久删除音频'} returnFocus={trigger} resolveReturnFocus={resolveReturnFocus} busy={c.pending} onClose={onClose}>
        <header><h2>{committed || r ? '永久删除结果' : '永久删除音频'}</h2></header>
        <div className="source-import-body">
            {!committed && !r && <>
                {all && <p>整个项目回收站：不受当前目录、搜索、筛选、个人隐藏或本机已采用音频范围影响。</p>}
                {p ? <>
                    <p>请求 {p.requestedCount} · 可删除 {p.eligibleCount} · 保留 {p.retainedCount}</p>
                    <p>他人有标注，保留：{p.otherAuthorRetainedCount}</p>
                    <p>已不在回收站，保留：{p.retainedCount - p.otherAuthorRetainedCount}</p>
                    <p>预计音频文件字节：{p.audioBytes}</p>
                    {p.eligibleCount > 0 && <>
                        <p>永久删除不可恢复。备注不影响删除权限；允许删除的音频及所有作者的关联备注一起删除。</p>
                        <p>仅删除项目内副本；项目外原始音频、原始 ZIP 和独立项目副本保留。</p>
                        {p.requiresFormatUpgrade && <p>首次实际永久删除将升级项目格式，旧版将无法打开此项目。</p>}
                    </>}
                    {!p.eligibleCount && <p>没有可删除的音频。</p>}
                    <div className="source-preview">
                        <ul aria-label="永久删除预览">{p.items.map(i =>
                            <li key={i.mediaId}>{i.displayName} · {i.reason ? reasonLabel[i.reason] : '可删除'}</li>
                        )}</ul>
                    </div>
                    <div className="source-import-row source-pagination">
                        <button disabled={c.pending || c.previewOffset === 0} onClick={() => void c.previewPage(c.previewOffset - 50)}>上一页预览</button>
                        <span>{p.requestedCount ? c.previewOffset + 1 : 0}–{Math.min(c.previewOffset + p.items.length, p.requestedCount)} / {p.requestedCount}</span>
                        <button disabled={c.pending || c.previewOffset + 50 >= p.requestedCount} onClick={() => void c.previewPage(c.previewOffset + 50)}>下一页预览</button>
                    </div>
                </> : <p role="status">{c.pending ? '正在预览…' : '未能取得预览，请关闭后重试。'}</p>}
            </>}
            {r && <div role="status">
                <p>已从项目移除：{r.removedIds.length}</p>
                <p>他人有标注，保留：{r.retained.filter(i => i.reason === 'other-author-annotation').length}</p>
                <p>已不在回收站，保留：{r.retained.filter(i => i.reason === 'not-in-recycle').length}</p>
            </div>}
            {committed && <>
                <p>永久删除已提交，不能撤销。{!r && '结果摘要暂不可用，可继续查看或重试同一操作的文件清理。'}</p>
                {bytes != null && <p>已删除音频字节：{bytes}</p>}
                <p>{pendingCount != null ? `待清理：${pendingCount} · 其中失败：${failedCount ?? 0}` : '文件清理状态待确认'}</p>
                <div className="source-import-row">
                    <button disabled={c.cleanupLoading} onClick={() => void c.loadCleanupPage()}>{c.cleanupPage || c.cleanupError ? '刷新待清理项' : '查看待清理项'}</button>
                    {pendingCount !== 0 && <button disabled={!c.writable || c.pending} onClick={() => void write(() => c.retryCleanup())}>重试清理</button>}
                </div>
                {c.cleanupLoading && <p role="status">正在读取待清理项…</p>}
                {c.cleanupError && <p role="alert">{c.cleanupError.message}</p>}
                {c.cleanupPage && <div className="source-preview">
                    <ul aria-label="待清理项">{c.cleanupPage.items.map(i => <li key={i.cleanupId}>
                        <span>{i.displayName} · {kindLabel[i.kind]} · {i.status === 'failed' ? '失败' : '待处理'}</span>
                        {i.error && <div>
                            <small>{i.error.code}：{i.error.message}</small>
                            {i.error.details != null && <details>
                                <summary>诊断详情</summary>
                                <pre>{JSON.stringify(i.error.details, null, 2)}</pre>
                            </details>}
                        </div>}
                    </li>)}</ul>
                    <div className="source-import-row source-pagination">
                        <button disabled={c.cleanupLoading || c.cleanupOffset === 0} onClick={() => void c.loadCleanupPage(c.cleanupOffset - 50)}>上一页待清理项</button>
                        <span>{c.cleanupPage.total ? c.cleanupOffset + 1 : 0}–{c.cleanupOffset + c.cleanupPage.items.length} / {c.cleanupPage.total}</span>
                        <button disabled={c.cleanupLoading || c.cleanupOffset + 50 >= c.cleanupPage.total} onClick={() => void c.loadCleanupPage(c.cleanupOffset + 50)}>下一页待清理项</button>
                    </div>
                </div>}
            </>}
            {c.error && <p role="alert">{c.error.message}</p>}
        </div>
        <footer className="dialog-actions">
            <button className="button" disabled={c.pending} onClick={onClose}>{committed || r || p?.eligibleCount === 0 ? '关闭' : '取消'}</button>
            {!committed && !r && !!p?.eligibleCount && <button className="button button-accent" disabled={c.pending || !c.writable} onClick={() => void write(() => c.commit())}>确认永久删除</button>}
        </footer>
    </MediaDialog>;
}
