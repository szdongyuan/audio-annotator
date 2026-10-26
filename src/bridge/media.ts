import { runtimeInvoke } from './runtimeInvoke';
import { Channel } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { parseAppError, parseChange, type AppError, type MediaDescriptor } from './types';

export type MediaEvent =
  | { type: 'progress'; taskId: string; index: number; path: string; phase: 'extract' | 'hashing' | 'decoding' | 'copyMedia'; completed: number }
  | { type: 'ready'; taskId: string; index: number; media: MediaDescriptor }
  | { type: 'failed'; taskId: string; index: number; path: string; error: AppError }
  | { type: 'finished'; taskId: string; cancelled: boolean };
export interface MediaStatus { mediaId: string; status: 'ready' | 'missing' | 'changed' | 'unverified' }
export const mediaDialogs = {
  choose: (multiple: boolean) => open({ multiple, directory: false, filters: [{ name: '音频', extensions: ['wav', 'flac', 'mp3'] }] }),
};
export interface MediaCommands {
  start(projectId: string, paths: string[], event: (event: MediaEvent) => void, relinkId?: string): Promise<string>;
  cancel(taskId: string): Promise<void>;
  release(taskId: string, mediaId: string): Promise<void>;
  status(projectId: string): Promise<MediaStatus[]>;
}
export function createMediaClient(runtimeNonce?: string) {
 const invoke = runtimeInvoke(runtimeNonce);
return {
  start: async (projectId, paths, receive, relinkId) => {
    const onEvent = new Channel<MediaEvent>();
    onEvent.onmessage = event => {
      // Validate document/error payloads before they reach the persistent command queue.
      if (event.type === 'ready') parseChange({ type: 'importMedia', media: event.media });
      if (event.type === 'failed') parseAppError(event.error);
      receive(event);
    };
    return relinkId
      ? invoke('relink_media', { projectId, mediaId: relinkId, path: paths[0], onEvent })
      : invoke('import_media', { projectId, paths, onEvent });
  },
  cancel: taskId => invoke('cancel_media_import', { taskId }),
  release: (taskId, mediaId) => invoke('release_media_import', { taskId, mediaId }),
  status: projectId => invoke('media_status', { projectId }),
} satisfies MediaCommands;

}
export const mediaClient = createMediaClient();
