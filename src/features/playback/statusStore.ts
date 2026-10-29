import {useSyncExternalStore} from 'react';
import {emptyPlayback, type PlaybackStatus} from '../../bridge/playback';

const controlFields=['generation','projectId','mediaId','state','startSeconds','firstSeconds','endSeconds','deviceName','deviceRate','deviceChannels','error'] as const;
export const samePlaybackControl=(a:PlaybackStatus,b:PlaybackStatus)=>controlFields.every(key=>a[key]===b[key]);

/** Progress has a narrow subscription; transport/owner changes still render the workspace. */
export class PlaybackStatusStore {
 private status=emptyPlayback;
 private listeners=new Set<()=>void>();
 getSnapshot=()=>this.status;
 subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
 publish(status:PlaybackStatus){this.status=status;for(const listener of this.listeners)listener();}
}

const idleSubscribe=()=>()=>{};
export function usePlaybackStatus(ui:{status:PlaybackStatus;statusStore?:PlaybackStatusStore}|null){
 return useSyncExternalStore(ui?.statusStore?.subscribe??idleSubscribe,ui?.statusStore?.getSnapshot??(()=>ui?.status??emptyPlayback));
}
