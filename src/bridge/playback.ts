import { runtimeInvoke } from './runtimeInvoke';
import { isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {parseAppError, type AppError,type Region } from './types';
export type AuditionMode='original'|'processed'|'selection';
export type SelectionSource='original'|'processed';
export interface PlaybackOptions { mode:AuditionMode;selectionSource:SelectionSource;bypass:boolean;looping:boolean;volume:number;deviceId:string|null }
export interface OutputDevice {id:string;name:string;isDefault:boolean}
export interface PresentationStatus {ringExhausted:boolean;scheduledFrames:number;callbackNanos:number|null;tailNanos:number|null;ringExhaustedNanos:number|null;pendingTailFrames:number;tailNonSilent:boolean;drained:boolean}
export interface PlaybackStatus { generation:number;projectId:string|null;mediaId:string|null;state:'stopped'|'buffering'|'playing'|'paused'|'ended'|'error';positionSeconds:number;startSeconds:number;firstSeconds:number;endSeconds:number;consumedFrames:number;presentation:PresentationStatus;underrunFrames:number;deviceName:string|null;deviceRate:number;deviceChannels:number;error:AppError|null }
export interface PlaybackRequest {projectId:string;mediaId:string;mode:{mode:'original'|'processed'}|{mode:'selection';region:Region;selectionSource:SelectionSource};bypass:boolean;looping:boolean;volume:number;monitorGainDb:number;deviceId:string|null;seekSeconds:number|null;play:boolean}
export const emptyPlayback:PlaybackStatus={generation:0,projectId:null,mediaId:null,state:'stopped',positionSeconds:0,startSeconds:0,firstSeconds:0,endSeconds:0,consumedFrames:0,presentation:{ringExhausted:false,scheduledFrames:0,callbackNanos:null,tailNanos:null,ringExhaustedNanos:null,pendingTailFrames:0,tailNonSilent:false,drained:false},underrunFrames:0,deviceName:null,deviceRate:0,deviceChannels:0,error:null};
export interface MonitorGainRequest {projectId:string;mediaId:string;generation:number;monitorGainDb:number}
const requireValid=(value:unknown)=>{if(!value)throw new Error('Invalid playback boundary');};
const object=(value:unknown,keys:string[])=>{requireValid(value!==null&&typeof value==='object'&&!Array.isArray(value));const v=value as Record<string,unknown>;requireValid(Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k)));return v;};
const nonnegative=(v:unknown)=>requireValid(typeof v==='number'&&Number.isFinite(v)&&v>=0);
const integer=(v:unknown)=>{nonnegative(v);requireValid(Number.isSafeInteger(v));};
const uuid=(v:unknown)=>requireValid(typeof v==='string'&&/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(v)&&v!=='00000000-0000-0000-0000-000000000000');
export function validMonitorGain(db:number){return Number.isFinite(db)&&db>=-60&&db<=24;}
export function parseMonitorGainRequest(value:unknown):MonitorGainRequest {
 const v=object(value,['projectId','mediaId','generation','monitorGainDb']);uuid(v.projectId);uuid(v.mediaId);integer(v.generation);requireValid(validMonitorGain(v.monitorGainDb as number));return value as MonitorGainRequest;
}
export function parsePlaybackStatus(value:unknown):PlaybackStatus {
 const v=object(value,Object.keys(emptyPlayback));integer(v.generation);
 for(const key of ['projectId','mediaId'])if(v[key]!==null)uuid(v[key]);
 requireValid(['stopped','buffering','playing','paused','ended','error'].includes(v.state as string));
 for(const key of ['positionSeconds','startSeconds','firstSeconds','endSeconds'])nonnegative(v[key]);
 for(const key of ['consumedFrames','underrunFrames','deviceRate','deviceChannels'])integer(v[key]);
 requireValid(v.deviceName===null||typeof v.deviceName==='string');if(v.error!==null)parseAppError(v.error);
 const timing=object(v.presentation,Object.keys(emptyPlayback.presentation));
 for(const key of ['ringExhausted','tailNonSilent','drained'])requireValid(typeof timing[key]==='boolean');
 for(const key of ['scheduledFrames','pendingTailFrames'])integer(timing[key]);
 for(const key of ['callbackNanos','tailNanos','ringExhaustedNanos'])if(timing[key]!==null)integer(timing[key]);
 return value as PlaybackStatus;
}
export function createPlaybackClient(runtimeNonce?: string) {
 const invoke = runtimeInvoke(runtimeNonce);
return {
 available:isTauri,
 devices:()=>invoke<OutputDevice[]>('playback_devices'),
 configure:async(request:PlaybackRequest)=>{requireValid(validMonitorGain(request.monitorGainDb));return parsePlaybackStatus(await invoke<unknown>('playback_configure',{request}));},
 monitorGain:async(request:MonitorGainRequest)=>{parseMonitorGainRequest(request);const status=parsePlaybackStatus(await invoke<unknown>('playback_monitor_gain',{request}));requireValid(status.projectId===request.projectId&&status.mediaId===request.mediaId&&status.generation===request.generation);return status;},
 control:(action:'pause'|'stop'|'reset')=>invoke<PlaybackStatus>('playback_control',{action}),
 listen:(callback:(status:PlaybackStatus)=>void)=>listen<PlaybackStatus>('playback-progress',event=>callback(event.payload)),
};

}
export const playbackClient = createPlaybackClient();
