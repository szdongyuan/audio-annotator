import { it, expect } from 'vitest';
import { TileCache } from './tileCache';
import { coveringTileKeys } from './tileCoverage';
import { defaultSettings, tileKey, type TileInput } from './workspace';
import type { TileResult } from './tileClient';
const request: TileInput = { mediaId: 'media', settings: defaultSettings, analysisSource:'original' as const,processingVersion:1,editSignature:'',configHash: 'config', channelIndex: 0, kind: 'stft', startFrame: 0, frameCount: 256, timeLod: 0, frequencyStart: 0, frequencyCount: 1025, frequencyLod: 0, visible: true };
it('reuses one or several covering finer tiles without crossing ownership or data configuration', () => {
  const cache = new TileCache<TileResult>();
  const add = (start: number, count: number) => { const r = { ...request, frequencyStart: start, frequencyCount: count }; const key = tileKey('owner/source', r); cache.set(key, { request: r } as TileResult, 100); return key; };
  const first = add(0, 1025), second = add(1025, 1025);
  expect(coveringTileKeys(cache, 'owner/source', { ...request, frequencyStart: 100, frequencyCount: 400, frequencyLod: 1 })).toEqual([first]);
  expect(coveringTileKeys(cache, 'owner/source', { ...request, frequencyStart: 900, frequencyCount: 800, frequencyLod: 1 })).toEqual([first, second]);
  for (const patch of [{ channelIndex: 1 }, { configHash: 'other' }, { analysisSource: 'processed' as const, editSignature: '0'.repeat(64) }, { processingVersion: 2 }, { editSignature: 'other' }, { startFrame: 256 }, { frequencyStart: 2040, frequencyCount: 100 }]) expect(coveringTileKeys(cache, 'owner/source', { ...request, ...patch })).toBeUndefined();
  expect(coveringTileKeys(cache, 'new-owner/source', request)).toBeUndefined();
  expect(cache.bytes).toBe(200);
});
it('does not use coarse cached bins for requested fine detail', () => {
  const cache = new TileCache<TileResult>();
  const coarse = { ...request, frequencyLod: 4 };
  cache.set(tileKey('source', coarse), { request: coarse } as TileResult, 100);
  expect(coveringTileKeys(cache, 'source', { ...request, frequencyStart: 100, frequencyCount: 200 })).toBeUndefined();
});
it('reuses complete finer time coverage, including the real tail, but never crosses a time gap', () => {
  const cache = new TileCache<TileResult>();
  const add = (startFrame: number) => { const r = { ...request, startFrame }; const key = tileKey('source', r); cache.set(key, { request: r } as TileResult, 100); return key; };
  const a = add(0), b = add(256);
  expect(coveringTileKeys(cache, 'source', { ...request, timeLod: 1 })).toEqual([a, b]);
  expect(coveringTileKeys(cache, 'source', { ...request, startFrame: 255, frameCount: 1 })).toEqual([a]);
  expect(coveringTileKeys(cache, 'source', { ...request, timeLod: 2 })).toBeUndefined();
});
it('does not combine incompatible time grids across frequency partitions', () => {
  const cache = new TileCache<TileResult>();
  for (const r of [{ ...request, frequencyCount: 500 }, { ...request, startFrame: 256, frequencyCount: 500 }, { ...request, timeLod: 1, frequencyStart: 500, frequencyCount: 525 }]) cache.set(tileKey('source', r), { request: r } as TileResult, 100);
  expect(coveringTileKeys(cache, 'source', { ...request, timeLod: 1 })).toBeUndefined();
});
