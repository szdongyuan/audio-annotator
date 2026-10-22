import type { AnalysisSettings, MediaView } from '../../bridge/types';
import { coordinates, clamp } from './coordinates';
import { paletteLut } from './palette';
import type { TileResult } from './tileClient';
/** Calculate inverse only once per screen ROW, never inside the pixel loop. */
export function frequencyRows(view: MediaView, sampleRate: number, settings: AnalysisSettings, height: number): Int32Array {
  const c = coordinates(view, sampleRate / 2, 1, height), rows = new Int32Array(height);
  for (let y = 0; y < height; y++) {
    const hz = c.yToHz(y + .5);
    rows[y] = view.spectrumKind === 'stft'
      ? clamp(Math.round(hz * settings.fftSize / sampleRate), 0, settings.fftSize / 2)
      : clamp(Math.round(Math.log1p(hz / 700) / Math.log1p(sampleRate / 1400) * (settings.melBands + 1)) - 1, 0, settings.melBands - 1);
  }
  return rows;
}
export function rasterize(pixels: Uint8ClampedArray, width: number, height: number, view: MediaView, bins: Int32Array, tiles: Iterable<TileResult>) {
  const lut = paletteLut(view.palette), c = coordinates(view, 1, width, height);
  for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255;
  for (const tile of tiles) {
    const { metadata: m, request: r, values } = tile;
    const first = Math.max(0, Math.ceil(c.secondsToX(m.startSeconds) - .5)), last = Math.min(width, Math.ceil(c.secondsToX(m.endSeconds) - .5));
    const rows = new Int32Array(Math.max(0, last - first));
    for (let x = first; x < last; x++) rows[x - first] = clamp(Math.floor((c.xToSeconds(x + .5) - m.startSeconds) * m.sampleRate / m.frameStepSamples), 0, m.rows - 1);
    for (let y = 0; y < height; y++) {
      const bin = bins[y];
      if (bin < r.frequencyStart || bin >= r.frequencyStart + r.frequencyCount) continue;
      const column = Math.floor((bin - r.frequencyStart) / 2 ** r.frequencyLod);
      for (let x = first; x < last; x++) {
        const db = values[rows[x - first] * m.columns + column];
        const color = Math.round(clamp((db + view.gainDb + view.dynamicRangeDb) / view.dynamicRangeDb, 0, 1) * 255) * 4;
        const target = (y * width + x) * 4;
        pixels[target] = lut[color]; pixels[target + 1] = lut[color + 1]; pixels[target + 2] = lut[color + 2];
      }
    }
  }
}
export function drawSpectrogram(canvas: HTMLCanvasElement, view: MediaView, settings: AnalysisSettings, sampleRate: number, tiles: Iterable<TileResult>) {
  const context = canvas.getContext('2d', { alpha: false });
  if (!context || !canvas.width || !canvas.height) return;
  const image = context.createImageData(canvas.width, canvas.height);
  rasterize(image.data, canvas.width, canvas.height, view, frequencyRows(view, sampleRate, settings, canvas.height), tiles);
  context.putImageData(image, 0, 0);
}
