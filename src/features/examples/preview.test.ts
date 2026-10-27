import { expect, it, vi } from 'vitest';
import { ExamplePreviewSession } from './preview';
import { emptyPlayback } from '../../bridge/playback';
import type { PreviewAPI, PreviewResult, ExampleEntry } from '../../bridge/examples';
import fixture from '../../../tests/fixtures/document-v3.json';
import { parseProjectDocument } from '../../bridge/types';
import { defaultSettings } from '../spectrogram/workspace';
const b={runtimeNonce:'11111111-1111-4111-8111-111111111111',projectId:'22222222-2222-4222-8222-222222222222',actorId:null};
const snapshot={document:parseProjectDocument(fixture),canUndo:false,canRedo:false};
const entry={sampleId:b.runtimeNonce,projectId:b.projectId,creatorId:b.runtimeNonce,scope:'shared',name:'NG1',revision:1,originalFilename:'ng.wav',media:snapshot.document.media[0]} satisfies ExampleEntry;
function fake(){return{open:vi.fn(async()=>({previewId:b.runtimeNonce,snapshot})),close:vi.fn(async()=>{}),cancelOpen:vi.fn(async()=>{}),configure:vi.fn(async()=>emptyPlayback),control:vi.fn(async()=>emptyPlayback),playbackStatus:vi.fn(async()=>emptyPlayback),status:vi.fn(async()=>[]),tiles:vi.fn(()=>({register:vi.fn(),retire:vi.fn(),cancel:vi.fn(),request:vi.fn()}))} as PreviewAPI;}
it('cancels pending open with its fresh request ID, closes a late response and never publishes it',async()=>{
 const api=fake();let resolve!:(r:PreviewResult)=>void;vi.mocked(api.open).mockReturnValue(new Promise(r=>resolve=r));const stop=vi.fn();const session=new ExamplePreviewSession(b,api);
 const pending=session.open(entry,defaultSettings,stop);await Promise.resolve();const id=vi.mocked(api.open).mock.calls[0][3];expect(id).toMatch(/^[0-9a-f-]{36}$/);expect(stop).toHaveBeenCalledOnce();session.dispose();expect(api.cancelOpen).toHaveBeenCalledWith(b,id);
 resolve({previewId:b.runtimeNonce,snapshot});await pending;expect(api.close).toHaveBeenCalledWith(b,b.runtimeNonce);expect(session.result).toBeNull();
});
it('superseded opens have separate cancellation IDs and only newest response survives',async()=>{
 const api=fake();const resolves:((r:PreviewResult)=>void)[]=[];vi.mocked(api.open).mockImplementation(()=>new Promise(r=>resolves.push(r)));const s=new ExamplePreviewSession(b,api);
 const first=s.open(entry,defaultSettings,vi.fn());await Promise.resolve();const second=s.open(entry,defaultSettings,vi.fn());await Promise.resolve();expect(vi.mocked(api.open).mock.calls[0][3]).not.toBe(vi.mocked(api.open).mock.calls[1][3]);
 resolves[1]({previewId:b.projectId,snapshot});await second;resolves[0]({previewId:b.runtimeNonce,snapshot});await first;expect(s.result?.previewId).toBe(b.projectId);expect(api.close).toHaveBeenCalledWith(b,b.runtimeNonce);s.dispose();expect(api.close).toHaveBeenCalledWith(b,b.projectId);
});
it('plays and seeks original audio with private global gain/volume/device/loop and filters progress by transient project',async()=>{
 const api=fake(),s=new ExamplePreviewSession(b,api);await s.open(entry,defaultSettings,vi.fn());const settings={monitorGainDb:7,volume:.4,deviceId:'usb',looping:true};await s.play(settings,1.25);
 expect(api.configure).toHaveBeenCalledWith(b,b.runtimeNonce,expect.objectContaining({projectId:snapshot.document.projectId,mediaId:entry.media.id,mode:{mode:'original'},bypass:false,play:true,seekSeconds:1.25,...settings}));
 s.progress({...emptyPlayback,projectId:b.projectId,state:'playing',positionSeconds:4});expect(s.status.positionSeconds).toBe(0);
 s.progress({...emptyPlayback,projectId:snapshot.document.projectId,mediaId:entry.media.id,state:'playing',positionSeconds:2});expect(s.status.positionSeconds).toBe(2);
 await s.pause();expect(api.control).toHaveBeenCalledWith(b,b.runtimeNonce,'pause');s.dispose();expect(api.close).toHaveBeenCalledOnce();
});
it('publishes open errors and allows retry',async()=>{
 const api=fake(),s=new ExamplePreviewSession(b,api);vi.mocked(api.open).mockRejectedValueOnce({code:'MissingMedia',message:'示例音频缺失',retryable:true});await s.open(entry,defaultSettings,vi.fn());expect(s.loading).toBe(false);expect(s.error).toBe('示例音频缺失');await s.open(entry,defaultSettings,vi.fn());expect(s.result).not.toBeNull();expect(s.error).toBeNull();s.dispose();
});
it('replays an ended event arriving before configure acknowledgement instead of remaining buffering',async()=>{
 const api=fake(),s=new ExamplePreviewSession(b,api);await s.open(entry,defaultSettings,vi.fn());let resolve!:(r:typeof emptyPlayback)=>void;vi.mocked(api.configure).mockReturnValue(new Promise(r=>resolve=r));
 const pending=s.play({monitorGainDb:0,volume:.75,deviceId:null,looping:false});await Promise.resolve();await Promise.resolve();const event={...emptyPlayback,generation:3,projectId:snapshot.document.projectId,mediaId:entry.media.id,state:'ended' as const,positionSeconds:.1};s.progress(event);resolve({...event,state:'buffering',positionSeconds:0});await pending;expect(s.status.state).toBe('ended');expect(s.status.positionSeconds).toBe(.1);s.dispose();
});
it('does not publish an obsolete control failure over a newer playback intent',async()=>{
 const api=fake(),s=new ExamplePreviewSession(b,api);await s.open(entry,defaultSettings,vi.fn());let reject!:(e:unknown)=>void;vi.mocked(api.control).mockReturnValue(new Promise((_r,j)=>reject=j));const pause=s.pause();await Promise.resolve();await Promise.resolve();
 const play=s.play({monitorGainDb:0,volume:.5,deviceId:null,looping:false});reject({code:'DeviceFailed',message:'旧暂停失败',retryable:true});await Promise.all([pause,play]);expect(s.error).toBeNull();s.dispose();
});
it('does not submit or cancel a native opening after closing while waiting for main output handoff',async()=>{
 const api=fake(),s=new ExamplePreviewSession(b,api);let resolve!:()=>void;const stopped=new Promise<void>(r=>resolve=r),opening=s.open(entry,defaultSettings,()=>stopped);s.dispose();resolve();await opening;expect(api.open).not.toHaveBeenCalled();expect(api.cancelOpen).not.toHaveBeenCalled();expect(s.result).toBeNull();
});
const playbackSettings={monitorGainDb:0,volume:.75,deviceId:null,looping:false};
const ownedStatus=(generation:number,state:typeof emptyPlayback.state)=>({...emptyPlayback,projectId:snapshot.document.projectId,mediaId:entry.media.id,generation,state});
it('keeps playing seeks playing through buffering and clears intent on stop and close',async()=>{
 const api=fake(),s=new ExamplePreviewSession(b,api);await s.open(entry,defaultSettings,vi.fn());
 vi.mocked(api.configure).mockResolvedValue(ownedStatus(2,'buffering'));await s.play(playbackSettings);await s.seek(playbackSettings,.1);await s.seek(playbackSettings,.2);
 expect(vi.mocked(api.configure).mock.calls.map(call=>call[2].play)).toEqual([true,true,true]);expect(s.wantsPlayback).toBe(true);
 await s.stop();expect(s.wantsPlayback).toBe(false);await s.seek(playbackSettings,.3);expect(vi.mocked(api.configure).mock.lastCall?.[2].play).toBe(false);
 await s.play(playbackSettings);expect(s.wantsPlayback).toBe(true);s.dispose();expect(s.wantsPlayback).toBe(false);expect(api.close).toHaveBeenCalledOnce();
});
it('pause during configure clears intent immediately and the queued seek stays paused',async()=>{
 const api=fake(),s=new ExamplePreviewSession(b,api);await s.open(entry,defaultSettings,vi.fn());let resolve!:(r:typeof emptyPlayback)=>void;
 vi.mocked(api.configure).mockReturnValueOnce(new Promise(r=>resolve=r)).mockResolvedValue(ownedStatus(4,'buffering'));vi.mocked(api.control).mockResolvedValue(ownedStatus(3,'paused'));
 const playing=s.play(playbackSettings);await Promise.resolve();await Promise.resolve();const paused=s.pause();expect(s.wantsPlayback).toBe(false);
 s.progress(ownedStatus(3,'playing'));resolve(ownedStatus(3,'buffering'));await Promise.all([playing,paused]);expect(s.wantsPlayback).toBe(false);
 await s.seek(playbackSettings,.5);expect(vi.mocked(api.configure).mock.lastCall?.[2].play).toBe(false);s.dispose();
});
it.each(['ended','error'] as const)('an old %s cannot clear a newer pending intent or publish after close',async state=>{
 const api=fake(),s=new ExamplePreviewSession(b,api);await s.open(entry,defaultSettings,vi.fn());vi.mocked(api.configure).mockResolvedValueOnce(ownedStatus(3,'playing'));await s.play(playbackSettings);
 let resolve!:(r:typeof emptyPlayback)=>void;vi.mocked(api.configure).mockReturnValueOnce(new Promise(r=>resolve=r));const seeking=s.seek(playbackSettings,.5);await Promise.resolve();await Promise.resolve();
 s.progress(ownedStatus(3,state));expect(s.wantsPlayback).toBe(true);resolve(ownedStatus(4,'buffering'));await seeking;expect(s.wantsPlayback).toBe(true);
 s.progress(ownedStatus(3,state));expect(s.wantsPlayback).toBe(true);s.progress(ownedStatus(4,state));expect(s.wantsPlayback).toBe(false);
 vi.mocked(api.configure).mockReturnValueOnce(new Promise(r=>resolve=r));const last=s.play(playbackSettings);await Promise.resolve();await Promise.resolve();expect(s.wantsPlayback).toBe(true);s.dispose();resolve(ownedStatus(5,'playing'));await last;expect(s.wantsPlayback).toBe(false);expect(s.result).toBeNull();
});
