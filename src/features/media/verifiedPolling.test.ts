import { expect, it, vi } from 'vitest';
import { OrganizationController } from './organization';
import { RecycleController } from './recycle';
import type { ActiveProject } from '../project/useProjectLifecycle';

const projectId='22222222-2222-4222-8222-222222222222',runtimeNonce='11111111-1111-4111-8111-111111111111';
const org=(revision:number)=>({runtimeNonce,projectId,organization:{kind:'audio-annotator-organization' as const,formatVersion:1 as const,projectId,revision,layoutRevision:revision,folders:[],media:[]}});
const trash=(revision:number)=>({runtimeNonce,projectId,recycle:{kind:'audio-annotator-recycle' as const,formatVersion:1 as const,projectId,revision,trashed:[],recentOperations:[]}});
it.each(['organization','recycle'] as const)('invalidates earlier %s evidence as soon as a forced refresh begins',async kind=>{
 let finish!:(value:ReturnType<typeof org>|ReturnType<typeof trash>)=>void;
 const value=kind==='organization'?org(2):trash(2),api={get:vi.fn().mockResolvedValueOnce(value).mockImplementationOnce(()=>new Promise(r=>finish=r)).mockResolvedValue(value),apply:vi.fn()};
 if(kind==='organization'){
  const c=new OrganizationController(projectId,runtimeNonce,true,api),read=await c.readVerified();expect(c.isVerifiedCurrent(read)).toBe(true);
  const forced=c.refresh(true),polls=Array.from({length:4},()=>c.refresh());expect(c.isVerifiedCurrent(read)).toBe(false);expect(api.get).toHaveBeenCalledTimes(2);
  finish(org(2));await Promise.all([forced,...polls]);expect(c.isVerifiedCurrent(read)).toBe(false);expect(c.isVerifiedCurrent(await c.readVerified())).toBe(true);
 }else{
  const c=new RecycleController(projectId,runtimeNonce,true,api),read=await c.readVerified();expect(c.isVerifiedCurrent(read)).toBe(true);
  const forced=c.refresh(true),polls=Array.from({length:4},()=>c.refresh());expect(c.isVerifiedCurrent(read)).toBe(false);expect(api.get).toHaveBeenCalledTimes(2);
  finish(trash(2));await Promise.all([forced,...polls]);expect(c.isVerifiedCurrent(read)).toBe(false);expect(c.isVerifiedCurrent(await c.readVerified())).toBe(true);
 }
});
it.each(['organization','recycle'] as const)('releases a failed %s review gate while safely observing a later newer head',async kind=>{
 let finish!:(value:ReturnType<typeof org>|ReturnType<typeof trash>)=>void;
 const value=kind==='organization'?org(2):trash(2),api={get:vi.fn().mockImplementationOnce(()=>new Promise(r=>finish=r)).mockResolvedValue(value),apply:vi.fn()};
 if(kind==='organization'){
  const c=new OrganizationController(projectId,runtimeNonce,true,api),old=c.readVerified(),error=old.catch(e=>e);c.retireVerified(old,true);
  await c.refresh();const read=await c.readVerified();expect(c.isVerifiedCurrent(read)).toBe(true);finish(org(3));expect(await error).toBeInstanceOf(Error);
  expect(c.snapshot?.revision).toBe(3);expect(c.isVerifiedCurrent(read)).toBe(false);
 }else{
  const c=new RecycleController(projectId,runtimeNonce,true,api),old=c.readVerified(),error=old.catch(e=>e);c.retireVerified(old,true);
  await c.refresh();const read=await c.readVerified();expect(c.isVerifiedCurrent(read)).toBe(true);finish(trash(3));expect(await error).toBeInstanceOf(Error);
  expect(c.snapshot?.revision).toBe(3);expect(c.isVerifiedCurrent(read)).toBe(false);
 }
});
it.each(['organization','recycle'] as const)('ending observation of an old %s pair does not retire an independent new review',async kind=>{
 let old!:(value:ReturnType<typeof org>|ReturnType<typeof trash>)=>void,latest!:(value:ReturnType<typeof org>|ReturnType<typeof trash>)=>void;
 const api={get:vi.fn().mockImplementationOnce(()=>new Promise(r=>old=r)).mockImplementationOnce(()=>new Promise(r=>latest=r)),apply:vi.fn()};
 if(kind==='organization'){
  const c=new OrganizationController(projectId,runtimeNonce,true,api),one=c.readVerified(),error=one.catch(e=>e);c.retireVerified(one,true);const two=c.readVerified();c.retireVerified(one);const poll=c.refresh();
  old(org(9));expect(await error).toBeInstanceOf(Error);expect(c.snapshot).toBeNull();expect(api.get).toHaveBeenCalledTimes(2);
  latest(org(2));const read=await two;await poll;expect(c.isVerifiedCurrent(read)).toBe(true);
 }else{
  const c=new RecycleController(projectId,runtimeNonce,true,api),one=c.readVerified(),error=one.catch(e=>e);c.retireVerified(one,true);const two=c.readVerified();c.retireVerified(one);const poll=c.refresh();
  old(trash(9));expect(await error).toBeInstanceOf(Error);expect(c.snapshot).toBeNull();expect(api.get).toHaveBeenCalledTimes(2);
  latest(trash(2));const read=await two;await poll;expect(c.isVerifiedCurrent(read)).toBe(true);
 }
});
it.each(['organization','recycle'] as const)('does not observe a failed %s pair after a mutation',async kind=>{
 let finish!:(value:ReturnType<typeof org>|ReturnType<typeof trash>)=>void;
 const api={get:vi.fn().mockImplementationOnce(()=>new Promise(r=>finish=r)).mockResolvedValue(kind==='organization'?org(2):trash(2)),apply:vi.fn()};
 if(kind==='organization'){
  const c=new OrganizationController(projectId,runtimeNonce,true,api),old=c.readVerified(),error=old.catch(e=>e);c.retireVerified(old,true);await c.refresh();
  api.apply.mockResolvedValueOnce(org(3));expect((await c.submitBatch({expectedRevision:2,operation:{type:'moveMediaBatch',mediaIds:[runtimeNonce],folderId:null}})).ok).toBe(true);
  finish(org(9));expect(await error).toBeInstanceOf(Error);expect(c.snapshot?.revision).toBe(3);
 }else{
  const c=new RecycleController(projectId,runtimeNonce,true,api),old=c.readVerified(),error=old.catch(e=>e);c.retireVerified(old,true);await c.refresh();
  api.apply.mockResolvedValueOnce(trash(3));expect(await c.submit({expectedRevision:2,operation:{operationId:runtimeNonce,mediaIds:[runtimeNonce],trash:true}})).toBe(true);
  finish(trash(9));expect(await error).toBeInstanceOf(Error);expect(c.snapshot?.revision).toBe(3);
 }
});
it.each(['organization','recycle'] as const)('does not observe a failed %s pair after an owner session switch',async kind=>{
 let finish!:(value:ReturnType<typeof org>|ReturnType<typeof trash>)=>void;
 const api={get:vi.fn().mockImplementationOnce(()=>new Promise(r=>finish=r)).mockResolvedValue(kind==='organization'?org(2):trash(2)),apply:vi.fn()};
 const state={collaboration:{runtimeNonce},store:{editingDisabled:false,snapshot:{document:{projectId}}},lifecycle:{admissionClosed:false}},owner=state as unknown as ActiveProject;
 if(kind==='organization'){
  const c=new OrganizationController(projectId,runtimeNonce,true,api,owner),old=c.readVerified(),error=old.catch(e=>e);c.retireVerified(old,true);await c.refresh();state.collaboration.runtimeNonce=projectId;
  finish(org(9));expect(await error).toBeInstanceOf(Error);expect(c.snapshot?.revision).toBe(2);
 }else{
  const c=new RecycleController(projectId,runtimeNonce,true,api,owner),old=c.readVerified(),error=old.catch(e=>e);c.retireVerified(old,true);await c.refresh();state.collaboration.runtimeNonce=projectId;
  finish(trash(9));expect(await error).toBeInstanceOf(Error);expect(c.snapshot?.revision).toBe(2);
 }
});
it.each(['organization','recycle'] as const)('does not install a forced %s response across a later mutation',async kind=>{
 let finish!:(value:ReturnType<typeof org>|ReturnType<typeof trash>)=>void;
 const value=kind==='organization'?org(2):trash(2),api={get:vi.fn().mockResolvedValueOnce(value).mockImplementationOnce(()=>new Promise(r=>finish=r)),apply:vi.fn()};
 if(kind==='organization'){
  const c=new OrganizationController(projectId,runtimeNonce,true,api),read=await c.readVerified(),forced=c.refresh(true);expect(c.isVerifiedCurrent(read)).toBe(false);
  api.apply.mockResolvedValueOnce(org(3));expect((await c.submitBatch({expectedRevision:2,operation:{type:'moveMediaBatch',mediaIds:[runtimeNonce],folderId:null}})).ok).toBe(true);
  finish(org(9));await forced;expect(c.snapshot?.revision).toBe(3);
 }else{
  const c=new RecycleController(projectId,runtimeNonce,true,api),read=await c.readVerified(),forced=c.refresh(true);expect(c.isVerifiedCurrent(read)).toBe(false);
  api.apply.mockResolvedValueOnce(trash(3));expect(await c.submit({expectedRevision:2,operation:{operationId:runtimeNonce,mediaIds:[runtimeNonce],trash:true}})).toBe(true);
  finish(trash(9));await forced;expect(c.snapshot?.revision).toBe(3);
 }
});
it.each(['organization','recycle'] as const)('does not install a forced %s response after an owner session change',async kind=>{
 let finish!:(value:ReturnType<typeof org>|ReturnType<typeof trash>)=>void;
 const value=kind==='organization'?org(2):trash(2),api={get:vi.fn().mockResolvedValueOnce(value).mockImplementationOnce(()=>new Promise(r=>finish=r)),apply:vi.fn()};
 const state={collaboration:{runtimeNonce},store:{editingDisabled:false,snapshot:{document:{projectId}}},lifecycle:{admissionClosed:false}},owner=state as unknown as ActiveProject;
 const c=kind==='organization'?new OrganizationController(projectId,runtimeNonce,true,api,owner):new RecycleController(projectId,runtimeNonce,true,api,owner);
 await c.readVerified();const forced=c.refresh(true);state.collaboration.runtimeNonce=projectId;finish(kind==='organization'?org(9):trash(9));await forced;expect(c.snapshot?.revision).toBe(2);
});
it.each(['organization','recycle'] as const)('retires an abandoned %s verification so normal refresh proceeds and a late response is ignored',async kind=>{
 let finish!:(value:ReturnType<typeof org>|ReturnType<typeof trash>)=>void;
 const api={get:vi.fn().mockImplementationOnce(()=>new Promise(r=>finish=r)).mockResolvedValueOnce(kind==='organization'?org(2):trash(2)),apply:vi.fn()};
 if(kind==='organization'){
  const c=new OrganizationController(projectId,runtimeNonce,true,api),pending=c.readVerified(),error=pending.catch(e=>e),coalesced=c.refresh();
  c.retireVerified(pending);await coalesced;await c.refresh();expect(api.get).toHaveBeenCalledTimes(2);expect(c.snapshot?.revision).toBe(2);
  finish(org(9));expect(await error).toBeInstanceOf(Error);expect(c.snapshot?.revision).toBe(2);expect(c.error).toBeNull();
 }else{
  const c=new RecycleController(projectId,runtimeNonce,true,api),pending=c.readVerified(),error=pending.catch(e=>e),coalesced=c.refresh();
  c.retireVerified(pending);await coalesced;await c.refresh();expect(api.get).toHaveBeenCalledTimes(2);expect(c.snapshot?.revision).toBe(2);
  finish(trash(9));expect(await error).toBeInstanceOf(Error);expect(c.snapshot?.revision).toBe(2);expect(c.error).toBeNull();
 }
});
it.each(['organization','recycle'] as const)('retiring an older %s review does not release an independent newer verification',async kind=>{
 let old!:(value:ReturnType<typeof org>|ReturnType<typeof trash>)=>void,latest!:(value:ReturnType<typeof org>|ReturnType<typeof trash>)=>void;
 const api={get:vi.fn().mockImplementationOnce(()=>new Promise(r=>old=r)).mockImplementationOnce(()=>new Promise(r=>latest=r)),apply:vi.fn()};
 if(kind==='organization'){
  const c=new OrganizationController(projectId,runtimeNonce,true,api),one=c.readVerified(),error=one.catch(e=>e),two=c.readVerified();c.retireVerified(one);const poll=c.refresh();
  old(org(9));expect(await error).toBeInstanceOf(Error);expect(c.snapshot).toBeNull();expect(api.get).toHaveBeenCalledTimes(2);
  latest(org(2));const read=await two;await poll;expect(c.isVerifiedCurrent(read)).toBe(true);expect(c.snapshot?.revision).toBe(2);
 }else{
  const c=new RecycleController(projectId,runtimeNonce,true,api),one=c.readVerified(),error=one.catch(e=>e),two=c.readVerified();c.retireVerified(one);const poll=c.refresh();
  old(trash(9));expect(await error).toBeInstanceOf(Error);expect(c.snapshot).toBeNull();expect(api.get).toHaveBeenCalledTimes(2);
  latest(trash(2));const read=await two;await poll;expect(c.isVerifiedCurrent(read)).toBe(true);expect(c.snapshot?.revision).toBe(2);
 }
});
it('coalesces recurring organization polls with a slow verified read and invalidates only after changed data arrives',async()=>{
 let verify!:(v:ReturnType<typeof org>)=>void,poll!:(v:ReturnType<typeof org>)=>void;
 const api={get:vi.fn().mockImplementationOnce(()=>new Promise(r=>verify=r)).mockImplementationOnce(()=>new Promise(r=>poll=r)),apply:vi.fn()};
 const c=new OrganizationController(projectId,runtimeNonce,true,api);c.snapshot=org(1).organization;
 const pending=c.readVerified(),polls=Array.from({length:10},()=>c.refresh());expect(api.get).toHaveBeenCalledTimes(1);
 verify(org(2));const read=await pending;await Promise.all(polls);expect(c.isVerifiedCurrent(read)).toBe(true);
 const next=c.refresh();expect(api.get).toHaveBeenCalledTimes(2);expect(c.isVerifiedCurrent(read)).toBe(true);
 poll(org(2));await next;expect(c.isVerifiedCurrent(read)).toBe(true);
 api.get.mockResolvedValueOnce(org(3));await c.refresh();expect(c.isVerifiedCurrent(read)).toBe(false);
});
it('coalesces recurring recycle polls with a slow verified read without ignoring a later recycle change',async()=>{
 let verify!:(v:ReturnType<typeof trash>)=>void,poll!:(v:ReturnType<typeof trash>)=>void;
 const api={get:vi.fn().mockImplementationOnce(()=>new Promise(r=>verify=r)).mockImplementationOnce(()=>new Promise(r=>poll=r)),apply:vi.fn()};
 const c=new RecycleController(projectId,runtimeNonce,true,api);c.snapshot=trash(1).recycle;
 const pending=c.readVerified(),polls=Array.from({length:10},()=>c.refresh());expect(api.get).toHaveBeenCalledTimes(1);
 verify(trash(2));const read=await pending;await Promise.all(polls);expect(c.isVerifiedCurrent(read)).toBe(true);
 const next=c.refresh();expect(c.isVerifiedCurrent(read)).toBe(true);poll(trash(2));await next;expect(c.isVerifiedCurrent(read)).toBe(true);
 api.get.mockResolvedValueOnce(trash(3));await c.refresh();expect(c.isVerifiedCurrent(read)).toBe(false);
});
it('defers and coalesces automatic forced organization refreshes, invalidating older evidence when they start',async()=>{
 let verify!:(v:ReturnType<typeof org>)=>void,refresh!:(v:ReturnType<typeof org>)=>void;
 const api={get:vi.fn().mockImplementationOnce(()=>new Promise(r=>verify=r)).mockImplementationOnce(()=>new Promise(r=>refresh=r)),apply:vi.fn()};
 const c=new OrganizationController(projectId,runtimeNonce,true,api);c.snapshot=org(1).organization;
 const pending=c.readVerified(),a=c.refreshAfterVerified(),b=c.refreshAfterVerified();expect(api.get).toHaveBeenCalledTimes(1);expect(a).toBe(b);
 verify(org(2));const read=await pending;await Promise.resolve();expect(api.get).toHaveBeenCalledTimes(2);expect(c.isVerifiedCurrent(read)).toBe(false);
 refresh(org(2));await Promise.all([a,b]);expect(c.isVerifiedCurrent(read)).toBe(false);
});
it('does not let a queued automatic refresh supersede a newer review',async()=>{
 let first!:(v:ReturnType<typeof org>)=>void,forced!:(v:ReturnType<typeof org>)=>void,second!:(v:ReturnType<typeof org>)=>void,last!:(v:ReturnType<typeof org>)=>void;
 const api={get:vi.fn().mockImplementationOnce(()=>new Promise(r=>first=r)).mockImplementationOnce(()=>new Promise(r=>forced=r)).mockImplementationOnce(()=>new Promise(r=>second=r)).mockImplementationOnce(()=>new Promise(r=>last=r)),apply:vi.fn()};
 const c=new OrganizationController(projectId,runtimeNonce,true,api);c.snapshot=org(1).organization;
 const one=c.readVerified(),queued=c.refreshAfterVerified();first(org(2));await one;await Promise.resolve();expect(api.get).toHaveBeenCalledTimes(2);
 const two=c.readVerified(),again=c.refreshAfterVerified();expect(again).toBe(queued);expect(api.get).toHaveBeenCalledTimes(3);
 forced(org(2));await Promise.resolve();await Promise.resolve();expect(api.get).toHaveBeenCalledTimes(3);
 second(org(2));const reviewed=await two;await Promise.resolve();expect(c.isVerifiedCurrent(reviewed)).toBe(false);expect(api.get).toHaveBeenCalledTimes(4);
 last(org(2));await Promise.all([queued,again]);expect(c.isVerifiedCurrent(reviewed)).toBe(false);
});
it('moves a deferred automatic refresh to the newest explicit review without waiting for an abandoned read',async()=>{
 let first!:(v:ReturnType<typeof org>)=>void,second!:(v:ReturnType<typeof org>)=>void,refresh!:(v:ReturnType<typeof org>)=>void;
 const api={get:vi.fn().mockImplementationOnce(()=>new Promise(r=>first=r)).mockImplementationOnce(()=>new Promise(r=>second=r)).mockImplementationOnce(()=>new Promise(r=>refresh=r)),apply:vi.fn()};
 const c=new OrganizationController(projectId,runtimeNonce,true,api),old=c.readVerified(),oldError=old.catch(e=>e),queued=c.refreshAfterVerified(),latest=c.readVerified();expect(api.get).toHaveBeenCalledTimes(2);
 second(org(2));const reviewed=await latest;await vi.waitFor(()=>expect(api.get).toHaveBeenCalledTimes(3));expect(c.isVerifiedCurrent(reviewed)).toBe(false);
 refresh(org(2));await queued;first(org(1));expect(await oldError).toBeInstanceOf(Error);expect(c.isVerifiedCurrent(reviewed)).toBe(false);
});
it.each(['organization','recycle'] as const)('starts a fresh explicit %s read and adopts a newer superseded response',async kind=>{
 let first!:(v:ReturnType<typeof org>|ReturnType<typeof trash>)=>void,second!:(v:ReturnType<typeof org>|ReturnType<typeof trash>)=>void;
 const api={get:vi.fn().mockImplementationOnce(()=>new Promise(r=>first=r)).mockImplementationOnce(()=>new Promise(r=>second=r)),apply:vi.fn()};
 if(kind==='organization'){
  const c=new OrganizationController(projectId,runtimeNonce,true,api),old=c.readVerified(),oldError=old.catch(e=>e),latest=c.readVerified();expect(api.get).toHaveBeenCalledTimes(2);
  const polls=Array.from({length:20},()=>c.refresh());expect(api.get).toHaveBeenCalledTimes(2);second(org(2));const read=await latest;await Promise.all(polls);expect(c.isVerifiedCurrent(read)).toBe(true);first(org(3));expect(await oldError).toBeInstanceOf(Error);expect(c.snapshot?.revision).toBe(3);expect(c.isVerifiedCurrent(read)).toBe(false);
 }else{
  const c=new RecycleController(projectId,runtimeNonce,true,api),old=c.readVerified(),oldError=old.catch(e=>e),latest=c.readVerified();expect(api.get).toHaveBeenCalledTimes(2);
  const polls=Array.from({length:20},()=>c.refresh());expect(api.get).toHaveBeenCalledTimes(2);second(trash(2));const read=await latest;await Promise.all(polls);expect(c.isVerifiedCurrent(read)).toBe(true);first(trash(3));expect(await oldError).toBeInstanceOf(Error);expect(c.snapshot?.revision).toBe(3);expect(c.isVerifiedCurrent(read)).toBe(false);
 }
});
it.each(['organization','recycle'] as const)('rejects an explicit %s review if a superseded read discovers a newer head first',async kind=>{
 let first!:(v:ReturnType<typeof org>|ReturnType<typeof trash>)=>void,second!:(v:ReturnType<typeof org>|ReturnType<typeof trash>)=>void;
 const api={get:vi.fn().mockImplementationOnce(()=>new Promise(r=>first=r)).mockImplementationOnce(()=>new Promise(r=>second=r)),apply:vi.fn()};
 const c=kind==='organization'?new OrganizationController(projectId,runtimeNonce,true,api):new RecycleController(projectId,runtimeNonce,true,api);
 const old=c.readVerified(),oldError=old.catch(e=>e),latest=c.readVerified(),latestError=latest.catch(e=>e);first(kind==='organization'?org(3):trash(3));expect(await oldError).toBeInstanceOf(Error);
 second(kind==='organization'?org(2):trash(2));expect(await latestError).toBeInstanceOf(Error);expect(c.snapshot?.revision).toBe(3);
});
it.each(['organization','recycle'] as const)('does not install a foreign superseded explicit %s response',async kind=>{
 let first!:(v:ReturnType<typeof org>|ReturnType<typeof trash>)=>void,second!:(v:ReturnType<typeof org>|ReturnType<typeof trash>)=>void;
 const api={get:vi.fn().mockImplementationOnce(()=>new Promise(r=>first=r)).mockImplementationOnce(()=>new Promise(r=>second=r)),apply:vi.fn()};
 const c=kind==='organization'?new OrganizationController(projectId,runtimeNonce,true,api):new RecycleController(projectId,runtimeNonce,true,api);
 const old=c.readVerified(),oldError=old.catch(e=>e),latest=c.readVerified();second(kind==='organization'?org(2):trash(2));await latest;
 const foreign=kind==='organization'?{...org(9),runtimeNonce:projectId}:{...trash(9),runtimeNonce:projectId};first(foreign);expect(await oldError).toBeInstanceOf(Error);expect(c.snapshot?.revision).toBe(2);
});
it.each(['organization','recycle'] as const)('does not install a superseded explicit %s response after owner session changes',async kind=>{
 let first!:(v:ReturnType<typeof org>|ReturnType<typeof trash>)=>void,second!:(v:ReturnType<typeof org>|ReturnType<typeof trash>)=>void;
 const api={get:vi.fn().mockImplementationOnce(()=>new Promise(r=>first=r)).mockImplementationOnce(()=>new Promise(r=>second=r)),apply:vi.fn()};
 const state={collaboration:{runtimeNonce},store:{editingDisabled:false,snapshot:{document:{projectId}}},lifecycle:{admissionClosed:false}},owner=state as unknown as ActiveProject;
 const c=kind==='organization'?new OrganizationController(projectId,runtimeNonce,true,api,owner):new RecycleController(projectId,runtimeNonce,true,api,owner);
 const old=c.readVerified(),oldError=old.catch(e=>e),latest=c.readVerified();second(kind==='organization'?org(2):trash(2));await latest;
 state.collaboration.runtimeNonce=projectId;first(kind==='organization'?org(9):trash(9));expect(await oldError).toBeInstanceOf(Error);expect(c.snapshot?.revision).toBe(2);
});
it.each(['organization','recycle'] as const)('does not install a superseded explicit %s response after a mutation',async kind=>{
 let first!:(v:ReturnType<typeof org>|ReturnType<typeof trash>)=>void,second!:(v:ReturnType<typeof org>|ReturnType<typeof trash>)=>void;
 const api={get:vi.fn().mockImplementationOnce(()=>new Promise(r=>first=r)).mockImplementationOnce(()=>new Promise(r=>second=r)),apply:vi.fn()};
 if(kind==='organization'){
  const c=new OrganizationController(projectId,runtimeNonce,true,api),old=c.readVerified(),oldError=old.catch(e=>e),latest=c.readVerified();second(org(2));await latest;
  api.apply.mockResolvedValueOnce(org(3));expect((await c.submitBatch({expectedRevision:2,operation:{type:'moveMediaBatch',mediaIds:[runtimeNonce],folderId:null}})).ok).toBe(true);
  first(org(9));expect(await oldError).toBeInstanceOf(Error);expect(c.snapshot?.revision).toBe(3);
 }else{
  const c=new RecycleController(projectId,runtimeNonce,true,api),old=c.readVerified(),oldError=old.catch(e=>e),latest=c.readVerified();second(trash(2));await latest;
  api.apply.mockResolvedValueOnce(trash(3));expect(await c.submit({expectedRevision:2,operation:{operationId:runtimeNonce,mediaIds:[runtimeNonce],trash:true}})).toBe(true);
  first(trash(9));expect(await oldError).toBeInstanceOf(Error);expect(c.snapshot?.revision).toBe(3);
 }
});
it('does not install a superseded recycle response after purge state changes',async()=>{
 let first!:(v:ReturnType<typeof trash>)=>void,second!:(v:ReturnType<typeof trash>)=>void;
 const api={get:vi.fn().mockImplementationOnce(()=>new Promise(r=>first=r)).mockImplementationOnce(()=>new Promise(r=>second=r)),apply:vi.fn()};
 const c=new RecycleController(projectId,runtimeNonce,true,api),old=c.readVerified(),oldError=old.catch(e=>e),latest=c.readVerified();second(trash(2));await latest;
 c.purge.cancel();first(trash(9));expect(await oldError).toBeInstanceOf(Error);expect(c.snapshot?.revision).toBe(2);
});
it.each(['organization','recycle'] as const)('keeps genuinely newer data from an older %s poll',async kind=>{
 let old!:(v:ReturnType<typeof org>|ReturnType<typeof trash>)=>void,verify!:(v:ReturnType<typeof org>|ReturnType<typeof trash>)=>void;
 const api={get:vi.fn().mockImplementationOnce(()=>new Promise(r=>old=r)).mockImplementationOnce(()=>new Promise(r=>verify=r)),apply:vi.fn()};
 const c=kind==='organization'?new OrganizationController(projectId,runtimeNonce,true,api as never):new RecycleController(projectId,runtimeNonce,true,api as never);
 const background=c.refresh(),pending=c.readVerified();old(kind==='organization'?org(3):trash(3));await background;
 verify(kind==='organization'?org(2):trash(2));await expect(pending).rejects.toThrow();expect(c.snapshot?.revision).toBe(3);
});
it.each(['organization','recycle'] as const)('invalidates an already displayed %s review if an older poll later returns newer data',async kind=>{
 let old!:(v:ReturnType<typeof org>|ReturnType<typeof trash>)=>void,verify!:(v:ReturnType<typeof org>|ReturnType<typeof trash>)=>void;
 const api={get:vi.fn().mockImplementationOnce(()=>new Promise(r=>old=r)).mockImplementationOnce(()=>new Promise(r=>verify=r)),apply:vi.fn()};
 if(kind==='organization'){
  const c=new OrganizationController(projectId,runtimeNonce,true,api),background=c.refresh(),pending=c.readVerified();verify(org(2));const read=await pending;expect(c.isVerifiedCurrent(read)).toBe(true);
  old(org(3));await background;expect(c.snapshot?.revision).toBe(3);expect(c.isVerifiedCurrent(read)).toBe(false);
 }else{
  const c=new RecycleController(projectId,runtimeNonce,true,api),background=c.refresh(),pending=c.readVerified();verify(trash(2));const read=await pending;expect(c.isVerifiedCurrent(read)).toBe(true);
  old(trash(3));await background;expect(c.snapshot?.revision).toBe(3);expect(c.isVerifiedCurrent(read)).toBe(false);
 }
});
it.each(['organization','recycle'] as const)('invalidates a %s review after a later failed poll',async kind=>{
 const api={get:vi.fn(),apply:vi.fn()};
 if(kind==='organization'){
  api.get.mockResolvedValueOnce(org(2)).mockRejectedValueOnce(new Error('offline'));const c=new OrganizationController(projectId,runtimeNonce,true,api);const read=await c.readVerified();await c.refresh();expect(c.isVerifiedCurrent(read)).toBe(false);
 }else{
  api.get.mockResolvedValueOnce(trash(2)).mockRejectedValueOnce(new Error('offline'));const c=new RecycleController(projectId,runtimeNonce,true,api);const read=await c.readVerified();await c.refresh();expect(c.isVerifiedCurrent(read)).toBe(false);
 }
});
it.each(['organization','recycle'] as const)('rejects a verified %s read after its owner is disposed',async kind=>{
 let resolve!:(v:ReturnType<typeof org>|ReturnType<typeof trash>)=>void;const api={get:vi.fn(()=>new Promise(r=>resolve=r)),apply:vi.fn()};
 const c=kind==='organization'?new OrganizationController(projectId,runtimeNonce,true,api as never):new RecycleController(projectId,runtimeNonce,true,api as never);
 const pending=c.readVerified();c.dispose();resolve(kind==='organization'?org(2):trash(2));await expect(pending).rejects.toThrow();
});
it.each(['organization','recycle'] as const)('keeps readonly %s metadata readable while forbidding verified write review',async kind=>{
 const owner={collaboration:{runtimeNonce},store:{editingDisabled:true,snapshot:{document:{projectId}}},lifecycle:{admissionClosed:false}} as unknown as ActiveProject;
 const api={get:vi.fn(async()=>kind==='organization'?org(2):trash(2)),apply:vi.fn()};
 const c=kind==='organization'?new OrganizationController(projectId,runtimeNonce,false,api as never,owner):new RecycleController(projectId,runtimeNonce,false,api as never,owner);
 await c.refresh();expect(c.snapshot?.revision).toBe(2);await expect(c.readVerified()).rejects.toThrow();
});
