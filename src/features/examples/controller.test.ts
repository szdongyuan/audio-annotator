import { describe, expect, it, vi } from 'vitest';
import { ExampleController, exampleOwner, friendlyName, nameError } from './controller';
import type { ExampleAPI, ExampleEntry } from '../../bridge/examples';
import fixture from '../../../tests/fixtures/document-v3.json';
import { ProjectStore } from '../../app/store';
import { parseProjectDocument } from '../../bridge/types';
import type { ActiveProject } from '../project/useProjectLifecycle';
import type { IdentityController } from '../identity/controller';

const actor='11111111-1111-4111-8111-111111111111', other='22222222-2222-4222-8222-222222222222';
const binding={runtimeNonce:actor,projectId:other,actorId:actor};
const entry={sampleId:actor,projectId:other,creatorId:actor,scope:'private',name:'OK1',revision:1,originalFilename:'ok.wav',media:parseProjectDocument(fixture).media[0]} satisfies ExampleEntry;
function fake(){return {list:vi.fn(async()=>({entries:[entry],revisions:{[actor]:1}})),import:vi.fn(async()=>entry),fromProject:vi.fn(async()=>entry),rename:vi.fn(async()=>entry),remove:vi.fn(async()=>{}),copy:vi.fn(async()=>entry)} as unknown as ExampleAPI;}
function deferred<T>(){let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>resolve=r);return{resolve,promise};}
describe('project example controller',()=>{
 it('discards late reads and mutations after its owner is disposed',async()=>{
  const api=fake(),read=deferred<Awaited<ReturnType<ExampleAPI['list']>>>();vi.mocked(api.list).mockReturnValue(read.promise);
  const c=new ExampleController(binding,api),pending=c.refresh();c.dispose();read.resolve({entries:[entry],revisions:{[actor]:1}});await pending;expect(c.entries).toEqual([]);
 });
 it('refreshes serial imports between records and retains per-row successes and failures',async()=>{
  const api=fake();let revision=0;vi.mocked(api.list).mockImplementation(async()=>({entries:[],revisions:{[actor]:revision}}));
  vi.mocked(api.import).mockImplementation(async(_b,_s,path,_name,expected)=>{expect(expected).toBe(revision);if(path==='bad.wav')throw{message:'无法读取',code:'MissingMedia',retryable:true};revision++;return{...entry,revision};});
  const c=new ExampleController(binding,api);c.setImportPaths(['one.wav','bad.wav','two.wav']);await c.importRows();
  expect(c.rows.map(r=>r.state)).toEqual(['success','error','success']);expect(c.rows[1].error).toBe('无法读取');expect(api.import).toHaveBeenCalledTimes(3);
 });
 it('enforces guest and creator rules, copying to the opposite scope revision',async()=>{
  const api=fake(),guest=new ExampleController({...binding,actorId:null},api);expect(guest.scope).toBe('shared');guest.setScope('private');expect(guest.scope).toBe('shared');await guest.rename(entry,'NG1');expect(api.rename).not.toHaveBeenCalled();
  const c=new ExampleController(binding,api);await c.refresh();const theirs={...entry,creatorId:other};await c.rename(theirs,'NG1');await c.remove(theirs);expect(api.rename).not.toHaveBeenCalled();expect(api.remove).not.toHaveBeenCalled();
  await c.copy(theirs);expect(api.copy).toHaveBeenCalledWith(binding,theirs,'shared',1);
 });
 it('preserves blank/overlong and failed rename input, searches names, allows duplicate names',async()=>{
  const api=fake(),c=new ExampleController(binding,api);await c.refresh();c.beginRename(entry);c.setRename('   ');await c.saveRename();expect(c.renameDraft?.name).toBe('   ');expect(c.error).toContain('名称');
  c.setRename('x'.repeat(129));await c.saveRename();expect(c.renameDraft?.name).toHaveLength(129);expect(api.rename).not.toHaveBeenCalled();
  c.setRename('NG1');vi.mocked(api.rename).mockRejectedValue({code:'SaveFailed',message:'磁盘忙',retryable:true});await c.saveRename();expect(c.renameDraft?.name).toBe('NG1');
  c.search='ok';expect(c.filtered).toEqual([entry]);c.search='ng';expect(c.filtered).toEqual([]);expect(nameError('OK1')).toBeNull();
 });
 it('caps batches and defaults names from basenames including deep ZIP paths',()=>{
  const c=new ExampleController(binding,fake());c.setImportPaths(Array.from({length:33},(_,i)=>`C:/deep/${i}.wav`));expect(c.rows).toHaveLength(32);expect(c.error).toContain('32');
  expect(friendlyName('C:\\deep\\'.repeat(20)+'转动异常.wav')).toBe('转动异常');
 });
 it('uses the project guest actor without global fallback, but uses stable ordinary profile identity',()=>{
  const active={store:new ProjectStore({document:parseProjectDocument(fixture),canUndo:false,canRedo:false}),collaboration:{projectFlavor:'default',actor:null,runtimeNonce:actor}} as ActiveProject;
  const identity={selected:{authorId:other},snapshot:{runtimeNonce:actor}} as IdentityController;
  expect(exampleOwner(active,identity)?.actorId).toBeNull();
  expect(exampleOwner({...active,collaboration:undefined},identity)?.actorId).toBe(other);
  expect(exampleOwner({...active,collaboration:undefined},identity)?.runtimeNonce).toBe(actor);
 });
 it('retries rename after conflict with the refreshed record revision and retains the edited name',async()=>{
  const api=fake(),c=new ExampleController(binding,api);await c.refresh();c.beginRename(entry);c.setRename('NG1');vi.mocked(api.rename).mockRejectedValueOnce({code:'RevisionConflict',message:'记录已更新',retryable:true});vi.mocked(api.list).mockResolvedValue({entries:[{...entry,revision:2}],revisions:{[actor]:2}});
  await c.saveRename();expect(c.renameDraft?.name).toBe('NG1');await c.saveRename();expect(api.rename).toHaveBeenLastCalledWith(binding,expect.objectContaining({revision:2}),'NG1');
 });
 it('locks scope immediately while add-current refreshes its destination revision',async()=>{
  const api=fake(),read=deferred<Awaited<ReturnType<ExampleAPI['list']>>>();vi.mocked(api.list).mockReturnValueOnce(read.promise);const c=new ExampleController(binding,api);const pending=c.addCurrent(entry.media.id,'OK2');expect(c.busy).toBe(true);c.setScope('shared');expect(c.scope).toBe('private');read.resolve({entries:[],revisions:{[actor]:3}});await pending;expect(api.fromProject).toHaveBeenCalledWith(binding,'private',entry.media.id,'OK2',3);
 });
 it('finishes visible loading when a quiet refresh supersedes a manual read',async()=>{
  const api=fake(),manual=deferred<Awaited<ReturnType<ExampleAPI['list']>>>();vi.mocked(api.list).mockReturnValueOnce(manual.promise);const c=new ExampleController(binding,api);const first=c.refresh();expect(c.loading).toBe(true);await c.refresh('private',true);expect(c.loading).toBe(false);manual.resolve({entries:[],revisions:{}});await first;expect(c.entries).toEqual([entry]);
 });
 it('ignores visible errors/loading from the previously selected scope',async()=>{
  const api=fake();let reject!:(e:unknown)=>void;vi.mocked(api.list).mockReturnValueOnce(new Promise((_r,j)=>reject=j));const c=new ExampleController(binding,api),old=c.refresh();c.setScope('shared');await Promise.resolve();reject({code:'SaveFailed',message:'旧范围失败',retryable:true});await old;expect(c.error).toBeNull();expect(c.loading).toBe(false);
 });
 it('uses the collaboration actor even for legacy shared guest/other-profile contexts',()=>{
  const active={store:new ProjectStore({document:parseProjectDocument(fixture),canUndo:false,canRedo:false}),collaboration:{projectFlavor:'ordinary',actor:null,runtimeNonce:actor}} as ActiveProject;const identity={selected:{authorId:other},snapshot:{runtimeNonce:actor}} as IdentityController;
  expect(exampleOwner(active,identity)?.actorId).toBeNull();expect(exampleOwner({...active,collaboration:{...active.collaboration!,actor:{authorId:actor} as NonNullable<ActiveProject['collaboration']>['actor']}},identity)?.actorId).toBe(actor);
 });
 it('retries a single busy admission for import/from-project/copy without retrying conflicts',async()=>{
  vi.useFakeTimers();try{const api=fake(),busy={code:'ResourceLimit',message:'Collaboration job already running',retryable:true,details:{operationBusy:true}},c=new ExampleController(binding,api);
   vi.mocked(api.import).mockRejectedValueOnce(busy);c.setImportPaths(['one.wav']);const importing=c.importRows();await vi.runAllTimersAsync();await importing;expect(api.import).toHaveBeenCalledTimes(2);expect(c.rows[0].state).toBe('success');
   vi.mocked(api.fromProject).mockRejectedValueOnce(busy);const adding=c.addCurrent(entry.media.id,'OK2');await vi.runAllTimersAsync();expect(await adding).toBe(true);expect(api.fromProject).toHaveBeenCalledTimes(2);
   vi.mocked(api.copy).mockRejectedValueOnce(busy);const copying=c.copy(entry);await vi.runAllTimersAsync();expect(await copying).toBe(true);expect(api.copy).toHaveBeenCalledTimes(2);
   c.beginRename(entry);c.setRename('NG1');vi.mocked(api.rename).mockRejectedValue({code:'RevisionConflict',message:'冲突',retryable:true});await c.saveRename();expect(api.rename).toHaveBeenCalledOnce();expect(c.renameDraft?.name).toBe('NG1');
  }finally{vi.useRealTimers();}
 });
 it('stops busy retries when its owner retires',async()=>{
  vi.useFakeTimers();try{const api=fake(),c=new ExampleController(binding,api);vi.mocked(api.import).mockRejectedValue({code:'ResourceLimit',message:'busy',retryable:true,details:{operationBusy:true}});c.setImportPaths(['one.wav']);const importing=c.importRows();await vi.advanceTimersByTimeAsync(0);expect(api.import).toHaveBeenCalledOnce();c.dispose();await vi.runAllTimersAsync();await importing;expect(api.import).toHaveBeenCalledOnce();}finally{vi.useRealTimers();}
 });
 it.each(['RevisionConflict','SaveFailed'] as const)('preserves import input without retrying %s',async code=>{
  const api=fake(),c=new ExampleController(binding,api);vi.mocked(api.import).mockRejectedValue({code,message:'导入失败',retryable:true});c.setImportPaths(['one.wav']);c.editRow(c.rows[0].id,'OK2');await c.importRows();expect(api.import).toHaveBeenCalledOnce();expect(c.rows[0]).toMatchObject({name:'OK2',state:'error',error:'导入失败'});
 });
 it('retains the private import destination across partial success, shared browsing and retry',async()=>{
  const api=fake(),c=new ExampleController(binding,api);vi.mocked(api.import).mockResolvedValueOnce(entry).mockRejectedValueOnce({code:'SaveFailed',message:'磁盘忙',retryable:true});c.setImportPaths(['one.wav','two.wav']);await c.importRows();expect(c.rows.map(r=>r.state)).toEqual(['success','error']);c.setImportScope('shared');expect(c.importScope).toBe('private');c.setScope('shared');await c.importRows();expect(vi.mocked(api.import).mock.calls.map(call=>call[1])).toEqual(['private','private','private']);expect(c.scope).toBe('shared');
 });
});
