import { createProjectClient, projectClient } from './client';
import { createLocalProjects, localProjects } from './projects';
import { createMediaClient, mediaClient } from './media';
import { createFolderClient, folderClient } from './folders';
import { createSourceClient, sourceClient } from './sourceImport';
import { createPlaybackClient, playbackClient } from './playback';
import { createTileTransport, nativeTileTransport } from '../features/spectrogram/tileClient';
export function createRuntimeCommands(runtimeNonce?:string){return Object.freeze({
 project:runtimeNonce?createProjectClient(runtimeNonce):projectClient,
 projects:runtimeNonce?createLocalProjects(runtimeNonce):localProjects,
 media:runtimeNonce?createMediaClient(runtimeNonce):mediaClient,
 folders:runtimeNonce?createFolderClient(runtimeNonce):folderClient,
 sources:runtimeNonce?createSourceClient(runtimeNonce):sourceClient,
 playback:runtimeNonce?createPlaybackClient(runtimeNonce):playbackClient,
 tiles:runtimeNonce?createTileTransport(runtimeNonce):nativeTileTransport,
});}
export type RuntimeCommands=ReturnType<typeof createRuntimeCommands>;
