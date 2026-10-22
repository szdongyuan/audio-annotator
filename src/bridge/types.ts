export type Id = string;
export interface Region { mediaId: Id; channelIndex: number; startSeconds: number; endSeconds: number; lowHz: number; highHz: number }
export interface MediaDescriptor {
  id: Id; displayName: string; sourceRef: string; sha256: string; byteLength: number;
  sampleRate: number; frameCount: number; channelCount: number; channelLayout: string[] | null;
  note: string; channelNotes: string[];
}
export interface Category { id: Id; name: string; color: string }
export interface Annotation { id: Id; region: Region; categoryId: Id | null; note: string; createdAt: string; updatedAt: string }
export interface SpectralEdit { id: Id; region: Region; enabled: boolean; processingVersion: 1 }
export interface AnalysisSettings { window: 'hann' | 'hamming' | 'blackman' | 'rectangular'; windowSize: number; hopSize: number; fftSize: number; melBands: number }
export interface PlaybackMix { soloChannels: number[]; mutedChannels: number[] }
export interface MediaView {
  visibleChannels: number[]; startSeconds: number; endSeconds: number; lowHz: number; highHz: number;
  frequencyMix: number; spectrumKind: 'stft' | 'mel'; gainDb: number; dynamicRangeDb: number; palette: string;
}
export interface ViewState { media: Record<Id, MediaView>; activeMediaId: Id | null; compareMediaId: Id | null; linkedTime: boolean }
export interface ProjectDocument {
  formatVersion: 1; projectId: Id; name: string; revision: number; createdAt: string; updatedAt: string;
  media: MediaDescriptor[]; categories: Category[]; annotations: Annotation[]; edits: SpectralEdit[];
  analysis: Record<Id, AnalysisSettings>; playbackMix: Record<Id, PlaybackMix>; viewState: ViewState;
  algorithmVersions: { analysis: 1; dsp: 1 };
}
export interface ProjectSnapshot { document: ProjectDocument; canUndo: boolean; canRedo: boolean }
export type Change =
  | { type: 'importMedia' | 'relinkMedia'; media: MediaDescriptor }
  | { type: 'removeMedia'; mediaId: Id }
  | { type: 'updateMediaNote'; mediaId: Id; note: string; mergeKey: string | null }
  | { type: 'updateChannelNote'; mediaId: Id; channelIndex: number; note: string; mergeKey: string | null }
  | { type: 'updateAnnotationNote'; id: Id; note: string; mergeKey: string | null }
  | { type: 'addCategory' | 'updateCategory'; category: Category }
  | { type: 'removeCategory' | 'removeAnnotation' | 'removeEdit'; id: Id }
  | { type: 'addAnnotation' | 'updateAnnotation'; annotation: Annotation }
  | { type: 'addEdit' | 'updateEdit'; edit: SpectralEdit }
  | { type: 'setEditEnabled'; id: Id; enabled: boolean }
  | { type: 'updateAnalysis'; mediaId: Id; settings: AnalysisSettings }
  | { type: 'updatePlaybackMix'; mediaId: Id; mix: PlaybackMix }
  | { type: 'updateViewState'; viewState: ViewState };
export const errorCodes = ['InvalidInput', 'RevisionConflict', 'MissingMedia', 'IdentityMismatch', 'UnsupportedFormat', 'UnsupportedChannels', 'Cancelled', 'DecodeFailed', 'AnalysisFailed', 'DeviceFailed', 'SaveFailed', 'ProjectLocked', 'UnsupportedVersion', 'InvalidArchive', 'ResourceLimit'] as const;
export interface AppError { code: typeof errorCodes[number]; message: string; entityId?: Id; retryable: boolean; details?: unknown }
export { parseProjectDocument, parseProjectSnapshot, parseChange, parseAppError } from './validation';
