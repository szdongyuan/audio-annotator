import {useEffect,useRef,useState} from 'react';
import type {MediaView} from '../../bridge/types';
import {usePlaybackContext} from './usePlayback';
export function Playhead({mediaId,view}:{mediaId:string;view:MediaView}){const ui=usePlaybackContext(),status=ui?.status;const anchor=useRef({at:performance.now(),seconds:status?.positionSeconds??0});const[seconds,setSeconds]=useState(anchor.current.seconds);
 useEffect(()=>{anchor.current={at:performance.now(),seconds:status?.positionSeconds??0};setSeconds(anchor.current.seconds);},[status]);
 useEffect(()=>{if(status?.state!=='playing')return;let frame=0;const draw=()=>{const elapsed=Math.min(.1,(performance.now()-anchor.current.at)/1000);let pos=anchor.current.seconds+elapsed;if(ui?.options.looping&&pos>status.endSeconds)pos=status.firstSeconds+(pos-status.firstSeconds)%(status.endSeconds-status.firstSeconds);setSeconds(Math.min(status.endSeconds,pos));frame=requestAnimationFrame(draw);};frame=requestAnimationFrame(draw);return()=>cancelAnimationFrame(frame);},[status,ui?.options.looping]);
 if(!status?.mediaId||(status.mediaId!==mediaId&&!ui?.active?.store.snapshot.document.viewState.linkedTime)||seconds<view.startSeconds||seconds>view.endSeconds)return null;
 return <div className="audio-playhead" aria-label="音频播放指针" style={{left:`${100*(seconds-view.startSeconds)/(view.endSeconds-view.startSeconds)}%`}}/>;
}
