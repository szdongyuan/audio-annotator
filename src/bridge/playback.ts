import { runtimeInvoke } from './runtimeInvoke';
import { isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { AppError,Region } from './types';
export type AuditionMode='original'|'processed'|'selection';
export type SelectionSource='original'|'processed';
export interface PlaybackOptions { mode:AuditionMode;selectionSource:SelectionSource;bypass:boolean;looping:boolean;volume:number;deviceId:string|null }
export interface OutputDevice {id:string;name:string;isDefault:boolean}
export interface PresentationStatus {ringExhausted:boolean;scheduledFrames:number;callbackNanos:number|null;tailNanos:number|null;ringExhaustedNanos:number|null;pendingTailFrames:number;tailNonSilent:boolean;drained:boolean}
export interface PlaybackStatus { generation:number;projectId:string|null;mediaId:string|null;state:'stopped'|'buffering'|'playing'|'paused'|'ended'|'error';positionSeconds:number;startSeconds:number;firstSeconds:number;endSeconds:number;consumedFrames:number;presentation:PresentationStatus;underrunFrames:number;deviceName:string|null;deviceRate:number;deviceChannels:number;error:AppError|null }
export interface PlaybackRequest {projectId:string;mediaId:string;mode:{mode:'original'|'processed'}|{mode:'selection';region:Region;selectionSource:SelectionSource};bypass:boolean;looping:boolean;volume:number;deviceId:string|null;seekSeconds:number|null;play:boolean}
export const emptyPlayback:PlaybackStatus={generation:0,projectId:null,mediaId:null,state:'stopped',positionSeconds:0,startSeconds:0,firstSeconds:0,endSeconds:0,consumedFrames:0,presentation:{ringExhausted:false,scheduledFrames:0,callbackNanos:null,tailNanos:null,ringExhaustedNanos:null,pendingTailFrames:0,tailNonSilent:false,drained:false},underrunFrames:0,deviceName:null,deviceRate:0,deviceChannels:0,error:null};
export function createPlaybackClient(runtimeNonce?: string) {
 const invoke = runtimeInvoke(runtimeNonce);
return {
 available:isTauri,
 devices:()=>invoke<OutputDevice[]>('playback_devices'),
 configure:(request:PlaybackRequest)=>invoke<PlaybackStatus>('playback_configure',{request}),
 control:(action:'pause'|'stop'|'reset')=>invoke<PlaybackStatus>('playback_control',{action}),
 listen:(callback:(status:PlaybackStatus)=>void)=>listen<PlaybackStatus>('playback-progress',event=>callback(event.payload)),
};

}
export const playbackClient = createPlaybackClient();
