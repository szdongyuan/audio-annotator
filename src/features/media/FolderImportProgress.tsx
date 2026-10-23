import { useState, useSyncExternalStore } from 'react';
import type { FolderImportController } from './folderImport';

const labels = { idle: '', choosing: '', scanning: '正在扫描文件夹', importing: '正在导入文件夹', paused: '导入已暂停 · 请处理写入失败', finished: '文件夹导入完成', cancelled: '文件夹导入已取消', failed: '文件夹导入失败' };
const itemLabels = { waiting: '等待导入', hashing: '校验指纹', decoding: '解码音频', publishing: '写入项目', success: '已导入', failed: '失败', cancelled: '已取消' };
const issueLabels = { access: '访问失败', unresolvedSource: '已有路径无法解析', existing: '已存在', reparse: '跳过链接', unsupported: '跳过格式' };
const pageSize = 50;
export function FolderImportProgress({ controller: c }: { controller: FolderImportController }) {
  useSyncExternalStore(c.subscribe, c.getVersion);
  const [expanded, setExpanded] = useState(false), [page, setPage] = useState(0), [recovering, setRecovering] = useState(false);
  if (c.state === 'idle' || c.state === 'choosing') return null;
  const failures = c.failures.length, total = c.items.length + c.issues.length;
  const pages = Math.max(1, Math.ceil(total / pageSize)), current = Math.min(page, pages - 1);
  const rows = expanded ? Array.from({ length: Math.min(pageSize, total - current * pageSize) }, (_, i) => {
    const index = current * pageSize + i, item = c.items[index];
    if (item) return { key: `item${item.index}`, number: item.index + 1, path: item.path, label: itemLabels[item.state], error: item.error?.message };
    const issue = c.issues[index - c.items.length];
    return { key: `issue${index}`, number: null, path: issue.path, label: issueLabels[issue.kind], error: issue.message };
  }) : [];
  const recover = (end: boolean) => { setRecovering(true); void (end ? c.end() : c.retry()).finally(() => setRecovering(false)); };
  return <section className="import-progress folder-import-progress" aria-label="文件夹导入进度">
    <div><strong>{labels[c.state]}</strong>{c.busy && <button className="button button-quiet" onClick={() => c.cancel()}>取消文件夹导入</button>}<button className="button button-quiet" onClick={() => setExpanded(!expanded)}>{expanded ? '收起详情' : '查看详情'}</button>{!c.busy && !failures && <button className="button button-quiet" onClick={() => c.dismiss()}>关闭文件夹结果</button>}</div>
    <div><span>成功 {c.successCount} · 失败 {c.failedCount} · 已存在 {c.counts.existing} · 跳过 {c.counts.skipped}</span><span>{c.state === 'scanning' ? `已检查 ${c.counts.checked}` : `已处理 ${c.items.filter(i => ['success', 'failed', 'cancelled'].includes(i.state)).length} / ${c.counts.candidates}`}</span></div>
    {c.state === 'importing' && <progress aria-label="文件夹完成文件数" max={Math.max(1, c.counts.candidates)} value={c.items.filter(i => ['success', 'failed', 'cancelled'].includes(i.state)).length} />}
    {failures > 0 && <div role="alert"><span>{failures} 项写入失败仍待恢复；取消保留失败编辑。</span><button className="button" disabled={recovering} onClick={() => recover(false)}>重试文件夹写入</button><button className="button" disabled={recovering} onClick={() => recover(true)}>结束并放弃失败项</button></div>}
    {c.state === 'paused' && c.otherFailures > 0 && <p role="alert">还有 {c.otherFailures} 项其他编辑失败，请先使用对应的重试更改操作。</p>}
    {c.state === 'paused' && !failures && <button className="button" disabled={recovering || c.otherFailures > 0} onClick={() => recover(false)}>继续文件夹导入</button>}
    {c.error && <p role="alert">{c.error.message}</p>}
    {expanded && <><p className="media-source-path">{c.root}</p>{c.counts.issues > c.issues.length && <p>扫描问题共 {c.counts.issues} 项，仅保留前 {c.issues.length} 项详情；汇总包含全部结果。</p>}<ul>{rows.map(row => <li key={row.key}><span title={row.path}>{row.number !== null ? `${row.number}. ` : ''}{row.path}</span><small>{row.label}</small>{row.error && <p>{row.error}</p>}</li>)}</ul><div><button className="button" disabled={current === 0} onClick={() => setPage(current - 1)}>上一页</button><span>{current + 1} / {pages}</span><button className="button" disabled={current === pages - 1} onClick={() => setPage(current + 1)}>下一页</button></div></>}
  </section>;
}
