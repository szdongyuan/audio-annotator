import type { TileCache } from './tileCache';
import type { TileResult } from './tileClient';
import { tileKey, type TileInput } from './workspace';
/** Reuse fine cached frequency partitions, including across a coarser LOD
 * boundary. Returns keys only; the shared LRU remains the sole buffer owner. */
export function coveringTileKeys(cache: TileCache<TileResult>, source: string, request: TileInput): string[] | undefined {
  const exact = tileKey(source, request);
  if (cache.get(exact)) return [exact];
  const candidates = cache.matchingKeys((tile, key) => {
    const r = tile.request;
    return key.startsWith(`${source}|`) && r.mediaId === request.mediaId && r.configHash === request.configHash
      && r.channelIndex === request.channelIndex && r.kind === request.kind && r.startFrame === request.startFrame
      && r.frameCount === request.frameCount && r.timeLod === request.timeLod && r.frequencyLod <= request.frequencyLod
      && r.frequencyStart < request.frequencyStart + request.frequencyCount && r.frequencyStart + r.frequencyCount > request.frequencyStart;
  }).map(key => { const r = cache.get(key)!.request; return { key, start: r.frequencyStart, end: r.frequencyStart + r.frequencyCount }; });
  const keys: string[] = [];
  let cursor = request.frequencyStart;
  while (cursor < request.frequencyStart + request.frequencyCount) {
    const covering = candidates.filter(c => c.start <= cursor && c.end > cursor).sort((a, b) => b.end - a.end)[0];
    if (!covering) return;
    keys.push(covering.key); cursor = covering.end;
  }
  return keys;
}
