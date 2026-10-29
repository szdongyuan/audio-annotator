import type { OpenedProject } from '../../bridge/projects';
import type { ProjectDocument } from '../../bridge/types';
import type { ActiveProject } from './useProjectLifecycle';

export const sessionKey = 'audio-annotator.project-session.v1';
export const inspectorTabs = ['region', 'list', 'notes', 'authors', 'categories', 'masks', 'mix', 'examples'] as const;
export interface SessionUI { inspectorTab: string; mediaOpen: boolean; propertiesOpen: boolean; cues: Record<string, number> }
export interface ProjectSession { version: 1; path: string; projectId: string; actorId: string | null; readOnly: boolean; ui: SessionUI }
export const defaultSessionUI = (): SessionUI => ({ inspectorTab: 'region', mediaOpen: true, propertiesOpen: true, cues: {} });
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(v);
const validPath = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v.length <= 4096 && !/[\u0000-\u001f]/.test(v);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function sanitizeUI(value: unknown): SessionUI {
  const v = object(value) ? value : {}, cues: Record<string, number> = {};
  if (object(v.cues)) for (const [id, seconds] of Object.entries(v.cues).slice(0, 128)) {
    if (uuid(id) && typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0 && seconds <= 1e9) cues[id] = seconds;
  }
  return { inspectorTab: inspectorTabs.some(tab => tab === v.inspectorTab) ? v.inspectorTab as string : 'region', mediaOpen: typeof v.mediaOpen === 'boolean' ? v.mediaOpen : true, propertiesOpen: typeof v.propertiesOpen === 'boolean' ? v.propertiesOpen : true, cues };
}
function storage(): Storage | undefined { try { return window.localStorage; } catch { return undefined; } }
export function readSession(target = storage()): ProjectSession | null {
  try {
    const raw = target?.getItem(sessionKey); if (!raw || raw.length > 65536) return null;
    const v: unknown = JSON.parse(raw);
    if (!object(v) || v.version !== 1 || !validPath(v.path) || !uuid(v.projectId) || v.actorId !== null && !uuid(v.actorId) || typeof v.readOnly !== 'boolean') return null;
    return { version: 1, path: v.path, projectId: v.projectId, actorId: v.actorId as string | null, readOnly: v.readOnly, ui: sanitizeUI(v.ui) };
  } catch { return null; }
}
export function matchingSessionUI(record: ProjectSession, opened: OpenedProject, excluded: readonly string[] = []): SessionUI | null {
  if (!opened.snapshot || opened.recovery || record.projectId !== opened.snapshot.document.projectId || record.actorId !== (opened.collaboration?.actor?.authorId ?? null)) return null;
  const ui = sanitizeUI(record.ui);
  return { ...ui, inspectorTab: ui.inspectorTab === 'authors' && !opened.collaboration ? 'region' : ui.inspectorTab, cues: validSessionCues(ui.cues, opened.snapshot.document, [...excluded, ...(opened.collaboration?.hiddenMediaIds ?? [])]) };
}
export function validSessionCues(cues: Record<string, number>, doc: ProjectDocument, excluded: readonly string[] = []): Record<string, number> {
  return Object.fromEntries(Object.entries(sanitizeUI({ cues }).cues).filter(([id, seconds]) => {
    const media = doc.media.find(m => m.id === id);
    return media && !excluded.includes(id) && seconds * media.sampleRate < media.frameCount;
  }));
}

/** Local acknowledged UI only. Native save/close barriers continue to own edits. */
export class SessionStore {
  record: ProjectSession | null;
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private deadline: ReturnType<typeof setTimeout> | undefined;
  constructor(private target = storage()) { this.record = readSession(target); }
  private cancel() { clearTimeout(this.timer); clearTimeout(this.deadline); this.timer = this.deadline = undefined; }
  flush = () => { this.cancel(); if (!this.dirty) return; try { if (this.record) this.target?.setItem(sessionKey, JSON.stringify(this.record)); this.dirty = false; } catch { /* Best effort local preference. */ } };
  adopt(opened: OpenedProject, readOnly = false) {
    if (!opened.snapshot || opened.recovery || !validPath(opened.path)) return;
    const ui = this.record && matchingSessionUI(this.record, opened) || defaultSessionUI();
    this.record = { version: 1, path: opened.path, projectId: opened.snapshot.document.projectId, actorId: opened.collaboration?.actor?.authorId ?? null, readOnly: readOnly || opened.collaboration?.identityMode === 'viewOnly', ui };
    this.dirty = true;
    this.flush();
  }
  update(owner: ActiveProject, ui: SessionUI, excluded: readonly string[]) {
    const r = this.record, doc = owner.store.snapshot.document;
    if (!r || r.path !== owner.path || r.projectId !== doc.projectId || r.actorId !== (owner.collaboration?.actor?.authorId ?? null)) return;
    const next = { ...sanitizeUI(ui), cues: validSessionCues(ui.cues, doc, excluded) };
    if (JSON.stringify(r.ui) === JSON.stringify(next)) return;
    this.record = { ...r, ui: next };
    this.dirty = true;
    clearTimeout(this.timer); this.timer = setTimeout(this.flush, 250);
    this.deadline ??= setTimeout(this.flush, 2000);
  }
  forget() { this.cancel(); this.record = null; this.dirty = false; try { this.target?.removeItem(sessionKey); } catch { /* Storage may be unavailable. */ } }
}
