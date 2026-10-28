import { registerSuspension, admitted } from './admission';
import { collaborationClient, parseCollaborationStatus, type CollaborationCommands, type CollaborationStatus, type Expected, type PlaybackPreferences } from '../../bridge/collaboration';
import { normalizeError } from '../../bridge/client';
import type { ActiveProject } from '../project/useProjectLifecycle';
import type { AppError, Category } from '../../bridge/types';
import { readVisibility, writeVisibility, type AuthorFilter, type VisibilityPreferences } from './visibilityPreferences';
export type { AuthorFilter } from './visibilityPreferences';
export function expectedProject(owner:ActiveProject):Expected{const d=owner.store.snapshot.document;if(!owner.collaboration)throw new Error('Shared owner required');return{runtimeNonce:owner.collaboration.runtimeNonce,projectId:d.projectId,expectedRevision:d.revision};}
/** Foreign state is never accepted into ProjectStore. One bounded in-flight read per owner. */
export class CollaborationController {
 status:CollaborationStatus|null=null;error:AppError|null=null;filter:AuthorFilter={mode:'all'};
 hiddenCategoryNames:string[]=[];includeOwnCategories=false;
 catalogError:AppError|null=null;
 private listeners=new Set<()=>void>();private version=0;private disposed=false;private paused=0;private timer?:ReturnType<typeof setInterval>;private flight:Promise<void>|null=null;
 private unregister?:()=>void;
 private manualFlight:Promise<void>|null=null;
 private catalogPoll=0;
 private catalogStatus:CollaborationStatus|null=null;
 get catalogRefresh(){return this.catalogPoll;}
 get canAdoptCatalog(){
  const status=this.status;
  return !this.disposed&&!this.paused&&!this.flight&&!this.manualFlight&&!this.owner.lifecycle.admissionClosed&&!this.error
   &&status===this.catalogStatus&&!!status?.catalogPending&&!status.busy&&!status.error&&!status.recoveryRequired;
 }
 constructor(readonly owner:ActiveProject,private api:CollaborationCommands=collaborationClient){
  const preferences=readVisibility(owner.store.snapshot.document.projectId,owner.collaboration?.actor?.authorId??null);
  if(preferences){this.filter=preferences.filter;this.hiddenCategoryNames=preferences.hiddenCategoryNames;this.includeOwnCategories=preferences.includeOwnCategories;}
 }
 subscribe=(f:()=>void)=>{this.listeners.add(f);return()=>{this.listeners.delete(f);};};getVersion=()=>this.version;
 private notify(){this.version++;this.listeners.forEach(f=>f());}
 private saveVisibility(){
  const value:VisibilityPreferences={filter:this.filter,hiddenCategoryNames:this.hiddenCategoryNames,includeOwnCategories:this.includeOwnCategories};
  writeVisibility(this.owner.store.snapshot.document.projectId,this.owner.collaboration?.actor?.authorId??null,value);this.notify();
 }
 get authorIdentities(){
  const own=this.owner.collaboration?.actor;
  return [...(own?[own]:[]),...(this.status?.snapshot?.authors??[]).filter(a=>a.identity.authorId!==own?.authorId).map(a=>a.identity)];
 }
 setFilter(filter:AuthorFilter){this.filter=filter.mode==='custom'?{mode:'custom',authorIds:[...new Set(filter.authorIds)]}:{...filter};this.saveVisibility();}
 setAuthorVisible(authorId:string,shown:boolean){
  const ids=new Set(this.filter.mode==='custom'?this.filter.authorIds:this.authorIdentities.filter(a=>this.visible(a.authorId)).map(a=>a.authorId));
  if(shown)ids.add(authorId);else ids.delete(authorId);
  this.setFilter({mode:'custom',authorIds:[...ids]});
 }
 setAllAuthorsVisible(shown:boolean,includeSelf:boolean){
  if(shown&&includeSelf){this.setFilter({mode:'all'});return;}
  const own=this.owner.collaboration?.actor?.authorId;
  this.setFilter({mode:'custom',authorIds:this.authorIdentities.filter(a=>a.authorId===own&&!includeSelf?this.visible(a.authorId):shown).map(a=>a.authorId)});
 }
 setCategoryVisible(name:string,shown:boolean){const names=new Set(this.hiddenCategoryNames);if(shown)names.delete(name.trim());else names.add(name.trim());this.hiddenCategoryNames=[...names];this.saveVisibility();}
 setIncludeOwnCategories(include:boolean){this.includeOwnCategories=include;this.saveVisibility();}
 contentVisible(authorId:string|null,categories:readonly Category[],categoryIds:readonly string[]){
  if(!this.visible(authorId))return false;
  if(!this.hiddenCategoryNames.length)return true;
  if(!this.includeOwnCategories&&authorId===(this.owner.collaboration?.actor?.authorId??null))return true;
  return !categories.some(c=>categoryIds.includes(c.id)&&this.hiddenCategoryNames.includes(c.name.trim()));
 }
 visible(authorId:string|null){const filter=this.filter;if(filter.mode==='custom')return authorId!==null&&filter.authorIds.includes(authorId);return filter.mode==='all'||authorId===(this.owner.collaboration?.actor?.authorId??null);}
 accept(status:CollaborationStatus,catalogAdopted=false){if(this.disposed||status.runtimeNonce!==this.owner.collaboration?.runtimeNonce)return;parseCollaborationStatus(status,this.owner.store.snapshot.document);this.status=status;this.error=null;if(catalogAdopted||!status.catalogPending)this.catalogError=null;this.notify();}
 catalogFailed(cause:unknown){
  if(this.disposed)return;
  const failure=normalizeError(cause),error={code:failure.code,message:failure.message.slice(0,1024),retryable:failure.retryable};
  if(this.catalogError?.code===error.code&&this.catalogError.message===error.message&&this.catalogError.retryable===error.retryable)return;
  this.catalogError=error;this.notify();
 }
 start(){this.unregister??=registerSuspension(this.owner.lifecycle,()=>this.suspend(false));if(this.timer||this.disposed)return;void this.refresh();this.timer=setInterval(()=>void this.refresh(),2000);}
 refresh():Promise<void>{
  if(this.disposed||this.paused||this.owner.lifecycle.admissionClosed||this.flight)return this.flight??Promise.resolve();
  this.flight=(async()=>{
   try{
    const status=await this.api.refresh(expectedProject(this.owner));this.accept(status);
    if(!this.disposed&&status===this.status){this.catalogStatus=status;this.catalogPoll++;}
   }catch(e){if(!this.disposed){this.error=normalizeError(e);this.notify();}}
   // Publication after release prevents adoption from recursively suspending this flight.
   finally{this.flight=null;if(!this.disposed)this.notify();}
  })();return this.flight;
 }
 async suspend(includeManual=true){this.paused++;await this.flight;if(includeManual)await this.manualFlight;let done=false;return()=>{if(!done){done=true;this.paused--;}};}
 sync(){if(this.manualFlight)return this.manualFlight;this.manualFlight=this.performSync().finally(()=>{this.manualFlight=null;});return this.manualFlight;}
 private async performSync(){const resume=await this.suspend(false);try{if(this.disposed)return;await this.owner.lifecycle.save();if(!this.disposed)this.accept(await admitted(this.owner,()=>this.api.sync(expectedProject(this.owner)),()=>!this.disposed,this.api));}catch(e){if(!this.disposed){this.error=normalizeError(e);this.notify();}}finally{resume();}}
 dispose(){this.unregister?.();this.disposed=true;clearInterval(this.timer);this.listeners.clear();}
}
/** Preference failures remain lifecycle drafts; switching cannot silently lose them. */
export class PreferenceDraft {
 private readonly key='collaboration:playback-preferences';private unregister:()=>void;
 constructor(private owner:ActiveProject,private api:CollaborationCommands=collaborationClient){this.unregister=owner.lifecycle.registerDraft(this.key,()=>this.submit());}
 update(preferences:PlaybackPreferences){this.owner.store.setDraft(this.key,JSON.stringify(preferences));}
 private async submit(){const value=this.owner.store.drafts.get(this.key);if(value===undefined)return;await this.api.preferences(expectedProject(this.owner),JSON.parse(value) as PlaybackPreferences);this.owner.store.clearDraftIfUnchanged(this.key,value);}
 dispose(){this.unregister();}
}
