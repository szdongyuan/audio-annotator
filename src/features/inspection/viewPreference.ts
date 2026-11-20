export type InspectionViewMode = 'audio' | 'annotation';
export type InspectionViewPreference = { mode: InspectionViewMode; locked: boolean };
export const inspectionViewPreferenceKey = 'audio-annotator.inspection-view.v1';
const defaults = (): InspectionViewPreference => ({ mode: 'annotation', locked: false });

// Separate from project data and per-audio display overrides: both entry points
// share only their preferred opening mode, never another audio's coordinates.
export function readInspectionViewPreference(): InspectionViewPreference {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(inspectionViewPreferenceKey) ?? 'null');
    if (value && typeof value === 'object' && 'mode' in value && 'locked' in value
      && (value.mode === 'audio' || value.mode === 'annotation') && typeof value.locked === 'boolean') return { mode: value.mode, locked: value.locked };
  } catch { /* Unavailable local storage must not prevent audio inspection. */ }
  return defaults();
}
export function saveInspectionViewPreference(value: InspectionViewPreference): string | null {
  try { localStorage.setItem(inspectionViewPreferenceKey, JSON.stringify(value)); return null; }
  catch { return '查看方式未保存到本机，下次打开时可能需要重新选择。'; }
}
