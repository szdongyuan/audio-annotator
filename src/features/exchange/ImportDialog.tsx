import { ExchangeDialog, type ExchangeState } from './ExchangeDialog';
export function ImportDialog(props: ExchangeState & { onStart: () => void }) {
  return <ExchangeDialog {...props} title="导入分享文件">
    <p>导入为独立项目副本，保存在所选位置的新文件夹中。当前项目会先保存，校验通过后再切换。</p>
    <div className="exchange-import-note"><strong>从文件接续工作</strong><p>选择 .annotations.json 或 .audioproj.zip。仅标注文件可以先导入，再按指纹关联原始音频。</p></div>
    <button className="button button-accent" disabled={props.busy} onClick={props.onStart}>{props.error || props.cancelled ? '重试 · 选择交换文件…' : '选择交换文件…'}</button>
  </ExchangeDialog>;
}
