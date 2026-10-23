import type { TileResult } from './tileClient';
export function timeCenters({ request: r, metadata: m }: TileResult): Float64Array {
  const step = 2 ** r.timeLod;
  return Float64Array.from({ length: m.rows }, (_, row) => (r.startFrame + row * step + (Math.min(step, m.sourceFrames - row * step) - 1) / 2) * r.settings.hopSize / m.sampleRate);
}
export function frequencyCenters({ request: r, metadata: m }: TileResult): Float64Array {
  const step = 2 ** r.frequencyLod;
  return Float64Array.from({ length: m.columns }, (_, column) => {
    const first = r.frequencyStart + column * step, count = Math.min(step, r.frequencyCount - column * step);
    if (r.kind === 'stft') return (first + (count - 1) / 2) * m.sampleRate / r.settings.fftSize;
    let sum = 0; for (let k = first; k < first + count; k++) sum += m.melPointsHz[k + 1];
    return sum / count;
  });
}
interface Point { center: number; start: number; end: number }
export interface Pair { low: number; high: number; weight: number }
const missing = (): Pair => ({ low: -1, high: -1, weight: 0 });
/** Gaps are pending data, not global endpoints. Only true DC/start and Nyquist/end extend. */
function brackets(points: Point[], positions: Float64Array, total: number, limit: number, exclusive: boolean): Pair[] {
  return Array.from(positions, position => {
    if (!points.length || position < 0 || (exclusive ? position >= limit : position > limit)) return missing();
    const last = points.length - 1;
    if (position < points[0].center) return points[0].start === 0 ? { low: 0, high: 0, weight: 0 } : missing();
    if (position > points[last].center) return points[last].end === total ? { low: last, high: last, weight: 0 } : missing();
    let lo = 0, hi = last;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (points[mid].center < position) lo = mid + 1; else hi = mid; }
    if (points[lo].center === position) return { low: lo, high: lo, weight: 0 };
    const left = lo - 1;
    if (points[left].end !== points[lo].start) return missing();
    return { low: left, high: lo, weight: (position - points[left].center) / (points[lo].center - points[left].center) };
  });
}
interface Column extends Point { tile: TileResult; column: number }
interface Row extends Point { parts: { tile: TileResult; row: number }[] }
/** Precompute both axes. The rasterizer keeps only two height-sized power profiles;
 * dB conversion happens once per needed source bin/row, never in the pixel loop. */
export function createSampler(input: Iterable<TileResult>, seconds: Float64Array, hz: Float64Array) {
  const tiles = [...input], first = tiles[0];
  const rows = new Map<string, Row>();
  for (const tile of tiles) {
    const centers = timeCenters(tile), step = 2 ** tile.request.timeLod;
    for (let row = 0; row < centers.length; row++) {
      const start = tile.request.startFrame + row * step, end = start + Math.min(step, tile.metadata.sourceFrames - row * step), key = `${start}:${end}`;
      let entry = rows.get(key);
      if (!entry) { entry = { start, end, center: centers[row], parts: [] }; rows.set(key, entry); }
      entry.parts.push({ tile, row });
    }
  }
  const ordered = [...rows.values()].sort((a, b) => a.center - b.center);
  const totalFrames = first ? Math.ceil(first.metadata.totalSamples / first.request.settings.hopSize) : 0;
  const time = brackets(ordered, seconds, totalFrames, first ? first.metadata.totalSamples / first.metadata.sampleRate : 0, true);
  // Each time tile shares one frequency topology across its rows.
  const topologies = new Map<string, { columns: Column[]; pairs: Pair[]; needed: number[] }>();
  const tileIds = new Map(tiles.map((t, i) => [t, i]));
  const profiles = ordered.map(row => {
    const key = row.parts.map(p => tileIds.get(p.tile)).join(',');
    let topology = topologies.get(key);
    if (!topology) {
      const columns: Column[] = [];
      for (const { tile } of row.parts) {
        const centers = frequencyCenters(tile), r = tile.request, step = 2 ** r.frequencyLod;
        for (let column = 0; column < centers.length; column++) {
          const start = r.frequencyStart + column * step;
          columns.push({ start, end: start + Math.min(step, r.frequencyCount - column * step), center: centers[column], tile, column });
        }
      }
      columns.sort((a, b) => a.center - b.center);
      const r = row.parts[0].tile.request, m = row.parts[0].tile.metadata;
      const pairs = brackets(columns, hz, r.kind === 'mel' ? r.settings.melBands : r.settings.fftSize / 2 + 1, m.sampleRate / 2, false);
      const needed = [...new Set(pairs.flatMap(p => p.low < 0 ? [] : [p.low, p.high]))];
      topology = { columns, pairs, needed }; topologies.set(key, topology);
    }
    return { row, topology };
  });
  // One reusable bin buffer across all profiles; no second numeric tile cache.
  const powers = new Float64Array(Math.max(0, ...[...topologies.values()].map(t => t.columns.length)));
  return { time, profile(index: number, out: Float64Array) {
    const { row, topology } = profiles[index];
    for (const k of topology.needed) {
      const c = topology.columns[k], source = row.parts.find(p => p.tile === c.tile)!;
      powers[k] = 10 ** (c.tile.values[source.row * c.tile.metadata.columns + c.column] / 10);
    }
    for (let y = 0; y < hz.length; y++) { const p = topology.pairs[y]; out[y] = p.low < 0 ? NaN : powers[p.low] * (1 - p.weight) + powers[p.high] * p.weight; }
  } };
}
