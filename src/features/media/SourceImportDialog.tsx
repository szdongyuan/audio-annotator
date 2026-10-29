import { useMemo, useState, useSyncExternalStore } from 'react';
import { sourceDialogs, type SourceOrganization, type SourceRules } from '../../bridge/sourceImport';
import type { SourceImportController } from './sourceImport';
import type { OrganizationController } from './organization';
import { organizationIndex } from './organization';
import { MediaDialog } from './MediaDialog';
function ResultTree({ summary }: {
    summary: NonNullable<SourceImportController['page']>['folderSummary'];
}) {
    const [expanded, setExpanded] = useState<Set<number>>(new Set()), [offset, setOffset] = useState(0);
    const children = useMemo(() => { const map = new Map<number | null, typeof summary>(); for (const f of summary) {
        const list = map.get(f.parentIndex) ?? [];
        list.push(f);
        map.set(f.parentIndex, list);
    } return map; }, [summary]);
    const rows: typeof summary = [];
    const visit = (parent: number | null) => { for (const f of children.get(parent) ?? []) {
        rows.push(f);
        if (expanded.has(f.index))
            visit(f.index);
    } };
    visit(null);
    const depth = (i: number) => { let n = 0, p = summary[i].parentIndex; while (p !== null) {
        n++;
        p = summary[p].parentIndex;
    } return n; };
    return <details><summary>结果目录（{summary.length}）</summary><div className="source-folder-preview">{rows.slice(offset, offset + 50).map(f => <div key={f.index} style={{ paddingLeft: depth(f.index) * 12 }}><button className="button button-quiet" aria-expanded={expanded.has(f.index)} onClick={() => setExpanded(old => { const next = new Set(old); if (next.has(f.index))
        next.delete(f.index);
    else
        next.add(f.index); setOffset(0); return next; })}>{children.has(f.index) ? expanded.has(f.index) ? '▾' : '▸' : '·'} {f.name} <small>{f.mediaCount}</small></button></div>)}</div>{rows.length > 50 && <div className="source-import-row"><button disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 50))}>上一组目录</button><span>{offset + 1}–{Math.min(offset + 50, rows.length)} / {rows.length}</span><button disabled={offset + 50 >= rows.length} onClick={() => setOffset(offset + 50)}>下一组目录</button></div>}</details>;
}
export function SourceImportDialog({ controller: c, picker, organization }: {
    controller: SourceImportController;
    picker?: () => Promise<string | string[] | null>;
    organization?: OrganizationController | null;
}) {
    useSyncExternalStore(c.subscribe, c.getVersion);
    const [name, setName] = useState(''), [localError, setLocalError] = useState('');
    const index = useMemo(() => organizationIndex(organization?.snapshot ?? null, new Set()), [organization?.snapshot]);
    if (!c.open)
        return null;
    const rules = c.config.rules, org = c.config.organization, editable = !c.picking && !['importing', 'paused'].includes(c.state);
    const update = (patch: Partial<SourceRules>) => { setLocalError(''); void c.configurePlan({ rules: { ...rules, ...patch } }); };
    const layout = (patch: Partial<SourceOrganization>) => { setLocalError(''); void c.configurePlan({ organization: { ...org, ...patch } }); };
    const tokens = rules.mode === 'generic' ? ['source', 'relativeDir'] : ['source', 'relativeDir', 'record', 'date', 'result', 'faultType', 'model', 'route'];
    return <MediaDialog returnFocus={c.returnFocus} title={c.config.kind === 'zip' ? '导入 ZIP 音频' : '导入文件夹'} onClose={() => void c.cancel()}>
  <header><h2>{c.config.kind === 'zip' ? '导入 ZIP 音频' : '导入文件夹'}</h2><button className="button button-quiet" aria-label="关闭音频导入" onClick={() => void c.cancel()}>关闭</button></header>
  <div className="source-import-body">
   <div className="source-import-row"><button className="button" disabled={!editable || c.state === 'scanning'} onClick={() => void c.choose(picker ?? (() => sourceDialogs.choose(c.config.kind)))}>{c.config.kind === 'zip' ? '选择 ZIP…' : '选择文件夹…'}</button><span className="source-path-summary" title={c.config.paths.join('\n')}>{c.config.paths.length ? c.config.paths.map(p => p.split(/[\\/]/).pop()).join('、') : '尚未选择来源'}</span></div>
   <div className="source-import-row"><label>导入方案<select aria-label="导入方案" value={c.presetId} disabled={!editable} onChange={e => void c.applyPreset(e.target.value)}><option value="">当前方案</option>{c.plans.presets.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label><label>目标文件夹<select aria-label="目标文件夹" value={org.targetFolderId ?? ''} disabled={!editable} onChange={e => layout({ targetFolderId: e.target.value || null })}><option value="">全部音频</option>{[...index.paths].map(([id, path]) => <option key={id} value={id}>{path}</option>)}{org.targetFolderId && !index.paths.has(org.targetFolderId) && <option value={org.targetFolderId}>当前目标</option>}</select></label><label>目录布局<select aria-label="目录布局" value={org.mode} disabled={!editable} onChange={e => layout({ mode: e.target.value as SourceOrganization['mode'] })}><option value="sourcePath">保留来源目录</option><option value="flat">平铺</option><option value="template">模板分类</option></select></label></div>
   <label className="source-route-option"><input type="checkbox" checked={rules.skipDuplicates} disabled={!editable} onChange={e => update({ skipDuplicates: e.target.checked })}/>跳过重复音频</label>
   <small>按目标目录和文件名判断，不区分大小写；回收站中的音频不参与</small>
   {rules.mode === 'jingcheng' && <label className="source-route-option"><input type="checkbox" checked={rules.includeSecond} disabled={!editable} onChange={e => update({ includeSecond: e.target.checked })}/>导入第二路音频</label>}
   <details className="source-rules"><summary>高级设置</summary><div className="source-rule-grid"><label>解析方式<select aria-label="解析方式" value={rules.mode} disabled={!editable} onChange={e => update({ mode: e.target.value as SourceRules['mode'] })}><option value="generic">通用音频</option><option value="jingcheng">精成采集记录</option></select></label><label><input type="checkbox" checked={rules.recursive} disabled={!editable} onChange={e => update({ recursive: e.target.checked })}/>包含子文件夹</label></div><div className="source-import-row">{['wav', 'flac', 'mp3'].map(ext => <label key={ext}><input type="checkbox" checked={rules.extensions.includes(ext)} disabled={!editable} onChange={e => update({ extensions: e.target.checked ? [...rules.extensions, ext] : rules.extensions.filter(x => x !== ext) })}/>{ext.toUpperCase()}</label>)}</div>
   <div className="source-rule-grid"><label>包含路径<textarea aria-label="包含路径" rows={2} disabled={!editable} value={c.form.include} onChange={e => void c.configureText('include', e.target.value)}/></label><label>排除路径<textarea aria-label="排除路径" rows={2} disabled={!editable} value={c.form.exclude} onChange={e => void c.configureText('exclude', e.target.value)}/></label></div><small>以换行、逗号或分号分隔。*/CH1 匹配任意层级的 CH1 音频，扩展名可省略。</small>
   <div className="source-import-row"><label><input type="checkbox" checked={org.wrapSource} disabled={!editable || org.mode !== 'sourcePath'} onChange={e => layout({ wrapSource: e.target.checked })}/>来源目录外包一层</label><label>去除目录组件<input aria-label="去除目录组件" value={c.form.strip} disabled={!editable} onChange={e => void c.configureText('strip', e.target.value)}/></label></div>
   <label>目录模板<input aria-label="目录模板" value={org.template} disabled={!editable} onChange={e => layout({ template: e.target.value })}/></label><div className="source-import-row" aria-label="可用模板字段">{tokens.map(t => <button key={t} className="button button-quiet" disabled={!editable} onClick={() => layout({ template: org.template ? `${org.template}/{${t}}` : `{${t}}` })}>{`{${t}}`}</button>)}</div>
   <div className="source-import-row"><input aria-label="新方案名称" placeholder="保存为本机方案" maxLength={64} value={name} onChange={e => setName(e.target.value)}/><button className="button button-quiet" disabled={!editable || !name.trim()} onClick={() => { try {
        const id = c.plans.save(name, c.config);
        setName('');
        setLocalError('');
        void c.applyPreset(id);
    }
    catch (e) {
        setLocalError(String(e));
    } }}>保存</button><button className="button button-quiet" disabled={!editable || !c.presetId.startsWith('custom-')} onClick={() => { c.plans.remove(c.presetId); void c.configurePlan({}); }}>删除</button></div></details>
   {c.state === 'scanning' && <p role="status">正在扫描 · 已检查 {c.counts.checked} · 候选 {c.counts.candidates}</p>}
   {c.state === 'preview' && <section className="source-preview" aria-label="音频预览"><div className="source-import-row"><strong>{c.counts.candidates} 个音频</strong><span>跳过 {c.counts.skipped}（其中重复 {c.counts.duplicateSkipped}） · 问题 {c.counts.issues} · {(c.counts.selectedBytes / 1048576).toFixed(1)} MiB</span></div>{c.counts.candidates === 0 && c.counts.duplicateSkipped > 0 && c.counts.issues === 0 && <p role="status">所选音频均已存在，无需重复导入</p>}{c.page && <ResultTree summary={c.page.folderSummary}/>}<ul>{c.page?.candidates.slice(0, 50).map(item => <li key={item.index} title={item.displayName}><span>{[...item.resultingFolderPath, item.originalFilename].join('/')}</span><details><summary>原始来源 · {item.relativePath}</summary><small>{item.displayName}{item.logicalPosition !== null ? ` · 第 ${item.logicalPosition} 路` : ''}</small></details></li>)}</ul><div className="source-import-row source-pagination"><button className="button button-quiet" disabled={c.loadingPage || c.pageOffset === 0} onClick={() => void c.loadPage(Math.max(0, c.pageOffset - 50))}>上一页</button><span>{Math.floor(c.pageOffset / 50) + 1} / {Math.max(1, Math.ceil(c.counts.candidates / 50))}</span><button className="button button-quiet" disabled={c.loadingPage || c.pageOffset + 50 >= c.counts.candidates} onClick={() => void c.loadPage(c.pageOffset + 50)}>下一页</button></div>{!!c.page?.issues.length && <details><summary>扫描问题 / 缺失字段（{c.counts.issues}，保留前 {c.page.issues.length} 项）</summary><ul>{c.page.issues.map((issue, i) => <li key={i}><span>{issue.relativePath}</span><small>{issue.message}</small></li>)}</ul></details>}</section>}
   {(localError || c.error || c.plans.error) && <p role="alert">{localError || c.error?.message || c.plans.error}</p>}
   {c.releasePending && <button className="button" onClick={() => void c.retryRelease()}>重试释放预览</button>}
  </div>
  <footer className="dialog-actions"><button className="button" onClick={() => void c.cancel()}>取消</button><button className="button" disabled={c.picking || c.state === 'scanning' || !c.config.paths.length} onClick={() => void c.scan()}>{c.state === 'preview' ? '重新扫描' : '扫描预览'}</button><button className="button button-accent" disabled={!c.canImport} onClick={() => void c.importAll()}>导入 {c.counts.candidates} 个音频</button></footer>
 </MediaDialog>;
}
