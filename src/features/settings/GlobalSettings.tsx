import { useState } from 'react';
import { DismissibleLayer } from '../../components/popover/DismissibleLayer';
import { analysisError, defaultSettings } from '../spectrogram/workspace';
import type { AnalysisSettings } from '../../bridge/types';
import { displayPatch, type DisplayPreferences, type GlobalPlayback, type LocalSettingsStore } from './localSettings';

export function GlobalSettings({ store, onClose, initialDisplay, initialPlayback, initialAnalysis }: { store: LocalSettingsStore; onClose: () => void; initialDisplay?: DisplayPreferences; initialPlayback?: GlobalPlayback; initialAnalysis?: AnalysisSettings }) {
  const [display,setDisplay] = useState<DisplayPreferences>({ spectrumKind:'stft',frequencyMix:.65,gainDb:0,dynamicRangeDb:100,palette:'ember',...displayPatch(initialDisplay ?? {}),...store.value.display });
  const [playback,setPlayback] = useState<GlobalPlayback>({ monitorGainDb:0,volume:.75,looping:false,source:'processed',...initialPlayback,...store.value.playback });
  const [analysis,setAnalysis] = useState<AnalysisSettings>(store.value.analysis ?? initialAnalysis ?? defaultSettings);
  const [saved,setSaved] = useState(false);
  const valid = Number.isFinite(playback.monitorGainDb) && playback.monitorGainDb >= -60 && playback.monitorGainDb <= 24 && Number.isFinite(display.gainDb) && display.gainDb >= -60 && display.gainDb <= 60 && !analysisError(analysis);
  return <DismissibleLayer onClose={onClose} triggerSelector="[data-global-settings-trigger]" role="dialog" aria-label="全局播放与显示设置" className="analysis-popover global-settings-dialog">
    <header><strong>全局设置 · 本机</strong><button className="button button-quiet" onClick={onClose}>关闭</button></header>
    <form onChange={() => setSaved(false)} onSubmit={e => { e.preventDefault(); if(valid) setSaved(store.applyGlobal({display,playback,analysis})); }}>
      <fieldset><legend>播放</legend>
        <label>监听增益（dB）<span><input aria-label="全局监听增益（dB）" type="number" min="-60" max="24" step="0.1" value={Number.isFinite(playback.monitorGainDb)?playback.monitorGainDb:''} onChange={e=>setPlayback({...playback,monitorGainDb:e.target.valueAsNumber})}/></span></label>
        <label>输出音量<span>{Math.round(playback.volume*100)}%<input aria-label="全局输出音量" type="range" min="0" max="1" step="0.01" value={playback.volume} onChange={e=>setPlayback({...playback,volume:+e.target.value})}/></span></label>
        <label>声音版本<select aria-label="全局声音版本" value={playback.source} onChange={e=>setPlayback({...playback,source:e.target.value as GlobalPlayback['source']})}><option value="processed">暂存编辑</option><option value="original">原音</option></select></label>
        <label>循环播放<input aria-label="全局循环播放" type="checkbox" checked={playback.looping} onChange={e=>setPlayback({...playback,looping:e.target.checked})}/></label>
      </fieldset>
      <fieldset><legend>显示</legend>
        <label>频谱类型<select aria-label="全局频谱类型" value={display.spectrumKind} onChange={e=>setDisplay({...display,spectrumKind:e.target.value as DisplayPreferences['spectrumKind']})}><option value="stft">STFT 频谱</option><option value="mel">梅尔频谱</option></select></label>
        <label title={display.spectrumKind==='mel'?'梅尔频谱使用固定梅尔坐标；此比例用于 STFT':undefined}>STFT 线性 / 对数<span>{Math.round(display.frequencyMix*100)}%<input aria-label="全局线性对数混合" type="range" min="0" max="1" step="0.01" value={display.frequencyMix} onChange={e=>setDisplay({...display,frequencyMix:+e.target.value})}/></span></label>
        <label>显示增益（dB）<span><input aria-label="全局显示增益（dB）" type="number" min="-60" max="60" value={Number.isFinite(display.gainDb)?display.gainDb:''} onChange={e=>setDisplay({...display,gainDb:e.target.valueAsNumber})}/></span></label>
        <label>动态范围<span>{display.dynamicRangeDb} dB<input aria-label="全局动态范围" type="range" min="20" max="160" value={display.dynamicRangeDb} onChange={e=>setDisplay({...display,dynamicRangeDb:+e.target.value})}/></span></label>
        <label>色表<select aria-label="全局色表" value={display.palette} onChange={e=>setDisplay({...display,palette:e.target.value})}><option value="ember">余烬 · 紫红橙黄</option><option value="ocean">海蓝</option><option value="gray">灰度</option></select></label>
      </fieldset>
      <details className="global-analysis-details"><summary>高级 · STFT / 梅尔计算参数</summary><fieldset>
        <label>窗函数<select aria-label="全局窗函数" value={analysis.window} onChange={e=>setAnalysis({...analysis,window:e.target.value as AnalysisSettings['window']})}><option value="hann">Hann</option><option value="hamming">Hamming</option><option value="blackman">Blackman</option><option value="rectangular">矩形</option></select></label>
        {([['windowSize','窗长'],['hopSize','步长'],['fftSize','FFT 长度'],['melBands','梅尔频带']] as const).map(([key,label])=><label key={key}>{label}<span><input aria-label={`全局${label}`} type="number" value={Number.isFinite(analysis[key])?analysis[key]:''} onChange={e=>setAnalysis({...analysis,[key]:e.target.valueAsNumber})}/></span></label>)}
      </fieldset></details>
      {(!valid || store.error) && <p role="alert">{store.error ?? analysisError(analysis) ?? '监听增益须为 −60 至 +24 dB，显示增益须为 −60 至 +60 dB。'}</p>}
      <footer><button className="button button-accent" type="submit" disabled={!valid} title="应用到所有音频，并恢复各音频跟随全局；设置仅保存于本机">应用到全部音频</button>{saved && <span role="status">已保存到本机</span>}</footer>
    </form>
  </DismissibleLayer>;
}
