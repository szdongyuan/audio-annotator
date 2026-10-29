import { inspectionClient, type InspectionAPI, type InspectionBinding, type InspectionPreview } from '../../bridge/inspection';
import { normalizeError } from '../../bridge/client';
import { emptyPlayback, type PlaybackRequest, type PlaybackStatus } from '../../bridge/playback';
import type { AnalysisSettings } from '../../bridge/types';
import type { PreviewPlaybackSettings } from '../examples/preview';
import { PlaybackStatusStore, samePlaybackControl } from '../playback/statusStore';

/** One native transient owner; never uses the ordinary project playback transport. */
export class InspectionSession {
 result: InspectionPreview | null = null;
 loading = false;
 analyzing = false;
 error: string | null = null;
 wantsPlayback = false;
 readonly statusStore = new PlaybackStatusStore();
 private alive = true;
 private version = 0;
 private epoch = 0;
 private pending: { id: string; submitted: boolean } | null = null;
 private stream = false;
 private configuring: PlaybackStatus | null | undefined;
 private tail: Promise<unknown> = Promise.resolve();
 private listeners = new Set<() => void>();
 constructor(readonly binding: InspectionBinding, private api: InspectionAPI = inspectionClient) {}
 subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
 getVersion = () => this.version;
 get status() { return this.statusStore.getSnapshot(); }
 start() { this.alive = true; }
 private notify() { if (this.alive) { this.version++; this.listeners.forEach(fn => fn()); } }
 private cleanup(promise: Promise<unknown>) { void promise.catch(() => {}); }
 private release() {
  this.epoch++; this.wantsPlayback = false; this.stream = false; this.configuring = undefined;
  if (this.pending?.submitted) this.cleanup(this.api.cancelOpen(this.binding, this.pending.id));
  this.pending = null;
  if (this.result) this.cleanup(this.api.close(this.binding, this.result.previewId));
  this.result = null; this.loading = false; this.analyzing = false;
 }
 unavailable(message = '此内容已不存在或音频不可用。') { this.release(); this.error = message; this.statusStore.publish(emptyPlayback); this.notify(); }
 async open(mediaId: string, settings: AnalysisSettings, stopMain: () => unknown | Promise<unknown>) {
  if (!this.alive) return null;
  this.release(); const pending = { id: crypto.randomUUID(), submitted: false }; this.pending = pending;
  this.loading = true; this.error = null; this.statusStore.publish(emptyPlayback); this.notify();
  try {
   await stopMain();
   if (!this.alive || this.pending !== pending) return null;
   pending.submitted = true;
   const result = await this.api.open(this.binding, mediaId, settings, pending.id);
   if (!this.alive || this.pending !== pending) { this.cleanup(this.api.close(this.binding, result.previewId)); return null; }
   this.pending = null; this.result = result; this.loading = false; this.notify(); return result;
  } catch (e) {
   if (this.alive && this.pending === pending) this.unavailable(normalizeError(e).message);
   return null;
  }
 }
 private enqueue(action: (result: InspectionPreview) => Promise<void>) {
  const result = this.result, epoch = this.epoch;
  this.tail = this.tail.catch(() => {}).then(async () => {
   if (!this.alive || !result || epoch !== this.epoch || !this.result) return;
   try { await action(this.result); }
   catch (e) { if (this.alive && epoch === this.epoch) this.unavailable(normalizeError(e).message); }
  });
  return this.tail;
 }
 private accept(status: PlaybackStatus) {
  const changed = !samePlaybackControl(this.status, status);
  this.statusStore.publish(status);
  if (status.state === 'error') { this.unavailable(status.error?.message ?? '预览输出失败'); return; }
  if (status.state === 'ended') this.wantsPlayback = false;
  if (changed) this.notify();
 }
 progress(status: PlaybackStatus) {
  const result = this.result;
  if (!this.alive || !result || status.projectId !== result.previewId || status.mediaId !== result.snapshot.document.media[0].id || status.generation < this.status.generation) return;
  if (this.configuring !== undefined) { if (!this.configuring || status.generation >= this.configuring.generation) this.configuring = status; return; }
  this.accept(status);
 }
 play(settings: PreviewPlaybackSettings, mode: PlaybackRequest['mode'], seekSeconds: number | null = null, play = true) {
  if (!this.result) return Promise.resolve();
  this.wantsPlayback = play; this.notify();
  return this.enqueue(async result => {
   const epoch = this.epoch; this.configuring = null;
   const status = await this.api.configure(this.binding, result.previewId, { projectId: result.previewId, mediaId: result.snapshot.document.media[0].id, mode, bypass: false, ...settings, seekSeconds, play });
   if (!this.alive || epoch !== this.epoch) return;
   this.stream = true;
   const event = this.configureEvent(); this.configuring = undefined;
   this.accept(event && event.generation >= status.generation ? event : status);
  });
 }
 private configureEvent(): PlaybackStatus | null | undefined { return this.configuring; }
 control(action: 'pause' | 'stop') {
  this.wantsPlayback = false; this.notify();
  return this.enqueue(async result => {
   if (!this.stream) return;
   const epoch = this.epoch, status = await this.api.control(this.binding, result.previewId, action);
   if (this.alive && epoch === this.epoch) this.accept(status);
  });
 }
 stop() { return this.control('stop'); }
 gain(monitorGainDb: number) {
  return this.enqueue(async result => {
   if (!this.stream) return;
   const epoch = this.epoch;
   const status = await this.api.monitorGain(this.binding, result.previewId, { projectId: result.previewId, mediaId: result.snapshot.document.media[0].id, generation: this.status.generation, monitorGainDb });
   if (this.alive && epoch === this.epoch && status.generation >= this.status.generation) this.accept(status);
  });
 }
 analysis(settings: AnalysisSettings) {
  if (!this.result || this.analyzing) return Promise.resolve();
  this.analyzing = true; this.wantsPlayback = false; this.notify();
  return this.enqueue(async result => {
   const epoch = this.epoch;
   if (this.stream) await this.api.control(this.binding, result.previewId, 'stop');
   if (!this.alive || epoch !== this.epoch) return;
   this.stream = false;
   const snapshot = await this.api.configureAnalysis(this.binding, result.previewId, settings);
   if (!this.alive || epoch !== this.epoch) return;
   // Native retires ALL view leases here: a new adapter identity creates new TileClients.
   this.result = { previewId: result.previewId, snapshot }; this.analyzing = false;
   this.statusStore.publish(emptyPlayback); this.notify();
  });
 }
 async checkSource() {
  const result = this.result, epoch = this.epoch;
  if (!this.alive || !result || this.analyzing || this.configuring !== undefined) return;
  try {
   const statuses = await this.api.status(this.binding, result.previewId);
   if (!this.alive || epoch !== this.epoch) return;
   if (statuses.length !== 1 || statuses[0].mediaId !== result.snapshot.document.media[0].id || statuses[0].status !== 'ready') this.unavailable();
  } catch (e) { if (this.alive && epoch === this.epoch) this.unavailable(normalizeError(e).message); }
 }
 // React owns subscription cleanup; effect replay/source replacement can restart this owner.
 dispose() { this.alive = false; this.release(); }
}
