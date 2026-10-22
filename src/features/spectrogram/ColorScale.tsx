import type { MediaView } from '../../bridge/types';
import { paletteGradient } from './palette';
export function ColorScale({ view }: { view: MediaView }) {
  return <div className="color-scale" aria-label={view.spectrumKind === 'mel' ? '梅尔带功率 dB 色阶' : '归一化幅度 dB 色阶'} title={view.spectrumKind === 'mel' ? '梅尔带功率 · 固定 dB 参考' : 'STFT 归一化幅度 · 固定 dB 参考'}><span>{-view.gainDb}</span><i style={{ background: paletteGradient(view.palette) }} /><span>{-view.dynamicRangeDb - view.gainDb}</span><small>dB</small></div>;
}
