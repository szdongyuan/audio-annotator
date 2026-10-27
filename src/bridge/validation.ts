import { errorCodes, type AnalysisSettings, type AppError, type Change, type MediaDescriptor, type ProjectDocument, type ProjectSnapshot, type Region } from './types';

type Check = (value: unknown) => void;
function check(valid: unknown, message = 'Invalid bridge input'): asserts valid { if (!valid) throw new Error(message); }
const text: Check = (v) => check(typeof v === 'string');
const nonempty: Check = (v) => { text(v); check((v as string).trim().length > 0); };
const finite: Check = (v) => check(typeof v === 'number' && Number.isFinite(v));
const integer: Check = (v) => check(Number.isSafeInteger(v) && (v as number) >= 0);
const positive: Check = (v) => { integer(v); check((v as number) > 0); };
const bool: Check = (v) => check(typeof v === 'boolean');
const oneOf = (...values: unknown[]): Check => (v) => check(values.includes(v));
const uuid: Check = (v) => { text(v); check(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(v as string) && v !== '00000000-0000-0000-0000-000000000000'); };
const utc: Check = (v) => {
  text(v);
  const value = v as string;
  check(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(value) && Number.isFinite(Date.parse(value)));
  // Date.parse normalizes impossible dates such as February 30; do not accept them.
  check(new Date(value).toISOString().slice(0, 19) === value.slice(0, 19));
};
const nullable = (item: Check): Check => (v) => { if (v !== null) item(v); };
const array = (item: Check): Check => (v) => { check(Array.isArray(v)); (v as unknown[]).forEach(item); };
function object(value: unknown): Record<string, unknown> { check(typeof value === 'object' && value !== null && !Array.isArray(value)); return value as Record<string, unknown>; }
function shape(fields: Record<string, Check>, optional: Record<string, Check> = {}): Check {
  return (value) => {
    const v = object(value);
    check(Object.keys(v).every((key) => Object.hasOwn(fields, key) || Object.hasOwn(optional, key)), 'Unknown field');
    for (const [key, validate] of Object.entries(fields)) { check(Object.hasOwn(v, key), `Missing ${key}`); validate(v[key]); }
    for (const [key, validate] of Object.entries(optional)) if (Object.hasOwn(v, key)) validate(v[key]);
  };
}
const record = (item: Check): Check => (v) => { for (const [key, value] of Object.entries(object(v))) { uuid(key); item(value); } };
const channel: Check = (v) => { integer(v); check((v as number) <= 5); };
const regionShape = shape({ mediaId: uuid, channelIndex: channel, startSeconds: finite, endSeconds: finite, lowHz: finite, highHz: finite });
const region: Check = (v) => { regionShape(v); const r = v as Region; check(r.startSeconds >= 0 && r.startSeconds < r.endSeconds && r.lowHz >= 0 && r.lowHz < r.highHz); };
const labels: Check = (v) => { array(uuid)(v); const ids = v as string[]; check(ids.length <= 64 && new Set(ids).size === ids.length); };
const mediaShape = shape({ id: uuid, displayName: nonempty, sourceRef: nonempty, sha256: (v) => { text(v); check(/^[0-9a-f]{64}$/.test(v as string)); }, byteLength: positive, sampleRate: positive, frameCount: positive, channelCount: positive, channelLayout: nullable(array(text)), note: text, channelNotes: array(text), categoryIds: labels, channelCategoryIds: array(labels) });
const media: Check = (v) => { mediaShape(v); const m = v as MediaDescriptor; check(m.channelCount <= 6 && m.sampleRate <= 0xffffffff && m.channelNotes.length === m.channelCount && m.channelCategoryIds.length === m.channelCount && (m.channelLayout === null || m.channelLayout.length === m.channelCount)); };
const category = shape({ id: uuid, name: nonempty, color: (v) => { text(v); check(/^#[0-9a-fA-F]{6}$/.test(v as string)); } });
const annotation = shape({ id: uuid, region, categoryIds: labels, note: text, createdAt: utc, updatedAt: utc });
const operation: Check = v => {
  const op=object(v);
  if(op.type==='mask')shape({type:oneOf('mask')})(v);
  else shape({type:oneOf('gain'),gainDb:v=>{finite(v);check((v as number)>=-60&&(v as number)<=24);}})(v);
};
const edit = shape({ id: uuid, region, enabled: bool, processingVersion: oneOf(2), operation });
const analysisShape = shape({ window: oneOf('hann', 'hamming', 'blackman', 'rectangular'), windowSize: integer, hopSize: integer, fftSize: integer, melBands: integer });
const analysis: Check = (v) => {
  analysisShape(v); const a = v as AnalysisSettings;
  check(a.windowSize >= 64 && a.windowSize <= 32768 && a.hopSize >= 1 && a.hopSize <= a.windowSize && a.fftSize >= a.windowSize && a.fftSize <= 65536 && (a.fftSize & (a.fftSize - 1)) === 0 && a.melBands >= 32 && a.melBands <= 512);
};
const mix = shape({ soloChannels: array(channel), mutedChannels: array(channel) });
const view = shape({ visibleChannels: array(channel), startSeconds: finite, endSeconds: finite, lowHz: finite, highHz: finite, frequencyMix: finite, spectrumKind: oneOf('stft', 'mel'), gainDb: finite, dynamicRangeDb: finite, palette: nonempty });
const viewState = shape({ media: record(view), activeMediaId: nullable(uuid), compareMediaId: nullable(uuid), linkedTime: bool, compareLayout: oneOf('horizontal', 'vertical'), compareSplit: (v) => { finite(v); check((v as number) >= .25 && (v as number) <= .75); } });
const project = shape({ formatVersion: oneOf(3), projectId: uuid, name: nonempty, revision: integer, createdAt: utc, updatedAt: utc, media: array(media), categories: array(category), annotations: array(annotation), edits: array(edit), analysis: record(analysis), playbackMix: record(mix), viewState, algorithmVersions: shape({ analysis: oneOf(1), dsp: oneOf(2) }) });
const unique = (values: unknown[]) => check(new Set(values).size === values.length, 'Duplicate values');
const dates = (v: { createdAt: string; updatedAt: string }) => check(Date.parse(v.createdAt) <= Date.parse(v.updatedAt));
function regionInMedia(r: Region, source: MediaDescriptor | undefined) {
  check(source !== undefined, 'Unknown media');
  const m = source!;
  check(r.channelIndex < m.channelCount && r.endSeconds <= m.frameCount / m.sampleRate && r.highHz <= m.sampleRate / 2);
}
export function parseProjectDocument(value: unknown): ProjectDocument {
  project(value);
  const d = value as ProjectDocument;
  dates(d);
  unique([d.projectId, ...[d.media, d.categories, d.annotations, d.edits].flatMap((items) => items.map((item) => item.id))]);
  unique(d.categories.map((c) => c.name.trim()));
  const sources = new Map(d.media.map((m) => [m.id, m]));
  for (const a of d.annotations) { dates(a); regionInMedia(a.region, sources.get(a.region.mediaId)); check(a.categoryIds.every(id => d.categories.some(c => c.id === id))); }
  for (const m of d.media) for (const id of [m.categoryIds, ...m.channelCategoryIds].flat()) check(d.categories.some(c => c.id === id));
  for (const e of d.edits) regionInMedia(e.region, sources.get(e.region.mediaId));
  for (const m of d.media) check(Object.hasOwn(d.analysis, m.id) && Object.hasOwn(d.playbackMix, m.id));
  for (const id of Object.keys(d.analysis)) check(sources.has(id));
  for (const [id, m] of Object.entries(d.playbackMix)) {
    check(sources.has(id));
    for (const channels of [m.soloChannels, m.mutedChannels]) { unique(channels); check(channels.every((c) => c < sources.get(id)!.channelCount)); }
  }
  const vs = d.viewState;
  for (const id of [vs.activeMediaId, vs.compareMediaId]) check(id === null || sources.has(id));
  check(vs.compareMediaId === null || vs.compareMediaId !== vs.activeMediaId);
  const maxDuration = Math.max(0, ...d.media.map((m) => m.frameCount / m.sampleRate));
  for (const [id, v] of Object.entries(vs.media)) {
    check(sources.has(id)); const m = sources.get(id)!;
    unique(v.visibleChannels); check(v.visibleChannels.every((c) => c < m.channelCount));
    check(v.startSeconds >= 0 && v.startSeconds < v.endSeconds && v.endSeconds <= (vs.linkedTime ? maxDuration : m.frameCount / m.sampleRate));
    check(v.lowHz >= 0 && v.lowHz < v.highHz && v.highHz <= m.sampleRate / 2 && v.frequencyMix >= 0 && v.frequencyMix <= 1 && v.dynamicRangeDb > 0);
  }
  return d;
}
export function parseProjectSnapshot(value: unknown): ProjectSnapshot {
  shape({ document: parseProjectDocument, canUndo: bool, canRedo: bool })(value);
  return value as ProjectSnapshot;
}
export function parseAppError(value: unknown): AppError {
  shape({ code: oneOf(...errorCodes), message: text, retryable: bool }, { entityId: uuid, details: () => {} })(value);
  return value as AppError;
}
const changeFields: Record<Change['type'], Record<string, Check>> = {
  importMediaBatch: { items: v => { array(media)(v); const items=v as MediaDescriptor[]; check(items.length>0 && items.length<=256); unique(items.map(m=>m.id)); } },
  importMedia: { media }, relinkMedia: { media }, removeMedia: { mediaId: uuid },
  setMediaCategories: { mediaId: uuid, categoryIds: labels },
  setChannelCategories: { mediaId: uuid, channelIndex: channel, categoryIds: labels },
  updateMediaNote: { mediaId: uuid, note: text, mergeKey: nullable(text) },
  updateChannelNote: { mediaId: uuid, channelIndex: channel, note: text, mergeKey: nullable(text) },
  updateAnnotationNote: { id: uuid, note: text, mergeKey: nullable(text) },
  addCategory: { category }, updateCategory: { category }, removeCategory: { id: uuid },
  addAnnotation: { annotation }, updateAnnotation: { annotation }, removeAnnotation: { id: uuid },
  resetMediaMasks: { mediaId: uuid }, addEdit: { edit }, updateEdit: { edit }, removeEdit: { id: uuid }, setEditEnabled: { id: uuid, enabled: bool },
  updateAnalysis: { mediaId: uuid, settings: analysis }, updatePlaybackMix: { mediaId: uuid, mix }, updateViewState: { viewState },
};
export function parseChange(value: unknown): Change {
  const v = object(value); text(v.type); check(Object.hasOwn(changeFields, v.type as string));
  shape({ type: text, ...changeFields[v.type as Change['type']] })(v);
  return value as Change;
}
