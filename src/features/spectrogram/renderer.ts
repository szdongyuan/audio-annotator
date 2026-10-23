import type { AnalysisSettings, MediaView } from '../../bridge/types';
import { coordinates, clamp } from './coordinates';
import { paletteLut } from './palette';
import type { TileResult } from './tileClient';
import { rasterBudget, scratchWidth } from './rasterBudget';
import { createSampler } from './sampling';
/** Invert the shared physical coordinate transform once per screen row. */
export function frequencyRows(view: MediaView, sampleRate: number, _settings: AnalysisSettings, height: number): Float64Array {
  const c = coordinates(view, sampleRate / 2, 1, height);
  return Float64Array.from({ length: height }, (_, y) => c.yToHz(y + .5));
}
function painter(width: number, height: number, view: MediaView, hz: Float64Array, tiles: Iterable<TileResult>) {
  const lut = paletteLut(view.palette), c = coordinates(view, 1, width, height);
  const seconds = Float64Array.from({ length: width }, (_, x) => c.xToSeconds(x + .5));
  const sampler = createSampler(tiles, seconds, hz);
  let lowIndex = -1, highIndex = -1, low = new Float64Array(height), high = new Float64Array(height);
  return (pixels: Uint8ClampedArray, from: number, count: number, stride: number) => {
    pixels.fill(0);
    for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255;
    for (let x = from; x < from + count; x++) {
      const pair = sampler.time[x];
      if (pair.low < 0) continue;
      if (pair.low !== lowIndex) {
        if (pair.low === highIndex) { [low, high] = [high, low]; [lowIndex, highIndex] = [highIndex, lowIndex]; }
        else { sampler.profile(pair.low, low); lowIndex = pair.low; }
      }
      if (pair.high !== highIndex) { sampler.profile(pair.high, high); highIndex = pair.high; }
      for (let y = 0; y < height; y++) {
        const power = low[y] * (1 - pair.weight) + high[y] * pair.weight;
        if (!Number.isFinite(power)) continue;
        const db = 10 * Math.log10(Math.max(1e-16, power));
        const color = Math.round(clamp((db + view.gainDb + view.dynamicRangeDb) / view.dynamicRangeDb, 0, 1) * 255) * 4;
        const target = (y * stride + x - from) * 4;
        pixels[target] = lut[color]; pixels[target + 1] = lut[color + 1]; pixels[target + 2] = lut[color + 2];
      }
    }
  };
}
export function rasterize(pixels: Uint8ClampedArray, width: number, height: number, view: MediaView, hz: Float64Array, tiles: Iterable<TileResult>) {
  painter(width, height, view, hz, tiles)(pixels, 0, width, width);
}
export function drawSpectrogram(canvas: HTMLCanvasElement, view: MediaView, settings: AnalysisSettings, sampleRate: number, tiles: Iterable<TileResult>) {
  const context = canvas.getContext('2d', { alpha: false });
  if (!context || !canvas.width || !canvas.height) return;
  const strip = scratchWidth(canvas.width), image = rasterBudget.image(context, strip, canvas.height);
  const paint = painter(canvas.width, canvas.height, view, frequencyRows(view, sampleRate, settings, canvas.height), tiles);
  for (let x = 0; x < canvas.width; x += strip) {
    const count = Math.min(strip, canvas.width - x);
    paint(image.data, x, count, strip);
    context.putImageData(image, x, 0, 0, 0, count, canvas.height);
  }
}
