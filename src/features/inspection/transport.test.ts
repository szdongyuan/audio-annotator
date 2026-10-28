import { expect, it, vi } from 'vitest';
import fixture from '../../../tests/fixtures/document-v3.json';
import { parseProjectDocument, type AnalysisSettings } from '../../bridge/types';
import { emptyPlayback } from '../../bridge/playback';
import { InspectionSession } from './session';
import { inspectionProject } from './adapter';
const invoke=vi.hoisted(()=>vi.fn());
vi.mock('@tauri-apps/api/core',()=>({invoke,isTauri:()=>false,Channel:class{onmessage:unknown}}));
it('uses production bridge contracts for isolated analysis/playback/gain/lease replacement and denies writes',async()=>{
 const binding={runtimeNonce:crypto.randomUUID(),projectId:fixture.projectId},previewId=crypto.randomUUID();
 const document=parseProjectDocument(structuredClone(fixture)); document.projectId=previewId; document.annotations=[]; document.media=[document.media[0]];
 const mediaId=document.media[0].id,snapshot={document,canUndo:false,canRedo:false};
 let stream=false,generation=0,nextLease=0; const leases=new Set<string>();
 invoke.mockImplementation(async(name:string,args:any)=>{
  expect(args.runtimeNonce).toBe(binding.runtimeNonce); expect(args.projectId).toBe(binding.projectId);
  if(name==='inspection_open'){expect(args.mediaId).toBe(mediaId);expect(args.requestId).toMatch(/^[0-9a-f-]{36}$/);return{previewId,snapshot:structuredClone(snapshot)};}
  expect(args.previewId).toBe(previewId);
  if(name==='inspection_configure_analysis'){leases.clear();snapshot.document.analysis[mediaId]=args.analysisSettings as AnalysisSettings;return structuredClone(snapshot);}
  if(name==='inspection_register_view'){const lease=`inspection-${++nextLease}`;leases.add(lease);return lease;}
  if(name==='inspection_media_status')return[{mediaId,status:'ready'}];
  if(name==='inspection_playback_configure'){expect(args.request.projectId).toBe(previewId);expect(args.request.mediaId).toBe(mediaId);stream=true;generation++;return{...emptyPlayback,projectId:previewId,mediaId,generation,state:'playing'};}
  if(name==='inspection_monitor_gain'){expect(stream).toBe(true);expect(args.request.generation).toBe(generation);return{...emptyPlayback,projectId:previewId,mediaId,generation,state:'playing'};}
  if(name==='inspection_playback_control'){expect(stream).toBe(true);return{...emptyPlayback,projectId:previewId,mediaId,generation,state:'stopped'};}
  if(name==='inspection_close'){stream=false;leases.clear();return;}
  throw new Error(`Unexpected ordinary command: ${name}`);
 });
 const session=new InspectionSession(binding); await session.open(mediaId,document.analysis[mediaId],async()=>{});
 const first=inspectionProject(session.result!,binding),firstLease=await first.commands!.tiles.register(previewId);
 await expect(first.commands!.project.getSnapshot(previewId)).rejects.toMatchObject({code:'InvalidInput'});
 await expect(first.commands!.media.start(previewId,['other.wav'],()=>{},mediaId)).rejects.toMatchObject({code:'InvalidInput'});
 await session.play({monitorGainDb:0,volume:.7,deviceId:null,looping:false},{mode:'processed'}); await session.gain(6);
 await session.analysis({...document.analysis[mediaId],hopSize:256}); expect(leases.has(firstLease)).toBe(false); first.lifecycle.dispose();
 const second=inspectionProject(session.result!,binding); expect(second).not.toBe(first);
 expect(await second.commands!.tiles.register(previewId)).not.toBe(firstLease); await session.checkSource(); session.dispose(); second.lifecycle.dispose();
 expect(stream).toBe(false);expect(leases.size).toBe(0);
});
