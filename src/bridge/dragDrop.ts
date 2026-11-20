import { invoke } from '@tauri-apps/api/core';
import { organizationUuid } from './organization';

export interface DropSession { projectId: string; runtimeNonce: string; shared: boolean }
export interface DropTarget { folderId: string | null; layoutRevision: number }
export type DropPreflight = { session: DropSession; paths: string[] } & (
  | { kind: 'audio'; target: DropTarget | null }
  | { kind: 'folder' | 'zip'; target: DropTarget }
);

function check(value: unknown): asserts value {
  if (!value) throw new Error('无效的拖放预检响应');
}
function exact(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  check(typeof value === 'object' && value !== null && !Array.isArray(value));
  check(Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)));
}
export function parseDropSession(value: unknown): DropSession {
  exact(value, ['projectId', 'runtimeNonce', 'shared']);
  organizationUuid(value.projectId); organizationUuid(value.runtimeNonce);
  check(typeof value.shared === 'boolean');
  return value as unknown as DropSession;
}
function parseTarget(value: unknown): DropTarget {
  exact(value, ['folderId', 'layoutRevision']);
  if (value.folderId !== null) organizationUuid(value.folderId);
  check(Number.isSafeInteger(value.layoutRevision) && (value.layoutRevision as number) >= 0);
  return value as unknown as DropTarget;
}
export function parseDropPreflight(value: unknown): DropPreflight {
  exact(value, ['session', 'kind', 'paths', 'target']);
  const session = parseDropSession(value.session);
  check(value.kind === 'audio' || value.kind === 'zip' || value.kind === 'folder');
  check(Array.isArray(value.paths) && value.paths.length > 0 && value.paths.length <= (value.kind === 'audio' ? 256 : value.kind === 'zip' ? 32 : 1));
  const maxPathLength = value.kind === 'audio' ? 32768 : 16384;
  check(value.paths.every(path => typeof path === 'string' && path.length > 0 && path.length <= maxPathLength && !path.includes('\0')));
  if (session.shared) parseTarget(value.target); else check(value.target === null && value.kind === 'audio');
  return value as unknown as DropPreflight;
}
export async function captureDropSession(projectId: string): Promise<DropSession> {
  organizationUuid(projectId);
  const session = parseDropSession(await invoke('capture_drop_session', { projectId }));
  check(session.projectId === projectId);
  return session;
}
export async function preflightDrop(session: DropSession, paths: string[], target: DropTarget | null): Promise<DropPreflight> {
  parseDropSession(session);
  if (target !== null) parseTarget(target);
  check(session.shared ? target !== null : target === null);
  check(Array.isArray(paths) && paths.length > 0 && paths.length <= 256 && paths.every(path => typeof path === 'string' && path.length > 0 && path.length <= 32768 && !path.includes('\0')));
  const capturedSession = { ...session }, capturedPaths = [...paths], capturedTarget = target ? { ...target } : null;
  const result = parseDropPreflight(await invoke('preflight_drop', { session: capturedSession, paths: capturedPaths, target: capturedTarget }));
  check(result.session.projectId === capturedSession.projectId && result.session.runtimeNonce === capturedSession.runtimeNonce && result.session.shared === capturedSession.shared);
  check(result.paths.length === capturedPaths.length && result.paths.every((path, i) => path === capturedPaths[i]));
  check(result.target === null ? capturedTarget === null : capturedTarget !== null && result.target.folderId === capturedTarget.folderId && result.target.layoutRevision === capturedTarget.layoutRevision);
  return result;
}
