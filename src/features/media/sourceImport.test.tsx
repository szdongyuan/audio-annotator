import { registerSuspension } from '../collaboration/admission';
import { afterEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import fixture from '../../../tests/fixtures/document-v3.json';
import { ProjectStore } from '../../app/store';
import { CommandQueue, type ProjectCommands } from '../../app/commands';
import { parseProjectDocument } from '../../bridge/types';
import type { SourceCommands, SourceEvent } from '../../bridge/sourceImport';
import type { MediaCommands, MediaEvent } from '../../bridge/media';
import { ProjectLifecycle } from '../project/lifecycle';
import { MediaImportController } from './imports';
import { SourceImportController } from './sourceImport';
import { SourceImportDialog } from './SourceImportDialog';
import { MediaList } from './MediaList';
import { ImportAcknowledgements } from './ImportProgress';
import { SourceImportProgress } from './SourceImportProgress';
import { OrganizationController } from './organization';
const cleanup:(()=>void)[]=[];afterEach(()=>cleanup.splice(0).forEach(f=>f()));
const nonce='11111111-1111-4111-8111-111111111111';
it('requires an explicit target review backed by a successful current directory read', async () => {
 const s=setup(1),drop=dropOwner(s);
 vi.mocked(s.api.start).mockImplementationOnce(async(_id,_config,receive)=>{receive({type:'failed',token:s.token,error:{code:'RevisionConflict',message:'目录变化',retryable:false,details:{droppedLayoutConflict:true}}});return s.token;});
 expect(s.c.beginDropped(drop)).toBe(true); await waitFor(()=>expect(s.c.droppedLayoutConflict).toBe(true));
 const head={kind:'audio-annotator-organization' as const,formatVersion:1 as const,projectId:fixture.projectId,revision:9,layoutRevision:9,folders:[{id:drop.target.folderId,parentId:null,name:'核对的目标'}],media:[]};
 const api={get:vi.fn(async()=>({runtimeNonce:nonce,projectId:fixture.projectId,organization:head})),apply:vi.fn()};
 const organization=new OrganizationController(fixture.projectId,nonce,true,api,s.owner);organization.snapshot={...head,revision:7,layoutRevision:7};
 render(<SourceImportDialog controller={s.c} organization={organization}/>);
 fireEvent.click(screen.getByRole('button',{name:'刷新并核对目标'}));
 await waitFor(()=>expect(screen.getByRole('button',{name:'确认目标并允许重新扫描'})).toBeVisible());
 expect(s.c.droppedLayoutConflict).toBe(true);expect(screen.getByRole('button',{name:'扫描预览'})).toBeDisabled();
 fireEvent.click(screen.getByRole('button',{name:'确认目标并允许重新扫描'})); expect(s.c.droppedLayoutConflict).toBe(false);
 fireEvent.click(screen.getByRole('button',{name:'扫描预览'})); await waitFor(()=>expect(s.api.start).toHaveBeenCalledTimes(2));
 expect(vi.mocked(s.api.start).mock.calls[1][3]).toEqual({runtimeNonce:nonce,expectedLayoutRevision:9});
});
it('rejects a source target review whose organization read was superseded', async () => {
 const s=setup(1),drop=dropOwner(s);
 vi.mocked(s.api.start).mockImplementationOnce(async(_id,_config,receive)=>{receive({type:'failed',token:s.token,error:{code:'RevisionConflict',message:'目录变化',retryable:false,details:{droppedLayoutConflict:true}}});return s.token;});
 expect(s.c.beginDropped(drop)).toBe(true);await waitFor(()=>expect(s.c.droppedLayoutConflict).toBe(true));
 const head={kind:'audio-annotator-organization' as const,formatVersion:1 as const,projectId:fixture.projectId,revision:9,layoutRevision:9,folders:[{id:drop.target.folderId,parentId:null,name:'目标'}],media:[]};
 let resolve!:(value:{runtimeNonce:string;projectId:string;organization:typeof head})=>void;
 const api={get:vi.fn().mockImplementationOnce(()=>new Promise(r=>{resolve=r;})).mockResolvedValue({runtimeNonce:nonce,projectId:fixture.projectId,organization:{...head,revision:10,layoutRevision:10}}),apply:vi.fn()};
 const organization=new OrganizationController(fixture.projectId,nonce,true,api,s.owner);organization.snapshot={...head,revision:7,layoutRevision:7};
 render(<SourceImportDialog controller={s.c} organization={organization}/>);fireEvent.click(screen.getByRole('button',{name:'刷新并核对目标'}));
 await act(()=>organization.refresh(true)); await act(async()=>resolve({runtimeNonce:nonce,projectId:fixture.projectId,organization:head}));
 expect(s.c.droppedLayoutConflict).toBe(true);expect(screen.queryByRole('button',{name:'确认目标并允许重新扫描'})).toBeNull();expect(screen.getByRole('button',{name:'扫描预览'})).toBeDisabled();
});
it('keeps a source target review usable during slow recurring polls',async()=>{
 const s=setup(1),drop=dropOwner(s);
 vi.mocked(s.api.start).mockImplementationOnce(async(_id,_config,receive)=>{receive({type:'failed',token:s.token,error:{code:'RevisionConflict',message:'目录变化',retryable:false,details:{droppedLayoutConflict:true}}});return s.token;});
 expect(s.c.beginDropped(drop)).toBe(true);await waitFor(()=>expect(s.c.droppedLayoutConflict).toBe(true));
 const head={kind:'audio-annotator-organization' as const,formatVersion:1 as const,projectId:fixture.projectId,revision:9,layoutRevision:9,folders:[{id:drop.target.folderId,parentId:null,name:'目标'}],media:[]};
 let verify!:(v:{runtimeNonce:string;projectId:string;organization:typeof head})=>void,poll!:(v:{runtimeNonce:string;projectId:string;organization:typeof head})=>void;
 const api={get:vi.fn().mockImplementationOnce(()=>new Promise(r=>verify=r)).mockImplementationOnce(()=>new Promise(r=>poll=r)),apply:vi.fn()};
 const organization=new OrganizationController(fixture.projectId,nonce,true,api,s.owner);organization.snapshot={...head,revision:7,layoutRevision:7};
 render(<SourceImportDialog controller={s.c} organization={organization}/>);fireEvent.click(screen.getByRole('button',{name:'刷新并核对目标'}));
 for(let i=0;i<8;i++)void organization.refresh();expect(api.get).toHaveBeenCalledTimes(1);
 await act(async()=>verify({runtimeNonce:nonce,projectId:fixture.projectId,organization:head}));await waitFor(()=>expect(screen.getByRole('button',{name:'确认目标并允许重新扫描'})).toBeVisible());
 let pending!:Promise<void>;act(()=>{pending=organization.refresh();});expect(api.get).toHaveBeenCalledTimes(2);
 fireEvent.click(screen.getByRole('button',{name:'确认目标并允许重新扫描'}));expect(s.c.droppedLayoutConflict).toBe(false);
 await act(async()=>{poll({runtimeNonce:nonce,projectId:fixture.projectId,organization:head});await pending;});
});
it('does not confirm source review after a later poll installs changed layout',async()=>{
 const s=setup(1),drop=dropOwner(s);
 vi.mocked(s.api.start).mockImplementationOnce(async(_id,_config,receive)=>{receive({type:'failed',token:s.token,error:{code:'RevisionConflict',message:'目录变化',retryable:false,details:{droppedLayoutConflict:true}}});return s.token;});
 expect(s.c.beginDropped(drop)).toBe(true);await waitFor(()=>expect(s.c.droppedLayoutConflict).toBe(true));
 const head={kind:'audio-annotator-organization' as const,formatVersion:1 as const,projectId:fixture.projectId,revision:9,layoutRevision:9,folders:[{id:drop.target.folderId,parentId:null,name:'目标'}],media:[]};
 const api={get:vi.fn().mockResolvedValueOnce({runtimeNonce:nonce,projectId:fixture.projectId,organization:head}).mockResolvedValue({runtimeNonce:nonce,projectId:fixture.projectId,organization:{...head,revision:10,layoutRevision:10}}),apply:vi.fn()};
 const organization=new OrganizationController(fixture.projectId,nonce,true,api,s.owner);organization.snapshot={...head,revision:7,layoutRevision:7};
 render(<SourceImportDialog controller={s.c} organization={organization}/>);fireEvent.click(screen.getByRole('button',{name:'刷新并核对目标'}));
 await waitFor(()=>expect(screen.getByRole('button',{name:'确认目标并允许重新扫描'})).toBeVisible());await act(()=>organization.refresh());
 fireEvent.click(screen.getByRole('button',{name:'确认目标并允许重新扫描'}));expect(s.c.droppedLayoutConflict).toBe(true);expect(screen.getByText(/目录或目标已变化/)).toBeVisible();
});
it('ignores a source review returned after its organization owner is replaced',async()=>{
 const s=setup(1),drop=dropOwner(s);
 vi.mocked(s.api.start).mockImplementationOnce(async(_id,_config,receive)=>{receive({type:'failed',token:s.token,error:{code:'RevisionConflict',message:'目录变化',retryable:false,details:{droppedLayoutConflict:true}}});return s.token;});
 expect(s.c.beginDropped(drop)).toBe(true);await waitFor(()=>expect(s.c.droppedLayoutConflict).toBe(true));
 const head={kind:'audio-annotator-organization' as const,formatVersion:1 as const,projectId:fixture.projectId,revision:9,layoutRevision:9,folders:[{id:drop.target.folderId,parentId:null,name:'目标'}],media:[]};
 let resolve!:(v:{runtimeNonce:string;projectId:string;organization:typeof head})=>void;const api={get:vi.fn(()=>new Promise<{runtimeNonce:string;projectId:string;organization:typeof head}>(r=>resolve=r)),apply:vi.fn()};
 const old=new OrganizationController(fixture.projectId,nonce,true,api,s.owner);old.snapshot=head;
 const replacement=new OrganizationController(fixture.projectId,nonce,true,{get:vi.fn(),apply:vi.fn()},s.owner);replacement.snapshot=head;
 const view=render(<SourceImportDialog controller={s.c} organization={old}/>);fireEvent.click(screen.getByRole('button',{name:'刷新并核对目标'}));
 view.rerender(<SourceImportDialog controller={s.c} organization={replacement}/>);old.dispose();await act(async()=>resolve({runtimeNonce:nonce,projectId:fixture.projectId,organization:head}));
 expect(screen.queryByRole('button',{name:'确认目标并允许重新扫描'})).toBeNull();expect(s.c.droppedLayoutConflict).toBe(true);
});
it('does not confirm a source target while a newer forced organization refresh is in flight',async()=>{
 const s=setup(1),drop=dropOwner(s);
 vi.mocked(s.api.start).mockImplementationOnce(async(_id,_config,receive)=>{receive({type:'failed',token:s.token,error:{code:'RevisionConflict',message:'目录变化',retryable:false,details:{droppedLayoutConflict:true}}});return s.token;});
 expect(s.c.beginDropped(drop)).toBe(true);await waitFor(()=>expect(s.c.droppedLayoutConflict).toBe(true));
 const head={kind:'audio-annotator-organization' as const,formatVersion:1 as const,projectId:fixture.projectId,revision:9,layoutRevision:9,folders:[{id:drop.target.folderId,parentId:null,name:'目标'}],media:[]};
 let finish!:(value:{runtimeNonce:string;projectId:string;organization:typeof head})=>void;
 const api={get:vi.fn().mockResolvedValueOnce({runtimeNonce:nonce,projectId:fixture.projectId,organization:head}).mockImplementationOnce(()=>new Promise(r=>finish=r)),apply:vi.fn()};
 const organization=new OrganizationController(fixture.projectId,nonce,true,api,s.owner);organization.snapshot=head;
 render(<SourceImportDialog controller={s.c} organization={organization}/>);fireEvent.click(screen.getByRole('button',{name:'刷新并核对目标'}));
 await waitFor(()=>expect(screen.getByRole('button',{name:'确认目标并允许重新扫描'})).toBeVisible());
 let forced!:Promise<void>;act(()=>{forced=organization.refreshAfterVerified();});expect(api.get).toHaveBeenCalledTimes(2);
 fireEvent.click(screen.getByRole('button',{name:'确认目标并允许重新扫描'}));expect(s.c.droppedLayoutConflict).toBe(true);expect(screen.getByText(/目录或目标已变化/)).toBeVisible();
 await act(async()=>{finish({runtimeNonce:nonce,projectId:fixture.projectId,organization:{...head,revision:10,layoutRevision:10}});await forced;});expect(organization.snapshot?.revision).toBe(10);
});
it('rejects a slow source review when an organization mutation starts during polling',async()=>{
 const s=setup(1),drop=dropOwner(s);
 vi.mocked(s.api.start).mockImplementationOnce(async(_id,_config,receive)=>{receive({type:'failed',token:s.token,error:{code:'RevisionConflict',message:'目录变化',retryable:false,details:{droppedLayoutConflict:true}}});return s.token;});
 expect(s.c.beginDropped(drop)).toBe(true);await waitFor(()=>expect(s.c.droppedLayoutConflict).toBe(true));
 const head={kind:'audio-annotator-organization' as const,formatVersion:1 as const,projectId:fixture.projectId,revision:9,layoutRevision:9,folders:[{id:drop.target.folderId,parentId:null,name:'目标'}],media:[]};
 let verify!:(v:{runtimeNonce:string;projectId:string;organization:typeof head})=>void,write!:(v:{runtimeNonce:string;projectId:string;organization:typeof head})=>void;
 const api={get:vi.fn(()=>new Promise<{runtimeNonce:string;projectId:string;organization:typeof head}>(r=>verify=r)),apply:vi.fn(()=>new Promise<{runtimeNonce:string;projectId:string;organization:typeof head}>(r=>write=r))};
 const organization=new OrganizationController(fixture.projectId,nonce,true,api);organization.snapshot=head;
 render(<SourceImportDialog controller={s.c} organization={organization}/>);fireEvent.click(screen.getByRole('button',{name:'刷新并核对目标'}));
 let pending!:Promise<boolean>;act(()=>{pending=organization.submit({expectedRevision:9,operation:{type:'renameFolder',id:drop.target.folderId,name:'新目标'}});});
 for(let i=0;i<5;i++)void organization.refresh();expect(api.get).toHaveBeenCalledTimes(1);
 await act(async()=>verify({runtimeNonce:nonce,projectId:fixture.projectId,organization:head}));expect(screen.queryByRole('button',{name:'确认目标并允许重新扫描'})).toBeNull();
 await act(async()=>{write({runtimeNonce:nonce,projectId:fixture.projectId,organization:{...head,revision:10,layoutRevision:10}});await pending;});expect(s.c.droppedLayoutConflict).toBe(true);
});
it('starts a fresh source review after cancellation and ignores its retired predecessor',async()=>{
 const s=setup(1),drop=dropOwner(s);
 const fail:SourceCommands['start']=async(_id,_config,receive)=>{receive({type:'failed',token:s.token,error:{code:'RevisionConflict',message:'目录变化',retryable:false,details:{droppedLayoutConflict:true}}});return s.token;};
 vi.mocked(s.api.start).mockImplementationOnce(fail).mockImplementationOnce(fail);
 expect(s.c.beginDropped(drop)).toBe(true);await waitFor(()=>expect(s.c.droppedLayoutConflict).toBe(true));
 const head={kind:'audio-annotator-organization' as const,formatVersion:1 as const,projectId:fixture.projectId,revision:9,layoutRevision:9,folders:[{id:drop.target.folderId,parentId:null,name:'目标'}],media:[]};
 let old!:(v:{runtimeNonce:string;projectId:string;organization:typeof head})=>void,fresh!:(v:{runtimeNonce:string;projectId:string;organization:typeof head})=>void;
 const api={get:vi.fn().mockImplementationOnce(()=>new Promise(r=>old=r)).mockImplementationOnce(()=>new Promise(r=>fresh=r)),apply:vi.fn()};
 const organization=new OrganizationController(fixture.projectId,nonce,true,api,s.owner);organization.snapshot={...head,revision:7,layoutRevision:7};
 render(<SourceImportDialog controller={s.c} organization={organization}/>);fireEvent.click(screen.getByRole('button',{name:'刷新并核对目标'}));expect(api.get).toHaveBeenCalledTimes(1);
 await act(()=>s.c.cancel());await waitFor(()=>expect(s.imports.occupied).toBe(false));act(()=>{expect(s.c.beginDropped(drop)).toBe(true);});await waitFor(()=>expect(s.c.droppedLayoutConflict).toBe(true));
 fireEvent.click(screen.getByRole('button',{name:'刷新并核对目标'}));expect(api.get).toHaveBeenCalledTimes(2);
 await act(async()=>fresh({runtimeNonce:nonce,projectId:fixture.projectId,organization:head}));await waitFor(()=>expect(screen.getByRole('button',{name:'确认目标并允许重新扫描'})).toBeVisible());
 await act(async()=>old({runtimeNonce:nonce,projectId:fixture.projectId,organization:{...head,revision:10,layoutRevision:10}}));
 expect(organization.snapshot?.revision).toBe(9);fireEvent.click(screen.getByRole('button',{name:'确认目标并允许重新扫描'}));expect(s.c.droppedLayoutConflict).toBe(false);
 await act(()=>s.c.scan());expect(vi.mocked(s.api.start).mock.calls.at(-1)?.[3]).toEqual({runtimeNonce:nonce,expectedLayoutRevision:9});
});
it.each(['取消','关闭音频导入','external'] as const)('retires a stalled source review on %s so ordinary refresh can proceed',async close=>{
 const s=setup(1),drop=dropOwner(s);
 vi.mocked(s.api.start).mockImplementationOnce(async(_id,_config,receive)=>{receive({type:'failed',token:s.token,error:{code:'RevisionConflict',message:'目录变化',retryable:false,details:{droppedLayoutConflict:true}}});return s.token;});
 expect(s.c.beginDropped(drop)).toBe(true);await waitFor(()=>expect(s.c.droppedLayoutConflict).toBe(true));
 const head={kind:'audio-annotator-organization' as const,formatVersion:1 as const,projectId:fixture.projectId,revision:9,layoutRevision:9,folders:[{id:drop.target.folderId,parentId:null,name:'目标'}],media:[]};
 let finish!:(v:{runtimeNonce:string;projectId:string;organization:typeof head})=>void;
 const api={get:vi.fn().mockImplementationOnce(()=>new Promise(r=>finish=r)).mockResolvedValue({runtimeNonce:nonce,projectId:fixture.projectId,organization:head}),apply:vi.fn()};
 const organization=new OrganizationController(fixture.projectId,nonce,true,api,s.owner);organization.snapshot={...head,revision:7,layoutRevision:7};
 render(<SourceImportDialog controller={s.c} organization={organization}/>);fireEvent.click(screen.getByRole('button',{name:'刷新并核对目标'}));expect(api.get).toHaveBeenCalledOnce();
 if(close==='external')await act(()=>s.c.cancel());else fireEvent.click(screen.getByRole('button',{name:close}));
 await waitFor(()=>expect(s.c.open).toBe(false));await act(()=>organization.refresh());expect(api.get).toHaveBeenCalledTimes(2);expect(organization.snapshot?.revision).toBe(9);
 await act(async()=>finish({runtimeNonce:nonce,projectId:fixture.projectId,organization:{...head,revision:12,layoutRevision:12}}));expect(organization.snapshot?.revision).toBe(9);expect(screen.queryByRole('button',{name:'确认目标并允许重新扫描'})).toBeNull();
});
function setup(count=257){
 const store=new ProjectStore({document:parseProjectDocument(structuredClone(fixture)),canUndo:false,canRedo:false});
 const commands:ProjectCommands={applyChange:vi.fn(async(_id,rev,change)=>{const s=structuredClone(store.snapshot);s.document.revision=rev+1;if(change.type==='importMedia')s.document.media.push(change.media);return s;}),getSnapshot:vi.fn(),undo:vi.fn(),redo:vi.fn()};
 const queue=new CommandQueue(store,commands), lifecycle=new ProjectLifecycle(store,queue,{save:vi.fn(async(_id,r)=>r),close:vi.fn()});
 const owner={store,queue,lifecycle,path:'D:/project'};
 const token={runtimeNonce:nonce,projectId:fixture.projectId,taskId:nonce};
 const counts={checked:count,candidates:count,skipped:0,duplicateSkipped:0,issues:0,selectedBytes:count*20};
 let scan!:(e:SourceEvent)=>void;const callbacks:((e:MediaEvent)=>void)[]=[];
 const api:SourceCommands={start:vi.fn(async(_id,_config,receive)=>{scan=receive;receive({type:'result',token,counts});return token;}),page:vi.fn(async(_t,offset,limit=256)=>({counts,issues:[],folderSummary:[],candidates:Array.from({length:Math.min(limit,count-offset)},(_,i)=>({index:offset+i,sourceIndex:0,sourceName:'a.zip',relativePath:`record${offset+i}/audio/CH2.wav`,displayName:`a.zip/record${offset+i}/audio/CH2.wav`,byteLength:20,logicalPosition:1,resultingFolderPath:[],originalFilename:'CH2.wav'}))})),cancel:vi.fn(async()=>{}),release:vi.fn(async()=>{}),batch:vi.fn(async(_token,_indices,receive)=>{callbacks.push(receive);return `batch${callbacks.length}`;})};
 const media:MediaCommands={start:vi.fn(),cancel:vi.fn(async()=>{}),release:vi.fn(async()=>{}),status:vi.fn(async()=>[])};
 const imports=new MediaImportController(store,queue,media,lifecycle), c=new SourceImportController(owner,imports,api);
 cleanup.push(()=>{c.dispose();imports.dispose();lifecycle.dispose();});
 const preview=async()=>{c.begin('zip');await c.choose(async()=>['D:/a.zip']);await c.scan();await waitFor(()=>expect(c.state).toBe('preview'));};
 const finish=(batch:number,ready=true)=>{const indices=vi.mocked(api.batch).mock.calls[batch-1][1];if(ready)indices.forEach((_,i)=>callbacks[batch-1]({type:'ready',taskId:`batch${batch}`,index:i,media:{...fixture.media[0],id:`00000000-0000-4000-8000-${String(batch*1000+i).padStart(12,'0')}`}}));callbacks[batch-1]({type:'finished',taskId:`batch${batch}`,cancelled:false});};
 return {c,api,media,imports,commands,queue,store,owner,token,counts,preview,finish,scan:(e:SourceEvent)=>scan(e)};
}
function dropOwner(s:ReturnType<typeof setup>) {
 Object.assign(s.owner,{collaboration:{runtimeNonce:nonce,projectFlavor:'default',identityMode:'profile',canWriteAnnotations:true,canImportMedia:true,hiddenMediaIds:[],catalogPending:false,actor:null,preferences:null}});
 const target={folderId:'33333333-3333-4333-8333-333333333333',layoutRevision:7};
 return {kind:'folder' as const,session:{projectId:fixture.projectId,runtimeNonce:nonce,shared:true},paths:['D:/folder'],target};
}
it('keeps the frozen revision for later dropped-source rescans',async()=>{
 const s=setup(1),drop=dropOwner(s),rules=structuredClone(s.c.plans.last.rules);
 expect(s.c.beginDropped(drop)).toBe(true);expect(s.c.open).toBe(true);expect(s.imports.occupied).toBe(true);
 await waitFor(()=>expect(s.c.canImport).toBe(true));
 expect(s.c.config).toMatchObject({kind:'folder',paths:drop.paths,rules,organization:{targetFolderId:drop.target.folderId}});
 expect(vi.mocked(s.api.start).mock.calls[0][3]).toEqual({runtimeNonce:nonce,expectedLayoutRevision:7});
 expect(s.api.batch).not.toHaveBeenCalled();
 await s.c.scan();await waitFor(()=>expect(s.c.canImport).toBe(true));
 expect(vi.mocked(s.api.start).mock.calls[1][3]).toEqual({runtimeNonce:nonce,expectedLayoutRevision:7});
 expect(JSON.stringify(s.c.plans.last)).not.toContain('layoutRevision');
 await s.c.cancel();expect(s.api.release).toHaveBeenCalled();expect(s.imports.occupied).toBe(false);
});
it('keeps direct and dropped source admission exclusive and releases a late cancelled scan',async()=>{
 const s=setup(1),drop=dropOwner(s);let resolve!:(token:typeof s.token)=>void;
 vi.mocked(s.api.start).mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));
 expect(s.c.beginDropped(drop)).toBe(true);
 expect(await s.imports.startDropped({kind:'audio',session:drop.session,paths:['D:/a.wav'],target:drop.target})).toBe(false);
 await waitFor(()=>expect(resolve).toBeDefined());await s.c.cancel();expect(s.imports.occupied).toBe(true);resolve(s.token);
 await waitFor(()=>expect(s.api.release).toHaveBeenCalledWith(s.token));
 await waitFor(()=>expect(s.imports.occupied).toBe(false));
 vi.mocked(s.media.start).mockImplementationOnce(async(_id,_paths,receive)=>{receive({type:'finished',taskId:'direct',cancelled:false});return 'direct';});
 expect(await s.imports.startDropped({kind:'audio',session:drop.session,paths:['D:/a.wav'],target:drop.target})).toBe(true);
 expect(()=>s.c.beginDropped({...drop,session:{...drop.session,runtimeNonce:drop.target.folderId}})).toThrow();
});
it('does not begin a dropped source while direct import owns admission',async()=>{
 const s=setup(1),drop=dropOwner(s);
 vi.mocked(s.media.start).mockResolvedValueOnce('direct');
 expect(await s.imports.startDropped({kind:'audio',session:drop.session,paths:['D:/a.wav'],target:drop.target})).toBe(true);
 expect(s.c.beginDropped(drop)).toBe(false);expect(s.api.start).not.toHaveBeenCalled();
 s.imports.cancel();
});
it('reports a stale dropped layout and rescans only on explicit confirmation',async()=>{
 const s=setup(1),drop=dropOwner(s);
 vi.mocked(s.api.start).mockImplementationOnce(async(_id,_config,receive)=>{
  receive({type:'failed',token:s.token,error:{code:'RevisionConflict',message:'目录布局已变化，请核对目标后重新扫描',retryable:false,details:{droppedLayoutConflict:true}}});return s.token;
 });
 expect(s.c.beginDropped(drop)).toBe(true);
 await waitFor(()=>expect(s.c.state).toBe('failed'));
 await waitFor(()=>expect(s.imports.occupied).toBe(false));
 expect(s.c.open).toBe(true);expect(s.c.error?.message).toContain('重新扫描');expect(s.c.droppedLayoutConflict).toBe(true);expect(s.api.batch).not.toHaveBeenCalled();
 await s.c.configure({...s.c.config.rules,recursive:false});expect(s.c.droppedLayoutConflict).toBe(true);
 await s.c.scan();expect(s.api.start).toHaveBeenCalledTimes(1);
 const review={projectId:drop.session.projectId,runtimeNonce:drop.session.runtimeNonce,targetFolderId:drop.target.folderId,layoutRevision:8};
 expect(s.c.acknowledgeDroppedLayoutReview({...review,projectId:'other'})).toBe(false);
 expect(s.c.acknowledgeDroppedLayoutReview({...review,runtimeNonce:'other'})).toBe(false);
 expect(s.c.acknowledgeDroppedLayoutReview({...review,targetFolderId:null})).toBe(false);
 expect(s.c.acknowledgeDroppedLayoutReview({...review,layoutRevision:-1})).toBe(false);
 expect(s.c.droppedLayoutConflict).toBe(true);
 expect(s.c.acknowledgeDroppedLayoutReview(review)).toBe(true);expect(s.c.droppedLayoutConflict).toBe(false);
 await s.c.scan();await waitFor(()=>expect(s.c.canImport).toBe(true));
 expect(vi.mocked(s.api.start).mock.calls[1][3]).toEqual({runtimeNonce:nonce,expectedLayoutRevision:8});
 await s.c.scan();await waitFor(()=>expect(s.c.canImport).toBe(true));
 expect(vi.mocked(s.api.start).mock.calls[2][3]).toEqual({runtimeNonce:nonce,expectedLayoutRevision:8});
});
it.each(['rename','move','delete'] as const)('gates a rescan after a remote target %s following a successful preview',async change=>{
 const s=setup(1),drop=dropOwner(s),original=vi.mocked(s.api.start).getMockImplementation()!;
 let changed=false;
 vi.mocked(s.api.start).mockImplementation(async(...args)=>{
  if(!changed)return original(...args);
  expect(args[3]).toEqual({runtimeNonce:nonce,expectedLayoutRevision:7});
  args[2]({type:'failed',token:s.token,error:{code:change==='delete'?'InvalidInput':'RevisionConflict',message:'目标目录已变化',retryable:false,details:{droppedLayoutConflict:true}}});return s.token;
 });
 expect(s.c.beginDropped(drop)).toBe(true);await waitFor(()=>expect(s.c.canImport).toBe(true));
 await s.c.configure({...s.c.config.rules,recursive:false});changed=true;await s.c.scan();
 expect(s.c.droppedLayoutConflict).toBe(true);expect(s.c.canImport).toBe(false);await s.c.scan();expect(s.api.start).toHaveBeenCalledTimes(2);
});
it('leaves ordinary menu rescans unconstrained and gates a changed dropped target after preview',async()=>{
 const menu=setup(1);await menu.preview();await menu.c.configure({...menu.c.config.rules,recursive:false});await menu.c.scan();
 await waitFor(()=>expect(menu.c.canImport).toBe(true));expect(vi.mocked(menu.api.start).mock.calls[1][3]).toBeUndefined();
 const s=setup(1),drop=dropOwner(s);expect(s.c.beginDropped(drop)).toBe(true);await waitFor(()=>expect(s.c.canImport).toBe(true));
 await s.c.configurePlan({organization:{...s.c.config.organization,targetFolderId:null}});
 expect(s.c.droppedLayoutConflict).toBe(true);await s.c.scan();expect(s.api.start).toHaveBeenCalledTimes(1);
 expect(s.c.acknowledgeDroppedLayoutReview({projectId:drop.session.projectId,runtimeNonce:nonce,targetFolderId:null,layoutRevision:8})).toBe(true);
 await s.c.scan();await waitFor(()=>expect(s.c.canImport).toBe(true));expect(vi.mocked(s.api.start).mock.calls[1][3]).toEqual({runtimeNonce:nonce,expectedLayoutRevision:8});
});
it('gates another explicit review when the reviewed layout changes before the retry',async()=>{
 const s=setup(1),drop=dropOwner(s);
 const conflict={code:'RevisionConflict' as const,message:'目录布局已变化',retryable:false,details:{droppedLayoutConflict:true}};
 vi.mocked(s.api.start).mockRejectedValueOnce(conflict).mockRejectedValueOnce(conflict);
 expect(s.c.beginDropped(drop)).toBe(true);await waitFor(()=>expect(s.c.droppedLayoutConflict).toBe(true));
 const review={projectId:drop.session.projectId,runtimeNonce:drop.session.runtimeNonce,targetFolderId:drop.target.folderId,layoutRevision:8};
 expect(s.c.acknowledgeDroppedLayoutReview(review)).toBe(true);await s.c.scan();
 expect(vi.mocked(s.api.start).mock.calls[1][3]).toEqual({runtimeNonce:nonce,expectedLayoutRevision:8});
 expect(s.c.droppedLayoutConflict).toBe(true);await s.c.scan();expect(s.api.start).toHaveBeenCalledTimes(2);
 expect(s.c.acknowledgeDroppedLayoutReview({...review,layoutRevision:9})).toBe(true);
 await s.c.scan();await waitFor(()=>expect(s.c.canImport).toBe(true));
 expect(vi.mocked(s.api.start).mock.calls[2][3]).toEqual({runtimeNonce:nonce,expectedLayoutRevision:9});
});
it('requires a new target review if the target changes after acknowledgment',async()=>{
 const s=setup(1),drop=dropOwner(s);
 vi.mocked(s.api.start).mockRejectedValueOnce({code:'RevisionConflict',message:'目录布局已变化',retryable:false,details:{droppedLayoutConflict:true}});
 expect(s.c.beginDropped(drop)).toBe(true);await waitFor(()=>expect(s.c.droppedLayoutConflict).toBe(true));
 const review={projectId:drop.session.projectId,runtimeNonce:drop.session.runtimeNonce,targetFolderId:drop.target.folderId,layoutRevision:8};
 expect(s.c.acknowledgeDroppedLayoutReview(review)).toBe(true);
 await s.c.configurePlan({organization:{...s.c.config.organization,targetFolderId:null}});
 expect(s.c.droppedLayoutConflict).toBe(true);await s.c.scan();expect(s.api.start).toHaveBeenCalledTimes(1);
 expect(s.c.acknowledgeDroppedLayoutReview(review)).toBe(false);
 expect(s.c.acknowledgeDroppedLayoutReview({...review,targetFolderId:null})).toBe(true);
 await s.c.scan();await waitFor(()=>expect(s.c.canImport).toBe(true));
 expect(vi.mocked(s.api.start).mock.calls[1][3]).toEqual({runtimeNonce:nonce,expectedLayoutRevision:8});
});
it('reports a stale native session during dropped scan admission',async()=>{
 const s=setup(1),drop=dropOwner(s);
 vi.mocked(s.api.start).mockRejectedValueOnce({code:'RevisionConflict',message:'Project or collaboration identity changed',retryable:false});
 expect(s.c.beginDropped(drop)).toBe(true);
 await waitFor(()=>expect(s.c.state).toBe('failed'));
 expect(s.c.error?.message).toBe('Project or collaboration identity changed');expect(s.c.droppedLayoutConflict).toBe(false);expect(s.imports.occupied).toBe(false);
 await s.c.cancel();
});
it('retains the original drop revision when a transient admission fails and the user retries',async()=>{
 const s=setup(1),drop=dropOwner(s);
 const conflict={code:'RevisionConflict' as const,message:'目录布局已变化',retryable:false,details:{droppedLayoutConflict:true}};
 vi.mocked(s.api.start).mockRejectedValueOnce({code:'ResourceLimit',message:'temporarily busy',retryable:true}).mockRejectedValueOnce(conflict);
 expect(s.c.beginDropped(drop)).toBe(true);await waitFor(()=>expect(s.c.state).toBe('failed'));
 await s.c.scan();expect(vi.mocked(s.api.start).mock.calls[1][3]).toEqual({runtimeNonce:nonce,expectedLayoutRevision:7});
 expect(s.c.droppedLayoutConflict).toBe(true);await s.c.scan();expect(s.api.start).toHaveBeenCalledTimes(2);
});
it('keeps the initial constraint when a rule change releases a scan without any later event',async()=>{
 const s=setup(1),drop=dropOwner(s);let resolve!:(token:typeof s.token)=>void;
 vi.mocked(s.api.start).mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));
 expect(s.c.beginDropped(drop)).toBe(true);await waitFor(()=>expect(resolve).toBeDefined());
 await s.c.configure({...s.c.config.rules,recursive:false});resolve(s.token);
 await waitFor(()=>expect(s.c.scanStartPending).toBe(false));await waitFor(()=>expect(s.api.release).toHaveBeenCalledWith(s.token));
 vi.mocked(s.api.start).mockRejectedValueOnce({code:'RevisionConflict',message:'目录布局已变化',retryable:false,details:{droppedLayoutConflict:true}});
 await s.c.scan();expect(vi.mocked(s.api.start).mock.calls[1][3]).toEqual({runtimeNonce:nonce,expectedLayoutRevision:7});
 expect(s.c.droppedLayoutConflict).toBe(true);
});
it('gates a target change while the original dropped layout is still unresolved',async()=>{
 const s=setup(1),drop=dropOwner(s);let resolve!:(token:typeof s.token)=>void;
 vi.mocked(s.api.start).mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));
 expect(s.c.beginDropped(drop)).toBe(true);await waitFor(()=>expect(resolve).toBeDefined());
 await s.c.configurePlan({organization:{...s.c.config.organization,targetFolderId:null}});
 expect(s.c.droppedLayoutConflict).toBe(true);resolve(s.token);await waitFor(()=>expect(s.c.scanStartPending).toBe(false));
 await s.c.scan();expect(s.api.start).toHaveBeenCalledTimes(1);
 const review={projectId:drop.session.projectId,runtimeNonce:nonce,targetFolderId:null,layoutRevision:8};
 expect(s.c.acknowledgeDroppedLayoutReview(review)).toBe(true);await s.c.scan();
 await waitFor(()=>expect(s.c.canImport).toBe(true));expect(vi.mocked(s.api.start).mock.calls[1][3]).toEqual({runtimeNonce:nonce,expectedLayoutRevision:8});
});
it('keeps dropped paths and the frozen revision if rules change as the dialog opens',async()=>{
 const s=setup(1),drop=dropOwner(s);let changed=false;
 const unsubscribe=s.c.subscribe(()=>{if(!changed&&s.c.open&&s.c.state==='choosing'){changed=true;void s.c.configure({...s.c.config.rules,recursive:false});}});
 expect(s.c.beginDropped(drop)).toBe(true);unsubscribe();expect(s.c.config.paths).toEqual(drop.paths);
 await s.c.scan();await waitFor(()=>expect(s.c.canImport).toBe(true));
 expect(vi.mocked(s.api.start).mock.calls[0][3]).toEqual({runtimeNonce:nonce,expectedLayoutRevision:7});
});
it('retains the frozen revision after a transient preview page failure',async()=>{
 const s=setup(1),drop=dropOwner(s);
 vi.mocked(s.api.page).mockRejectedValueOnce({code:'SaveFailed',message:'temporary page failure',retryable:true});
 expect(s.c.beginDropped(drop)).toBe(true);await waitFor(()=>expect(s.c.state).toBe('failed'));
 expect(s.c.droppedLayoutConflict).toBe(false);await s.c.scan();await waitFor(()=>expect(s.c.canImport).toBe(true));
 expect(vi.mocked(s.api.start).mock.calls[1][3]).toEqual({runtimeNonce:nonce,expectedLayoutRevision:7});
});
it('gates page layout conflicts and checks the reviewed revision again on retry',async()=>{
 const s=setup(1),drop=dropOwner(s);
 const conflict={code:'RevisionConflict' as const,message:'目录布局已变化',retryable:false,details:{droppedLayoutConflict:true}};
 vi.mocked(s.api.page).mockRejectedValueOnce(conflict).mockRejectedValueOnce(conflict);
 expect(s.c.beginDropped(drop)).toBe(true);await waitFor(()=>expect(s.c.droppedLayoutConflict).toBe(true));
 expect(s.c.canImport).toBe(false);await s.c.scan();expect(s.api.start).toHaveBeenCalledTimes(1);
 const review={projectId:drop.session.projectId,runtimeNonce:nonce,targetFolderId:drop.target.folderId,layoutRevision:8};
 expect(s.c.acknowledgeDroppedLayoutReview(review)).toBe(true);await s.c.scan();
 await waitFor(()=>expect(s.c.droppedLayoutConflict).toBe(true));expect(vi.mocked(s.api.start).mock.calls[1][3]).toEqual({runtimeNonce:nonce,expectedLayoutRevision:8});
 expect(s.c.acknowledgeDroppedLayoutReview({...review,layoutRevision:9})).toBe(true);await s.c.scan();await waitFor(()=>expect(s.c.canImport).toBe(true));
 expect(vi.mocked(s.api.start).mock.calls[2][3]).toEqual({runtimeNonce:nonce,expectedLayoutRevision:9});
});
it('gates a removed target discovered on a later preview page',async()=>{
 const s=setup(1),drop=dropOwner(s);
 expect(s.c.beginDropped(drop)).toBe(true);await waitFor(()=>expect(s.c.canImport).toBe(true));
 vi.mocked(s.api.page).mockRejectedValueOnce({code:'InvalidInput',message:'目标文件夹已不存在',retryable:false,details:{droppedLayoutConflict:true}});
 await s.c.loadPage(0);expect(s.c.droppedLayoutConflict).toBe(true);expect(s.c.canImport).toBe(false);
 await s.c.scan();expect(s.api.start).toHaveBeenCalledTimes(1);
});
it('guards a layout conflict rejected by the initial scan RPC',async()=>{
 const s=setup(1),drop=dropOwner(s);
 vi.mocked(s.api.start).mockRejectedValueOnce({code:'RevisionConflict',message:'目录布局已变化',retryable:false,details:{droppedLayoutConflict:true}});
 expect(s.c.beginDropped(drop)).toBe(true);await waitFor(()=>expect(s.c.state).toBe('failed'));
 expect(s.c.droppedLayoutConflict).toBe(true);await s.c.scan();expect(s.api.start).toHaveBeenCalledTimes(1);
});
it('keeps a late layout RPC rejection after editing, but ignores it after cancellation',async()=>{
 for(const cancelled of [false,true]){
  const s=setup(1),drop=dropOwner(s);let reject!:(error:unknown)=>void;
  vi.mocked(s.api.start).mockImplementationOnce(()=>new Promise((_resolve,r)=>{reject=r;}));
  expect(s.c.beginDropped(drop)).toBe(true);await waitFor(()=>expect(reject).toBeDefined());
  if(cancelled)await s.c.cancel();else await s.c.configure({...s.c.config.rules,recursive:false});
  reject({code:'RevisionConflict',message:'目录布局已变化',retryable:false,details:{droppedLayoutConflict:true}});
  await waitFor(()=>expect(s.c.scanStartPending).toBe(false));
  if(!cancelled){await waitFor(()=>expect(s.c.droppedLayoutConflict).toBe(true));await s.c.scan();expect(s.api.start).toHaveBeenCalledTimes(1);}
  else expect(s.c.droppedLayoutConflict).toBe(false);
 }
});
it('keeps a late layout event after editing and releases the retired start',async()=>{
 const s=setup(1),drop=dropOwner(s);let receive!:(event:SourceEvent)=>void;let resolve!:(token:typeof s.token)=>void;
 vi.mocked(s.api.start).mockImplementationOnce((_id,_config,callback)=>{receive=callback;return new Promise(r=>{resolve=r;});});
 expect(s.c.beginDropped(drop)).toBe(true);await waitFor(()=>expect(resolve).toBeDefined());
 await s.c.configure({...s.c.config.rules,recursive:false});
 act(()=>receive({type:'failed',token:s.token,error:{code:'RevisionConflict',message:'目录布局已变化',retryable:false,details:{droppedLayoutConflict:true}}}));
 expect(s.c.droppedLayoutConflict).toBe(true);expect(s.c.canImport).toBe(false);
 await act(async()=>{resolve(s.token);});await waitFor(()=>expect(s.api.release).toHaveBeenCalledWith(s.token));
 await s.c.scan();expect(s.api.start).toHaveBeenCalledTimes(1);
});
it('ignores an old conflict after a newer scan validates the same frozen revision',async()=>{
 const s=setup(1),drop=dropOwner(s);let receive!:(event:SourceEvent)=>void;
 const oldToken={...s.token,taskId:'44444444-4444-4444-8444-444444444444'};
 vi.mocked(s.api.start).mockImplementationOnce(async(_id,_config,callback)=>{receive=callback;return oldToken;});
 expect(s.c.beginDropped(drop)).toBe(true);await waitFor(()=>expect(receive).toBeDefined());await waitFor(()=>expect(s.c.scanStartPending).toBe(false));
 await s.c.configure({...s.c.config.rules,recursive:false});await s.c.scan();await waitFor(()=>expect(s.c.canImport).toBe(true));
 act(()=>receive({type:'failed',token:oldToken,error:{code:'RevisionConflict',message:'目录布局已变化',retryable:false,details:{droppedLayoutConflict:true}}}));
 expect(s.c.droppedLayoutConflict).toBe(false);expect(s.c.state).toBe('preview');expect(s.c.canImport).toBe(true);
 expect(s.api.release).not.toHaveBeenCalledWith(s.token);
});
it('ignores an old conflict after explicit review and a newer verified preview',async()=>{
 const s=setup(1),drop=dropOwner(s);let receive!:(event:SourceEvent)=>void;
 const oldToken={...s.token,taskId:'44444444-4444-4444-8444-444444444444'};
 vi.mocked(s.api.start).mockImplementationOnce(async(_id,_config,callback)=>{receive=callback;return oldToken;});
 expect(s.c.beginDropped(drop)).toBe(true);await waitFor(()=>expect(receive).toBeDefined());await waitFor(()=>expect(s.c.scanStartPending).toBe(false));
 await s.c.configurePlan({organization:{...s.c.config.organization,targetFolderId:null}});expect(s.c.droppedLayoutConflict).toBe(true);
 expect(s.c.acknowledgeDroppedLayoutReview({projectId:drop.session.projectId,runtimeNonce:nonce,targetFolderId:null,layoutRevision:8})).toBe(true);
 await s.c.scan();await waitFor(()=>expect(s.c.canImport).toBe(true));
 act(()=>receive({type:'failed',token:oldToken,error:{code:'RevisionConflict',message:'旧目录已变化',retryable:false,details:{droppedLayoutConflict:true}}}));
 expect(s.c.droppedLayoutConflict).toBe(false);expect(s.c.state).toBe('preview');expect(s.c.canImport).toBe(true);
 expect(s.api.release).not.toHaveBeenCalledWith(s.token);
});
it('ignores a late layout event from a cancelled and replaced preview',async()=>{
 const s=setup(1),drop=dropOwner(s);let receive!:(event:SourceEvent)=>void;
 vi.mocked(s.api.start).mockImplementationOnce(async(_id,_config,callback)=>{receive=callback;return s.token;});
 expect(s.c.beginDropped(drop)).toBe(true);await waitFor(()=>expect(receive).toBeDefined());await waitFor(()=>expect(s.c.scanStartPending).toBe(false));
 await s.c.cancel();expect(s.c.begin('zip')).toBe(true);
 act(()=>receive({type:'failed',token:s.token,error:{code:'RevisionConflict',message:'目录布局已变化',retryable:false,details:{droppedLayoutConflict:true}}}));
 expect(s.c.droppedLayoutConflict).toBe(false);expect(s.c.state).toBe('choosing');
});
it('does not mistake unrelated asynchronous revision errors for layout conflicts',async()=>{
 const s=setup(1),drop=dropOwner(s);let receive!:(event:SourceEvent)=>void;
 vi.mocked(s.api.start).mockImplementationOnce(async(_id,_config,callback)=>{receive=callback;return s.token;});
 expect(s.c.beginDropped(drop)).toBe(true);await waitFor(()=>expect(receive).toBeDefined());
 act(()=>receive({type:'failed',token:s.token,error:{code:'RevisionConflict',message:'unrelated revision',retryable:false,details:{droppedLayoutConflict:'true'}}}));
 expect(s.c.droppedLayoutConflict).toBe(false);
});
it('guards a removed target reported by an asynchronous initial scan event',async()=>{
 const s=setup(1),drop=dropOwner(s);let receive!:(event:SourceEvent)=>void;
 vi.mocked(s.api.start).mockImplementationOnce(async(_id,_config,callback)=>{receive=callback;return s.token;});
 expect(s.c.beginDropped(drop)).toBe(true);await waitFor(()=>expect(receive).toBeDefined());
 act(()=>receive({type:'failed',token:s.token,error:{code:'InvalidInput',message:'目标文件夹已不存在',retryable:false,details:{droppedLayoutConflict:true}}}));
 expect(s.c.droppedLayoutConflict).toBe(true);await s.c.scan();expect(s.api.start).toHaveBeenCalledTimes(1);
 render(<SourceImportDialog controller={s.c}/>);
 expect(screen.getByText('目录已变化，请刷新目录并核对目标后再重新扫描')).toBeVisible();
 expect(screen.getByRole('button',{name:'扫描预览'})).toBeDisabled();
});
it('disables and labels Scan while an invalidated dropped scan start is settling',async()=>{
 const s=setup(1),drop=dropOwner(s);let resolve!:(token:typeof s.token)=>void;
 vi.mocked(s.api.start).mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));
 expect(s.c.beginDropped(drop)).toBe(true);render(<SourceImportDialog controller={s.c}/>);
 await waitFor(()=>expect(resolve).toBeDefined());
 fireEvent.click(screen.getByRole('checkbox',{name:'跳过重复音频'}));
 await waitFor(()=>expect(s.c.state).toBe('choosing'));
 expect(screen.getByRole('button',{name:'正在结束上次扫描…'})).toBeDisabled();
 await act(async()=>{resolve(s.token);});
 await waitFor(()=>expect(screen.getByRole('button',{name:'扫描预览'})).toBeEnabled());
 fireEvent.click(screen.getByRole('button',{name:'扫描预览'}));
 await waitFor(()=>expect(s.api.start).toHaveBeenCalledTimes(2));
 expect(vi.mocked(s.api.start).mock.calls[1][1].rules.skipDuplicates).toBe(false);
 expect(vi.mocked(s.api.start).mock.calls[1][3]).toEqual({runtimeNonce:nonce,expectedLayoutRevision:7});
});
it('does not start a dropped scan if its owner cancels during the scanning notification',async()=>{
 const s=setup(1),drop=dropOwner(s);
 const unsubscribe=s.c.subscribe(()=>{if(s.c.state==='scanning')void s.c.cancel();});
 expect(s.c.beginDropped(drop)).toBe(true);
 await waitFor(()=>expect(s.c.state).toBe('cancelled'));
 await waitFor(()=>expect(s.imports.occupied).toBe(false));
 expect(s.api.start).not.toHaveBeenCalled();unsubscribe();
});
it('does not start a dropped scan if the preview is cancelled as it opens',async()=>{
 const s=setup(1),drop=dropOwner(s);
 const unsubscribe=s.c.subscribe(()=>{if(s.c.open && s.c.state==='choosing')void s.c.cancel();});
 expect(s.c.beginDropped(drop)).toBe(true);
 await waitFor(()=>expect(s.imports.occupied).toBe(false));
 expect(s.c.state).toBe('cancelled');expect(s.api.start).not.toHaveBeenCalled();unsubscribe();
});
it('previews early results without import, then imports 257 in bounded sequential batches',async()=>{
 const s=setup();await s.preview();expect(s.api.batch).not.toHaveBeenCalled();expect(s.imports.occupied).toBe(true);
 void s.c.importAll();await waitFor(()=>expect(s.api.batch).toHaveBeenCalledTimes(1));expect(vi.mocked(s.api.batch).mock.calls[0][1]).toHaveLength(256);
 s.finish(1);await waitFor(()=>expect(s.api.batch).toHaveBeenCalledTimes(2));expect(vi.mocked(s.api.batch).mock.calls[1][1]).toEqual([256]);s.finish(2);
 await waitFor(()=>expect(s.c.state).toBe('finished'));expect(s.c.items[256].index).toBe(256);expect(s.media.start).not.toHaveBeenCalled();expect(s.api.release).toHaveBeenCalledWith(s.token);
});
it('invalidates preview on rule change and ignores retired scan events',async()=>{const s=setup(1);await s.preview();await s.c.configure({...s.c.config.rules,include:['*/CH1','*/CH2'],includeSecond:false});expect(s.c.state).toBe('choosing');await s.c.importAll();expect(s.api.batch).not.toHaveBeenCalled();s.scan({type:'result',token:s.token,counts:s.counts});expect(s.c.state).toBe('choosing');expect(s.api.release).toHaveBeenCalled();});
it('keeps failed preview release visible and retryable before rescanning',async()=>{const s=setup(1);await s.preview();vi.mocked(s.api.release).mockRejectedValueOnce(new Error('release failed'));await s.c.configure({...s.c.config.rules,includeSecond:false});expect(s.c.releasePending).toBe(true);expect(s.c.error).toBeTruthy();await s.c.scan();expect(s.api.start).toHaveBeenCalledTimes(2);await waitFor(()=>expect(s.c.state).toBe('preview'));});
it('pauses next batch for publication or acknowledgement failure and retries retained owners',async()=>{const s=setup();await s.preview();vi.mocked(s.media.release).mockRejectedValueOnce(new Error('ack failed'));void s.c.importAll();await waitFor(()=>expect(s.api.batch).toHaveBeenCalledTimes(1));s.finish(1);await waitFor(()=>expect(s.c.state).toBe('paused'));expect(s.api.batch).toHaveBeenCalledTimes(1);await s.c.retry();await waitFor(()=>expect(s.api.batch).toHaveBeenCalledTimes(2));s.finish(2);await waitFor(()=>expect(s.c.state).toBe('finished'));});
it('project replacement cancels and ignores delayed work; picker cancellation retains configuration',async()=>{const s=setup(1);s.c.begin('zip');await s.c.choose(async()=>null);expect(s.c.state).toBe('choosing');expect(s.api.start).not.toHaveBeenCalled();await s.c.choose(async()=>['D:/a.zip']);await s.c.scan();await waitFor(()=>expect(s.c.state).toBe('preview'));s.c.dispose();s.scan({type:'result',token:s.token,counts:s.counts});expect(s.api.batch).not.toHaveBeenCalled();expect(s.api.release).toHaveBeenCalled();});
it('renders compact editable presets, second route, pattern syntax and explicit preview import',async()=>{
 const s=setup(1);s.c.begin('zip');render(<SourceImportDialog controller={s.c} picker={async()=>['D:/a.zip','D:/b.zip']} />);
 fireEvent.change(screen.getByLabelText('导入方案'),{target:{value:'jingcheng-result'}});await waitFor(()=>expect(screen.getByLabelText('导入第二路音频')).toBeChecked());
 fireEvent.click(screen.getByLabelText('导入第二路音频'));expect(s.c.config.rules.includeSecond).toBe(false);
 fireEvent.click(screen.getByText('高级设置'));
 fireEvent.change(screen.getByLabelText('包含路径'),{target:{value:'*/CH1, */CH2'}});expect(s.c.config.rules.include).toEqual(['*/CH1','*/CH2']);
 fireEvent.click(screen.getByText('选择 ZIP…'));await waitFor(()=>expect(s.c.config.paths).toHaveLength(2));
 await act(()=>s.c.scan());await waitFor(()=>expect(screen.getByText('导入 1 个音频')).toBeEnabled());expect(s.api.batch).not.toHaveBeenCalled();
 expect(screen.getByTitle('a.zip/record0/audio/CH2.wav')).toBeVisible();
});
it('shows record identity and filename with full searchable accessible structured name',()=>{
 const name='very-long-common-archive.zip/records/record-unique-102/audio/CH2.wav';
 render(<MediaList media={[{...fixture.media[0],displayName:name}]} annotations={[]} statuses={[]} selectedId={null} disabled={false} onSelect={vi.fn()} onImport={vi.fn()} onRelink={vi.fn()}/>);
 expect(screen.getByRole('button',{name}).title).toContain(name);expect(screen.getByText('record-unique-102')).toBeVisible();expect(screen.getByText('CH2.wav')).toBeVisible();
 fireEvent.change(screen.getByLabelText('搜索音频'),{target:{value:'very-long-common-archive'}});expect(screen.getByRole('button',{name})).toBeVisible();
});
it('does not resurrect a cancelled scan when start acknowledgement rejects late',async()=>{const s=setup(1);let reject!:(e:unknown)=>void;vi.mocked(s.api.start).mockImplementation(()=>new Promise((_r,j)=>{reject=j;}));s.c.begin('zip');await s.c.choose(async()=>['D:/a.zip']);const scanning=s.c.scan();await waitFor(()=>expect(s.api.start).toHaveBeenCalled());await s.c.cancel();reject(new Error('late transport'));await scanning;expect(s.c.state).toBe('cancelled');});
it('keeps authoritative final counts when a late progress event arrives',async()=>{const s=setup(1);await s.preview();s.scan({type:'progress',token:s.token,counts:{...s.counts,candidates:8}});expect(s.c.counts.candidates).toBe(1);});
it('pauses publication failure and explicitly discards only its retained items',async()=>{const s=setup(257);await s.preview();vi.mocked(s.commands.applyChange).mockRejectedValueOnce({code:'SaveFailed',message:'disk full',retryable:true});void s.c.importAll();await waitFor(()=>expect(s.api.batch).toHaveBeenCalledTimes(1));s.finish(1);await waitFor(()=>expect(s.c.state).toBe('paused'));expect(s.api.batch).toHaveBeenCalledTimes(1);expect(s.c.failures.length).toBeGreaterThan(0);await s.c.end();expect(s.c.failures).toHaveLength(0);expect(s.api.release).toHaveBeenCalled();});
it('ends stale dropped publications without losing committed audio and requires reviewed rescanning',async()=>{
 const s=setup(2),drop=dropOwner(s),before=s.store.snapshot.document.media.length;
 const original=vi.mocked(s.commands.applyChange).getMockImplementation()!;let rejectPublication!:(error:unknown)=>void;
 vi.mocked(s.commands.getSnapshot).mockImplementation(async()=>structuredClone(s.store.snapshot));
 vi.mocked(s.commands.applyChange).mockImplementation((...args)=>{
  const change=args[2];
  if(change.type==='importMedia'&&change.media.id.endsWith('1001'))return new Promise((_resolve,reject)=>{rejectPublication=reject;});
  return original(...args);
 });
 expect(s.c.beginDropped(drop)).toBe(true);await waitFor(()=>expect(s.c.canImport).toBe(true));
 render(<><SourceImportDialog controller={s.c}/><SourceImportProgress controller={s.c}/></>);
 act(()=>{void s.c.importAll();});await waitFor(()=>expect(s.api.batch).toHaveBeenCalledOnce());act(()=>s.finish(1));
 await waitFor(()=>expect(rejectPublication).toBeDefined());expect(s.store.snapshot.document.media.length).toBe(before+1);
 await act(async()=>{rejectPublication({code:'RevisionConflict',message:'Organization layout changed',retryable:false});});
 await waitFor(()=>expect(s.c.state).toBe('paused'));
 expect(s.c.staleDroppedPublication).toBe(true);expect(s.c.successCount).toBe(1);expect(s.c.failures).toHaveLength(1);
 expect(screen.getByText(/此前成功导入的音频仍保留/)).toBeVisible();expect(screen.getByRole('button',{name:'重试并继续导入'})).toBeDisabled();
 await s.c.retry();expect(s.commands.applyChange).toHaveBeenCalledTimes(2);expect(s.c.failures).toHaveLength(1);
 fireEvent.click(screen.getByRole('button',{name:'结束并放弃失败项'}));
 await waitFor(()=>expect(screen.getByRole('button',{name:'重新配置并扫描'})).toBeVisible());
 expect(s.queue.unresolvedFailures).toHaveLength(0);expect(s.store.snapshot.document.media.length).toBe(before+1);
 expect(s.media.release).toHaveBeenCalledWith('batch1','00000000-0000-4000-8000-000000001001');
 fireEvent.click(screen.getByRole('button',{name:'重新配置并扫描'}));expect(s.c.droppedLayoutConflict).toBe(true);
 await s.c.scan();expect(s.api.start).toHaveBeenCalledTimes(1);
 expect(s.c.acknowledgeDroppedLayoutReview({projectId:drop.session.projectId,runtimeNonce:nonce,targetFolderId:drop.target.folderId,layoutRevision:8})).toBe(true);
 await act(()=>s.c.scan());await waitFor(()=>expect(s.c.canImport).toBe(true));
 expect(vi.mocked(s.api.start).mock.calls[1][3]).toEqual({runtimeNonce:nonce,expectedLayoutRevision:8});
});
it('retains normal retry for other dropped-source publication failures',async()=>{
 const s=setup(1),drop=dropOwner(s);
 vi.mocked(s.commands.applyChange).mockRejectedValueOnce({code:'SaveFailed',message:'temporary',retryable:true});
 expect(s.c.beginDropped(drop)).toBe(true);await waitFor(()=>expect(s.c.canImport).toBe(true));
 void s.c.importAll();await waitFor(()=>expect(s.api.batch).toHaveBeenCalledOnce());s.finish(1);await waitFor(()=>expect(s.c.state).toBe('paused'));
 expect(s.c.staleDroppedPublication).toBe(false);expect(s.c.canRetry).toBe(true);await s.c.retry();
 await waitFor(()=>expect(s.c.state).toBe('finished'));expect(s.commands.applyChange).toHaveBeenCalledTimes(2);
});
it('blocks other stale prepared items but permits already-committed adoptions to retry',async()=>{
 const s=setup(3),drop=dropOwner(s);
 vi.mocked(s.commands.getSnapshot).mockImplementation(async()=>structuredClone(s.store.snapshot));
 vi.mocked(s.commands.applyChange).mockRejectedValueOnce({code:'RevisionConflict',message:'Organization layout changed',retryable:false})
  .mockRejectedValueOnce({code:'SaveFailed',message:'temporary write failure',retryable:true})
  .mockRejectedValueOnce({code:'SaveFailed',message:'adoption pending',retryable:true,details:{catalogCommitted:true,catalogAdoptionRequired:true,mediaId:'00000000-0000-4000-8000-000000001002'}});
 expect(s.c.beginDropped(drop)).toBe(true);await waitFor(()=>expect(s.c.canImport).toBe(true));
 void s.c.importAll();await waitFor(()=>expect(s.api.batch).toHaveBeenCalledOnce());s.finish(1);await waitFor(()=>expect(s.c.state).toBe('paused'));
 expect(s.c.failures).toHaveLength(3);expect(s.c.staleDroppedPublication).toBe(true);expect(s.c.canRetry).toBe(true);
 await s.c.retry();expect(s.c.failures).toHaveLength(2);expect(s.c.successCount).toBe(1);expect(s.c.canRetry).toBe(false);
 expect(s.commands.applyChange).toHaveBeenCalledTimes(4);await s.c.end();expect(s.c.failures).toHaveLength(0);
});
it('keeps failed scan configuration for retry and never publishes a source-change error',async()=>{const s=setup(1);s.c.begin('zip');await s.c.choose(async()=>['D:/a.zip']);vi.mocked(s.api.start).mockRejectedValueOnce({code:'ResourceLimit',message:'worker draining',retryable:true});await s.c.scan();expect(s.c.state).toBe('failed');expect(s.c.config.paths).toEqual(['D:/a.zip']);await s.c.scan();await waitFor(()=>expect(s.c.state).toBe('preview'));vi.mocked(s.api.batch).mockRejectedValueOnce({code:'IdentityMismatch',message:'source changed; rescan',retryable:false});await s.c.importAll();expect(s.c.state).toBe('failed');expect(s.c.error?.code).toBe('IdentityMismatch');expect(s.commands.applyChange).not.toHaveBeenCalled();});
it('loads bounded preview pages and ignores an obsolete delayed page',async()=>{const s=setup();await s.preview();await s.c.loadPage(50);expect(s.c.page?.candidates[0].index).toBe(50);let resolve!:(p:Awaited<ReturnType<SourceCommands['page']>>)=>void;vi.mocked(s.api.page).mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));const loading=s.c.loadPage(100);await s.c.configure({...s.c.config.rules,include:['*/CH2']});resolve({counts:s.counts,candidates:[],issues:[],folderSummary:[]});await loading;expect(s.c.page).toBeNull();expect(s.c.state).toBe('choosing');});
it('saves and deletes custom rules through the dialog while preserving builtins',async()=>{const s=setup(1);s.c.begin('folder');render(<SourceImportDialog controller={s.c}/>);fireEvent.click(screen.getByText('高级设置'));fireEvent.change(screen.getByLabelText('新方案名称'),{target:{value:'本机 CH 规则'}});fireEvent.click(screen.getByText('保存'));await waitFor(()=>expect(screen.getByText('删除')).toBeEnabled());expect(screen.getByRole('option',{name:'本机 CH 规则'})).toBeInTheDocument();fireEvent.click(screen.getByText('删除'));expect(screen.queryByRole('option',{name:'本机 CH 规则'})).not.toBeInTheDocument();fireEvent.change(screen.getByLabelText('导入方案'),{target:{value:'generic-source'}});expect(screen.getByText('删除')).toBeDisabled();});
it('retains failed release of a late cancelled Ready for explicit acknowledgement retry',async()=>{const s=setup(1);await s.preview();void s.c.importAll();await waitFor(()=>expect(s.api.batch).toHaveBeenCalled());await s.c.cancel();vi.mocked(s.media.release).mockRejectedValueOnce(new Error('release unavailable'));s.finish(1);await s.imports.settled();expect(s.imports.pendingAcknowledgements).toHaveLength(1);await s.imports.retryAcknowledgements();expect(s.imports.pendingAcknowledgements).toHaveLength(0);expect(s.commands.applyChange).not.toHaveBeenCalled();});
it('retries the exact retired token when its delayed acknowledgement release fails beside a new preview',async()=>{
 const s=setup(1);let acknowledge!:(t:typeof s.token)=>void;vi.mocked(s.api.start).mockImplementationOnce(()=>new Promise(r=>{acknowledge=r;}));s.c.begin('zip');await s.c.choose(async()=>['D:/old.zip']);const old=s.c.scan();await waitFor(()=>expect(s.api.start).toHaveBeenCalled());await s.c.cancel();
 const fresh={...s.token,taskId:'44444444-4444-4444-8444-444444444444'};vi.mocked(s.api.start).mockImplementationOnce(async(_id,_config,receive)=>{receive({type:'result',token:fresh,counts:s.counts});return fresh;});await s.preview();
 vi.mocked(s.api.release).mockRejectedValueOnce(new Error('old release failed'));acknowledge(s.token);await old;expect(s.c.releasePending).toBe(true);await s.c.retryRelease();expect(vi.mocked(s.api.release).mock.calls.at(-1)?.[0]).toEqual(s.token);expect(s.c.canImport).toBe(true);
});
it('rechecks publication barriers after a delayed next-batch page returns',async()=>{const s=setup();await s.preview();const original=vi.mocked(s.api.page).getMockImplementation()!;let resolve!:(p:Awaited<ReturnType<SourceCommands['page']>>)=>void;vi.mocked(s.api.page).mockImplementation((...args)=>args[1]===256?new Promise(r=>{resolve=r;}):original(...args));void s.c.importAll();await waitFor(()=>expect(s.api.batch).toHaveBeenCalledTimes(1));s.finish(1);await waitFor(()=>expect(resolve).toBeDefined());vi.mocked(s.commands.applyChange).mockRejectedValueOnce({code:'SaveFailed',message:'another edit failed',retryable:true});await s.queue.enqueue({type:'updateMediaNote',mediaId:fixture.media[0].id,note:'pending',mergeKey:null},{owner:'annotations'}).catch(()=>{});resolve(await original(s.token,256,256));await waitFor(()=>expect(s.c.state).toBe('paused'));expect(s.api.batch).toHaveBeenCalledTimes(1);});
it('releases a cancelled source reservation after shared acknowledgement retry and admits new direct/source imports',async()=>{
 const s=setup(1);await s.preview();vi.mocked(s.media.release).mockRejectedValueOnce(new Error('ack unavailable'));
 void s.c.importAll();await waitFor(()=>expect(s.api.batch).toHaveBeenCalled());s.finish(1);await waitFor(()=>expect(s.c.state).toBe('paused'));
 await s.c.cancel();expect(s.imports.occupied).toBe(true);
 render(<><ImportAcknowledgements controller={s.imports}/><SourceImportProgress controller={s.c}/></>);
 fireEvent.click(screen.getByRole('button',{name:'重试导入确认'}));await waitFor(()=>expect(s.imports.pendingAcknowledgements).toHaveLength(0));
 fireEvent.click(screen.getByRole('button',{name:'关闭结果'}));expect(s.c.state).toBe('idle');expect(s.imports.occupied).toBe(false);
 vi.mocked(s.media.start).mockImplementationOnce(async(_id,_paths,receive)=>{receive({type:'finished',taskId:'direct',cancelled:false});return 'direct';});
 await s.imports.start(['D:/direct.wav']);await s.imports.completed();expect(s.media.start).toHaveBeenCalledOnce();expect(s.c.begin('folder')).toBe(true);
});
it('reconciles cancelled source reservation after project-wide publication retry',async()=>{
 const s=setup(1);await s.preview();vi.mocked(s.commands.applyChange).mockRejectedValueOnce({code:'SaveFailed',message:'disk full',retryable:true});
 void s.c.importAll();await waitFor(()=>expect(s.api.batch).toHaveBeenCalled());s.finish(1);await waitFor(()=>expect(s.c.state).toBe('paused'));await s.c.cancel();
 expect(s.imports.occupied).toBe(true);const failure=s.queue.unresolvedFailures[0];await s.queue.retry(failure.id);
 await waitFor(()=>expect(s.imports.pendingAcknowledgements).toHaveLength(0));await waitFor(()=>expect(s.imports.occupied).toBe(false));s.c.dismiss();expect(s.c.begin('zip')).toBe(true);
});
it('retains reservation through choosing, preview, active publication and failed preview release',async()=>{
 const s=setup(1);s.c.begin('zip');await s.imports.retryAcknowledgements();expect(s.imports.occupied).toBe(true);await s.c.choose(async()=>['D:/a.zip']);await s.c.scan();await waitFor(()=>expect(s.c.state).toBe('preview'));await s.imports.retryAcknowledgements();expect(s.imports.occupied).toBe(true);
 const apply=vi.mocked(s.commands.applyChange).getMockImplementation()!;let resume!:()=>void;vi.mocked(s.commands.applyChange).mockImplementationOnce(async(...args)=>{await new Promise<void>(r=>{resume=r;});return apply(...args);});void s.c.importAll();await waitFor(()=>expect(s.api.batch).toHaveBeenCalled());s.finish(1);await waitFor(()=>expect(resume).toBeDefined());
 vi.mocked(s.api.release).mockRejectedValueOnce(new Error('preview release unavailable'));await s.c.cancel();s.c.dismiss();expect(s.c.state).toBe('cancelled');expect(s.imports.occupied).toBe(true);await s.c.retryRelease();s.c.dismiss();expect(s.c.state).toBe('cancelled');expect(s.imports.occupied).toBe(true);
 resume();await s.imports.settled();await waitFor(()=>expect(s.imports.occupied).toBe(false));s.c.dismiss();expect(s.c.state).toBe('idle');
});
it('keeps target on atomic preset changes, resets advanced disclosure and releases old preview on layout edits',async()=>{const s=setup(61);await s.preview();const target='33333333-3333-4333-8333-333333333333';await s.c.configurePlan({organization:{...s.c.config.organization,targetFolderId:target}});await s.c.applyPreset('jingcheng-result');expect(s.c.config.organization).toMatchObject({targetFolderId:target,mode:'template',template:'{source}/{result}/{faultType}/{record}'});await s.c.configurePlan({rules:{...s.c.config.rules,mode:'generic'}});expect(s.c.config.organization.template).toBe('{source}/{relativeDir}');expect(s.api.release).toHaveBeenCalled();render(<SourceImportDialog controller={s.c}/>);expect(screen.getByText('高级设置').closest('details')).not.toHaveAttribute('open');expect(screen.getByLabelText('目录布局')).toHaveValue('template');expect(screen.queryByLabelText('导入第二路音频')).toBeNull();});
it('keeps path-rule typing separators editable while synchronizing plans and reopened configuration',async()=>{const s=setup(1);s.c.begin('folder');const view=render(<SourceImportDialog controller={s.c}/>);fireEvent.click(screen.getByText('高级设置'));fireEvent.change(screen.getByLabelText('包含路径'),{target:{value:'*/CH1\n'}});expect(screen.getByLabelText('包含路径')).toHaveValue('*/CH1\n');fireEvent.change(screen.getByLabelText('去除目录组件'),{target:{value:'audio; '}});expect(screen.getByLabelText('去除目录组件')).toHaveValue('audio; ');await act(()=>s.c.applyPreset('jingcheng-source'));expect(screen.getByLabelText('包含路径')).toHaveValue('**/*');expect(screen.getByLabelText('去除目录组件')).toHaveValue('audio');await act(()=>s.c.cancel());view.unmount();s.c.begin('folder');render(<SourceImportDialog controller={s.c}/>);expect(screen.getByText('高级设置').closest('details')).not.toHaveAttribute('open');expect(screen.getByLabelText('包含路径')).toHaveValue(s.c.config.rules.include.join('\n'));});
it('renders full native folder-summary beyond the first media page with bounded folder and media pagination',async()=>{const s=setup(61);const original=vi.mocked(s.api.page).getMockImplementation()!;vi.mocked(s.api.page).mockImplementation(async(...args)=>({...await original(...args),folderSummary:Array.from({length:61},(_,index)=>({index,parentIndex:null,name:`目录${index}`,mediaCount:1}))}));await s.preview();render(<SourceImportDialog controller={s.c}/>);expect(screen.getByText('结果目录（61）')).toBeInTheDocument();fireEvent.click(screen.getByText('结果目录（61）'));expect(screen.queryByRole('button',{name:/目录60/})).toBeNull();fireEvent.click(screen.getByText('下一组目录'));expect(screen.getByRole('button',{name:/目录60/})).toBeVisible();expect(document.querySelectorAll('.source-preview > ul > li')).toHaveLength(50);fireEvent.click(screen.getByRole('button',{name:'下一页'}));await waitFor(()=>expect(document.querySelectorAll('.source-preview > ul > li')).toHaveLength(11));expect(screen.getByText('结果目录（61）')).toBeInTheDocument();expect(s.api.batch).not.toHaveBeenCalled();});
it('pins the stable source-menu return trigger before rendering the modal',()=>{const s=setup(1),trigger=document.createElement('button');s.c.begin('folder',null,trigger);expect(s.c.returnFocus).toBe(trigger);});
it('imports 920 candidates through four bounded batches with no loss or duplicated publication',async()=>{
 const s=setup(920),before=s.store.snapshot.document.media.length;await s.preview();void s.c.importAll();
 for(let batch=1;batch<=4;batch++){await waitFor(()=>expect(s.api.batch).toHaveBeenCalledTimes(batch));expect(vi.mocked(s.api.batch).mock.calls[batch-1][1]).toHaveLength(batch===4?152:256);s.finish(batch);}
 await waitFor(()=>expect(s.c.state).toBe('finished'));expect(s.c.successCount).toBe(920);expect(s.store.snapshot.document.media.length).toBe(before+920);expect(new Set(s.store.snapshot.document.media.map(m=>m.id)).size).toBe(before+920);expect(s.queue.unresolvedFailures).toHaveLength(0);
});

it('keeps automatic refresh suspended across source batches and resumes when import finishes',async()=>{
 const s=setup();await s.preview();let release!:()=>void;const flight=new Promise<void>(r=>{release=r;}),resume=vi.fn();
 cleanup.push(registerSuspension(s.owner.lifecycle,async()=>{await flight;return resume;}));
 const work=s.c.importAll();await Promise.resolve();expect(s.api.batch).not.toHaveBeenCalled();release();
 await waitFor(()=>expect(s.api.batch).toHaveBeenCalledTimes(1));s.finish(1);await waitFor(()=>expect(s.api.batch).toHaveBeenCalledTimes(2));expect(resume).not.toHaveBeenCalled();
 s.finish(2);await work;expect(s.c.state).toBe('finished');expect(resume).toHaveBeenCalledTimes(1);
});
it('cancelling while refresh is draining resumes it without starting native import',async()=>{
 const s=setup(1);await s.preview();let release!:()=>void;const flight=new Promise<void>(r=>{release=r;}),resume=vi.fn();
 cleanup.push(registerSuspension(s.owner.lifecycle,async()=>{await flight;return resume;}));
 const work=s.c.importAll();await s.c.cancel();release();await work;expect(s.api.batch).not.toHaveBeenCalled();expect(resume).toHaveBeenCalledTimes(1);
});

it.each(['zip', 'folder'] as const)('shows default duplicate skipping outside advanced settings for %s and invalidates its preview on toggle', async kind => {
 window.localStorage.clear();
 const s=setup(1);s.c.begin(kind);
 render(<SourceImportDialog controller={s.c}/>);
 const checkbox=screen.getByRole('checkbox',{name:'跳过重复音频'});
 expect(checkbox).toBeVisible();expect(checkbox).toBeChecked();expect(checkbox.closest('details')).toBeNull();
 expect(screen.getByText('按目标目录和文件名判断，不区分大小写；回收站中的音频不参与')).toBeVisible();
 await act(()=>s.c.choose(async()=>kind==='zip'?['D:/a.zip']:['D:/audio']));
 await act(()=>s.c.scan());await waitFor(()=>expect(s.c.page?.candidates).toHaveLength(1));
 expect(screen.getByRole('button',{name:'导入 1 个音频'})).toBeEnabled();
 fireEvent.click(checkbox);
 expect(s.c.page).toBeNull();expect(s.c.state).toBe('choosing');
 expect(screen.getByRole('button',{name:'导入 0 个音频'})).toBeDisabled();
 await waitFor(()=>expect(s.api.release).toHaveBeenCalledWith(s.token));
 await act(()=>s.c.scan());await waitFor(()=>expect(s.c.canImport).toBe(true));
 expect(vi.mocked(s.api.start).mock.calls.at(-1)?.[1].rules.skipDuplicates).toBe(false);
});

it.each([true,false])('restores duplicate skipping=%s from custom and last plans while builtins stay checked',async enabled=>{
 window.localStorage.clear();cleanup.push(()=>window.localStorage.clear());
 const s=setup(1);s.c.begin('zip');const view=render(<SourceImportDialog controller={s.c}/>);
 if(!enabled)fireEvent.click(screen.getByRole('checkbox',{name:'跳过重复音频'}));
 fireEvent.click(screen.getByText('高级设置'));
 fireEvent.change(screen.getByLabelText('新方案名称'),{target:{value:'重复策略'}});fireEvent.click(screen.getByRole('button',{name:'保存'}));
 await waitFor(()=>expect(s.c.presetId).toMatch(/^custom-/));const customId=s.c.presetId;
 for(const preset of s.c.plans.presets.filter(p=>!p.id.startsWith('custom-'))){
  await act(()=>s.c.applyPreset(preset.id));expect(screen.getByRole('checkbox',{name:'跳过重复音频'})).toBeChecked();
 }
 fireEvent.change(screen.getByLabelText('导入方案'),{target:{value:customId}});
 await waitFor(()=>expect(s.c.presetId).toBe(customId));
 expect((screen.getByRole('checkbox',{name:'跳过重复音频'}) as HTMLInputElement).checked).toBe(enabled);
 await act(()=>s.c.choose(async()=>['D:/a.zip']));await act(()=>s.c.scan());
 expect(JSON.parse(window.localStorage.getItem('annotator.import-plans.v3')!).version).toBe(3);
 await act(()=>s.c.cancel());view.unmount();
 const reopened=setup(1);reopened.c.begin('folder');render(<SourceImportDialog controller={reopened.c}/>);
 expect((screen.getByRole('checkbox',{name:'跳过重复音频'}) as HTMLInputElement).checked).toBe(enabled);
 fireEvent.change(screen.getByLabelText('导入方案'),{target:{value:customId}});
 await waitFor(()=>expect(reopened.c.presetId).toBe(customId));
 expect((screen.getByRole('checkbox',{name:'跳过重复音频'}) as HTMLInputElement).checked).toBe(enabled);
});

it('disables duplicate policy while picking, importing and paused',async()=>{
 window.localStorage.clear();const s=setup(1);s.c.begin('zip');render(<SourceImportDialog controller={s.c}/>);
 let picked!:(paths:string[])=>void;let choosing!:Promise<void>;
 act(()=>{choosing=s.c.choose(()=>new Promise(resolve=>{picked=resolve;}));});
 expect(screen.getByRole('checkbox',{name:'跳过重复音频'})).toBeDisabled();
 await act(async()=>{picked(['D:/a.zip']);await choosing;});
 expect(screen.getByRole('checkbox',{name:'跳过重复音频'})).toBeEnabled();
 await act(()=>s.c.scan());await waitFor(()=>expect(s.c.canImport).toBe(true));
 vi.mocked(s.media.release).mockRejectedValueOnce(new Error('ack failed'));
 act(()=>{void s.c.importAll();});await waitFor(()=>expect(s.api.batch).toHaveBeenCalled());act(()=>s.c.show());
 expect(screen.getByRole('checkbox',{name:'跳过重复音频'})).toBeDisabled();
 act(()=>s.finish(1));await waitFor(()=>expect(s.c.state).toBe('paused'));
 expect(screen.getByRole('checkbox',{name:'跳过重复音频'})).toBeDisabled();
});

it('shows duplicate skips as a subset in the 40/60 preview and final result',async()=>{
 const s=setup(40);Object.assign(s.counts,{checked:100,skipped:60,duplicateSkipped:60});await s.preview();
 render(<><SourceImportDialog controller={s.c}/><SourceImportProgress controller={s.c}/></>);
 expect(screen.getByRole('button',{name:'导入 40 个音频'})).toBeEnabled();
 expect(screen.getByText(/跳过 60（其中重复 60）/)).toBeVisible();expect(screen.queryByText(/跳过 120/)).toBeNull();
 act(()=>{void s.c.importAll();});await waitFor(()=>expect(s.api.batch).toHaveBeenCalled());act(()=>s.finish(1));
 await waitFor(()=>expect(s.c.state).toBe('finished'));
 expect(screen.getByText(/跳过 60（其中重复 60）/)).toBeVisible();expect(screen.queryByText(/跳过 120/)).toBeNull();
 expect(s.c.successCount).toBe(40);expect(s.c.failures).toHaveLength(0);
});

it.each([
 {duplicates:60,issues:0,allDuplicate:true},
 {duplicates:0,issues:0,allDuplicate:false},
 {duplicates:0,issues:1,allDuplicate:false},
 {duplicates:60,issues:1,allDuplicate:false},
])('only reports all duplicates for a clean empty scan: %j',async({duplicates,issues,allDuplicate})=>{
 const s=setup(0);Object.assign(s.counts,{checked:60,skipped:duplicates,duplicateSkipped:duplicates,issues});
 const original=vi.mocked(s.api.page).getMockImplementation()!;
 vi.mocked(s.api.page).mockImplementation(async(...args)=>({...await original(...args),issues:issues?[{sourceIndex:0,relativePath:'broken.wav',message:'无法读取音频'}]:[]}));
 await s.preview();render(<SourceImportDialog controller={s.c}/>);
 const message=screen.queryByText('所选音频均已存在，无需重复导入');
 if(allDuplicate)expect(message).toBeVisible();else expect(message).toBeNull();
 expect(screen.getByRole('button',{name:'导入 0 个音频'})).toBeDisabled();
 if(issues)expect(screen.getByText(/扫描问题 \/ 缺失字段/)).toBeVisible();
});

it('requests a fresh scan after stale batch start without creating a publication retry',async()=>{
 const s=setup(1);await s.preview();
 const stale={code:'RevisionConflict',message:'项目音频已变化，请重新扫描',retryable:false,details:{sourceImportRescanRequired:true}};
 vi.mocked(s.api.batch).mockRejectedValueOnce(stale);
 await s.c.importAll();expect(s.c.state).toBe('failed');expect(s.c.error).toEqual(stale);
 expect(s.c.items[0]).toMatchObject({state:'failed',error:stale});expect(s.c.failures).toHaveLength(0);
 expect(s.queue.unresolvedFailures).toHaveLength(0);expect(s.commands.applyChange).not.toHaveBeenCalled();
 render(<><SourceImportDialog controller={s.c}/><SourceImportProgress controller={s.c}/></>);
 expect(screen.queryByRole('button',{name:'重试并继续导入'})).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'重新配置并扫描'}));
 await act(()=>s.c.scan());await waitFor(()=>expect(s.c.canImport).toBe(true));
 expect(s.api.start).toHaveBeenCalledTimes(2);expect(s.api.batch).toHaveBeenCalledTimes(1);expect(s.media.start).not.toHaveBeenCalled();
});

it('keeps earlier publications when a later batch requires rescanning and does not decode the old batch again',async()=>{
 const s=setup(257),before=s.store.snapshot.document.media.length;await s.preview();
 const stale={code:'RevisionConflict',message:'项目音频已变化，请重新扫描',retryable:false,details:{sourceImportRescanRequired:true}};
 const original=vi.mocked(s.api.batch).getMockImplementation()!;
 vi.mocked(s.api.batch).mockImplementation((...args)=>vi.mocked(s.api.batch).mock.calls.length===2?Promise.reject(stale):original(...args));
 render(<><SourceImportDialog controller={s.c}/><SourceImportProgress controller={s.c}/></>);
 act(()=>{void s.c.importAll();});await waitFor(()=>expect(s.api.batch).toHaveBeenCalledTimes(1));act(()=>s.finish(1));
 await waitFor(()=>expect(s.c.state).toBe('failed'));
 expect(s.c.successCount).toBe(256);expect(s.store.snapshot.document.media.length).toBe(before+256);
 expect(s.c.items[256]).toMatchObject({state:'failed',error:stale});expect(s.c.failures).toHaveLength(0);
 expect(s.c.pendingAcknowledgements).toHaveLength(0);expect(s.api.release).toHaveBeenCalledWith(s.token);
 expect(s.media.start).not.toHaveBeenCalled();expect(screen.queryByRole('button',{name:'重试并继续导入'})).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'重新配置并扫描'}));await act(()=>s.c.scan());
 expect(s.api.start).toHaveBeenCalledTimes(2);expect(s.api.batch).toHaveBeenCalledTimes(2);
 expect(s.store.snapshot.document.media.length).toBe(before+256);
});
