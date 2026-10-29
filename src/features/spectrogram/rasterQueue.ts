/** All channels share one frame budget; twelve canvases must not each consume it. */
const jobs=new Map<object,()=>boolean>();
let frame=0;
function tick(){
 frame=0;const until=performance.now()+6;
 while(jobs.size&&performance.now()<until){
  const [owner,step]=jobs.entries().next().value!;jobs.delete(owner);
  if(!step())jobs.set(owner,step);
 }
 if(jobs.size)frame=requestAnimationFrame(tick);
}
/** A step returns true when complete. Callers own error reporting and cancellation. */
export function scheduleRaster(step:()=>boolean){
 const owner={};jobs.set(owner,step);if(!frame)frame=requestAnimationFrame(tick);
 return ()=>{jobs.delete(owner);if(!jobs.size&&frame){cancelAnimationFrame(frame);frame=0;}};
}
