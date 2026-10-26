import {expect,it,vi} from 'vitest';
const invoked=vi.hoisted(()=>vi.fn());
vi.mock('@tauri-apps/api/core',()=>({invoke:invoked,isTauri:()=>true}));
import {createPlaybackClient,emptyPlayback} from './playback';
const id='11111111-1111-4111-8111-111111111111';
it('binds strict realtime monitor request and response to captured runtime',async()=>{
 const api=createPlaybackClient('owner');
 const request={projectId:id,mediaId:id,generation:9,monitorGainDb:6};
 invoked.mockResolvedValue({...emptyPlayback,projectId:id,mediaId:id,generation:9});
 await api.monitorGain(request);
 expect(invoked).toHaveBeenCalledWith('playback_monitor_gain',{runtimeNonce:'owner',request},undefined);
 for(const patch of [{monitorGainDb:NaN},{monitorGainDb:24.1},{monitorGainDb:-60.1},{generation:-1},{generation:Infinity},{projectId:'invalid'},{extra:1}]) {
  invoked.mockClear();await expect(api.monitorGain({...request,...patch})).rejects.toThrow();expect(invoked).not.toHaveBeenCalled();
 }
 for(const bad of [{...emptyPlayback,unknown:1},{...emptyPlayback,positionSeconds:NaN},{...emptyPlayback,generation:-1},{...emptyPlayback,presentation:{...emptyPlayback.presentation,drained:'yes'}}]) {
  invoked.mockResolvedValue(bad);await expect(api.monitorGain(request)).rejects.toThrow();
 }
 invoked.mockResolvedValue({...emptyPlayback,projectId:id,mediaId:id,generation:10});
 await expect(api.monitorGain(request)).rejects.toThrow();
});
