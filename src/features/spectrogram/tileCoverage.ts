import type { TileCache } from './tileCache';
import type { TileResult } from './tileClient';
import { tileKey, type TileInput } from './workspace';
/** Reuse complete finer time/frequency coverage. Keys retain ownership in the
 * shared LRU; no copied numeric buffers and no gaps treated as endpoints. */
export function coveringTileKeys(cache: TileCache<TileResult>, source: string, request: TileInput): string[] | undefined {
  const exact = tileKey(source, request);
  if (cache.get(exact)) return [exact];
  const requestedEnd = request.startFrame + request.frameCount * 2 ** request.timeLod;
  let end = requestedEnd;
  const candidates = cache.matchingKeys((tile, key) => {
    const r = tile.request;
    return key.startsWith(`${source}|`) && r.mediaId === request.mediaId && r.configHash === request.configHash
      && r.analysisSource === request.analysisSource && r.processingVersion === request.processingVersion && r.editSignature === request.editSignature
      && r.channelIndex === request.channelIndex && r.kind === request.kind && r.timeLod <= request.timeLod
      && r.frequencyLod <= request.frequencyLod && r.startFrame < requestedEnd
      && r.startFrame + r.frameCount * 2 ** r.timeLod > request.startFrame
      && r.frequencyStart < request.frequencyStart + request.frequencyCount && r.frequencyStart + r.frequencyCount > request.frequencyStart;
  }).map(key => {
    const tile = cache.get(key)!, r = tile.request;
    const total = tile.metadata ? Math.ceil(tile.metadata.totalSamples / r.settings.hopSize) : Infinity;
    end = Math.min(end, total);
    return { key, lod: r.timeLod, start: r.frequencyStart, end: r.frequencyStart + r.frequencyCount, from: r.startFrame, to: Math.min(total, r.startFrame + r.frameCount * 2 ** r.timeLod) };
  });
  if (end <= request.startFrame) return;
  // Frequency partitions must describe the same time grid. A mix of time
  // strides cannot form complete rows; request the missing coherent data instead.
  for (const lod of [...new Set(candidates.map(c => c.lod))].sort((a, b) => b - a)) {
    const grid = candidates.filter(c => c.lod === lod);
    const boundaries = [...new Set([request.startFrame, end, ...grid.flatMap(c => [c.from, c.to]).filter(t => t > request.startFrame && t < end)])].sort((a, b) => a - b);
    const keys = new Set<string>();
    let complete = true;
    for (let i = 0; i < boundaries.length - 1 && complete; i++) {
      let cursor = request.frequencyStart;
      while (cursor < request.frequencyStart + request.frequencyCount) {
        const covering = grid.filter(c => c.from <= boundaries[i] && c.to >= boundaries[i + 1] && c.start <= cursor && c.end > cursor).sort((a, b) => b.end - a.end)[0];
        if (!covering) { complete = false; break; }
        keys.add(covering.key); cursor = covering.end;
      }
    }
    if (complete) return [...keys];
  }
}
