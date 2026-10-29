import {act, cleanup, render} from '@testing-library/react';
import {afterEach, expect, it, vi} from 'vitest';
import {emptyPlayback, type PlaybackStatus} from '../../bridge/playback';
import {Playhead} from './Playhead';
import {PlaybackContext} from './usePlayback';
import {defaultView} from '../spectrogram/workspace';
import fixture from '../../../tests/fixtures/document-v3.json';

afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});
function setup(){
 let now=0,id=0;const frames=new Map<number,FrameRequestCallback>();
 vi.spyOn(performance,'now').mockImplementation(()=>now);
 vi.stubGlobal('requestAnimationFrame',(cb:FrameRequestCallback)=>{frames.set(++id,cb);return id;});
 vi.stubGlobal('cancelAnimationFrame',(key:number)=>frames.delete(key));
 const media=fixture.media[0],view={...defaultView(media),startSeconds:0,endSeconds:10};
 let status:PlaybackStatus={...emptyPlayback,generation:1,mediaId:media.id,state:'playing',positionSeconds:1,firstSeconds:0,endSeconds:10,consumedFrames:48000};
 const ui=()=>({status,options:{looping:false}});
 const tree=()=> <PlaybackContext.Provider value={ui() as never}><Playhead mediaId={media.id} view={view}/></PlaybackContext.Provider>;
 const rendered=render(tree());
 return {frame(at:number){now=at;act(()=>{const pending=[...frames.values()];frames.clear();for(const callback of pending)callback(now);});},status(patch:Partial<PlaybackStatus>){status={...status,...patch};rendered.rerender(tree());},seconds(){return parseFloat((document.querySelector('.audio-playhead') as HTMLElement).style.left)/10;}};
}
it('does not move backward when a quantized native progress event trails the displayed cursor',()=>{
 const p=setup();p.frame(50);const displayed=p.seconds();
 p.status({positionSeconds:1.024,consumedFrames:49152});
 expect(p.seconds()).toBeGreaterThanOrEqual(displayed);
 p.frame(60);expect(p.seconds()).toBeGreaterThanOrEqual(displayed);
});
it('retains linked-media visibility and recalculates cursor placement when the viewport zooms',()=>{
 const media=fixture.media[0],status={...emptyPlayback,mediaId:'other',positionSeconds:1.5,endSeconds:10,state:'paused' as const};
 const ui=(linkedTime:boolean)=>({status,options:{looping:false},active:{store:{snapshot:{document:{viewState:{linkedTime}}}}}});
 const tree=(startSeconds:number,linkedTime=true)=><PlaybackContext.Provider value={ui(linkedTime) as never}><Playhead mediaId={media.id} view={{...defaultView(media),startSeconds,endSeconds:2}}/></PlaybackContext.Provider>;
 const rendered=render(tree(0));expect(document.querySelector('.audio-playhead')).toHaveStyle({left:'75%'});
 rendered.rerender(tree(1));expect(document.querySelector('.audio-playhead')).toHaveStyle({left:'50%'});
 rendered.rerender(tree(1,false));expect(document.querySelector('.audio-playhead')).toBeNull();
});
