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
  private bindings = new WeakMap<Selection, Selection>();
  intentVersion = 0;
  follow(target: Selection): Selection { let next = this.bindings.get(target); while (next) { target = next; next = this.bindings.get(target); } return target; }
  matches(target: Selection) { return this.getActiveSelection() === this.follow(target); }
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
  select(value: Selection | null, binding = false) { if (!binding) this.intentVersion++; this.value = value; this.active = !!value; if (value) this.interact({ mediaId: value.region.mediaId, channelIndex: value.region.channelIndex }); this.listeners.forEach(l => l()); }
  deactivate() { if (this.active) this.intentVersion++; this.active = false; this.listeners.forEach(l => l()); }
  clear(target?: Selection) { if (target && !this.matches(target)) return; this.select(null); }
  clearCandidate(target: Selection) { if (this.value !== this.follow(target)) return false; this.select(null); return true; }
  beginGesture() { this.prior = this.value; this.priorActive = this.active; this.dragging = true; this.listeners.forEach(l => l()); }
  endGesture() { this.dragging = false; this.prior = null; this.listeners.forEach(l => l()); }
  cancel() {
    if (!this.dragging) { this.deactivate(); return; }
    this.value = this.prior; this.active = this.priorActive && !!this.value;
    this.endGesture();
    if (this.value) this.interact({ mediaId: this.value.region.mediaId, channelIndex: this.value.region.channelIndex });
    this.listeners.forEach(l => l());
  }
  bind(target: Selection, object: ObjectRef) { const latest = this.follow(target); if (this.getActiveSelection() !== latest) return false; const next = { region: latest.region, object }; this.bindings.set(latest, next); this.select(next, true); return true; }
  reconcile(doc: ProjectDocument) {
    // Native work and history may settle mid-gesture. Cancellation must not
    // restore an obsolete saved region or resurrect a removed prior object.
    this.prior = resolveSelection(doc, this.prior);
    if (this.context && !doc.media.some(m => m.id === this.context!.mediaId && (this.context!.channelIndex === null || this.context!.channelIndex >= 0 && this.context!.channelIndex < m.channelCount))) this.interact(null);
    const next = resolveSelection(doc, this.value);
    if (next === this.value) return;
    if (!next) this.endGesture();
    if (this.value && next) this.bindings.set(this.value, next);
    this.value = next; this.active = this.active && !!next;
    if (this.active && next) this.interact({ mediaId: next.region.mediaId, channelIndex: next.region.channelIndex });
    this.listeners.forEach(l => l());
  }
}
