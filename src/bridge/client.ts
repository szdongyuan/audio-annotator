import { invoke } from '@tauri-apps/api/core';
import { parseAppError, parseChange, parseProjectSnapshot, type AppError } from './types';
import type { ProjectCommands } from '../app/commands';

export function normalizeError(value: unknown): AppError {
  try { return parseAppError(value); }
  catch { return { code: 'InvalidInput', message: 'The command failed or returned an invalid response', retryable: false }; }
}
async function snapshotCommand(command: string, args: Record<string, unknown>) {
  try { return parseProjectSnapshot(await invoke<unknown>(command, args)); }
  catch (error) { throw normalizeError(error); }
}
/** Native transport only. Tests inject ProjectCommands instead of installing a fake runtime. */
export const projectClient: ProjectCommands = {
  applyChange: (projectId, expectedRevision, change) => snapshotCommand('apply_change', { projectId, expectedRevision, change: parseChange(change) }),
  getSnapshot: (projectId) => snapshotCommand('get_project_snapshot', { projectId }),
  undo: (projectId, expectedRevision) => snapshotCommand('undo', { projectId, expectedRevision }),
  redo: (projectId, expectedRevision) => snapshotCommand('redo', { projectId, expectedRevision }),
};
