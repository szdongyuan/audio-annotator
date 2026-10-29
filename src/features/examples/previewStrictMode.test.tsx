/// <reference types="node" />
import { webcrypto } from 'node:crypto';
import { StrictMode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ExamplePreview } from './ExamplePreview';
import { exampleClient, type ExampleEntry } from '../../bridge/examples';
import { parseProjectDocument, type MediaDescriptor } from '../../bridge/types';
import type { PlaybackUI } from '../playback/usePlayback';
import { SelectionContext, type SelectionUI } from '../selection/useSelection';
import type { TileRequest } from '../spectrogram/tileClient';
import { tileCache } from '../spectrogram/tileScheduler';
import fixture from '../../../tests/fixtures/document-v3.json';
const draw=vi.hoisted(()=>vi.fn());
// jsdom has no bitmap implementation; Canvas interactions/useTiles stay real.
vi.mock('../spectrogram/renderer',()=>({spectrogramDrawSteps:(...args:unknown[])=>{draw(...args);return()=>true;}}));
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();tileCache.clear();draw.mockReset();});
it('analyzes, zooms and pans the real preview Canvas after StrictMode replay and retires its view on close',async()=>{
 vi.stubGlobal('crypto',webcrypto);vi.stubGlobal('PointerEvent',MouseEvent);
 vi.stubGlobal('ResizeObserver',class{alive=true;constructor(private cb:ResizeObserverCallback){}observe(target:Element){queueMicrotask(()=>{if(this.alive)this.cb([{target,contentRect:{width:800,height:300}}] as ResizeObserverEntry[],this as unknown as ResizeObserver);});}disconnect(){this.alive=false;}});
 vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue({left:0,top:0,right:800,bottom:300,width:800,height:300,x:0,y:0,toJSON(){}});
 HTMLElement.prototype.setPointerCapture=vi.fn();HTMLElement.prototype.releasePointerCapture=vi.fn();HTMLElement.prototype.hasPointerCapture=()=>true;
 const actor='11111111-1111-4111-8111-111111111111',project='22222222-2222-4222-8222-222222222222',doc=parseProjectDocument(fixture),media=doc.media[0];
 const snapshot={document:{...doc,media:[media],annotations:[],edits:[]},canUndo:false,canRedo:false};
 const entry={sampleId:actor,projectId:project,creatorId:actor,scope:'shared',name:'OK1',revision:1,originalFilename:'ok.wav',media} satisfies ExampleEntry;
 vi.spyOn(exampleClient,'open').mockResolvedValue({previewId:actor,snapshot});vi.spyOn(exampleClient,'close').mockResolvedValue();vi.spyOn(exampleClient,'cancelOpen').mockResolvedValue();vi.spyOn(exampleClient,'status').mockResolvedValue([{mediaId:media.id,status:'ready'}]);
 const request=vi.fn(async(r:TileRequest)=>packet(r,media)),retire=vi.fn(async()=>{});
 vi.spyOn(exampleClient,'tiles').mockReturnValue({register:vi.fn(async()=>'view-1'),request,retire,cancel:vi.fn(async()=>{})});
 const beginGesture=vi.fn(),endGesture=vi.fn(),playback={monitor:{monitorGainDb:0},options:{volume:.5,deviceId:null,looping:false},stopAndWait:vi.fn()} as unknown as PlaybackUI;
 const rendered=render(<StrictMode><SelectionContext.Provider value={{state:{beginGesture,endGesture}} as unknown as SelectionUI}><ExamplePreview binding={{runtimeNonce:actor,projectId:project}} entry={entry} playback={playback} onClose={vi.fn()}/></SelectionContext.Provider></StrictMode>);
 await waitFor(()=>expect(request).toHaveBeenCalled());await waitFor(()=>expect(draw.mock.lastCall?.[4].length).toBeGreaterThan(0));
 const surface=screen.getByLabelText('通道 1 频谱'),before={...draw.mock.lastCall![1]};
 fireEvent(surface,new WheelEvent('wheel',{bubbles:true,cancelable:true,deltaY:-120,clientX:400,clientY:150}));
 await waitFor(()=>expect(draw.mock.lastCall![1].endSeconds-draw.mock.lastCall![1].startSeconds).toBeLessThan(before.endSeconds-before.startSeconds));const zoomed={...draw.mock.lastCall![1]};
 fireEvent.pointerDown(surface,{button:0,altKey:true,clientX:400,clientY:150});fireEvent.pointerMove(surface,{clientX:300,clientY:150});fireEvent.pointerUp(surface);
 await waitFor(()=>expect(draw.mock.lastCall![1].startSeconds).toBeGreaterThan(zoomed.startSeconds));expect(beginGesture).not.toHaveBeenCalled();expect(endGesture).not.toHaveBeenCalled();
 rendered.unmount();await waitFor(()=>expect(retire).toHaveBeenCalledWith(doc.projectId,'view-1'));
});
function packet(r:TileRequest,media:MediaDescriptor){
 const sourceFrames=Math.min(Math.ceil(media.frameCount/r.settings.hopSize)-r.startFrame,r.frameCount*2**r.timeLod),rows=Math.ceil(sourceFrames/2**r.timeLod),columns=Math.ceil(r.frequencyCount/2**r.frequencyLod);
 const metadata=new TextEncoder().encode(JSON.stringify({protocol:1,request:r,encoding:'f32le-db-row-major',valueCount:rows*columns,tile:{rows,columns,sourceFrames,sampleRate:media.sampleRate,totalSamples:media.frameCount,startSeconds:r.startFrame*r.settings.hopSize/media.sampleRate,endSeconds:Math.min((r.startFrame+sourceFrames)*r.settings.hopSize,media.frameCount)/media.sampleRate,frameStepSamples:r.settings.hopSize*2**r.timeLod,melPointsHz:[]}}));
 const offset=Math.ceil((8+metadata.length)/4)*4,bytes=new ArrayBuffer(offset+rows*columns*4);new Uint8Array(bytes).set([65,84,48,49]);new DataView(bytes).setUint32(4,metadata.length,true);new Uint8Array(bytes,8,metadata.length).set(metadata);return bytes;
}
