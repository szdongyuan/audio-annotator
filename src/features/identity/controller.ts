import { profileClient, type ProfileCommands, type ProfileExpected, type ProfileResponse, type ProfileSnapshot } from '../../bridge/profiles';
import { collaborationClient, type CollaborationStatus } from '../../bridge/collaboration';
import { normalizeError } from '../../bridge/client';
import { admissionCancelled, retryAdmission } from '../../bridge/admission';
import type { AppError } from '../../bridge/types';
import type { ActiveProject } from '../project/useProjectLifecycle';
export type IdentityDialogKind='create'|'switch'|'rename'|'import'|'export';
export interface IdentityHost {
 owner:()=>ActiveProject|null;
 perform:(owner:ActiveProject|null,action:()=>Promise<ProfileResponse|null>,save:boolean)=>Promise<ProfileResponse|null>;
 acceptStatus:(status:CollaborationStatus)=>void;
}
/** Application identity is independent of the nullable project actor. */
export class IdentityController {
 snapshot:ProfileSnapshot|null=null;error:AppError|null=null;warning:AppError|null=null;
 returnFocus:HTMLElement|null=null;
 result:ProfileResponse|null=null;dialog:IdentityDialogKind|null=null;busy=false;
 private operation:{id:string;cancelled:boolean}|null=null;private generation=0;private disposed=false;
 private listeners=new Set<()=>void>();private version=0;
 constructor(private host:IdentityHost,private api:ProfileCommands=profileClient,private cancelNative:(id:string)=>Promise<unknown>=collaborationClient.cancel){}
 subscribe=(f:()=>void)=>{this.listeners.add(f);return()=>{this.listeners.delete(f);};};getVersion=()=>this.version;
 private notify(){this.version++;this.listeners.forEach(f=>f());}
 start(){this.disposed=false;this.generation++;}
 get selected(){return this.snapshot?.profiles.find(p=>p.authorId===this.snapshot?.selectedAuthorId)??null;}
 async refresh(){const generation=++this.generation,owner=this.host.owner();try{const s=await this.api.list();if(!this.disposed&&!this.operation&&generation===this.generation&&owner===this.host.owner()){this.snapshot=s;this.error=null;this.notify();}}catch(e){if(!this.disposed&&generation===this.generation&&owner===this.host.owner()){this.error=normalizeError(e);this.notify();}}}
 show(kind:IdentityDialogKind,returnFocus?:HTMLElement|null){if(this.busy||this.disposed)return;this.returnFocus=returnFocus??(document.activeElement instanceof HTMLElement?document.activeElement:null);this.dialog=kind;this.error=null;this.warning=null;this.result=null;this.notify();void this.refresh();}
 close(){if(!this.busy){this.dialog=null;this.notify();}}
 cancel(){if(this.operation){this.operation.cancelled=true;void this.cancelNative(this.operation.id).catch(e=>{if(!this.disposed){this.error=normalizeError(e);this.notify();}});}else this.close();}
 private accept(result:ProfileResponse){this.snapshot=result.profiles;this.warning=result.warning;this.result=result;if(result.status)this.host.acceptStatus(result.status);this.notify();}
 private async run(save:boolean,action:(fresh:()=>Promise<ProfileExpected>,id:string,valid:()=>boolean)=>Promise<ProfileResponse|null>){
  if(this.operation||this.disposed)return;const owner=this.host.owner(),op={id:crypto.randomUUID(),cancelled:false};
  this.operation=op;this.generation++;this.busy=true;this.error=null;this.warning=null;this.result=null;this.notify();
  const valid=()=>!this.disposed&&!op.cancelled&&this.host.owner()===owner;
  const fresh=async()=>{if(!valid())throw admissionCancelled();const s=await this.api.list();if(!valid())throw admissionCancelled();
   const doc=owner?.store.snapshot.document;
   if((s.project?.projectId??null)!==(doc?.projectId??null)||(doc&&s.project?.expectedRevision!==doc.revision)||(owner?.collaboration&&s.runtimeNonce!==owner.collaboration.runtimeNonce))throw admissionCancelled();
   this.snapshot=s;this.notify();return{storeRevision:s.storeRevision,runtimeNonce:s.runtimeNonce,project:s.project};};
  try{const result=await this.host.perform(owner,()=>action(fresh,op.id,valid),save);
   // Successful native selection is a committed result. A late cancel must not
   // leave the UI on the retired editor/UUID; host adopts before returning.
   if(result&&!this.disposed)this.accept(result);
  }catch(e){if(!this.disposed){this.error=normalizeError(e);this.notify();}}
  finally{this.operation=null;this.busy=false;if(!this.disposed)this.notify();}
 }
 private mutate(fresh:()=>Promise<ProfileExpected>,valid:()=>boolean,attempt:(expected:ProfileExpected)=>Promise<ProfileResponse>){return retryAdmission(async()=>attempt(await fresh()),{valid});}
 create(displayName:string){return this.run(true,async(fresh,id,valid)=>{const created=await this.mutate(fresh,valid,e=>this.api.create(e,id,displayName));this.accept(created);if(!valid())return created;return this.mutate(fresh,valid,e=>this.api.select(e,id,created.profile!.authorId));});}
 select(authorId:string){if(authorId===this.snapshot?.selectedAuthorId)return Promise.resolve();return this.run(true,async(fresh,id,valid)=>this.mutate(fresh,valid,e=>this.api.select(e,id,authorId)));}
 rename(displayName:string){const authorId=this.selected?.authorId;if(!authorId)return Promise.resolve();return this.run(false,async(fresh,id,valid)=>this.mutate(fresh,valid,e=>this.api.rename(e,id,authorId,displayName)));}
 import(){return this.run(false,async(fresh,id,valid)=>{const path=await this.api.chooseImport();if(!path||!valid())return null;return this.mutate(fresh,valid,e=>this.api.import(e,id,path));});}
 export(){const authorId=this.selected?.authorId;if(!authorId)return Promise.resolve();return this.run(false,async(fresh,id,valid)=>{const path=await this.api.chooseExport(authorId);if(!path||!valid())return null;return this.mutate(fresh,valid,e=>this.api.export(e,id,authorId,path));});}
 dispose(){this.disposed=true;this.generation++;if(this.operation){this.operation.cancelled=true;void this.cancelNative(this.operation.id).catch(()=>{});}this.listeners.clear();}
}
