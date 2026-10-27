import type { MediaView } from '../../bridge/types';
import { usePlaybackContext } from './usePlayback';
export function CueLine({mediaId,view}:{mediaId:string;view:MediaView}) {
 const ui=usePlaybackContext();
 const seconds=ui ? ui.cues?.[mediaId] ?? (ui.status?.mediaId===mediaId ? ui.status.startSeconds : 0) : undefined;
 if(seconds===undefined||seconds<view.startSeconds||seconds>=view.endSeconds)return null;
 return <div className="audio-cue" aria-label="起播定位线" data-seconds={seconds} style={{position:'absolute',top:0,bottom:0,left:`${100*(seconds-view.startSeconds)/(view.endSeconds-view.startSeconds)}%`,width:0,borderLeft:'1px dashed white',pointerEvents:'none',zIndex:4}}/>;
}
