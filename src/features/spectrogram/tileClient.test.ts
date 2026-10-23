/// <reference types="node" />
import { describe,it,expect,vi } from 'vitest';
import { TileClient, decodeTile, splitFrequencyRequests, analysisConfigHash, type TileRequest, type TileTransport } from './tileClient';
import { webcrypto } from 'node:crypto';
const settings={window:'hann' as const,windowSize:64,hopSize:64,fftSize:64,melBands:128};
const request:TileRequest={requestId:'r1',viewId:'v1',projectId:'p1',mediaId:'m1',generation:1,analysisSource:'original' as const,processingVersion:1,editSignature:'',configHash:'hash',settings,channelIndex:0,kind:'stft',startFrame:0,frameCount:2,timeLod:0,frequencyStart:0,frequencyCount:33,frequencyLod:0,visible:true};
function packet(req= request, overrides:Record<string,unknown>={},value=-20):ArrayBuffer {
 const meta=new TextEncoder().encode(JSON.stringify({protocol:1,request:req,tile:{rows:2,columns:33,sourceFrames:2,sampleRate:48000,totalSamples:4800,startSeconds:0,endSeconds:128/48000,frameStepSamples:64,melPointsHz:[]},valueCount:66,encoding:'f32le-db-row-major',...overrides}));
 const offset=Math.ceil((8+meta.length)/4)*4;const bytes=new ArrayBuffer(offset+66*4);const data=new DataView(bytes);new Uint8Array(bytes).set([65,84,48,49]);data.setUint32(4,meta.length,true);new Uint8Array(bytes,8,meta.length).set(meta);for(let i=0;i<66;i++)data.setFloat32(offset+i*4,value,true);return bytes;
}
describe('binary tile contract',()=>{
 it('rejects missing, forged, mismatched and unknown source identity fields',()=>{
   const original={...request,analysisSource:'original' as const,processingVersion:1,editSignature:''};
   for(const changed of [{analysisSource:'processed'},{processingVersion:2},{editSignature:'0'.repeat(64)},{analysisSource:undefined},{extraAuthority:'untrusted'}])expect(()=>decodeTile(packet({...original,...changed} as TileRequest),original)).toThrow();
   expect(()=>decodeTile(packet({...original,analysisSource:'future'} as unknown as TileRequest),{...original,analysisSource:'future'} as unknown as TileRequest)).toThrow();
 });
 it('reads little-endian raw floats and physical metadata',()=>{const result=decodeTile(packet(),request);expect(result.values).toBeInstanceOf(Float32Array);expect(result.values[0]).toBe(-20);expect(result.metadata.endSeconds).toBe(128/48000);});
 it('rejects stale IDs, generation, config, geometry, missing bytes, oversized and nonfinite data',()=>{
   for(const changed of [{requestId:'other'},{generation:0},{configHash:'other'},{channelIndex:1},{startFrame:1}])expect(()=>decodeTile(packet({...request,...changed}),request)).toThrow();
   expect(()=>decodeTile(packet(request,{valueCount:67}),request)).toThrow();
   expect(()=>decodeTile(packet(request,{tile:{rows:2,columns:33}}),request)).toThrow();
   expect(()=>decodeTile(packet().slice(0,-4),request)).toThrow();expect(()=>decodeTile(new ArrayBuffer(4*1024*1024+1),request)).toThrow();expect(()=>decodeTile(packet(request,{},NaN),request)).toThrow();
 });
 it('splits maximum FFT into exact nonoverlapping frequency chunks within response budget',()=>{
   const big={...request,settings:{...settings,fftSize:65536},frameCount:256,frequencyCount:32769};const chunks=splitFrequencyRequests(big);expect(chunks.length).toBeGreaterThan(1);let end=0;for(const chunk of chunks){expect(chunk.frequencyStart).toBe(end);expect(chunk.frameCount*Math.ceil(chunk.frequencyCount/2**chunk.frequencyLod)*4+16384).toBeLessThanOrEqual(4*1024*1024);end+=chunk.frequencyCount;}expect(end).toBe(32769);
 });
 it('hashes the same versioned canonical analysis settings as Rust',async()=>{expect(await analysisConfigHash(settings,webcrypto.subtle as SubtleCrypto)).toBe('004a35379c8fa102532bffa66112e9b1531da9c148320b9bef93fec2325f89d8');});
 it('drops late results for one view without cancelling another view',async()=>{
   const pending:Array<{req:TileRequest,resolve:(buffer:ArrayBuffer)=>void}>=[];const cancelled:string[]=[];
   let nextLease=0;const transport:TileTransport={register:async()=>['a','b'][nextLease++],retire:async()=>{},request:(req)=>new Promise(resolve=>pending.push({req,resolve})),cancel:async(_p,v)=>{cancelled.push(v);}};
   const a=new TileClient('p1',transport);const b=new TileClient('p1',transport);
   const one=a.request(request);const rejected=expect(one).rejects.toMatchObject({code:'Cancelled'});const two=b.request(request);await vi.waitFor(()=>expect(pending).toHaveLength(2));a.nextGeneration();pending[0].resolve(packet(pending[0].req));pending[1].resolve(packet(pending[1].req));await rejected;expect((await two).values[0]).toBe(-20);expect(cancelled).toEqual(['a']);
   const next=a.request(request);await vi.waitFor(()=>expect(pending).toHaveLength(3));a.dispose();pending[2].resolve(packet(pending[2].req));await expect(next).rejects.toMatchObject({code:'Cancelled'});
 });
});
describe('native view lease lifecycle',()=>{
 it('waits for registration and retires a lease resolving after disposal without sending work',async()=>{
   let registered!:(id:string)=>void;
   const transport={register:vi.fn(()=>new Promise<string>(resolve=>registered=resolve)),retire:vi.fn(async()=>{}),cancel:vi.fn(async()=>{}),request:vi.fn(async(req:TileRequest)=>packet(req))};
   const client=new TileClient('p1',transport);
   const result=client.request(request);const rejected=expect(result).rejects.toMatchObject({code:'Cancelled'});
   expect(transport.request).not.toHaveBeenCalled();expect(transport.register).toHaveBeenCalledTimes(1);
   client.nextGeneration();client.dispose();client.dispose();registered('native-lease');
   await rejected;await vi.waitFor(()=>expect(transport.retire).toHaveBeenCalledExactlyOnceWith('p1','native-lease'));
   expect(transport.request).not.toHaveBeenCalled();
   await expect(client.request(request)).rejects.toMatchObject({code:'Cancelled'});
 });
 it('keeps same-project replacement registration independent when old registration resolves last',async()=>{
   const registrations:Array<(id:string)=>void>=[];
   const transport={register:vi.fn(()=>new Promise<string>(resolve=>registrations.push(resolve))),retire:vi.fn(async()=>{}),cancel:vi.fn(async()=>{}),request:vi.fn(async(req:TileRequest)=>packet(req))};
   const old=new TileClient('p1',transport);const replacement=new TileClient('p1',transport);
   const oldResult=old.request(request);const rejected=expect(oldResult).rejects.toMatchObject({code:'Cancelled'});old.dispose();
   const newResult=replacement.request(request);registrations[1]('new-native');expect((await newResult).values[0]).toBe(-20);
   registrations[0]('old-native');await rejected;await vi.waitFor(()=>expect(transport.retire).toHaveBeenCalledWith('p1','old-native'));
   expect(transport.retire).not.toHaveBeenCalledWith('p1','new-native');expect(transport.request.mock.calls.map(([r])=>r.viewId)).toEqual(['new-native']);
   replacement.dispose();await vi.waitFor(()=>expect(transport.retire).toHaveBeenCalledWith('p1','new-native'));
 });
 it('retries failed registration and does not allocate unused disposed clients',async()=>{
   const transport={register:vi.fn<()=>Promise<string>>().mockRejectedValueOnce(new Error('registration failed')).mockResolvedValue('lease'),retire:vi.fn(async()=>{}),cancel:vi.fn(async()=>{}),request:vi.fn(async(req:TileRequest)=>packet(req))};
   const unused=new TileClient('p1',transport);unused.nextGeneration();unused.dispose();expect(transport.register).not.toHaveBeenCalled();
   const client=new TileClient('p1',transport);await expect(client.request(request)).rejects.toThrow('registration failed');
   expect((await client.request(request)).request.viewId).toBe('lease');expect(transport.register).toHaveBeenCalledTimes(2);
   client.dispose();
 });
});
