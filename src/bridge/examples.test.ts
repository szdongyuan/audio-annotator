import { beforeEach, expect, it, vi } from 'vitest';
import { exampleClient, parseExampleLibrary } from './examples';
import { parseProjectDocument } from './types';
import fixture from '../../tests/fixtures/document-v3.json';
import { emptyPlayback, type PlaybackRequest } from './playback';
const invoke=vi.hoisted(()=>vi.fn());
vi.mock('@tauri-apps/api/core',()=>({invoke,isTauri:()=>false,Channel:class{onmessage:unknown}}));
const actor='11111111-1111-4111-8111-111111111111',project='22222222-2222-4222-8222-222222222222';
const b={runtimeNonce:actor,projectId:project};
const entry={sampleId:actor,projectId:project,creatorId:actor,scope:'private' as const,name:'OK1',revision:1,originalFilename:'ok.wav',media:parseProjectDocument(fixture).media[0]};
beforeEach(()=>invoke.mockReset());
it('binds mutations to project runtime, entry owner/revision and destination scope revision',async()=>{
 invoke.mockResolvedValue(entry);await exampleClient.rename(b,entry,'NG1');expect(invoke).toHaveBeenLastCalledWith('examples_rename',{...b,scope:'private',creatorId:actor,sampleId:actor,name:'NG1',expectedRevision:1});
 invoke.mockResolvedValue({...entry,scope:'shared'});await exampleClient.copy(b,entry,'shared',4);expect(invoke).toHaveBeenLastCalledWith('examples_copy',{...b,scope:'private',creatorId:actor,sampleId:actor,targetScope:'shared',expectedRevision:4});
});
it('rejects unknown fields, wrong scope/project/revision, duplicate IDs and malformed names',()=>{
 const library={entries:[entry],revisions:{[actor]:1}};expect(parseExampleLibrary(library,b,'private')).toEqual(library);
 for(const patch of [{extra:1},{entries:[{...entry,scope:'shared'}]},{entries:[{...entry,projectId:actor}]},{revisions:{[actor]:2}},{entries:[entry,entry]},{entries:[{...entry,name:'x'.repeat(129)}]},{entries:[{...entry,name:'x\u0085'}]}])expect(()=>parseExampleLibrary({...library,...patch},b,'private')).toThrow();
});
it('accepts native scheduler view IDs and supports 256 author revisions',async()=>{
 invoke.mockResolvedValue('view-1');expect(await exampleClient.tiles(b,actor).register(project)).toBe('view-1');expect(invoke).toHaveBeenCalledWith('example_preview_register_view',{...b,previewId:actor});
 const revisions=Object.fromEntries(Array.from({length:256},(_,i)=>[`${i.toString(16).padStart(8,'0')}-1111-4111-8111-111111111111`,0]));expect(parseExampleLibrary({entries:[],revisions},b,'shared').revisions).toEqual(revisions);
});
it('rejects a mutation result belonging to a different parent project',async()=>{
 invoke.mockResolvedValue({...entry,projectId:actor});await expect(exampleClient.import(b,'private','C:/ok.wav','OK1',0)).rejects.toMatchObject({code:'InvalidInput'});
});
it('rejects processed/bypassed or parent-document preview playback before invoking native',async()=>{
 invoke.mockResolvedValue(emptyPlayback);const request:PlaybackRequest={projectId:fixture.projectId,mediaId:entry.media.id,mode:{mode:'original'},bypass:false,monitorGainDb:0,volume:.5,deviceId:null,looping:false,seekSeconds:0,play:true};
 for(const patch of [{mode:{mode:'processed' as const}},{bypass:true},{projectId:project}])await expect(exampleClient.configure(b,actor,{...request,...patch})).rejects.toBeDefined();expect(invoke).not.toHaveBeenCalled();
});
