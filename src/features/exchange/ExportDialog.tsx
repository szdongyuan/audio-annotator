import { useState } from 'react';
import { FileJson, Package } from 'lucide-react';
import { ExchangeDialog, type ExchangeState } from './ExchangeDialog';
export function ExportDialog(props: ExchangeState & { shared?: boolean; onStart: (kind: 'annotations' | 'bundle') => void }) {
  const [kind, setKind] = useState<'annotations' | 'bundle'>('bundle');
  return <ExchangeDialog {...props} title={props.shared?'导出我的标注 / 项目包':'分享项目'}>
    <p>{props.shared?'只导出当前身份的标注、类别和文件/通道备注；不包含其他作者、账号及个人播放、屏蔽或视图设置。':'把当前版本保存为本地文件，交给另一台电脑继续标注。'}</p>
    <div className="exchange-options">{(['bundle', 'annotations'] as const).map(value => <label className={kind === value ? 'is-selected' : ''} key={value}>
      <input type="radio" name="exchange-format" aria-label={value === 'annotations' ? (props.shared?'我的标注（不含音频）':'仅标注（不含音频）') : (props.shared?'我的项目包（含音频）':'完整项目包（含音频）')} checked={kind === value} disabled={props.busy} onChange={() => setKind(value)} />
      {value === 'annotations' ? <FileJson size={24} /> : <Package size={24} />}<span><strong>{value === 'annotations' ? (props.shared?'我的标注（不含音频）':'仅标注（不含音频）') : (props.shared?'我的项目包（含音频）':'完整项目包（含音频）')}</strong><small>{value === 'annotations' ? '.annotations.json · 接收方需要同一批原始音频，导入后按指纹关联' : '.audioproj.zip · 包含所有原始音频'}</small></span>
    </label>)}</div>
    <p className="exchange-detail">{props.shared?'项目包包含原始音频，是当前身份的导出；全员协作请使用 NAS 原目录。':'保留备注、类别、区域、屏蔽、分析、混合与视图设置。完整包会校验每个原文件；缺失或改变时请先重新关联。'}</p>
    <button className="button button-accent" disabled={props.busy} onClick={() => props.onStart(kind)}>{props.error || props.cancelled ? '重试 · 选择保存位置…' : '选择保存位置…'}</button>
  </ExchangeDialog>;
}
