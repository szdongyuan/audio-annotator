import { Channel, invoke } from '@tauri-apps/api/core';
import { organizationCheck as check, organizationShape as shape, organizationUuid as uuid } from './organization';
import { open, save } from '@tauri-apps/plugin-dialog';
import { parseOpened, type OpenedProject } from './projects';
import { parseAppError, parseChange, type MediaDescriptor, type AppError } from './types';
export interface ExportPathChange {kind:'folder'|'media';id:string;originalPath:string;plannedPath:string}
export interface ExportPreview {token:string;runtimeNonce:string;projectId:string;documentRevision:number;organizationRevision:number|null;bundle:boolean;preserveFolders:boolean;directories:string[];mediaPaths:Record<string,string>;changes:ExportPathChange[]}
const integer=(v:unknown)=>check(Number.isSafeInteger(v)&&(v as number)>=0);
const boolean=(v:unknown)=>check(typeof v==='boolean');
function path(v:unknown,directory:boolean){
 check(typeof v==='string'&&v.length<=240&&v.startsWith('audio/')&&v.endsWith('/')===directory&&!/[\\\x00-\x1f\x7f-\x9f<>:"|?*]/.test(v));
 for(const part of (v as string).replace(/\/$/,'').split('/')){
  const stem=part.split('.')[0].toUpperCase();
  check(part!==''&&part!=='.'&&part!=='..'&&!/[. ]$/.test(part)&&!['CON','PRN','AUX','NUL'].includes(stem)&&!/^(COM|LPT)[1-9¹²³]$/.test(stem));
 }
}
export function parseExportPreview(value:unknown):ExportPreview {
 shape(value,{token:uuid,runtimeNonce:uuid,projectId:uuid,documentRevision:integer,organizationRevision:v=>{if(v!==null)integer(v);},bundle:boolean,preserveFolders:boolean,
 directories:v=>{check(Array.isArray(v)&&v.length<=10001);v.forEach(p=>path(p,true));},
 mediaPaths:v=>{check(v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length<=10000);for(const [id,p] of Object.entries(v as Record<string,unknown>)){uuid(id);path(p,false);}},
 changes:v=>{check(Array.isArray(v)&&v.length<=20000);for(const c of v)shape(c,{kind:k=>check(k==='folder'||k==='media'),id:uuid,originalPath:p=>check(typeof p==='string'&&p.length<=8192&&p.startsWith('audio/')&&!/[\\\x00-\x1f\x7f-\x9f]/.test(p)),plannedPath:p=>path(p,(c as ExportPathChange).kind==='folder')});}});
 const p=value as ExportPreview;
 const paths=[...p.directories,...Object.values(p.mediaPaths)].map(s=>s.replace(/\/$/,'').toLowerCase());check(new Set(paths).size===paths.length);
 check(p.bundle ? p.directories.includes('audio/')&&(p.preserveFolders||p.directories.length===1) : p.directories.length===0&&Object.keys(p.mediaPaths).length===0&&p.changes.length===0);
 const declared=new Set(p.directories);for(const full of [...p.directories.filter(d=>d!=='audio/'),...Object.values(p.mediaPaths)]){const plain=full.replace(/\/$/,'');check(declared.has(plain.slice(0,plain.lastIndexOf('/')+1)));}
 const changed=new Set<string>();for(const c of p.changes){const key=c.kind+c.id;check(!changed.has(key)&&c.originalPath!==c.plannedPath);changed.add(key);check(c.kind==='folder'?p.directories.includes(c.plannedPath):p.mediaPaths[c.id]===c.plannedPath);}
 return p;
}
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
export interface ExchangeRequest { kind: ExchangeKind; expected: ExpectedProject | null; path?: string; source?: string; parent?: string;bindings?:SourceBindings;preserveFolders?:boolean;previewToken?:string }
export const exchangeClient = {
  preview: async(expected:ExpectedProject,bundle:boolean,preserveFolders=true):Promise<ExportPreview>=>{
    const p=parseExportPreview(await invoke('export_path_preview',{expected,bundle,preserveFolders}));
    check(p.projectId===expected.projectId&&p.documentRevision===expected.expectedRevision&&(!expected.runtimeNonce||p.runtimeNonce===expected.runtimeNonce)&&p.bundle===bundle&&p.preserveFolders===preserveFolders);
    return p;
  },
  start: async (request: ExchangeRequest, receive: (event: ExchangeEvent) => void): Promise<string> => {
    let previewToken=request.previewToken;
    if(request.kind!=='import'){
      check(request.expected!==null);
      if(!previewToken)previewToken=(await exchangeClient.preview(request.expected,request.kind==='bundle',request.preserveFolders??true)).token;
      uuid(previewToken);
    }
    const onEvent = new Channel<ExchangeEvent>();
    onEvent.onmessage = event => {
      if (typeof event.taskId !== 'string') throw new Error('Invalid exchange task');
      if (event.type === 'completed') { if (typeof event.path !== 'string') throw new Error('Invalid result path'); if (event.opened) event.opened = parseOpened(event.opened); }
      if(event.type==='sourcesRequired'){
        if(!/^[a-f0-9]{64}$/.test(event.sourceSha256)||!Array.isArray(event.media)||event.media.length>10000||new Set(event.media.map(m=>m.id)).size!==event.media.length||Object.keys(event).some(k=>!['type','taskId','sourceSha256','media'].includes(k)))throw new Error('Invalid source requirements');
        for(const m of event.media){if(!Number.isInteger(m.channelCount)||m.channelCount<1||m.channelCount>6)throw new Error('Invalid channel count');if(Object.keys(m).length!==8||Object.keys(m).some(k=>!['id','displayName','sha256','byteLength','sampleRate','frameCount','channelCount','channelLayout'].includes(k)))throw new Error('Invalid source metadata');parseChange({type:'importMedia',media:{...m,sourceRef:'media/source.wav',note:'',channelNotes:Array(m.channelCount).fill(''),categoryIds:[],channelCategoryIds:Array.from({length:m.channelCount},()=>[])}});}
      }
      if (event.type === 'failed') parseAppError(event.error);
      receive(event);
    };
    return invoke(request.kind === 'import' ? 'import_exchange' : request.kind === 'bundle' ? 'export_bundle' : 'export_annotations', { expected: request.expected, path: request.path, source: request.source, parent: request.parent, bindings:request.bindings, previewToken, onEvent });
  },
  cancel: (taskId: string) => invoke<void>('cancel_exchange', { taskId }),
};
