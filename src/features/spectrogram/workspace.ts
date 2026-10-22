import type { AnalysisSettings, MediaDescriptor, MediaView, ViewState } from '../../bridge/types';
import { splitFrequencyRequests, type TileRequest } from './tileClient';
import { boundRange } from './viewport';
export const defaultSettings: AnalysisSettings = { window: 'hann', windowSize: 2048, hopSize: 512, fftSize: 2048, melBands: 128 };
export const duration = (m: MediaDescriptor) => m.frameCount / m.sampleRate;
export function defaultView(media: MediaDescriptor): MediaView {
  return { visibleChannels: Array.from({ length: Math.min(2, media.channelCount) }, (_, i) => i), startSeconds: 0, endSeconds: Math.min(10, duration(media)), lowHz: 0, highHz: media.sampleRate / 2, frequencyMix: .65, spectrumKind: 'stft', gainDb: 0, dynamicRangeDb: 100, palette: 'ember' };
}
export function changeView(state: ViewState, media: MediaDescriptor[], id: string, patch: Partial<MediaView>): ViewState {
  const source = media.find(m => m.id === id)!;
  const next = { ...state, media: { ...state.media, [id]: { ...(state.media[id] ?? defaultView(source)), ...patch } } };
  if (state.linkedTime && ('startSeconds' in patch || 'endSeconds' in patch)) {
    for (const target of [state.activeMediaId, state.compareMediaId]) if (target && target !== id) {
      const m = media.find(m => m.id === target);
      if (m) next.media[target] = { ...(next.media[target] ?? defaultView(m)), startSeconds: next.media[id].startSeconds, endSeconds: next.media[id].endSeconds };
    }
  }
  return next;
}
export function toggleLinked(state: ViewState, media: MediaDescriptor[], linkedTime: boolean): ViewState {
  let next = { ...state, media: { ...state.media }, linkedTime };
  if (linkedTime && state.activeMediaId) {
    const m = media.find(m => m.id === state.activeMediaId);
    if (m) {
      const v = state.media[m.id] ?? defaultView(m);
      const pair = media.filter(source => source.id === state.activeMediaId || source.id === state.compareMediaId);
      const [startSeconds, endSeconds] = boundRange(v.startSeconds, v.endSeconds, Math.max(...pair.map(duration)));
      next = changeView(next, media, m.id, { startSeconds, endSeconds });
    }
  } else for (const m of media) if (next.media[m.id]) {
    const v = next.media[m.id], [startSeconds, endSeconds] = boundRange(v.startSeconds, v.endSeconds, duration(m));
    next.media[m.id] = { ...v, startSeconds, endSeconds };
  }
  return next;
}
export function analysisError(s: AnalysisSettings | { window: string; windowSize: number; hopSize: number; fftSize: number; melBands: number }): string | null {
  if (!['hann', 'hamming', 'blackman', 'rectangular'].includes(s.window)) return '请选择有效窗函数';
  if (!Number.isInteger(s.windowSize) || s.windowSize < 64 || s.windowSize > 32768) return '窗长须为 64–32768 samples 的整数';
  if (!Number.isInteger(s.hopSize) || s.hopSize < 1 || s.hopSize > s.windowSize) return '步长须为 1 至窗长之间的整数';
  if (!Number.isInteger(s.fftSize) || s.fftSize < s.windowSize || s.fftSize > 65536 || (s.fftSize & (s.fftSize - 1)) !== 0) return 'FFT 长度须是不小于窗长的 2 的幂，最大 65536';
  if (!Number.isInteger(s.melBands) || s.melBands < 32 || s.melBands > 512) return '梅尔频带数须为 32–512 的整数';
  return null;
}
export const analysisKey = (s: AnalysisSettings | { window: string; windowSize: number; hopSize: number; fftSize: number; melBands: number }) => `${s.window}|${s.windowSize}|${s.hopSize}|${s.fftSize}|${s.melBands}`;
export type TileInput = Omit<TileRequest, 'requestId' | 'projectId' | 'viewId' | 'generation'>;
// Twelve mounted channels can each own this working set: <=60 MiB numeric
// dependencies, leaving room in the 64 MiB LRU for historical/prefetch tiles.
export const CHANNEL_TILE_BUDGET = 5 * 1024 * 1024;
export const tileInputBytes = (r: TileInput) => r.frameCount * Math.ceil(r.frequencyCount / 2 ** r.frequencyLod) * 4 + 16384;
export function frequencyWindow(media: MediaDescriptor, settings: AnalysisSettings, view: Pick<MediaView, 'spectrumKind' | 'lowHz' | 'highHz'>) {
  const bins = view.spectrumKind === 'mel' ? settings.melBands : settings.fftSize / 2 + 1;
  const binAt = (hz: number) => view.spectrumKind === 'mel' ? Math.log1p(hz / 700) / Math.log1p(media.sampleRate / 1400) * (settings.melBands + 1) - 1 : hz * settings.fftSize / media.sampleRate;
  return { bins, lowBin: Math.max(0, Math.floor(binAt(view.lowHz)) - 1), endBin: Math.min(bins, Math.ceil(binAt(view.highHz)) + 2) };
}
/** Aligned time tiles reuse native cache. Frequency data is independent of axis/color changes. */
export function tilePlan(media: MediaDescriptor, settings: AnalysisSettings, view: Pick<MediaView, 'startSeconds' | 'endSeconds' | 'spectrumKind' | 'lowHz' | 'highHz'>, width: number, channelIndex: number, configHash: string): TileInput[] {
  const end = Math.min(duration(media), view.endSeconds);
  if (view.startSeconds >= end) return [];
  const first = Math.floor(view.startSeconds * media.sampleRate / settings.hopSize), last = Math.ceil(end * media.sampleRate / settings.hopSize);
  let timeLod = Math.min(16, Math.max(0, Math.ceil(Math.log2((last - first) / Math.max(64, Math.min(1024, width))))));
  const total = Math.ceil(media.frameCount / settings.hopSize);
  const { bins, lowBin, endBin } = frequencyWindow(media, settings, view);
  // Reserve the worst possible pair of frequency partitions independently of
  // the frequency viewport. Frequency-only navigation must not alter time LOD.
  const maxColumns = Math.min(bins, 2050), maxParts = Math.ceil(maxColumns / 1025);
  const workingBytes = (lod: number) => {
    const step = 2 ** lod, span = 256 * step;
    const start = Math.floor(first / span) * span, final = Math.floor((last - 1) / span) * span;
    const count = (final - start) / span + 1;
    const rows = (count - 1) * 256 + Math.min(256, Math.ceil((total - final) / step));
    return rows * maxColumns * 4 + count * maxParts * 16384;
  };
  while (timeLod < 16 && workingBytes(timeLod) > CHANNEL_TILE_BUDGET) timeLod++;
  if (workingBytes(timeLod) > CHANNEL_TILE_BUDGET) throw { code: 'ResourceLimit', message: '当前时间范围过大，请放大时间轴后重试', retryable: true };
  const stride = 2 ** timeLod, tileSpan = 256 * stride;
  const starts: { start: number; visible: boolean }[] = [];
  for (let start = Math.floor(first / tileSpan) * tileSpan; start < last; start += tileSpan) starts.push({ start, visible: true });
  for (const start of [starts[0].start - tileSpan, starts[starts.length - 1].start + tileSpan]) if (start >= 0 && start < total) starts.push({ start, visible: false });
  const frequencyLod = Math.max(0, Math.ceil(Math.log2((endBin - lowBin) / 1025)));
  // Stable partitions, not viewport edges, define native cache keys. Default
  // STFT and every mel band fit in one full-resolution partition. Large FFTs
  // refine only as needed and each response remains at most 1025 columns.
  const partition = 1025 * 2 ** frequencyLod;
  const frequencies: { frequencyStart: number; frequencyCount: number }[] = [];
  for (let frequencyStart = Math.floor(lowBin / partition) * partition; frequencyStart < endBin; frequencyStart += partition) frequencies.push({ frequencyStart, frequencyCount: Math.min(partition, bins - frequencyStart) });
  return starts.flatMap(({ start, visible }) => frequencies.flatMap(frequency => splitFrequencyRequests({ mediaId: media.id, settings, configHash, channelIndex, kind: view.spectrumKind, startFrame: start, frameCount: Math.min(256, Math.ceil((total - start) / stride)), timeLod, ...frequency, frequencyLod, visible })));
}
export function tileKey(source: string, r: TileInput) { return `${source}|${r.mediaId}|${r.channelIndex}|${r.configHash}|${r.kind}|${r.startFrame}|${r.frameCount}|${r.timeLod}|${r.frequencyStart}|${r.frequencyCount}|${r.frequencyLod}`; }
