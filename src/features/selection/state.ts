import type { ClassificationTarget } from '../annotations/classification';
import type { ProjectDocument, Region } from '../../bridge/types';
export type ObjectRef = { kind: 'annotation' | 'mask'; id: string };
export type Selection = { region: Region; object: ObjectRef | null };
export const sameRegion = (a: Region, b: Region) => a.mediaId === b.mediaId && a.channelIndex === b.channelIndex && a.startSeconds === b.startSeconds && a.endSeconds === b.endSeconds && a.lowHz === b.lowHz && a.highHz === b.highHz;
export function validRegion(doc: ProjectDocument, r: Region) {
  const m = doc.media.find(m => m.id === r.mediaId);
  return !!m && Number.isInteger(r.channelIndex) && r.channelIndex >= 0 && r.channelIndex < m.channelCount && [r.startSeconds, r.endSeconds, r.lowHz, r.highHz].every(Number.isFinite) && r.startSeconds >= 0 && r.startSeconds < r.endSeconds && r.endSeconds <= m.frameCount / m.sampleRate && r.lowHz >= 0 && r.lowHz < r.highHz && r.highHz <= m.sampleRate / 2;
}
/** Keep unchanged snapshots stable while saved identities follow current authority. */
export function resolveSelection(doc: ProjectDocument, selection: Selection | null): Selection | null {
  if (!selection) return null;
  const object = selection.object && (selection.object.kind === 'annotation' ? doc.annotations : doc.edits).find(a => a.id === selection.object!.id);
  if (selection.object && !object) return null;
  const region = object?.region ?? selection.region;
  if (!validRegion(doc, region)) return null;
  return sameRegion(region, selection.region) ? selection : { ...selection, region };
}
/** Ephemeral state belongs to a runtime owner, never the durable document. */
export class SelectionState {
  private value: Selection | null = null;
  private prior: Selection | null = null;
  private active = false;
  private priorActive = false;
  private dragging = false;
  private listeners = new Set<() => void>();
  context: ClassificationTarget | null = null;
  getContext = () => this.context;
  interact(context: ClassificationTarget | null) {
    if (context?.mediaId === this.context?.mediaId && context?.channelIndex === this.context?.channelIndex) return;
    this.context = context; this.listeners.forEach(l => l());
  }
  /** Rendering and invalidation may inspect the retained outline; commands use active only. */
  getCandidate = () => this.value;
  getActiveSelection = () => this.active ? this.value : null;
  getSnapshot = this.getActiveSelection;
  getGesture = () => this.dragging;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  select(value: Selection | null) { this.value = value; this.active = !!value; if (value) this.interact({ mediaId: value.region.mediaId, channelIndex: value.region.channelIndex }); this.listeners.forEach(l => l()); }
  deactivate() { this.active = false; this.listeners.forEach(l => l()); }
  beginGesture() { this.prior = this.value; this.priorActive = this.active; this.dragging = true; this.listeners.forEach(l => l()); }
  endGesture() { this.dragging = false; this.prior = null; this.listeners.forEach(l => l()); }
  cancel() {
    if (!this.dragging) { this.deactivate(); return; }
    this.value = this.prior; this.active = this.priorActive && !!this.value;
    this.endGesture();
    if (this.value) this.interact({ mediaId: this.value.region.mediaId, channelIndex: this.value.region.channelIndex });
    this.listeners.forEach(l => l());
  }
  bind(target: Selection, object: ObjectRef) { if (this.getActiveSelection() !== target) return false; this.select({ region: target.region, object }); return true; }
  reconcile(doc: ProjectDocument) {
    // Native work and history may settle mid-gesture. Cancellation must not
    // restore an obsolete saved region or resurrect a removed prior object.
    this.prior = resolveSelection(doc, this.prior);
    if (this.context && !doc.media.some(m => m.id === this.context!.mediaId && (this.context!.channelIndex === null || this.context!.channelIndex >= 0 && this.context!.channelIndex < m.channelCount))) this.interact(null);
    const next = resolveSelection(doc, this.value);
    if (next === this.value) return;
    if (!next) this.endGesture();
    this.value = next; this.active = this.active && !!next;
    if (this.active && next) this.interact({ mediaId: next.region.mediaId, channelIndex: next.region.channelIndex });
    this.listeners.forEach(l => l());
  }
}
