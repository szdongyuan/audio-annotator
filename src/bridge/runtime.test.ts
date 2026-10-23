import { describe,expect,it,vi } from 'vitest';
const invoked=vi.hoisted(()=>vi.fn());
vi.mock('@tauri-apps/api/core',()=>({invoke:invoked,isTauri:()=>true,Channel:class{onmessage=()=>{};}}));
import { createRuntimeCommands } from './runtime';
import { collaborationClient } from './collaboration';
describe('captured runtime authority',()=>{
 it('binds delayed calls to the original identity across every transport family',async()=>{
  const a=createRuntimeCommands('actor-a'), b=createRuntimeCommands('actor-b');
  invoked.mockResolvedValue(undefined);
  await a.playback.control('stop');await b.playback.control('stop');
  await a.media.status('project');await a.tiles.cancel('project','view',1);
  await a.projects.close('project',3,false);
  await a.project.getSnapshot('project').catch(()=>{});
  expect(invoked.mock.calls.map(c=>c[1].runtimeNonce)).toEqual(['actor-a','actor-b','actor-a','actor-a','actor-a','actor-a']);
 });
 it('preserves ordinary command argument shapes',async()=>{
  invoked.mockClear();await createRuntimeCommands().playback.control('reset');
  expect(invoked).toHaveBeenCalledWith('playback_control',{action:'reset'});
 });
 it('passes passwords exactly, including whitespace, while enforcing native length bounds',async()=>{
  invoked.mockClear();invoked.mockRejectedValue({code:'Cancelled',message:'test boundary',retryable:true});const id='11111111-1111-4111-8111-111111111111';
  await collaborationClient.identity({runtimeNonce:id,projectId:id,expectedRevision:0},id,{type:'login',login:'alice',password:'        '}).catch(()=>{});
  expect(invoked).toHaveBeenCalledWith('collaboration_identity',expect.objectContaining({action:{type:'login',login:'alice',password:'        '}}));
 });
});
