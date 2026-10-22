const palettes: Record<string, number[][]> = {
  ember: [[0, 0, 0], [18, 3, 36], [64, 12, 96], [141, 21, 95], [210, 49, 51], [248, 126, 33], [255, 222, 87], [255, 251, 211]],
  ocean: [[0, 0, 0], [9, 18, 52], [25, 48, 111], [26, 112, 153], [39, 185, 188], [161, 233, 207], [247, 255, 222]],
  gray: [[0, 0, 0], [255, 255, 255]],
};
export function paletteLut(name: string): Uint8ClampedArray {
  const stops = palettes[name] ?? palettes.ember, result = new Uint8ClampedArray(256 * 4);
  for (let i = 0; i < 256; i++) {
    const position = i / 255 * (stops.length - 1), lo = Math.min(stops.length - 2, Math.floor(position)), mix = position - lo;
    for (let c = 0; c < 3; c++) result[i * 4 + c] = stops[lo][c] * (1 - mix) + stops[lo + 1][c] * mix;
    result[i * 4 + 3] = 255;
  }
  return result;
}
export function paletteGradient(name: string) { return `linear-gradient(to top, ${(palettes[name] ?? palettes.ember).map(c => `rgb(${c.join(',')})`).join(',')})`; }
