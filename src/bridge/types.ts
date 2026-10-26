export type Id = string;
export interface Region { mediaId: Id; channelIndex: number; startSeconds: number; endSeconds: number; lowHz: number; highHz: number }
export interface MediaDescriptor {
  id: Id; displayName: string; sourceRef: string; sha256: string; byteLength: number;
  sampleRate: number; frameCount: number; channelCount: number; channelLayout: string[] | null;
  note: string; channelNotes: string[]; categoryIds: Id[]; channelCategoryIds: Id[][];
}
export interface Category { id: Id; name: string; color: string }
export interface Annotation { id: Id; region: Region; categoryIds: Id[]; note: string; createdAt: string; updatedAt: string }
export type EditOperation = {type: 'mask'} | {type: 'gain'; gainDb: number};
export interface SpectralEdit { id: Id; region: Region; enabled: boolean; processingVersion: 2; operation: EditOperation }
export interface AnalysisSettings { window: 'hann' | 'hamming' | 'blackman' | 'rectangular'; windowSize: number; hopSize: number; fftSize: number; melBands: number }
export interface PlaybackMix { soloChannels: number[]; mutedChannels: number[] }
export interface MediaView {
  visibleChannels: number[]; startSeconds: number; endSeconds: number; lowHz: number; highHz: number;
  frequencyMix: number; spectrumKind: 'stft' | 'mel'; gainDb: number; dynamicRangeDb: number; palette: string;
}
export type CompareLayout = 'horizontal' | 'vertical';
export interface ViewState { compareLayout: CompareLayout; compareSplit: number; media: Record<Id, MediaView>; activeMediaId: Id | null; compareMediaId: Id | null; linkedTime: boolean }
export interface ProjectDocument {
  formatVersion: 3; projectId: Id; name: string; revision: number; createdAt: string; updatedAt: string;
  media: MediaDescriptor[]; categories: Category[]; annotations: Annotation[]; edits: SpectralEdit[];
  analysis: Record<Id, AnalysisSettings>; playbackMix: Record<Id, PlaybackMix>; viewState: ViewState;
  algorithmVersions: { analysis: 1; dsp: 2 };
}
export interface ProjectSnapshot { document: ProjectDocument; canUndo: boolean; canRedo: boolean }
export type Change =
  | { type: 'importMedia' | 'relinkMedia'; media: MediaDescriptor }
  | { type: 'removeMedia'; mediaId: Id }
  | { type: 'setMediaCategories'; mediaId: Id; categoryIds: Id[] }
  | { type: 'setChannelCategories'; mediaId: Id; channelIndex: number; categoryIds: Id[] }
  | { type: 'updateMediaNote'; mediaId: Id; note: string; mergeKey: string | null }
  | { type: 'updateChannelNote'; mediaId: Id; channelIndex: number; note: string; mergeKey: string | null }
  | { type: 'updateAnnotationNote'; id: Id; note: string; mergeKey: string | null }
  | { type: 'addCategory' | 'updateCategory'; category: Category }
  | { type: 'removeCategory' | 'removeAnnotation' | 'removeEdit'; id: Id }
  | { type: 'addAnnotation' | 'updateAnnotation'; annotation: Annotation }
  | { type: 'addEdit' | 'updateEdit'; edit: SpectralEdit }
  | { type: 'resetMediaMasks'; mediaId: Id }
  | { type: 'setEditEnabled'; id: Id; enabled: boolean }
  | { type: 'updateAnalysis'; mediaId: Id; settings: AnalysisSettings }
  | { type: 'updatePlaybackMix'; mediaId: Id; mix: PlaybackMix }
  | { type: 'updateViewState'; viewState: ViewState };
export const errorCodes = ['InvalidInput', 'RevisionConflict', 'MissingMedia', 'IdentityMismatch', 'UnsupportedFormat', 'UnsupportedChannels', 'Cancelled', 'DecodeFailed', 'AnalysisFailed', 'DeviceFailed', 'SaveFailed', 'ProjectLocked', 'UnsupportedVersion', 'InvalidArchive', 'ResourceLimit'] as const;
export interface AppError { code: typeof errorCodes[number]; message: string; entityId?: Id; retryable: boolean; details?: unknown }
export { parseProjectDocument, parseProjectSnapshot, parseChange, parseAppError } from './validation';
