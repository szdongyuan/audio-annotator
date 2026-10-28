import { act, renderHook, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { ExamplePreviewSession } from './preview';
import { exampleClient, type ExampleEntry } from '../../bridge/examples';
import { usePlayback } from '../playback/usePlayback';
import { emptyPlayback, type PlaybackStatus, type PlaybackRequest } from '../../bridge/playback';
import { ProjectStore } from '../../app/store';
import { CommandQueue } from '../../app/commands';
import { ProjectLifecycle } from '../project/lifecycle';
import { parseProjectDocument } from '../../bridge/types';
import type { ActiveProject } from '../project/useProjectLifecycle';
import { defaultSettings } from '../spectrogram/workspace';
import fixture from '../../../tests/fixtures/document-v3.json';
function deferred<T>(){let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>resolve=r);return{resolve,promise};}
it('waits for outstanding main configure and the acknowledged queued stop before opening a sample',async()=>{
 const doc=parseProjectDocument(fixture),media=doc.media[0],store=new ProjectStore({document:doc,canUndo:false,canRedo:false});
 const queue=new CommandQueue(store,{applyChange:vi.fn(),getSnapshot:async()=>store.snapshot,undo:vi.fn(),redo:vi.fn()});
 const lifecycle=new ProjectLifecycle(store,queue,{save:async(_id,r)=>r,close:async()=>{}}),active:ActiveProject={store,queue,lifecycle,path:''};
 const configured=deferred<PlaybackStatus>(),stopped=deferred<PlaybackStatus>();let output='stopped';const events:string[]=[];
 const main={available:()=>true,devices:async()=>[],listen:async()=>()=>{},configure:vi.fn((_r:PlaybackRequest)=>configured.promise),control:vi.fn(async(action:string)=>{if(action==='stop'){events.push('main-stop-issued');const result=await stopped.promise;output='stopped';events.push('main-stop-ack');return result;}return emptyPlayback;})};
 const hook=renderHook(()=>usePlayback(active,media.id,undefined,main));await act(async()=>{});act(()=>hook.result.current.toggle());await waitFor(()=>expect(main.configure).toHaveBeenCalledOnce());
 const binding={runtimeNonce:'11111111-1111-4111-8111-111111111111',projectId:doc.projectId},entry={sampleId:binding.runtimeNonce,projectId:doc.projectId,creatorId:binding.runtimeNonce,scope:'shared',name:'OK1',revision:1,originalFilename:'ok.wav',media} satisfies ExampleEntry;
 const preview={...exampleClient,open:vi.fn(async()=>{events.push('sample-open');output='sample';return{previewId:binding.runtimeNonce,snapshot:{document:{...doc,projectId:'22222222-2222-4222-8222-222222222222'},canUndo:false,canRedo:false}};}),close:vi.fn(async()=>{})};
 const session=new ExamplePreviewSession(binding,preview);let opening!:ReturnType<ExamplePreviewSession['open']>;act(()=>{opening=session.open(entry,defaultSettings,()=>hook.result.current.stopAndWait());});await act(async()=>{});expect(preview.open).not.toHaveBeenCalled();
 await act(async()=>{output='main';events.push('main-configure-ack');configured.resolve({...emptyPlayback,generation:2,projectId:doc.projectId,mediaId:media.id,state:'playing'});});await waitFor(()=>expect(events).toContain('main-stop-issued'));expect(preview.open).not.toHaveBeenCalled();
 await act(async()=>{stopped.resolve({...emptyPlayback,generation:3});await opening;});expect(events).toEqual(['main-configure-ack','main-stop-issued','main-stop-ack','sample-open']);await act(async()=>{});expect(output).toBe('sample');expect(hook.result.current.playing).toBe(false);session.dispose();hook.unmount();lifecycle.dispose();
});
