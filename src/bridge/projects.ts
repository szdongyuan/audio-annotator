import { runtimeInvoke } from './runtimeInvoke';

import { open } from '@tauri-apps/plugin-dialog';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { normalizeError } from './client';
import { parseProjectDocument, parseProjectSnapshot, type ProjectDocument, type ProjectSnapshot } from './types';
import type { PersistenceCommands } from '../features/project/lifecycle';
import { parseSharedContext, type SharedContext } from './collaboration';

export type RecoverySource = 'recovery' | 'backup';
export interface RecoveryReport { primary: ProjectDocument | null; candidates: { source: RecoverySource; document: ProjectDocument }[] }
export interface OpenedProject { snapshot: ProjectSnapshot | null; persistedRevision: number; path: string; recovery: RecoveryReport | null; collaboration?: SharedContext }
export interface LocalProjectCommands extends PersistenceCommands {
  choose(kind: 'create' | 'open' | 'saveAs'): Promise<string | null>;
  create(path: string): Promise<OpenedProject>;
  open(path: string): Promise<OpenedProject>;
  recover(source: RecoverySource | null): Promise<OpenedProject>;
  saveAs(path: string, projectId: string, revision: number): Promise<OpenedProject>;
  cancelRecovery(): Promise<void>;
  onCloseRequested(callback: () => void): Promise<() => void>;
  destroyWindow(): Promise<void>;
}
export function parseOpened(value: unknown): OpenedProject {
  if (!value || typeof value !== 'object') throw new Error('Invalid project response');
  const v = value as Record<string, unknown>;
  if (typeof v.path !== 'string' || typeof v.persistedRevision !== 'number' || !Number.isSafeInteger(v.persistedRevision) || v.persistedRevision < 0) throw new Error('Invalid project path or revision');
  let recovery: RecoveryReport | null = null;
  if (v.recovery !== null) {
    if (!v.recovery || typeof v.recovery !== 'object') throw new Error('Invalid recovery response');
    const r = v.recovery as Record<string, unknown>;
    if (!Array.isArray(r.candidates)) throw new Error('Invalid recovery candidates');
    recovery = { primary: r.primary === null ? null : parseProjectDocument(r.primary), candidates: r.candidates.map(c => {
      if (!c || typeof c !== 'object' || !['recovery', 'backup'].includes(c.source)) throw new Error('Invalid recovery source');
      return { source: c.source as RecoverySource, document: parseProjectDocument(c.document) };
    }) };
  }
  if (Object.keys(v).some(k => !['path','persistedRevision','snapshot','recovery','collaboration'].includes(k))) throw new Error('Unknown opened project field');
  return { path: v.path, persistedRevision: v.persistedRevision, snapshot: v.snapshot === null ? null : parseProjectSnapshot(v.snapshot), recovery, ...(v.collaboration === undefined ? {} : { collaboration: parseSharedContext(v.collaboration) }) };
}
export function createLocalProjects(runtimeNonce?: string) {
 const invoke = runtimeInvoke(runtimeNonce);
async function call<T>(command: string, args: Record<string, unknown>, parse: (value: unknown) => T): Promise<T> {
  try { return parse(await invoke(command, args)); } catch (error) { throw normalizeError(error); }
}
return {
  choose: async kind => {
    const result = await open({ directory: kind !== 'open', multiple: false,
      title: kind === 'open' ? '打开项目 · 选择 project.json' : kind === 'create' ? '新建项目 · 选择空文件夹' : '另存项目副本 · 选择空文件夹',
      ...(kind === 'open' ? { filters: [{ name: '项目文档', extensions: ['json'] }] } : {}),
    });
    return typeof result === 'string' ? result : null;
  },
  create: path => call('create_project', { path, name: path.split(/[\\/]/).filter(Boolean).at(-1) ?? '未命名项目' }, parseOpened),
  open: path => call('open_project', { path }, parseOpened),
  recover: source => call('resolve_recovery', { source }, parseOpened),
  saveAs: (path, projectId, expectedRevision) => call('save_project_as', { path, projectId, expectedRevision }, parseOpened),
  save: (projectId, expectedRevision) => call('save_project', { projectId, expectedRevision }, value => { if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error('Invalid saved revision'); return value; }),
  close: (projectId, expectedRevision, discard) => call('close_project', { projectId, expectedRevision, discard }, () => undefined),
  cancelRecovery: () => call('close_project', { projectId: null, expectedRevision: null, discard: false }, () => undefined),
  onCloseRequested: callback => listen('project-close-requested', callback),
  destroyWindow: () => getCurrentWindow().destroy(),
} satisfies LocalProjectCommands;

}
export const localProjects = createLocalProjects();
