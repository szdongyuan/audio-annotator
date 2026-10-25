import { Channel, invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import { parseOpened, type OpenedProject } from './projects';
import { parseAppError, parseChange, type MediaDescriptor, type AppError } from './types';
export type ExchangeKind = 'annotations' | 'bundle' | 'import';
export interface ExpectedProject { projectId: string; expectedRevision: number; runtimeNonce?: string }
export type SourceRequirement=Pick<MediaDescriptor,'id'|'displayName'|'sha256'|'byteLength'|'sampleRate'|'frameCount'|'channelCount'|'channelLayout'>;
export interface SourceBindings {sourceSha256:string;media:{mediaId:string;path:string}[]}
export type ExchangeEvent =
  | {type:'sourcesRequired';taskId:string;sourceSha256:string;media:SourceRequirement[]}
  | { type: 'progress'; taskId: string; phase: string; completed: number }
  | { type: 'completed'; taskId: string; path: string; opened: OpenedProject | null }
  | { type: 'failed'; taskId: string; error: AppError }
  | { type: 'cancelled'; taskId: string };
export const exchangeDialogs = {
  save: (kind: 'annotations' | 'bundle') => save({ title: '分享 · 保存到本机', defaultPath: kind === 'bundle' ? 'project.audioproj.zip' : 'project.annotations.json', filters: [{ name: kind === 'bundle' ? '完整项目包（含音频）' : '仅标注（不含音频）', extensions: [kind === 'bundle' ? 'zip' : 'json'] }] }),
  source: () => open({ title: '导入标注文件或完整项目包', multiple: false, directory: false, filters: [{ name: '交换文件', extensions: ['json', 'zip'] }] }),
  parent: () => open({ title: '选择新项目的存放位置 · 将创建独立子文件夹', multiple: false, directory: true }),
};
export interface ExchangeRequest { kind: ExchangeKind; expected: ExpectedProject | null; path?: string; source?: string; parent?: string;bindings?:SourceBindings }
export const exchangeClient = {
  start: async (request: ExchangeRequest, receive: (event: ExchangeEvent) => void): Promise<string> => {
    const onEvent = new Channel<ExchangeEvent>();
    onEvent.onmessage = event => {
      if (typeof event.taskId !== 'string') throw new Error('Invalid exchange task');
      if (event.type === 'completed') { if (typeof event.path !== 'string') throw new Error('Invalid result path'); if (event.opened) event.opened = parseOpened(event.opened); }
      if(event.type==='sourcesRequired'){
        if(!/^[a-f0-9]{64}$/.test(event.sourceSha256)||!Array.isArray(event.media)||event.media.length>4096||new Set(event.media.map(m=>m.id)).size!==event.media.length||Object.keys(event).some(k=>!['type','taskId','sourceSha256','media'].includes(k)))throw new Error('Invalid source requirements');
        for(const m of event.media){if(!Number.isInteger(m.channelCount)||m.channelCount<1||m.channelCount>6)throw new Error('Invalid channel count');if(Object.keys(m).length!==8||Object.keys(m).some(k=>!['id','displayName','sha256','byteLength','sampleRate','frameCount','channelCount','channelLayout'].includes(k)))throw new Error('Invalid source metadata');parseChange({type:'importMedia',media:{...m,sourceRef:'media/source.wav',note:'',channelNotes:Array(m.channelCount).fill(''),categoryId:null,channelCategoryIds:Array(m.channelCount).fill(null)}});}
      }
      if (event.type === 'failed') parseAppError(event.error);
      receive(event);
    };
    return invoke(request.kind === 'import' ? 'import_exchange' : request.kind === 'bundle' ? 'export_bundle' : 'export_annotations', { expected: request.expected, path: request.path, source: request.source, parent: request.parent, bindings:request.bindings, onEvent });
  },
  cancel: (taskId: string) => invoke<void>('cancel_exchange', { taskId }),
};
