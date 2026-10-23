import { useEffect, useState } from 'react';
import { DismissibleLayer } from '../../components/popover/DismissibleLayer';
import type { AnalysisSettings as Settings, MediaDescriptor, MediaView } from '../../bridge/types';
import { analysisError } from './workspace';
export function AnalysisSettings({ media, settings, view, disabled, onApply, onView, onClose }: { media: MediaDescriptor; settings: Settings; view: MediaView; disabled: boolean; onApply: (s: Settings) => void; onView: (v: Partial<MediaView>) => void; onClose: () => void }) {
  const [draft, setDraft] = useState(settings);
  const { window: analysisWindow, windowSize, hopSize, fftSize, melBands } = settings;
  // View-only native saves return fresh objects. Reset only for changed analysis
  // authority, preserving unapplied compute edits across unrelated snapshots.
  useEffect(() => setDraft({ window: analysisWindow, windowSize, hopSize, fftSize, melBands }), [analysisWindow, windowSize, hopSize, fftSize, melBands]);
  const error = analysisError(draft);
  return <DismissibleLayer onClose={onClose} triggerSelector="[data-analysis-trigger]" className="analysis-popover" role="dialog" aria-label={`${media.displayName} 分析设置`}><header><div><strong>分析设置</strong><small>{media.displayName}</small></div><button className="button button-quiet" onClick={onClose}>关闭</button></header>
    <fieldset disabled={disabled}><legend>计算参数</legend><label>窗函数<select value={draft.window} onChange={e => setDraft({ ...draft, window: e.target.value as Settings['window'] })}><option value="hann">Hann</option><option value="hamming">Hamming</option><option value="blackman">Blackman</option><option value="rectangular">矩形</option></select></label>
      {([['windowSize', '窗长'], ['hopSize', '步长'], ['fftSize', 'FFT 长度'], ['melBands', '梅尔频带']] as const).map(([key, label]) => <label key={key}>{label}<span><input aria-label={label} type="number" value={Number.isNaN(draft[key]) ? '' : draft[key]} onChange={e => setDraft({ ...draft, [key]: e.target.valueAsNumber })} />{key !== 'melBands' && <small>{Number.isFinite(draft[key]) ? `${draft[key]} samples · ${(draft[key] / media.sampleRate * 1000).toFixed(2)} ms` : '请输入整数'}</small>}</span></label>)}
      {error && <p role="alert">{error}</p>}<button className="button button-accent" disabled={!!error} onClick={() => onApply(draft)}>应用分析参数</button>
    </fieldset>
    <fieldset disabled={disabled}><legend>显示参数</legend><label>频谱类型<select aria-label={`${media.displayName} 设置频谱类型`} value={view.spectrumKind} onChange={e => onView({ spectrumKind: e.target.value as MediaView['spectrumKind'] })}><option value="stft">STFT 频谱</option><option value="mel">梅尔频谱</option></select></label><label title={view.spectrumKind === 'mel' ? '梅尔模式使用固定梅尔映射' : undefined}>线性 / 对数 <span>{Math.round(view.frequencyMix * 100)}%<input type="range" min="0" max="1" step="0.01" aria-label={`${media.displayName} 线性对数混合`} value={view.frequencyMix} disabled={view.spectrumKind === 'mel'} onChange={e => onView({ frequencyMix: +e.target.value })} /></span></label><label>色表<select value={view.palette} onChange={e => onView({ palette: e.target.value })}><option value="ember">余烬 · 紫红橙黄</option><option value="ocean">海蓝</option><option value="gray">灰度</option></select></label>
      <label>显示增益 <span>{view.gainDb} dB<input aria-label="显示增益" type="range" min="-60" max="60" value={view.gainDb} onChange={e => onView({ gainDb: +e.target.value })} /></span></label>
      <label>动态范围 <span>{view.dynamicRangeDb} dB<input aria-label="动态范围" type="range" min="20" max="160" value={view.dynamicRangeDb} onChange={e => onView({ dynamicRangeDb: +e.target.value })} /></span></label>
      <p className="settings-note">显示增益仅改变颜色，不改变音量。STFT 幅度与梅尔带功率使用各自的固定 dB 参考。</p>
    </fieldset>
  </DismissibleLayer>;
}
