import { it, expect } from 'vitest';
import { TileCache } from './tileCache';
import { coveringTileKeys } from './tileCoverage';
import { defaultSettings, tileKey, type TileInput } from './workspace';
import type { TileResult } from './tileClient';
const request: TileInput = { mediaId: 'media', settings: defaultSettings, configHash: 'config', channelIndex: 0, kind: 'stft', startFrame: 0, frameCount: 256, timeLod: 0, frequencyStart: 0, frequencyCount: 1025, frequencyLod: 0, visible: true };
it('reuses one or several covering finer tiles without crossing ownership or data configuration', () => {
  const cache = new TileCache<TileResult>();
  const add = (start: number, count: number) => { const r = { ...request, frequencyStart: start, frequencyCount: count }; const key = tileKey('owner/source', r); cache.set(key, { request: r } as TileResult, 100); return key; };
  const first = add(0, 1025), second = add(1025, 1025);
  expect(coveringTileKeys(cache, 'owner/source', { ...request, frequencyStart: 100, frequencyCount: 400, frequencyLod: 1 })).toEqual([first]);
  expect(coveringTileKeys(cache, 'owner/source', { ...request, frequencyStart: 900, frequencyCount: 800, frequencyLod: 1 })).toEqual([first, second]);
  for (const patch of [{ channelIndex: 1 }, { configHash: 'other' }, { startFrame: 256 }, { frequencyStart: 2040, frequencyCount: 100 }]) expect(coveringTileKeys(cache, 'owner/source', { ...request, ...patch })).toBeUndefined();
  expect(coveringTileKeys(cache, 'new-owner/source', request)).toBeUndefined();
  expect(cache.bytes).toBe(200);
});
it('does not use coarse cached bins for requested fine detail', () => {
  const cache = new TileCache<TileResult>();
  const coarse = { ...request, frequencyLod: 4 };
  cache.set(tileKey('source', coarse), { request: coarse } as TileResult, 100);
  expect(coveringTileKeys(cache, 'source', { ...request, frequencyStart: 100, frequencyCount: 200 })).toBeUndefined();
});
