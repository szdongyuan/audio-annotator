import { exampleClient, type ExampleBinding, type ExampleEntry, type PreviewAPI, type PreviewResult } from '../../bridge/examples';
import { normalizeError } from '../../bridge/client';
import { emptyPlayback, type PlaybackStatus } from '../../bridge/playback';
import type { AnalysisSettings } from '../../bridge/types';
export interface PreviewPlaybackSettings {
    monitorGainDb: number;
    volume: number;
    deviceId: string | null;
    looping: boolean;
}
/** Owns exactly one pending opening and one completed transient preview. */
export class ExamplePreviewSession {
    result: PreviewResult | null = null;
    loading = false;
    error: string | null = null;
    status: PlaybackStatus = emptyPlayback;
    // Native buffering also occurs for paused seeks; it does not imply Play.
    private desiredPlay = false;
    get wantsPlayback() { return this.desiredPlay; }
    private pending: string | null = null;
    private alive = true;
    private version = 0;
    private sequence = 0;
    private listeners = new Set<() => void>();
    private tail: Promise<unknown> = Promise.resolve();
    private configuring: {
        sequence: number;
        event: PlaybackStatus | null;
    } | null = null;
    private submitted = false;
    constructor(readonly binding: ExampleBinding, private api: PreviewAPI = exampleClient) { }
    start() { this.alive = true; }
    subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
    getVersion = () => this.version;
    private notify() {
        if (!this.alive) return;
        this.version++;
        this.listeners.forEach(fn => fn());
    }
    reportError(message: string) {
        if (!this.alive) return;
        this.error = message;
        this.notify();
    }
    private cleanup(promise: Promise<unknown>) {
        void promise.catch(e => this.reportError(normalizeError(e).message));
    }
    private release() {
        this.desiredPlay = false;
        this.configuring = null;
        if (this.pending) {
            // An intent cancelled before IPC submission owns no native opening.
            if (this.submitted) this.cleanup(this.api.cancelOpen(this.binding, this.pending));
            this.pending = null;
            this.submitted = false;
        }
        if (this.result) {
            this.cleanup(this.api.close(this.binding, this.result.previewId));
            this.result = null;
        }
    }
    async open(entry: ExampleEntry, settings: AnalysisSettings, stopMain: () => void | Promise<unknown>) {
        if (!this.alive)
            return null;
        this.release();
        const requestId = crypto.randomUUID();
        this.pending = requestId;
        this.loading = true;
        this.error = null;
        this.status = emptyPlayback;
        this.sequence++;
        this.notify();
        try {
            // Wait through any pending main configure and its acknowledged stop.
            await stopMain();
            if (!this.alive || this.pending !== requestId) return null;
            this.submitted = true;
            const result = await this.api.open(this.binding, entry, settings, requestId);
            if (!this.alive || this.pending !== requestId) {
                this.cleanup(this.api.close(this.binding, result.previewId));
                return null;
            }
            this.pending = null;
            this.submitted = false;
            this.result = result;
            return result;
        }
        catch (e) {
            if (this.alive && this.pending === requestId) {
                this.pending = null;
                this.submitted = false;
                this.error = normalizeError(e).message;
            }
        }
        finally {
            if (this.alive && (this.pending === requestId || !this.pending)) {
                this.loading = false;
                this.notify();
            }
        }
        return null;
    }
    progress(status: PlaybackStatus) {
        if (!this.alive || !this.result) return;
        const doc = this.result.snapshot.document;
        if (status.projectId !== doc.projectId || status.mediaId !== doc.media[0].id || status.generation < this.status.generation) return;
        if (this.configuring) {
            if (!this.configuring.event || status.generation >= this.configuring.event.generation) this.configuring.event = status;
            return;
        }
        this.acceptStatus(status);
        this.notify();
    }
    private acceptStatus(status: PlaybackStatus) {
        this.status = status;
        if (status.state === 'ended' || status.state === 'error') this.desiredPlay = false;
        if (status.error) this.error = status.error.message;
    }
    seek(settings: PreviewPlaybackSettings, seconds: number) { return this.play(settings, seconds, this.desiredPlay); }
    async play(settings: PreviewPlaybackSettings, seekSeconds: number | null = null, play = true) {
        const result = this.result;
        if (!this.alive || !result)
            return;
        this.desiredPlay = play;
        const sequence = ++this.sequence;
        this.configuring = { sequence, event: null };
        this.error = null;
        this.notify();
        this.tail = this.tail.catch(() => {}).then(async () => {
            if (!this.alive || this.result !== result || this.sequence !== sequence) return;
            const doc = result.snapshot.document;
            const status = await this.api.configure(this.binding, result.previewId, {
                projectId: doc.projectId, mediaId: doc.media[0].id,
                mode: { mode: 'original' }, bypass: false, ...settings, seekSeconds, play,
            });
            if (this.alive && this.result === result && this.sequence === sequence && status.generation >= this.status.generation) {
                // Decode/output can publish playing/end before configure returns buffering.
                const event = this.configuring?.event;
                this.configuring = null;
                this.acceptStatus(event && event.generation >= status.generation ? event : status);
                this.notify();
            }
        }).catch(e => {
            if (this.alive && this.result === result && this.sequence === sequence) {
                this.configuring = null;
                this.desiredPlay = false;
                this.error = normalizeError(e).message;
                this.notify();
            }
        });
        await this.tail;
    }
    private async control(action: 'pause' | 'stop') {
        const result = this.result;
        if (!this.alive || !result) return;
        this.desiredPlay = false;
        const sequence = ++this.sequence;
        this.configuring = { sequence, event: null };
        this.notify();
        this.tail = this.tail.catch(() => {}).then(async () => {
            if (!this.alive || this.result !== result || this.sequence !== sequence) return;
            const status = await this.api.control(this.binding, result.previewId, action);
            if (this.alive && this.result === result && this.sequence === sequence) {
                this.configuring = null;
                this.status = status;
                this.notify();
            }
        }).catch(e => {
            if (this.alive && this.result === result && this.sequence === sequence) {
                this.configuring = null;
                this.error = normalizeError(e).message;
                this.notify();
            }
        });
        await this.tail;
    }
    pause() { return this.control('pause'); }
    stop() { return this.control('stop'); }
    dispose() { this.alive = false; this.sequence++; this.release(); this.listeners.clear(); }
}
