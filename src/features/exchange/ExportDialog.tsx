import { useState } from 'react';
import { FileJson, Package } from 'lucide-react';
import type { ExportPreview } from '../../bridge/exchange';
import { ExchangeDialog, type ExchangeState } from './ExchangeDialog';
export function ExportDialog(props: ExchangeState & {
    shared?: boolean;
    previewBusy?: boolean;
    preview?: ExportPreview | null;
    onPreview?: (kind: 'annotations' | 'bundle', preserveFolders: boolean) => void;
    onInvalidatePreview?: () => void;
    onStart: (kind: 'annotations' | 'bundle') => void;
}) {
    const [kind, setKind] = useState<'annotations' | 'bundle'>('bundle'), [preserve, setPreserve] = useState(true), [offset, setOffset] = useState(0);
    const preview = props.preview, ready = !!preview && preview.bundle === (kind === 'bundle') && preview.preserveFolders === preserve;
    return <ExchangeDialog {...props} title={props.shared ? '导出我的标注 / 项目包' : '分享项目'}>
 <p className="exchange-detail">{props.shared ? '包含当前身份的标注、类别、备注与项目目录；个人播放、屏蔽、视图和其他作者内容不在导出范围内。' : '导出标注、类别、备注和项目目录；个人播放、屏蔽与视图设置不在导出范围内。'}</p>
 <div className="exchange-options">{(['bundle', 'annotations'] as const).map(value => <label className={kind === value ? 'is-selected' : ''} key={value}><input type="radio" name="exchange-format" aria-label={value === 'annotations' ? (props.shared ? '我的标注（不含音频）' : '仅标注（不含音频）') : (props.shared ? '我的项目包（含音频）' : '完整项目包（含音频）')} checked={kind === value} disabled={props.busy} onChange={() => { setKind(value); setOffset(0); props.onInvalidatePreview?.(); }}/>{value === 'annotations' ? <FileJson size={24}/> : <Package size={24}/>}<span><strong>{value === 'annotations' ? (props.shared ? '我的标注（不含音频）' : '仅标注（不含音频）') : (props.shared ? '我的项目包（含音频）' : '完整项目包（含音频）')}</strong><small>{value === 'annotations' ? '.annotations.json · 接收方需要同一批原始音频，导入后按指纹关联' : '.audioproj.zip · 包含原始音频'}</small></span></label>)}</div>
 {kind === 'bundle' && <label className="source-route-option"><input type="checkbox" checked={preserve} disabled={props.busy} onChange={e => { setPreserve(e.target.checked); setOffset(0); props.onInvalidatePreview?.(); }}/>保留项目文件夹层级</label>}
 {props.onPreview && <button className="button" disabled={props.busy} onClick={() => props.onPreview?.(kind, preserve)}>{preview || props.error ? '刷新导出预览' : '预览导出路径'}</button>}
 {props.previewBusy && <p role="status">正在预览导出路径…</p>}
 {ready && <div className="source-preview" aria-label="导出路径预览"><p role="status">{kind === 'bundle' ? `${Object.keys(preview.mediaPaths).length} 个音频 · ${Math.max(0, preview.directories.length - 1)} 个目录` : '标注 JSON · 保留逻辑目录'} · 预览已就绪</p>{preview.changes.length > 0 && <details><summary>路径调整（{preview.changes.length}）</summary><ul>{preview.changes.slice(offset, offset + 50).map(c => <li key={c.kind + c.id}><small>{c.originalPath} → {c.plannedPath}</small></li>)}</ul>{preview.changes.length > 50 && <div className="source-import-row"><button className="button button-quiet" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 50))}>上一页调整</button><span>{Math.floor(offset / 50) + 1} / {Math.ceil(preview.changes.length / 50)}</span><button className="button button-quiet" disabled={offset + 50 >= preview.changes.length} onClick={() => setOffset(offset + 50)}>下一页调整</button></div>}</details>}</div>}
 <button className="button button-accent" disabled={props.busy || (!!props.onPreview && !ready)} onClick={() => props.onStart(kind)}>{props.error || props.cancelled ? '重试 · 选择保存位置…' : '选择保存位置…'}</button>
 </ExchangeDialog>;
}
