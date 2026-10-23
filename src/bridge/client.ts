import { runtimeInvoke } from './runtimeInvoke';

import { parseAppError, parseChange, parseProjectSnapshot, type AppError } from './types';
import type { ProjectCommands } from '../app/commands';

export function normalizeError(value: unknown): AppError {
  try { return parseAppError(value); }
  catch { return { code: 'InvalidInput', message: 'The command failed or returned an invalid response', retryable: false }; }
}
export function createProjectClient(runtimeNonce?: string) {
 const invoke = runtimeInvoke(runtimeNonce);
async function snapshotCommand(command: string, args: Record<string, unknown>) {
  try { return parseProjectSnapshot(await invoke<unknown>(command, args)); }
  catch (error) { throw normalizeError(error); }
}
/** Native transport only. Tests inject ProjectCommands instead of installing a fake runtime. */
return {
  applyChange: (projectId, expectedRevision, change) => snapshotCommand('apply_change', { projectId, expectedRevision, change: parseChange(change) }),
  getSnapshot: (projectId) => snapshotCommand('get_project_snapshot', { projectId }),
  undo: (projectId, expectedRevision) => snapshotCommand('undo', { projectId, expectedRevision }),
  redo: (projectId, expectedRevision) => snapshotCommand('redo', { projectId, expectedRevision }),
} satisfies ProjectCommands;

}
export const projectClient = createProjectClient();
