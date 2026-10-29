import {emptyPlayback, type PlaybackStatus} from '../../bridge/playback';

/** Native progress is a quantized sample, not a fresh visual anchor. */
export class PresentationClock {
 private status:PlaybackStatus=emptyPlayback;
 private at=0;
 private displayed=0;

 accept(status:PlaybackStatus,now:number,looping:boolean){
  const previous=this.status;
  const continuous=previous.state==='playing'&&status.state==='playing'&&previous.generation===status.generation&&previous.mediaId===status.mediaId&&previous.projectId===status.projectId;
  const consumed=status.consumedFrames-previous.consumedFrames;
  const crossedEnd=status.deviceRate>0&&consumed/status.deviceRate>=previous.endSeconds-previous.positionSeconds;
  const wrapped=continuous&&looping&&consumed>0&&(status.positionSeconds<previous.positionSeconds||crossedEnd);
  this.status=status;this.at=now;
  if(!continuous||wrapped)this.displayed=status.positionSeconds;
  return this.position(now);
 }

 position(now:number){
  const status=this.status;
  // Extrapolate at most 250 ms while waiting for native confirmation. Never
  // predict a loop wrap: only a native position wrap starts the next pass.
  const elapsed=status.state==='playing'?Math.min(.25,Math.max(0,now-this.at)/1000):0;
  const predicted=status.positionSeconds+elapsed;
  this.displayed=Math.max(status.firstSeconds,Math.min(status.endSeconds,Math.max(this.displayed,predicted)));
  return this.displayed;
 }
}
