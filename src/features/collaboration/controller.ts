import { registerSuspension, admitted } from './admission';
import { collaborationClient, parseCollaborationStatus, type CollaborationCommands, type CollaborationStatus, type Expected, type PlaybackPreferences } from '../../bridge/collaboration';
import { normalizeError } from '../../bridge/client';
import type { ActiveProject } from '../project/useProjectLifecycle';
import type { AppError } from '../../bridge/types';
export type AuthorFilter={mode:'all'|'mine'}|{mode:'custom';authorIds:string[]};
export function expectedProject(owner:ActiveProject):Expected{const d=owner.store.snapshot.document;if(!owner.collaboration)throw new Error('Shared owner required');return{runtimeNonce:owner.collaboration.runtimeNonce,projectId:d.projectId,expectedRevision:d.revision};}
/** Foreign state is never accepted into ProjectStore. One bounded in-flight read per owner. */
export class CollaborationController {
 status:CollaborationStatus|null=null;error:AppError|null=null;filter:AuthorFilter={mode:'all'};
 private listeners=new Set<()=>void>();private version=0;private disposed=false;private paused=0;private timer?:ReturnType<typeof setInterval>;private flight:Promise<void>|null=null;
 private unregister?:()=>void;
 private manualFlight:Promise<void>|null=null;
 constructor(readonly owner:ActiveProject,private api:CollaborationCommands=collaborationClient){}
 subscribe=(f:()=>void)=>{this.listeners.add(f);return()=>{this.listeners.delete(f);};};getVersion=()=>this.version;
 private notify(){this.version++;this.listeners.forEach(f=>f());}
 setFilter(filter:AuthorFilter){this.filter=filter;this.notify();}
 visible(authorId:string|null){const filter=this.filter;if(filter.mode==='custom')return authorId!==null&&filter.authorIds.includes(authorId);return filter.mode==='all'||authorId===(this.owner.collaboration?.actor?.authorId??null);}
 accept(status:CollaborationStatus){if(this.disposed||status.runtimeNonce!==this.owner.collaboration?.runtimeNonce||(status.actor?.authorId??null)!==(this.owner.collaboration?.actor?.authorId??null))return;parseCollaborationStatus(status,this.owner.store.snapshot.document);if(status.retirement)this.owner.store.retire(status.retirement.mediaIds,status.retirement.snapshot);this.status=status;this.error=null;this.notify();}
 start(){this.unregister??=registerSuspension(this.owner.lifecycle,()=>this.suspend(false));if(this.timer||this.disposed)return;void this.refresh();this.timer=setInterval(()=>void this.refresh(),2000);}
 refresh():Promise<void>{if(this.disposed||this.paused||this.owner.lifecycle.admissionClosed||this.flight)return this.flight??Promise.resolve();this.flight=(async()=>{try{this.accept(await this.api.refresh(expectedProject(this.owner)));}catch(e){if(!this.disposed){this.error=normalizeError(e);this.notify();}}finally{this.flight=null;}})();return this.flight;}
 async suspend(includeManual=true){this.paused++;await this.flight;if(includeManual)await this.manualFlight;let done=false;return()=>{if(!done){done=true;this.paused--;}};}
 sync(){if(this.manualFlight)return this.manualFlight;this.manualFlight=this.performSync().finally(()=>{this.manualFlight=null;});return this.manualFlight;}
 private async performSync(){const resume=await this.suspend(false);try{if(this.disposed)return;await this.owner.lifecycle.save();if(!this.disposed)this.accept(await admitted(this.owner,()=>this.api.sync(expectedProject(this.owner)),()=>!this.disposed,this.api));}catch(e){if(!this.disposed){this.error=normalizeError(e);this.notify();}}finally{resume();}}
 dispose(){this.unregister?.();this.disposed=true;clearInterval(this.timer);this.listeners.clear();}
}
/** Preference failures remain lifecycle drafts; switching cannot silently lose them. */
export class PreferenceDraft {
 private readonly key='collaboration:playback-preferences';private unregister:()=>void;
 constructor(private owner:ActiveProject,private api:CollaborationCommands=collaborationClient){this.unregister=owner.lifecycle.registerDraft(this.key,()=>this.submit());}
 update(preferences:PlaybackPreferences){this.owner.store.setDraft(this.key,JSON.stringify({...preferences,mediaMonitorGainDb:Object.fromEntries(Object.entries(preferences.mediaMonitorGainDb).filter(([id])=>!this.owner.store.isRetired(id)))}));}
 private async submit(){const value=this.owner.store.drafts.get(this.key);if(value===undefined)return;await this.api.preferences(expectedProject(this.owner),JSON.parse(value) as PlaybackPreferences);this.owner.store.clearDraftIfUnchanged(this.key,value);}
 dispose(){this.unregister();}
}
