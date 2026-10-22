import { useEffect, useRef, useState } from 'react';
import type { AnalysisSettings, MediaDescriptor, MediaView } from '../../bridge/types';
import type { ActiveProject } from '../project/useProjectLifecycle';
import { mediaClient, type MediaStatus } from '../../bridge/media';
import { normalizeError } from '../../bridge/client';
import { analysisConfigHash, TileClient } from './tileClient';
import { analysisKey, CHANNEL_TILE_BUDGET, frequencyWindow, tileInputBytes, tileKey, tilePlan } from './workspace';
import { tileCache, tileScheduler } from './tileScheduler';
import { coveringTileKeys } from './tileCoverage';

export interface TileState { keys: string[]; completed: number; total: number; phase: string; error: string | null; cancelled: boolean; version: number }
const empty = (): TileState => ({ keys: [], completed: 0, total: 0, phase: '准备分析', error: null, cancelled: false, version: 0 });
const runtimeIds = new WeakMap<ActiveProject, string>();
function runtimeId(active: ActiveProject) { if (!runtimeIds.has(active)) runtimeIds.set(active, crypto.randomUUID()); return runtimeIds.get(active)!; }
export function useTiles(active: ActiveProject, media: MediaDescriptor, settings: AnalysisSettings, view: MediaView, channel: number, width: number, status: MediaStatus['status']) {
  const [state, setState] = useState<TileState>(empty);
  const [retry, setRetry] = useState(0);
  const stop = useRef(() => {});
  const displayed = useRef('');
  const source = `${runtimeId(active)}|${media.id}|${media.sha256}|${media.sourceRef}|${media.sampleRate}|${media.frameCount}`;
  const dataKey = `${source}|${analysisKey(settings)}|${view.spectrumKind}|${channel}`;
  // Do not key on document revision, notes, axis transform or palette.
  const key = `${source}|${analysisKey(settings)}|${view.spectrumKind}|${view.startSeconds}|${view.endSeconds}|${view.lowHz}|${view.highHz}|${Math.round(width / 64)}|${channel}|${status}|${retry}|${active.store.editingDisabled}`;
  const owner = useRef<{ active: ActiveProject; client: TileClient; cacheOwner: string } | null>(null);
  useEffect(() => {
    const cacheOwner = crypto.randomUUID();
    const client = new TileClient(active.store.snapshot.document.projectId);
    owner.current = { active, client, cacheOwner };
    return () => { client.dispose(); tileCache.setPins(cacheOwner, []); owner.current = null; };
  }, [active]);
  useEffect(() => {
    const client = owner.current?.client;
    if (!client || !width || active.store.editingDisabled) return;
    const cacheOwner = owner.current!.cacheOwner;
    const invalidateSource = () => tileCache.deleteMatching(key => key.startsWith(`${source}|`));
    client.nextGeneration();
    let alive = true;
    const sameData = displayed.current === dataKey;
    displayed.current = dataKey;
    // Reproject already displayed data immediately while the next viewport is
    // verified. A file/config/runtime switch always starts with a clean surface.
    setState(previous => sameData ? { ...previous, completed: 0, total: 0, error: null, cancelled: false, phase: '更新频谱' } : empty());
    stop.current = () => { alive = false; client.nextGeneration(); setState(s => ({ ...s, cancelled: true, phase: '分析已取消' })); };
    if (status === 'missing' || status === 'changed') {
      tileCache.setPins(cacheOwner, []); invalidateSource();
      setState({ ...empty(), error: status === 'missing' ? '音频缺失，请重新关联' : '源文件已改变，请重新校验关联' });
      return () => { alive = false; client.nextGeneration(); };
    }
    const valid = () => alive && !active.store.editingDisabled;
    const timer = setTimeout(() => {
      void (async () => {
        // Validate source even on a frontend cache hit. Unverified sources must go
        // through native lazy rehydration before any retained numeric data is used.
        const statuses = await mediaClient.status(active.store.snapshot.document.projectId);
        if (!valid()) return;
        const current = statuses.find(s => s.mediaId === media.id)?.status;
        if (current === 'missing' || current === 'changed') { tileCache.setPins(cacheOwner, []); invalidateSource(); throw { code: current === 'missing' ? 'MissingMedia' : 'IdentityMismatch', retryable: true, message: current === 'missing' ? '音频缺失，请重新关联' : '源文件已改变，请重新校验关联' }; }
        const hash = await analysisConfigHash(settings);
        if (!valid()) return;
        const requests = tilePlan(media, settings, view, width, channel, hash);
        const { lowBin, endBin } = frequencyWindow(media, settings, view);
        const resolved = requests.map(request => {
          const frequencyStart = Math.max(lowBin, request.frequencyStart);
          const frequencyCount = Math.min(endBin, request.frequencyStart + request.frequencyCount) - frequencyStart;
          // Only the visible part needs coverage; do not recompute FFT merely
          // to fill unseen edges of a newly selected coarser partition.
          return { request, cached: current === 'ready' ? coveringTileKeys(tileCache, source, { ...request, frequencyStart, frequencyCount }) : undefined };
        });
        const visible = resolved.filter(r => r.request.visible);
        // Covering finer tiles can have a larger footprint than the requested
        // LOD. Reuse them only if their complete retained buffers fit this view.
        const dependencyBytes = new Map<string, number>();
        for (const r of visible) {
          if (r.cached) for (const key of r.cached) dependencyBytes.set(key, tileCache.byteSize(key));
          else dependencyBytes.set(tileKey(source, r.request), tileInputBytes(r.request));
        }
        if ([...dependencyBytes.values()].reduce((a, b) => a + b, 0) > CHANNEL_TILE_BUDGET) {
          for (const r of visible) { const exact = tileKey(source, r.request); r.cached = current === 'ready' && tileCache.get(exact) ? [exact] : undefined; }
        }
        const visibleKeys = [...new Set(visible.flatMap(r => r.cached ?? [tileKey(source, r.request)]))];
        // Replace the previous dependency set atomically; current channels own
        // their keys until the next viewport or unmount, including display edits.
        tileCache.setPins(cacheOwner, visibleKeys);
        setState(s => ({ ...s, keys: visibleKeys, total: visible.length, phase: visible.length ? '分析频谱' : '此范围无音频' }));
        for (const { request, cached } of resolved) {
          const cacheKey = tileKey(source, request);
          if (cached) {
            if (request.visible) setState(s => ({ ...s, completed: s.completed + 1, version: s.version + 1 }));
            continue;
          }
          tileScheduler.submit(request.visible, valid, async () => {
            if (!valid()) return;
            try {
              const tile = await client.request(request, progress => {
                if (valid() && request.visible) setState(s => ({ ...s, phase: progress.phase === 'analysis' ? `分析频谱 ${progress.total ? Math.round(progress.completed / progress.total * 100) : 0}%` : progress.phase === 'ready' ? '绘制频谱' : '校验与加载音频' }));
              });
              if (!valid()) return;
              const bytes = tile.values.byteLength + 16384;
              // Prefetch must never evict current visible tiles under pressure.
              if (request.visible || tileCache.bytes + bytes <= tileCache.limit * .75) {
                const retained = tileCache.set(cacheKey, tile, bytes);
                if (request.visible && !retained) throw { code: 'ResourceLimit', message: '频谱缓存不足，请缩小时间范围后重试', retryable: true };
              }
              if (request.visible) setState(s => ({ ...s, completed: s.completed + 1, version: s.version + 1 }));
            } catch (cause) {
              if (!valid()) return;
              const error = normalizeError(cause);
              if (error.code === 'IdentityMismatch' || error.code === 'MissingMedia') { tileCache.setPins(cacheOwner, []); invalidateSource(); alive = false; client.nextGeneration(); }
              setState(s => ({ ...s, keys: error.code === 'IdentityMismatch' || error.code === 'MissingMedia' ? [] : s.keys, error: error.message, version: s.version + 1 }));
            }
          });
        }
      })().catch(cause => { if (valid()) setState({ ...empty(), error: normalizeError(cause).message }); });
    }, 45);
    return () => { clearTimeout(timer); alive = false; client.nextGeneration(); };
    // Primitive logical keys intentionally exclude unrelated model revisions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, key]);
  return { ...state, cancel: () => stop.current(), retry: () => setRetry(r => r + 1), recoverMissing: () => {
    setState({ ...empty(), phase: '正在重新加载频谱缓存' }); setRetry(r => r + 1);
  } };
}
