import { Channel, invoke } from '@tauri-apps/api/core';
import { normalizeError } from './client';
import { parseChange, parseProjectSnapshot, type AnalysisSettings, type ProjectSnapshot } from './types';
import { parseMonitorGainRequest, parsePlaybackStatus, validMonitorGain, type MonitorGainRequest, type PlaybackRequest } from './playback';
import type { MediaStatus } from './media';
import type { TileProgress, TileTransport } from '../features/spectrogram/tileClient';
export interface InspectionBinding { runtimeNonce: string; projectId: string }
export interface InspectionPreview { previewId: string; snapshot: ProjectSnapshot }
function check(value: unknown): asserts value { if (!value) throw new Error('Invalid inspection boundary'); }
function uuid(value: unknown): asserts value is string { check(typeof value === 'string' && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value) && value !== '00000000-0000-0000-0000-000000000000'); }
function shape(value: unknown, keys: string[]) {
  check(value && typeof value === 'object' && !Array.isArray(value));
  const object = value as Record<string, unknown>;
  check(Object.keys(object).length === keys.length && keys.every(k => Object.hasOwn(object, k)));
  return object;
}
function analysis(settings: AnalysisSettings, mediaId: string) { parseChange({ type: 'updateAnalysis', mediaId, settings }); }
function previewSnapshot(value: unknown, b: InspectionBinding, previewId: string, mediaId?: string): ProjectSnapshot {
  uuid(previewId);
  const snapshot = parseProjectSnapshot(value);
  check(snapshot.document.projectId === previewId && previewId !== b.projectId && snapshot.document.media.length === 1 && (!mediaId || snapshot.document.media[0].id === mediaId) && !snapshot.canUndo && !snapshot.canRedo && !snapshot.document.annotations.length);
  return snapshot;
}
function boundStatus(value: unknown, previewId: string, mediaId?: string, generation?: number) {
  const status = parsePlaybackStatus(value);
  check(status.projectId === previewId && (!mediaId || status.mediaId === mediaId) && (generation === undefined || status.generation === generation));
  return status;
}
async function call<T>(name: string, b: InspectionBinding, extra: Record<string, unknown>, parse: (v: unknown) => T): Promise<T> {
  uuid(b.projectId); uuid(b.runtimeNonce);
  try { return parse(await invoke(name, { runtimeNonce: b.runtimeNonce, projectId: b.projectId, ...extra })); }
  catch (error) { throw normalizeError(error); }
}
export const inspectionClient = {
  open: async (b: InspectionBinding, mediaId: string, analysisSettings: AnalysisSettings, requestId: string): Promise<InspectionPreview> => {
    uuid(mediaId); uuid(requestId);
    analysis(analysisSettings, mediaId);
    return call('inspection_open', b, { mediaId, analysisSettings, requestId }, value => {
      const v = shape(value, ['previewId', 'snapshot']); uuid(v.previewId);
      const snapshot = previewSnapshot(v.snapshot, b, v.previewId, mediaId);
      return { previewId: v.previewId, snapshot };
    });
  },
  configureAnalysis: async (b: InspectionBinding, previewId: string, analysisSettings: AnalysisSettings) => {
    uuid(previewId); analysis(analysisSettings, previewId);
    return call('inspection_configure_analysis', b, { previewId, analysisSettings }, v => previewSnapshot(v, b, previewId));
  },
  configure: async (b: InspectionBinding, previewId: string, request: PlaybackRequest) => {
    uuid(previewId); uuid(request.mediaId);
    check(request.projectId === previewId && previewId !== b.projectId && validMonitorGain(request.monitorGainDb));
    return call('inspection_playback_configure', b, { previewId, request }, v => boundStatus(v, previewId, request.mediaId));
  },
  monitorGain: async (b: InspectionBinding, previewId: string, request: MonitorGainRequest) => {
    uuid(previewId); parseMonitorGainRequest(request); check(request.projectId === previewId && previewId !== b.projectId);
    return call('inspection_monitor_gain', b, { previewId, request }, v => boundStatus(v, previewId, request.mediaId, request.generation));
  },
  control: async (b: InspectionBinding, previewId: string, action: 'pause' | 'stop') => {
    uuid(previewId); check(action === 'pause' || action === 'stop');
    return call('inspection_playback_control', b, { previewId, action }, v => boundStatus(v, previewId));
  },
  playbackStatus: async (b: InspectionBinding, previewId: string) => {
    uuid(previewId);
    return call('inspection_playback_status', b, { previewId }, value => {
      const status = parsePlaybackStatus(value); check(status.projectId === null || status.projectId === previewId); return status;
    });
  },
  close: async (b: InspectionBinding, previewId: string) => { uuid(previewId); return call('inspection_close', b, { previewId }, () => {}); },
  cancelOpen: async (b: InspectionBinding, requestId: string) => { uuid(requestId); return call('inspection_cancel_open', b, { requestId }, () => {}); },
  status: async (b: InspectionBinding, previewId: string) => {
    uuid(previewId);
    return call('inspection_media_status', b, { previewId }, value => {
      check(Array.isArray(value) && value.length === 1); const v = shape(value[0], ['mediaId', 'status']);
      uuid(v.mediaId); check(['ready', 'changed', 'missing'].includes(v.status as string)); return value as MediaStatus[];
    });
  },
  // configureAnalysis retires native view leases; recreate the tile client after it resolves.
  tiles: (b: InspectionBinding, previewId: string): TileTransport => {
    uuid(previewId); check(previewId !== b.projectId);
    const view = (viewId: string) => check(typeof viewId === 'string' && viewId.length > 0 && viewId.length <= 128);
    const generation = (g: number) => check(Number.isSafeInteger(g) && g >= 0);
    return {
      register: async projectId => { check(projectId === previewId); return call('inspection_register_view', b, { previewId }, v => { view(v as string); return v as string; }); },
      retire: async (projectId, viewId) => { check(projectId === previewId); view(viewId); return call('inspection_retire_view', b, { previewId, viewId }, () => {}); },
      cancel: async (projectId, viewId, g) => { check(projectId === previewId); view(viewId); generation(g); return call('inspection_cancel_generation', b, { previewId, viewId, generation: g }, () => {}); },
      request: async (request, onProgress) => {
        check(request.projectId === previewId); uuid(request.mediaId); view(request.viewId); generation(request.generation);
        const onEvent = new Channel<TileProgress>();
        onEvent.onmessage = event => { if (event.requestId === request.requestId && event.viewId === request.viewId && event.generation === request.generation && Number.isSafeInteger(event.completed) && event.completed >= 0 && Number.isSafeInteger(event.total) && event.total >= 0) onProgress?.(event); };
        return call('inspection_request_tile', b, { previewId, request, onEvent }, value => { check(value instanceof ArrayBuffer); return value; });
      },
    };
  },
};
export type InspectionAPI = typeof inspectionClient;
