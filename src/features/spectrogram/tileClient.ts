import { Channel, invoke } from '@tauri-apps/api/core';
import type { AnalysisSettings, AppError } from '../../bridge/types';
import { normalizeError } from '../../bridge/client';

export const MAX_TILE_BYTES = 4 * 1024 * 1024;
const METADATA_RESERVE = 16 * 1024;
export interface TileRequest {
  requestId: string; viewId: string; projectId: string; mediaId: string; generation: number;
  configHash: string; settings: AnalysisSettings; channelIndex: number; kind: 'stft' | 'mel';
  startFrame: number; frameCount: number; timeLod: number;
  frequencyStart: number; frequencyCount: number; frequencyLod: number; visible: boolean;
}
export interface TileMetadata {
  rows: number; columns: number; sourceFrames: number; sampleRate: number; totalSamples: number;
  startSeconds: number; endSeconds: number; frameStepSamples: number; melPointsHz: number[];
}
export interface TileResult { request: TileRequest; metadata: TileMetadata; values: Float32Array }
export interface TileProgress { requestId: string; viewId: string; generation: number; phase: string; completed: number; total: number }
export interface TileTransport {
  register: (projectId: string) => Promise<string>;
  retire: (projectId: string, viewId: string) => Promise<void>;
  request: (request: TileRequest, onProgress?: (progress: TileProgress) => void) => Promise<ArrayBuffer>;
  cancel: (projectId: string, viewId: string, generation: number) => Promise<void>;
}
export const nativeTileTransport: TileTransport = {
  async register(projectId) {
    try {
      const view = await invoke<string>('register_analysis_view', { projectId });
      if (typeof view !== 'string' || !view.length || view.length > 128) throw new Error('Invalid analysis view lease');
      return view;
    } catch (error) { throw normalizeError(error); }
  },
  async retire(projectId, viewId) { await invoke('retire_analysis_view', { projectId, viewId }); },
  async request(request, onProgress) {
    const onEvent = new Channel<TileProgress>();
    onEvent.onmessage = event => {
      if (event.requestId === request.requestId && event.viewId === request.viewId && event.generation === request.generation
        && Number.isSafeInteger(event.completed) && event.completed >= 0 && Number.isSafeInteger(event.total) && event.total >= 0) onProgress?.(event);
    };
    try { return await invoke<ArrayBuffer>('request_tile', { request, onEvent }); }
    catch (error) { throw normalizeError(error); }
  },
  async cancel(projectId, viewId, generation) { await invoke('cancel_generation', { projectId, viewId, generation }); },
};
export async function analysisConfigHash(settings: AnalysisSettings, subtle: SubtleCrypto = crypto.subtle): Promise<string> {
  const text = `analysis-v1|${settings.window}|${settings.windowSize}|${settings.hopSize}|${settings.fftSize}|${settings.melBands}`;
  return Array.from(new Uint8Array(await subtle.digest('SHA-256', new TextEncoder().encode(text))), byte => byte.toString(16).padStart(2, '0')).join('');
}
const invalid = () => new Error('Invalid or mismatched binary tile response');
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
};
const uint = (value: unknown, min = 0): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) throw invalid();
  return value;
};
const finite = (value: unknown): number => { if (typeof value !== 'number' || !Number.isFinite(value)) throw invalid(); return value; };
/** One binary envelope associates compact JSON geometry and raw f32 bytes atomically.
 * Offsets are aligned to four bytes; all numeric payloads are explicitly little-endian. */
export function decodeTile(buffer: ArrayBuffer, expected: TileRequest): TileResult {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 8 || buffer.byteLength > MAX_TILE_BYTES) throw invalid();
  const view = new DataView(buffer);
  if (view.getUint32(0, false) !== 0x41543031) throw invalid();
  const length = view.getUint32(4, true); const offset = Math.ceil((8 + length) / 4) * 4;
  if (length > METADATA_RESERVE - 12 || offset > buffer.byteLength) throw invalid();
  const header = record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(buffer, 8, length))));
  if (header.protocol !== 1 || header.encoding !== 'f32le-db-row-major') throw invalid();
  const received = record(header.request);
  for (const [key, value] of Object.entries(expected)) {
    if (key === 'settings') { const settings = record(received.settings); for (const [k, v] of Object.entries(value)) if (settings[k] !== v) throw invalid(); }
    else if (received[key] !== value) throw invalid();
  }
  const m = record(header.tile);
  const rows = uint(m.rows, 1), columns = uint(m.columns, 1), sourceFrames = uint(m.sourceFrames, 1);
  const sampleRate = uint(m.sampleRate, 1), totalSamples = uint(m.totalSamples, 1), step = uint(m.frameStepSamples, 1);
  const start = finite(m.startSeconds), end = finite(m.endSeconds);
  const stride = 2 ** expected.timeLod;
  const totalFrames = Math.ceil(totalSamples / expected.settings.hopSize);
  const expectedFrames = Math.min(totalFrames - expected.startFrame, expected.frameCount * stride);
  const valueCount = uint(header.valueCount, 1);
  if (sourceFrames !== expectedFrames || rows !== Math.ceil(expectedFrames / stride) || rows > 256
    || columns !== Math.ceil(expected.frequencyCount / 2 ** expected.frequencyLod) || rows * columns !== valueCount
    || buffer.byteLength !== offset + valueCount * 4 || step !== expected.settings.hopSize * stride
    || Math.abs(start - expected.startFrame * expected.settings.hopSize / sampleRate) > 1e-10
    || Math.abs(end - Math.min((expected.startFrame + sourceFrames) * expected.settings.hopSize, totalSamples) / sampleRate) > 1e-10
    || start < 0 || end <= start || end > totalSamples / sampleRate) throw invalid();
  if (!Array.isArray(m.melPointsHz) || m.melPointsHz.length !== (expected.kind === 'mel' ? expected.settings.melBands + 2 : 0)) throw invalid();
  const melPointsHz = m.melPointsHz.map(finite);
  for (let i = 0; i < melPointsHz.length; i++) {
    const expectedHz = 700 * (10 ** (i / (expected.settings.melBands + 1) * Math.log10(1 + sampleRate / 1400)) - 1);
    if (Math.abs(melPointsHz[i] - expectedHz) > 1e-7) throw invalid();
  }
  // DataView avoids host-endian assumptions. This is at most one bounded tile allocation.
  const values = new Float32Array(valueCount);
  for (let i = 0; i < valueCount; i++) { values[i] = view.getFloat32(offset + i * 4, true); if (!Number.isFinite(values[i])) throw invalid(); }
  return { request: expected, metadata: { rows, columns, sourceFrames, sampleRate, totalSamples, startSeconds: start, endSeconds: end, frameStepSamples: step, melPointsHz }, values };
}
/** Splits on frequency group boundaries, preserving all bins including the last partial group. */
export function splitFrequencyRequests<T extends Pick<TileRequest, 'frameCount' | 'frequencyLod' | 'frequencyCount' | 'frequencyStart'>>(request: T): T[] {
  const rows = uint(request.frameCount, 1), lod = uint(request.frequencyLod), count = uint(request.frequencyCount, 1);
  uint(request.frequencyStart);
  if (rows > 256 || lod > 16 || count > 32769) throw invalid();
  const maxBins = Math.floor((MAX_TILE_BYTES - METADATA_RESERVE) / (rows * 4)) * 2 ** lod;
  const result: T[] = [];
  for (let offset = 0; offset < count; offset += maxBins) result.push({ ...request, frequencyStart: request.frequencyStart + offset, frequencyCount: Math.min(maxBins, count - offset) });
  return result;
}
function cancelled(): AppError { return { code: 'Cancelled', message: '分析视图已更新或关闭', retryable: false }; }
/** One instance per pane/view; never share its generation between unrelated consumers.
 * Dispose on close/Save As, even if projectId is unchanged. Task 6 owns image/tile retention. */
export class TileClient {
  private generation = 1;
  private disposed = false;
  private lease: Promise<string> | undefined;
  constructor(private projectId: string, private transport: TileTransport = nativeTileTransport) {}
  private register(): Promise<string> {
    if (!this.lease) {
      const pending = this.transport.register(this.projectId);
      this.lease = pending;
      void pending.catch(() => { if (this.lease === pending) this.lease = undefined; });
    }
    return this.lease;
  }
  nextGeneration(): number {
    if (this.disposed) return this.generation;
    const previous = this.generation++;
    // Local invalidation is synchronous; a transport failure cannot revive stale results.
    void this.lease?.then(view => this.transport.cancel(this.projectId, view, previous)).catch(() => {});
    return this.generation;
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.generation++;
    // Registration may still be in flight. Always retire its eventual lease,
    // while local invalidation prevents any request/progress/result publication.
    void this.lease?.then(view => this.transport.retire(this.projectId, view)).catch(() => {});
  }
  async request(input: Omit<TileRequest, 'requestId' | 'projectId' | 'viewId' | 'generation'>, onProgress?: (event: TileProgress) => void): Promise<TileResult> {
    if (this.disposed) throw cancelled();
    const generation = this.generation;
    try {
      const viewId = await this.register();
      if (this.disposed || generation !== this.generation) throw cancelled();
      const request = { ...input, requestId: crypto.randomUUID(), projectId: this.projectId, viewId, generation };
      const bytes = await this.transport.request(request, event => { if (!this.disposed && generation === this.generation) onProgress?.(event); });
      if (this.disposed || generation !== this.generation) throw cancelled();
      return decodeTile(bytes, request);
    } catch (error) { if (this.disposed || generation !== this.generation) throw cancelled(); throw error; }
  }
}
