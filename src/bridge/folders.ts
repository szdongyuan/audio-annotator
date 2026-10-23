import { Channel, invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { parseAppError, type AppError } from './types';

export interface ScanToken { taskId: string; ownerId: string }
export interface FolderCounts { checked: number; candidates: number; existing: number; skipped: number; failed: number; issues: number }
export interface FolderCandidate { path: string; relativePath: string }
export interface FolderIssue { path: string; kind: 'access' | 'unresolvedSource' | 'existing' | 'reparse' | 'unsupported'; message: string }
export type FolderEvent =
  | { type: 'progress'; token: ScanToken; counts: FolderCounts }
  | { type: 'result'; token: ScanToken; root: string; counts: FolderCounts; retainedIssues: number }
  | { type: 'cancelled'; token: ScanToken }
  | { type: 'failed'; token: ScanToken; error: AppError };
export type FolderPageKind = 'candidates' | 'issues';
export interface FolderPage { token: ScanToken; kind: FolderPageKind; offset: number; total: number; candidates: FolderCandidate[]; issues: FolderIssue[] }

function check(value: unknown): asserts value { if (!value) throw new Error('Invalid folder bridge message'); }
type Check = (value: unknown) => void;
function object(value: unknown): Record<string, unknown> { check(typeof value === 'object' && value !== null && !Array.isArray(value)); return value as Record<string, unknown>; }
function shape(value: unknown, fields: Record<string, Check>) {
  const v = object(value); check(Object.keys(v).length === Object.keys(fields).length);
  for (const [key, validate] of Object.entries(fields)) { check(Object.hasOwn(v, key)); validate(v[key]); }
}
const text: Check = value => check(typeof value === 'string' && value.length > 0 && !value.includes('\0'));
const integer = (max = Number.MAX_SAFE_INTEGER): Check => value => check(Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max);
const uuid: Check = value => { text(value); check(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value as string) && value !== '00000000-0000-0000-0000-000000000000'); };
const oneOf = (...values: string[]): Check => value => check(values.includes(value as string));
const absolute: Check = value => { text(value); check(/^(?:[a-zA-Z]:[\\/]|\\\\|\/)/.test(value as string)); };
const relative: Check = value => { text(value); check(!(value as string).includes('\\') && !(value as string).includes(':') && !(value as string).split('/').some(p => p === '' || p === '.' || p === '..')); };
const counts: Check = value => {
  shape(value, { checked: integer(100000), candidates: integer(10000), existing: integer(100000), skipped: integer(100000), failed: integer(), issues: integer() });
  const c = value as FolderCounts; check(c.candidates + c.existing + c.skipped <= c.checked);
};
const candidate: Check = value => shape(value, { path: absolute, relativePath: relative });
const issue: Check = value => shape(value, { path: text, kind: oneOf('access', 'unresolvedSource', 'existing', 'reparse', 'unsupported'), message: text });
const array = (validate: Check): Check => value => { check(Array.isArray(value) && value.length <= 256); value.forEach(validate); };
export function parseScanToken(value: unknown): ScanToken { shape(value, { taskId: uuid, ownerId: uuid }); return value as ScanToken; }
export function sameScanToken(a: ScanToken, b: ScanToken): boolean { return a.taskId === b.taskId && a.ownerId === b.ownerId; }
export function parseFolderEvent(value: unknown): FolderEvent {
  const v = object(value);
  const common = { type: oneOf('progress', 'result', 'cancelled', 'failed'), token: parseScanToken };
  switch (v.type) {
    case 'progress': shape(value, { ...common, counts }); break;
    case 'result': shape(value, { ...common, root: absolute, counts, retainedIssues: integer(256) }); check((v.retainedIssues as number) === Math.min((v.counts as FolderCounts).issues, 256)); break;
    case 'cancelled': shape(value, common); break;
    case 'failed': shape(value, { ...common, error: parseAppError }); break;
    default: throw new Error('Unknown folder event');
  }
  return value as FolderEvent;
}
export function parseFolderPage(value: unknown): FolderPage {
  shape(value, { token: parseScanToken, kind: oneOf('candidates', 'issues'), offset: integer(10000), total: integer(10000), candidates: array(candidate), issues: array(issue) });
  const p = value as FolderPage;
  const entries = p.kind === 'candidates' ? p.candidates : p.issues;
  check((p.kind === 'candidates' ? p.issues : p.candidates).length === 0);
  check(p.kind !== 'issues' || p.total <= 256);
  check(p.offset <= p.total && p.offset + entries.length <= p.total && (p.offset === p.total || entries.length > 0));
  return p;
}

export const folderDialogs = { choose: () => open({ title: '选择音频文件夹', directory: true, multiple: false }) };
export interface FolderCommands {
  start(projectId: string, path: string, receive: (event: FolderEvent) => void, recursive?: boolean): Promise<ScanToken>;
  page(token: ScanToken, kind: FolderPageKind, offset: number, limit?: number): Promise<FolderPage>;
  cancel(token: ScanToken): Promise<void>;
  release(token: ScanToken): Promise<void>;
}
/** Events may arrive before start resolves. Keep the token until all candidate pages are consumed,
 * then release it on acceptance/discard. cancel clears unpublished results; release also frees the slot. */
export const folderClient: FolderCommands = {
  start: async (projectId, path, receive, recursive = false) => {
    uuid(projectId); absolute(path); check(typeof recursive === 'boolean');
    const onEvent = new Channel<unknown>();
    onEvent.onmessage = value => receive(parseFolderEvent(value));
    return parseScanToken(await invoke('scan_folder', { projectId, path, recursive, onEvent }));
  },
  page: async (token, kind, offset, limit = 256) => {
    parseScanToken(token); oneOf('candidates', 'issues')(kind); integer(10000)(offset); integer(256)(limit); check(limit > 0);
    const page = parseFolderPage(await invoke('folder_scan_page', { token, kind, offset, limit }));
    check(sameScanToken(page.token, token) && page.kind === kind && page.offset === offset);
    check(page.candidates.length + page.issues.length === Math.min(limit, page.total - offset));
    return page;
  },
  cancel: token => { parseScanToken(token); return invoke('cancel_folder_scan', { token }); },
  release: token => { parseScanToken(token); return invoke('release_folder_scan', { token }); },
};
