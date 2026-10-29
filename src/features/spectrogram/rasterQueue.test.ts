import {afterEach,expect,it,vi} from 'vitest';
import {scheduleRaster} from './rasterQueue';
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
it('shares one frame budget across channels, rotates fairly and cancels obsolete work',()=>{
 let now=0,id=0;const frames=new Map<number,FrameRequestCallback>(),seen:number[]=[];
 vi.spyOn(performance,'now').mockImplementation(()=>now);
 vi.stubGlobal('requestAnimationFrame',(f:FrameRequestCallback)=>{frames.set(++id,f);return id;});
 vi.stubGlobal('cancelAnimationFrame',(n:number)=>frames.delete(n));
 const cancel=Array.from({length:12},(_,n)=>scheduleRaster(()=>{seen.push(n);now+=2;return false;}));
 const frame=()=>{const fs=[...frames.values()];frames.clear();for(const f of fs)f(now);};
 expect(frames.size).toBe(1);frame();expect(seen).toEqual([0,1,2]);
 cancel[3]();frame();expect(seen).toEqual([0,1,2,4,5,6]);
 cancel.forEach(f=>f());expect(frames.size).toBe(0);frame();expect(seen).toHaveLength(6);
 const done=vi.fn(()=>true);scheduleRaster(done);frame();expect(done).toHaveBeenCalledOnce();expect(frames.size).toBe(0);
});
