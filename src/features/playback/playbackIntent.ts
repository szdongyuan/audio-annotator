import type { Region } from '../../bridge/types';
export type WorkspaceSoundVersion = 'original' | 'processed';
export type PlaybackIntent =
 | { kind: 'automatic' }
 | { kind: 'explicit-file'; mediaId: string; sourceOverride?: WorkspaceSoundVersion }
 | { kind: 'explicit-cue'; mediaId: string; seconds: number; sourceOverride?: WorkspaceSoundVersion }
 | { kind: 'explicit-selection'; region: Region; sourceOverride?: WorkspaceSoundVersion };
export function resolveIntent(intent: PlaybackIntent, sourceId: string | null, selection: Region | undefined, workspaceSource: WorkspaceSoundVersion) {
 const region = intent.kind === 'explicit-selection' ? intent.region : intent.kind === 'automatic' ? selection : undefined;
 const source = ('sourceOverride' in intent ? intent.sourceOverride : undefined) ?? workspaceSource;
 const mediaId = region?.mediaId ?? (intent.kind === 'explicit-file' || intent.kind === 'explicit-cue' ? intent.mediaId : sourceId);
 return { mediaId, region, source, start: region?.startSeconds ?? (intent.kind === 'explicit-cue' ? intent.seconds : 0) };
}
