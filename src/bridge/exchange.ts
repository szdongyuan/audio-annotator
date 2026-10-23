import { Channel, invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import { parseOpened, type OpenedProject } from './projects';
import { parseAppError, type AppError } from './types';
export type ExchangeKind = 'annotations' | 'bundle' | 'import';
export interface ExpectedProject { projectId: string; expectedRevision: number }
export type ExchangeEvent =
  | { type: 'progress'; taskId: string; phase: string; completed: number }
  | { type: 'completed'; taskId: string; path: string; opened: OpenedProject | null }
  | { type: 'failed'; taskId: string; error: AppError }
  | { type: 'cancelled'; taskId: string };
export const exchangeDialogs = {
  save: (kind: 'annotations' | 'bundle') => save({ title: '分享 · 保存到本机', defaultPath: kind === 'bundle' ? 'project.audioproj.zip' : 'project.annotations.json', filters: [{ name: kind === 'bundle' ? '完整项目包（含音频）' : '仅标注（不含音频）', extensions: [kind === 'bundle' ? 'zip' : 'json'] }] }),
  source: () => open({ title: '导入标注文件或完整项目包', multiple: false, directory: false, filters: [{ name: '交换文件', extensions: ['json', 'zip'] }] }),
  parent: () => open({ title: '选择新项目的存放位置 · 将创建独立子文件夹', multiple: false, directory: true }),
};
export interface ExchangeRequest { kind: ExchangeKind; expected: ExpectedProject | null; path?: string; source?: string; parent?: string }
export const exchangeClient = {
  start: async (request: ExchangeRequest, receive: (event: ExchangeEvent) => void): Promise<string> => {
    const onEvent = new Channel<ExchangeEvent>();
    onEvent.onmessage = event => {
      if (typeof event.taskId !== 'string') throw new Error('Invalid exchange task');
      if (event.type === 'completed') { if (typeof event.path !== 'string') throw new Error('Invalid result path'); if (event.opened) event.opened = parseOpened(event.opened); }
      if (event.type === 'failed') parseAppError(event.error);
      receive(event);
    };
    return invoke(request.kind === 'import' ? 'import_exchange' : request.kind === 'bundle' ? 'export_bundle' : 'export_annotations', { expected: request.expected, path: request.path, source: request.source, parent: request.parent, onEvent });
  },
  cancel: (taskId: string) => invoke<void>('cancel_exchange', { taskId }),
};
