import { Channel } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { runtimeInvoke } from './runtimeInvoke';
import { parseAppError, parseChange, type AppError } from './types';
import type { MediaEvent } from './media';
export interface SourceRules {
  mode: 'generic' | 'jingcheng';
  recursive: boolean;
  extensions: string[];
  include: string[];
  exclude: string[];
  includeSecond: boolean;
}
export interface SourceConfig {
  kind: 'folder' | 'zip';
  paths: string[];
  rules: SourceRules;
}
export interface SourceToken {
  runtimeNonce: string;
  projectId: string;
  taskId: string;
}
export interface SourceCounts {
  checked: number;
  candidates: number;
  skipped: number;
  issues: number;
  selectedBytes: number;
}
export interface SourceCandidate {
  index: number;
  sourceIndex: number;
  sourceName: string;
  relativePath: string;
  displayName: string;
  byteLength: number;
  logicalPosition: number | null;
}
export interface SourceIssue {
  sourceIndex: number;
  relativePath: string;
  message: string;
}
export interface SourcePage {
  candidates: SourceCandidate[];
  issues: SourceIssue[];
  counts: SourceCounts;
}
export type SourceEvent = {
  type: 'progress' | 'result';
  token: SourceToken;
  counts: SourceCounts;
} | {
  type: 'failed';
  token: SourceToken;
  error: AppError;
};
function check(v: unknown): asserts v {
  if (!v)
    throw new Error('无效的音频导入配置或响应');
}
type Check = (v: unknown) => void;
function shape(v: unknown, fields: Record<string, Check>) {
  check(typeof v === 'object' && v !== null && !Array.isArray(v));
  const o = v as Record<string, unknown>;
  check(Object.keys(o).length === Object.keys(fields).length);
  for (const [k, validate] of Object.entries(fields)) {
    check(Object.hasOwn(o, k));
    validate(o[k]);
  }
}
const text: Check = v => check(typeof v === 'string' && v.length > 0 && v.length <= 16384 && !v.includes('\0'));
const integer = (max = Number.MAX_SAFE_INTEGER): Check => v => check(Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= max);
const bool: Check = v => check(typeof v === 'boolean');
const uuid: Check = v => {
  text(v);
  check(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(v as string) && v !== '00000000-0000-0000-0000-000000000000');
};
const oneOf = (...values: string[]): Check => v => check(values.includes(v as string));
const array = (validator: Check, max = 256): Check => v => {
  check(Array.isArray(v) && v.length <= max);
  v.forEach(validator);
};
const relative: Check = v => {
  text(v);
  check(!(v as string).includes('\\') && !(v as string).includes(':') && !(v as string).split('/').some(p => !p || p === '.' || p === '..'));
};
const counts: Check = v => shape(v, { checked: integer(100000), candidates: integer(10000), skipped: integer(), issues: integer(), selectedBytes: integer(20 * 1024 ** 3) });
const pattern: Check = v => {
  text(v);
  const p = v as string;
  check([...p].length <= 512 && !/[\x00-\x1f\x7f\\:\[\]{},;]/.test(p) && !p.split('/').some(s => !s || s === '.' || s === '..' || (s.includes('**') && s !== '**')));
};
export function parseSourceRules(v: unknown): SourceRules {
  shape(v, { mode: oneOf('generic', 'jingcheng'), recursive: bool, extensions: array(x => {
      text(x);
      oneOf('wav', 'flac', 'mp3')((x as string).toLowerCase());
    }, 3), include: array(pattern), exclude: array(pattern), includeSecond: bool });
  const r = v as SourceRules;
  check(r.extensions.length && r.include.length && r.include.length + r.exclude.length <= 256);
  return r;
}
export function parseSourceToken(v: unknown): SourceToken {
  shape(v, { runtimeNonce: uuid, projectId: uuid, taskId: uuid });
  return v as SourceToken;
}
export function sameSourceToken(a: SourceToken, b: SourceToken) {
  return a.runtimeNonce === b.runtimeNonce && a.projectId === b.projectId && a.taskId === b.taskId;
}
export function parseSourceEvent(v: unknown): SourceEvent {
  const type = (v as {
    type?: unknown;
  })?.type;
  if (type === 'failed')
    shape(v, { type: oneOf('failed'), token: parseSourceToken, error: parseAppError });
  else
    shape(v, { type: oneOf('progress', 'result'), token: parseSourceToken, counts });
  return v as SourceEvent;
}
export function parseSourcePage(v: unknown): SourcePage {
  shape(v, { candidates: array(c => shape(c, { index: integer(9999), sourceIndex: integer(31), sourceName: text, relativePath: relative, displayName: text, byteLength: integer(1024 ** 3), logicalPosition: x => {
        if (x !== null)
          integer()(x);
      } })), issues: array(i => shape(i, { sourceIndex: integer(31), relativePath: text, message: text })), counts });
  return v as SourcePage;
}
export function parseSourceMediaEvent(v: unknown): MediaEvent {
  const type = (v as {
    type?: unknown;
  })?.type;
  const common = { type: oneOf('progress', 'ready', 'failed'), taskId: uuid, index: integer(255) };
  if (type === 'finished')
    shape(v, { type: oneOf('finished'), taskId: uuid, cancelled: bool });
  else if (type === 'ready')
    shape(v, { ...common, media: m => parseChange({ type: 'importMedia', media: m }) });
  else if (type === 'failed')
    shape(v, { ...common, path: text, error: parseAppError });
  else
    shape(v, { ...common, path: text, phase: oneOf('extract', 'hashing', 'decoding', 'copyMedia'), completed: integer() });
  return v as MediaEvent;
}
export interface SourceCommands {
  start(projectId: string, config: SourceConfig, receive: (event: SourceEvent) => void): Promise<SourceToken>;
  page(token: SourceToken, offset: number, limit?: number): Promise<SourcePage>;
  cancel(token: SourceToken): Promise<void>;
  release(token: SourceToken): Promise<void>;
  batch(token: SourceToken, indices: number[], receive: (event: MediaEvent) => void): Promise<string>;
}
export function createSourceClient(runtimeNonce?: string): SourceCommands {
  const invoke = runtimeInvoke(runtimeNonce);
  const owned = (token: SourceToken) => {
    parseSourceToken(token);
    check(!runtimeNonce || token.runtimeNonce === runtimeNonce);
  };
  return {
    start: async (projectId, config, receive) => {
      uuid(projectId);
      shape(config, { kind: oneOf('folder', 'zip'), paths: array(text, 32), rules: parseSourceRules });
      check(config.paths.length > 0 && (config.kind !== 'folder' || config.paths.length === 1));
      const onEvent = new Channel<unknown>();
      onEvent.onmessage = v => {
        const e = parseSourceEvent(v);
        owned(e.token);
        check(e.token.projectId === projectId);
        receive(e);
      };
      const token = parseSourceToken(await invoke('scan_import_sources', { projectId, config, onEvent }));
      owned(token);
      check(token.projectId === projectId);
      return token;
    },
    page: async (token, offset, limit = 256) => {
      owned(token);
      integer(10000)(offset);
      integer(256)(limit);
      check(limit > 0);
      const page = parseSourcePage(await invoke('import_source_page', { token, offset, limit }));
      check(offset <= page.counts.candidates && page.candidates.length === Math.min(limit, page.counts.candidates - offset));
      page.candidates.forEach((c, i) => check(c.index === offset + i));
      return page;
    },
    cancel: token => {
      owned(token);
      return invoke('cancel_import_source_scan', { token });
    },
    release: token => {
      owned(token);
      return invoke('release_import_source_scan', { token });
    },
    batch: async (token, indices, receive) => {
      owned(token);
      array(integer(9999))(indices);
      check(indices.length > 0 && new Set(indices).size === indices.length);
      const onEvent = new Channel<unknown>();
      onEvent.onmessage = v => receive(parseSourceMediaEvent(v));
      const task = await invoke<string>('import_source_batch', { token, indices, onEvent });
      uuid(task);
      return task;
    },
  };
}
export const sourceClient = createSourceClient();
export const sourceDialogs = { choose: (kind: SourceConfig['kind']) => open(kind === 'folder' ? { title: '选择音频文件夹', directory: true, multiple: false } : { title: '选择 ZIP 音频', directory: false, multiple: true, filters: [{ name: 'ZIP', extensions: ['zip'] }] }) };
