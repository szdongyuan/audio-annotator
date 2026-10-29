import {expect,it} from 'vitest';
import {emptyPlayback,type PlaybackStatus} from '../../bridge/playback';
import {PresentationClock} from './presentationClock';
const playing=(patch:Partial<PlaybackStatus>={}):PlaybackStatus=>({...emptyPlayback,generation:1,mediaId:'media',state:'playing',positionSeconds:1,firstSeconds:0,endSeconds:10,deviceRate:48000,consumedFrames:48000,...patch});

it('bounds prediction during delayed native progress, then catches up without backsteps',()=>{
 const clock=new PresentationClock();clock.accept(playing(),0,false);
 expect(clock.position(150)).toBeCloseTo(1.15);
 expect(clock.position(1000)).toBe(1.25);
 expect(clock.accept(playing({positionSeconds:1.1,consumedFrames:52800}),1000,false)).toBe(1.25);
 expect(clock.accept(playing({positionSeconds:1.5,consumedFrames:72000}),1100,false)).toBe(1.5);
});
it('honors pause, resume/seek generations, owner replacement and native end exactly',()=>{
 const clock=new PresentationClock();clock.accept(playing(),0,false);clock.position(100);
 expect(clock.accept(playing({state:'paused',positionSeconds:1.08}),100,false)).toBe(1.08);
 expect(clock.position(5000)).toBe(1.08);
 expect(clock.accept(playing({generation:2,positionSeconds:1.08}),5000,false)).toBe(1.08);
 expect(clock.position(5100)).toBeCloseTo(1.18);
 expect(clock.accept(playing({generation:3,positionSeconds:.5}),5100,false)).toBe(.5);
 expect(clock.accept(playing({mediaId:'replacement',positionSeconds:.2}),5100,false)).toBe(.2);
 expect(clock.accept(playing({state:'ended',positionSeconds:10}),5200,false)).toBe(10);
 expect(clock.position(10000)).toBe(10);
});
it('waits for native loop confirmation and stays inside the selection range',()=>{
 const clock=new PresentationClock(),status=playing({firstSeconds:2,endSeconds:3,positionSeconds:2.98});
 clock.accept(status,0,true);expect(clock.position(100)).toBe(3);
 expect(clock.accept({...status,positionSeconds:2.04,consumedFrames:50880},100,true)).toBe(2.04);
 expect(clock.position(200)).toBeCloseTo(2.14);
});
it('recognizes complete short loops even when the next native position is higher',()=>{
 const clock=new PresentationClock(),status=playing({firstSeconds:2,endSeconds:2.02,positionSeconds:2.005});
 clock.accept(status,0,true);expect(clock.position(30)).toBe(2.02);
 expect(clock.accept({...status,positionSeconds:2.015,consumedFrames:49440},30,true)).toBe(2.015);
});
