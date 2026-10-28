import {useEffect,useRef,useState} from 'react';
import type {MediaView} from '../../bridge/types';
import {usePlaybackContext} from './usePlayback';
import {PresentationClock} from './presentationClock';
import {usePlaybackStatus} from './statusStore';
export function Playhead({mediaId,view}:{mediaId:string;view:MediaView}){const ui=usePlaybackContext(),status=usePlaybackStatus(ui);const clock=useRef(new PresentationClock());const[seconds,setSeconds]=useState(status.positionSeconds);
 useEffect(()=>{if(status)setSeconds(clock.current.accept(status,performance.now(),!!ui?.options.looping));},[status,ui?.options.looping]);
 useEffect(()=>{if(status?.state!=='playing')return;let frame=0;const draw=()=>{setSeconds(clock.current.position(performance.now()));frame=requestAnimationFrame(draw);};frame=requestAnimationFrame(draw);return()=>cancelAnimationFrame(frame);},[status?.state]);
 if(!status?.mediaId||(status.mediaId!==mediaId&&!ui?.active?.store.snapshot.document.viewState.linkedTime)||seconds<view.startSeconds||seconds>view.endSeconds)return null;
 return <div className="audio-playhead" aria-label="音频播放指针" style={{left:`${100*(seconds-view.startSeconds)/(view.endSeconds-view.startSeconds)}%`}}/>;
}
