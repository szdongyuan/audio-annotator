import { retryAdmission } from './admission';
import { exchangeClient } from './exchange';
import fixture from '../../tests/fixtures/document-v3.json';
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
 it('creates collaboration copies using the selected native profile without credentials',async()=>{
  invoked.mockClear();invoked.mockRejectedValue({code:'Cancelled',message:'test boundary',retryable:true});const id='11111111-1111-4111-8111-111111111111';
  await collaborationClient.create({runtimeNonce:id,projectId:id,expectedRevision:0},id,'target',()=>{}).catch(()=>{});
  expect(invoked).toHaveBeenCalledWith('collaboration_create',{expected:{runtimeNonce:id,projectId:id,expectedRevision:0},operationId:id,target:'target',onProgress:expect.anything()});
 });
});

it.each(['media','copy','exchange'] as const)('busy %s retry allocates a fresh Channel and delivers progress plus terminal/result',async kind=>{
 invoked.mockReset();const channels:unknown[]=[];const events:unknown[]=[];const api=createRuntimeCommands('actor-a');
 invoked.mockImplementation(async(_command,args)=>{const channel=args.onEvent??args.onProgress;channels.push(channel);if(channels.length===1)throw{code:'ResourceLimit',message:'busy',retryable:true,details:{operationBusy:true}};
 if(kind==='copy'){channel.onmessage({operationId:'11111111-1111-4111-8111-111111111111',phase:'copyMedia',completed:42});return {snapshot:{document:fixture,canUndo:false,canRedo:false},persistedRevision:0,recovery:null,path:'target'};}
 channel.onmessage({type:'progress',taskId:'new',index:0,path:'a.wav',phase:'copyMedia',completed:42});channel.onmessage(kind==='media'?{type:'finished',taskId:'new',cancelled:false}:{type:'completed',taskId:'new',path:'target',opened:null});return 'new';});
 await retryAdmission<unknown>(()=>kind==='media'?api.media.start(fixture.projectId,['a.wav'],e=>events.push(e),undefined):kind==='copy'?api.projects.saveAs('target',fixture.projectId,0,{operationId:'11111111-1111-4111-8111-111111111111',onProgress:p=>events.push(p)}):exchangeClient.start({kind:'import',expected:null,source:'share.json',parent:'target'},e=>events.push(e)));
 expect(channels).toHaveLength(2);expect(channels[0]).not.toBe(channels[1]);expect(events).toHaveLength(kind==='copy'?1:2);expect(events[0]).toMatchObject({phase:'copyMedia',completed:42});
});
