import { createContext, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import type { AnalysisSettings, MediaView } from '../../bridge/types';
import { analysisError } from '../spectrogram/workspace';

export type DisplayPreferences = Pick<MediaView, 'spectrumKind' | 'frequencyMix' | 'gainDb' | 'dynamicRangeDb' | 'palette'>;
export type GlobalPlayback = { monitorGainDb: number; volume: number; looping: boolean; source: 'original' | 'processed' };
type Override = { display?: Partial<DisplayPreferences>; analysis?: AnalysisSettings; monitorGainDb?: number };
export interface LocalPreferences { version: 1; display: Partial<DisplayPreferences>; analysis: AnalysisSettings | null; playback: Partial<GlobalPlayback>; overrides: Record<string, Override> }
export const localSettingsKey = 'audio-annotator.global-settings.v1';
export const emptyLocalPreferences = (): LocalPreferences => ({ version: 1, display: {}, analysis: null, playback: {}, overrides: {} });
const displayKeys = ['spectrumKind', 'frequencyMix', 'gainDb', 'dynamicRangeDb', 'palette'] as const;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const inRange = (v: unknown, lo: number, hi: number) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
function validDisplay(v: unknown): boolean {
  return record(v) && Object.entries(v).every(([k, n]) => k === 'frequencyMix' ? inRange(n, 0, 1) : k === 'gainDb' ? inRange(n, -60, 60) : k === 'dynamicRangeDb' ? inRange(n, 20, 160) : k === 'spectrumKind' ? ['stft', 'mel'].includes(n as string) : k === 'palette' && ['ember', 'ocean', 'gray'].includes(n as string));
}
function validAnalysis(v: unknown): v is AnalysisSettings {
  return record(v) && Object.keys(v).length === 5 && analysisError(v as unknown as AnalysisSettings) === null;
}
export function parseLocalPreferences(text: string): LocalPreferences {
  const v: unknown = JSON.parse(text);
  if (!record(v) || Object.keys(v).sort().join() !== 'analysis,display,overrides,playback,version' || v.version !== 1 || !validDisplay(v.display) || v.analysis !== null && !validAnalysis(v.analysis) || !record(v.playback) || !Object.entries(v.playback).every(([k,n]) => k === 'monitorGainDb' ? inRange(n,-60,24) : k === 'volume' ? inRange(n,0,1) : k === 'looping' ? typeof n === 'boolean' : k === 'source' && ['original','processed'].includes(n as string)) || !record(v.overrides) || Object.keys(v.overrides).length > 10000 || !Object.entries(v.overrides).every(([k,n]) => /^[a-zA-Z0-9-]+\/[a-zA-Z0-9-]+$/.test(k) && record(n) && Object.entries(n).every(([field,value]) => field === 'display' ? validDisplay(value) : field === 'analysis' ? validAnalysis(value) : field === 'monitorGainDb' && inRange(value,-60,24)))) throw Error('本机全局设置格式无效，请在全局设置中重新保存。');
  return v as unknown as LocalPreferences;
}
export class LocalSettingsStore {
  value = emptyLocalPreferences();
  error: string | null = null;
  private version = 0;
  private listeners = new Set<() => void>();
  constructor(private storage: Pick<Storage, 'getItem' | 'setItem'>) { this.reload(); }
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  getVersion = () => this.version;
  private notify() { this.version++; this.listeners.forEach(fn => fn()); }
  reload = () => { try { const raw = this.storage.getItem(localSettingsKey); this.value = raw ? parseLocalPreferences(raw) : emptyLocalPreferences(); this.error = null; } catch (e) { this.error = e instanceof Error ? e.message : '无法读取本机全局设置'; } this.notify(); };
  private change(action: (next: LocalPreferences) => void): boolean {
    try {
      // Re-read to retain unrelated settings saved by another app window.
      const raw = this.storage.getItem(localSettingsKey);
      let next: LocalPreferences; try { next = raw ? parseLocalPreferences(raw) : emptyLocalPreferences(); } catch { next = structuredClone(this.value); }
      action(next); const text = JSON.stringify(next); parseLocalPreferences(text); this.storage.setItem(localSettingsKey,text);
      this.value = next; this.error = null; this.notify(); return true;
    } catch (e) { this.error = `全局设置未保存：${e instanceof Error ? e.message : '本机存储不可用'}`; this.notify(); return false; }
  }
  applyGlobal(patch: { display?: Partial<DisplayPreferences>; analysis?: AnalysisSettings; playback?: Partial<GlobalPlayback> }) {
    return this.change(next => {
      if (patch.display) Object.assign(next.display,patch.display);
      if (patch.analysis) next.analysis = patch.analysis;
      if (patch.playback) Object.assign(next.playback,patch.playback);
      for (const [key,override] of Object.entries(next.overrides)) {
        for (const field of displayKeys) if (patch.display && field in patch.display && override.display) delete override.display[field];
        if (override.display && !Object.keys(override.display).length) delete override.display;
        if (patch.analysis) delete override.analysis;
        if (patch.playback && 'monitorGainDb' in patch.playback) delete override.monitorGainDb;
        if (!Object.keys(override).length) delete next.overrides[key];
      }
    });
  }
  mediaKey(projectId: string, mediaId: string) { return `${projectId}/${mediaId}`; }
  override(projectId: string, mediaId: string): Override { return this.value.overrides[this.mediaKey(projectId,mediaId)] ?? {}; }
  patchMedia(projectId: string, mediaId: string, patch: Override) {
    return this.change(next => { const key = this.mediaKey(projectId,mediaId), old = next.overrides[key] ?? {}; next.overrides[key] = { ...old, ...patch, ...(patch.display ? { display: { ...old.display, ...patch.display } } : {}) }; });
  }
  follow(projectId: string, mediaId: string, fields: (keyof Override)[]) {
    return this.change(next => { const key = this.mediaKey(projectId,mediaId), value = next.overrides[key]; if (value) { for (const field of fields) delete value[field]; if (!Object.keys(value).length) delete next.overrides[key]; } });
  }
}
const LocalSettingsContext = createContext<LocalSettingsStore | null>(null);
export function LocalSettingsProvider({ children, store }: { children: ReactNode; store?: LocalSettingsStore }) {
  const owned = useMemo(() => store ?? new LocalSettingsStore(window.localStorage), [store]);
  useEffect(() => { const sync = (e: StorageEvent) => { if (e.key === localSettingsKey || e.key === null) owned.reload(); }; window.addEventListener('storage',sync); return () => window.removeEventListener('storage',sync); }, [owned]);
  return <LocalSettingsContext.Provider value={owned}>{children}</LocalSettingsContext.Provider>;
}
const noop = () => () => {}, zero = () => 0;
export function useLocalSettings() { const store = useContext(LocalSettingsContext); useSyncExternalStore(store?.subscribe ?? noop,store?.getVersion ?? zero); return store; }
export function displayPatch(patch: Partial<MediaView>): Partial<DisplayPreferences> { return Object.fromEntries(displayKeys.filter(k => k in patch).map(k => [k,patch[k]])); }
