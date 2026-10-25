import type { ExchangeUI } from './useExchange';
import { ExchangeDialog, type ExchangeState } from './ExchangeDialog';
export function ImportDialog(props: ExchangeState & { onStart: () => void } & Partial<Pick<ExchangeUI,'sources'|'bindings'|'chooseSource'|'continueImport'>>) {
  return <ExchangeDialog {...props} title="导入分享文件">
    <p>导入为独立项目副本，保存在所选位置的新文件夹中。当前项目会先保存，校验通过后再切换。</p>
    <div className="exchange-import-note"><strong>从文件接续工作</strong><p>完整项目包（含音频）.audioproj.zip 导入后即可继续工作。仅标注（不含音频）.annotations.json 需要接收方提供同一批原始音频，再按指纹关联。</p></div>
    {props.sources&&<div aria-label="关联原始音频">{props.sources.media.map(m=><div key={m.id}><span>{m.displayName}</span><button className="button" disabled={props.busy} onClick={()=>void props.chooseSource?.(m.id)}>{props.bindings?.[m.id]?'更换音频':'选择音频'}</button>{props.bindings?.[m.id]&&<small className="media-source-path">{props.bindings[m.id]}</small>}</div>)}<button className="button button-accent" disabled={props.busy||props.sources.media.some(m=>!props.bindings?.[m.id])} onClick={()=>void props.continueImport?.()}>校验并导入</button><button className="button" disabled={props.busy} onClick={props.onCancel}>取消关联</button></div>}
    <button className="button button-accent" disabled={props.busy} onClick={props.onStart}>{props.error || props.cancelled ? '重试 · 选择交换文件…' : '选择交换文件…'}</button>
  </ExchangeDialog>;
}
