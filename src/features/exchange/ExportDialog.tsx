import { useState } from 'react';
import { FileJson, Package } from 'lucide-react';
import { ExchangeDialog, type ExchangeState } from './ExchangeDialog';
export function ExportDialog(props: ExchangeState & { onStart: (kind: 'annotations' | 'bundle') => void }) {
  const [kind, setKind] = useState<'annotations' | 'bundle'>('annotations');
  return <ExchangeDialog {...props} title="分享项目">
    <p>把当前版本保存为本地文件，交给另一台电脑继续标注。</p>
    <div className="exchange-options">{(['annotations', 'bundle'] as const).map(value => <label className={kind === value ? 'is-selected' : ''} key={value}>
      <input type="radio" name="exchange-format" aria-label={value === 'annotations' ? '仅标注文件' : '完整项目包'} checked={kind === value} disabled={props.busy} onChange={() => setKind(value)} />
      {value === 'annotations' ? <FileJson size={24} /> : <Package size={24} />}<span><strong>{value === 'annotations' ? '仅标注文件' : '完整项目包'}</strong><small>{value === 'annotations' ? '.annotations.json · 接收后关联原始音频' : '.audioproj.zip · 包含所有原始音频'}</small></span>
    </label>)}</div>
    <p className="exchange-detail">保留备注、类别、区域、屏蔽、分析、混合与视图设置。完整包会校验每个原文件；缺失或改变时请先重新关联。</p>
    <button className="button button-accent" disabled={props.busy} onClick={() => props.onStart(kind)}>{props.error || props.cancelled ? '重试 · 选择保存位置…' : '选择保存位置…'}</button>
  </ExchangeDialog>;
}
