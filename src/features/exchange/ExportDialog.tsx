import { useState } from 'react';
import { FileJson, Package } from 'lucide-react';
import type { AuthorSnapshot } from '../../bridge/collaboration';
import type { ExportPreview, ExportSelection } from '../../bridge/exchange';
import { ExchangeDialog, type ExchangeState } from './ExchangeDialog';
export function ExportDialog(props: ExchangeState & {
    shared?: boolean;
    selection?: ExportSelection|null;
    authors?: AuthorSnapshot[];
    updateSelection?:(selection:ExportSelection)=>void;
    previewBusy?: boolean;
    preview?: ExportPreview | null;
    onPreview?: (kind: 'annotations' | 'bundle', preserveFolders: boolean) => void;
    onInvalidatePreview?: () => void;
    onStart: (kind: 'annotations' | 'bundle', preserveFolders?:boolean) => void;
}) {
    const [kind, setKind] = useState<'annotations' | 'bundle'>('bundle'), [preserve, setPreserve] = useState(true), [offset, setOffset] = useState(0);
    const canExport = !props.selection || props.selection.audioOnly || props.selection.authorIds.length > 0;
    const preview = props.preview, ready = !!preview && preview.bundle === (kind === 'bundle') && preview.preserveFolders === preserve;
    const paths=ready ? Object.values(preview!.mediaPaths).sort((a,b)=>a.localeCompare(b,'zh-CN',{numeric:true})) : [];
    return <ExchangeDialog {...props} primaryAction={!props.result && <button className="button button-accent" disabled={props.busy || !canExport} onClick={()=>props.onStart(kind,preserve)}>{props.busy?'导出中…':'导出…'}</button>} title={props.selection ? '导出所选音频' : props.shared ? '导出我的标注 / 项目包' : '分享项目'}>
 {props.selection && <><p>{props.selection.mediaIds.length} 个音频</p><div className="source-import-row"><label><input type="radio" name="selected-export-kind" checked={!props.selection.audioOnly} disabled={props.busy} onChange={()=>props.updateSelection?.({...props.selection!,audioOnly:false})}/>音频标注包</label><label><input type="radio" name="selected-export-kind" checked={props.selection.audioOnly} disabled={props.busy} onChange={()=>props.updateSelection?.({...props.selection!,audioOnly:true})}/>原始音频 ZIP</label></div>{!props.selection.audioOnly && <fieldset className="exchange-author-list"><legend>包含的作者</legend><div><button className="text-button" disabled={props.busy} onClick={()=>props.updateSelection?.({...props.selection!,authorIds:(props.authors??[]).filter(a=>!a.error).map(a=>a.identity.authorId)})}>全选</button><button className="text-button" disabled={props.busy} onClick={()=>props.updateSelection?.({...props.selection!,authorIds:[]})}>清空</button></div>{(props.authors??[]).map(a=><label key={a.identity.authorId}><input type="checkbox" checked={props.selection!.authorIds.includes(a.identity.authorId)} disabled={props.busy||!!a.error} onChange={e=>props.updateSelection?.({...props.selection!,authorIds:e.target.checked?[...props.selection!.authorIds,a.identity.authorId]:props.selection!.authorIds.filter(id=>id!==a.identity.authorId)})}/>{a.identity.displayName}{a.error?'（读取失败）':''}</label>)}</fieldset>}</>}
 {!props.selection && <><p className="exchange-detail">{props.shared ? '包含当前身份的标注、类别、备注与项目目录；个人播放、屏蔽、视图和其他作者内容不在导出范围内。' : '导出标注、类别、备注和项目目录；个人播放、屏蔽与视图设置不在导出范围内。'}</p>
 <div className="exchange-options">{(['bundle', 'annotations'] as const).map(value => <label className={kind === value ? 'is-selected' : ''} key={value}><input type="radio" name="exchange-format" aria-label={value === 'annotations' ? (props.shared ? '我的标注（不含音频）' : '仅标注（不含音频）') : (props.shared ? '我的项目包（含音频）' : '完整项目包（含音频）')} checked={kind === value} disabled={props.busy} onChange={() => { setKind(value); setOffset(0); props.onInvalidatePreview?.(); }}/>{value === 'annotations' ? <FileJson size={24}/> : <Package size={24}/>}<span><strong>{value === 'annotations' ? (props.shared ? '我的标注（不含音频）' : '仅标注（不含音频）') : (props.shared ? '我的项目包（含音频）' : '完整项目包（含音频）')}</strong><small>{value === 'annotations' ? '.annotations.json · 接收方需要同一批原始音频，导入后按指纹关联' : '.audioproj.zip · 包含原始音频'}</small></span></label>)}</div></>}
 {kind === 'bundle' && <label className="source-route-option"><input type="checkbox" checked={preserve} disabled={props.busy} onChange={e => { setPreserve(e.target.checked); setOffset(0); props.onInvalidatePreview?.(); }}/>保留项目文件夹层级</label>}
 {kind === 'bundle' && props.onPreview && <details className="export-layout-preview" onToggle={e=>{if(e.currentTarget.open&&!ready&&!props.previewBusy&&!props.busy&&canExport)props.onPreview?.(kind,preserve);}}>
 <summary>查看压缩包内部目录</summary>
 {props.previewBusy ? <p role="status">正在读取目录…</p> : ready ? <div aria-label="压缩包内部目录"><p>{paths.length} 个音频</p><ul>{paths.slice(offset,offset+50).map(path=><li key={path}><code>{path}</code></li>)}</ul>{paths.length>50&&<div className="source-import-row"><button className="button button-quiet" disabled={!offset} onClick={()=>setOffset(Math.max(0,offset-50))}>上一页</button><span>{Math.floor(offset/50)+1} / {Math.ceil(paths.length/50)}</span><button className="button button-quiet" disabled={offset+50>=paths.length} onClick={()=>setOffset(offset+50)}>下一页</button></div>}{preview!.changes.length>0&&<p>已调整 {preview!.changes.length} 个重名或不兼容路径。</p>}</div> : null}
 {!props.previewBusy&&<button className="text-button" disabled={props.busy||!canExport} onClick={()=>{setOffset(0);props.onPreview?.(kind,preserve);}}>{ready?'刷新目录':'读取目录'}</button>}
 </details>}
 </ExchangeDialog>;
}
