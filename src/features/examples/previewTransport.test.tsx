/// <reference types="node" />
import { webcrypto } from 'node:crypto';
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { previewProject } from './ExamplePreview';
import { useTiles } from '../spectrogram/useTiles';
import { defaultSettings, defaultView } from '../spectrogram/workspace';
import { tileCache } from '../spectrogram/tileScheduler';
import type { TileRequest } from '../spectrogram/tileClient';
import { type MediaDescriptor, parseProjectDocument } from '../../bridge/types';
import fixture from '../../../tests/fixtures/document-v3.json';
const invoke=vi.hoisted(()=>vi.fn());
vi.mock('@tauri-apps/api/core',()=>({invoke,isTauri:()=>false,Channel:class{onmessage:unknown}}));
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();tileCache.clear();});
it('analyzes through preview-only IPC with transient nested IDs, then retires the native view',async()=>{
 vi.stubGlobal('crypto',webcrypto);const doc=parseProjectDocument(fixture),media=doc.media[0];const binding={runtimeNonce:'11111111-1111-4111-8111-111111111111',projectId:'22222222-2222-4222-8222-222222222222'},previewId='33333333-3333-4333-8333-333333333333';
 invoke.mockImplementation(async(command,args)=>{expect(args).toMatchObject({...binding,previewId});switch(command){case'example_preview_media_status':return[{mediaId:media.id,status:'ready'}];case'example_preview_register_view':return'view-1';case'example_preview_cancel_generation':case'example_preview_retire_view':return;case'example_preview_request_tile':expect(args.request).toMatchObject({projectId:doc.projectId,mediaId:media.id,viewId:'view-1',analysisSource:'original',editSignature:''});return packet(args.request,media);default:throw Error(`Ordinary command reached: ${command}`);}});
 const active=previewProject({previewId,snapshot:{document:doc,canUndo:false,canRedo:false}},binding),before=JSON.stringify(active.store.snapshot);
 const hook=renderHook(()=>useTiles(active,media,defaultSettings,defaultView(media),0,800,'unverified','original'));
 await waitFor(()=>expect(hook.result.current.completed).toBe(1));expect(hook.result.current.error).toBeNull();expect(JSON.stringify(active.store.snapshot)).toBe(before);
 await expect(active.commands!.project.getSnapshot(doc.projectId)).rejects.toMatchObject({message:'示例预览只读'});
 hook.unmount();await waitFor(()=>expect(invoke).toHaveBeenCalledWith('example_preview_retire_view',{...binding,previewId,viewId:'view-1'}));active.lifecycle.dispose();
});
function packet(r:TileRequest,media:MediaDescriptor){
 const sourceFrames=Math.min(Math.ceil(media.frameCount/r.settings.hopSize)-r.startFrame,r.frameCount*2**r.timeLod),rows=Math.ceil(sourceFrames/2**r.timeLod),columns=Math.ceil(r.frequencyCount/2**r.frequencyLod);
 const metadata=new TextEncoder().encode(JSON.stringify({protocol:1,request:r,encoding:'f32le-db-row-major',valueCount:rows*columns,tile:{rows,columns,sourceFrames,sampleRate:media.sampleRate,totalSamples:media.frameCount,startSeconds:r.startFrame*r.settings.hopSize/media.sampleRate,endSeconds:Math.min((r.startFrame+sourceFrames)*r.settings.hopSize,media.frameCount)/media.sampleRate,frameStepSamples:r.settings.hopSize*2**r.timeLod,melPointsHz:[]}}));
 const offset=Math.ceil((8+metadata.length)/4)*4,bytes=new ArrayBuffer(offset+rows*columns*4);new Uint8Array(bytes).set([65,84,48,49]);new DataView(bytes).setUint32(4,metadata.length,true);new Uint8Array(bytes,8,metadata.length).set(metadata);return bytes;
}
