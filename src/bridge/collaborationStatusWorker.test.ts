import {afterEach,expect,it,vi} from 'vitest';
import {parseCollaborationStatus,createCollaborationStatusParser} from './collaborationSchema';
const id='11111111-1111-4111-8111-111111111111';
const value=()=>({formatVersion:1,runtimeNonce:id,projectId:null,shared:false,projectFlavor:'ordinary',identityMode:'ordinary',canWriteAnnotations:false,canImportMedia:false,hiddenMediaIds:[],catalogPending:false,actor:null,preferences:null,pending:false,recoveryRequired:false,busy:false,lastSuccessMs:null,error:null,retirement:null,purgeMaintenance:{total:0,items:[]},snapshot:null});
class TestWorker{
 static instances:TestWorker[]=[];sent:{id:number;value:unknown}[]=[];terminated=false;
 private previous:{id:number;value:Record<string,unknown>}|undefined;
 onmessage?: (e:{data:unknown})=>void;onerror?:()=>void;onmessageerror?:()=>void;
 constructor(){TestWorker.instances.push(this);}
 postMessage(message:{id:number;value:unknown}){this.sent.push(structuredClone(message));}
 terminate(){this.terminated=true;}
 reply(index=0){const message=this.sent[index];try{const parsed=parseCollaborationStatus(message.value),patch=Object.fromEntries(Object.entries(parsed).filter(([key,value])=>JSON.stringify(this.previous?.value[key])!==JSON.stringify(value)));this.onmessage?.({data:{id:message.id,ok:true,base:this.previous?.id??0,patch:structuredClone(patch)}});this.previous={id:message.id,value:parsed as unknown as Record<string,unknown>};}catch{this.onmessage?.({data:{id:message.id,ok:false}});}}
}
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();vi.resetModules();TestWorker.instances=[];});
it('uses one lazy worker and returns immutable validated results with current-document checks',async()=>{
 vi.stubGlobal('Worker',TestWorker);const {validateNativeStatus}=await import('./collaborationStatusWorker');
 expect(TestWorker.instances).toHaveLength(0);const flight=validateNativeStatus(value()),worker=TestWorker.instances[0];worker.reply();
 const result=await flight;expect(Object.isFrozen(result)).toBe(true);expect(Object.isFrozen(result.hiddenMediaIds)).toBe(true);
 expect(()=>{result.hiddenMediaIds.push(id);}).toThrow();expect(createCollaborationStatusParser()(result)).toBe(result);
 const second=validateNativeStatus({...value(),lastSuccessMs:42});worker.reply(1);const updated=await second;expect(updated.lastSuccessMs).toBe(42);expect(updated.hiddenMediaIds).toBe(result.hiddenMediaIds);
 const invalid=validateNativeStatus({...value(),formatVersion:2});worker.reply(2);await expect(invalid).rejects.toMatchObject({code:'InvalidInput'});
 expect(TestWorker.instances).toHaveLength(1);worker.onerror?.();
});
it('bounds concurrent work and fences delayed errors from a retired worker',async()=>{
 vi.stubGlobal('Worker',TestWorker);const {validateNativeStatus}=await import('./collaborationStatusWorker');
 const flights=Array.from({length:8},()=>validateNativeStatus(value())),settled=Promise.allSettled(flights),old=TestWorker.instances[0];
 await expect(validateNativeStatus(value())).rejects.toMatchObject({code:'ResourceLimit'});old.onerror?.();expect((await settled).every(v=>v.status==='rejected')).toBe(true);expect(old.terminated).toBe(true);
 const next=validateNativeStatus(value()),current=TestWorker.instances[1];old.onerror?.();expect(current.terminated).toBe(false);current.reply();await expect(next).resolves.toMatchObject({formatVersion:1});current.onerror?.();
});
it('retires stalled validation without retaining pending promises',async()=>{
 vi.useFakeTimers();vi.stubGlobal('Worker',TestWorker);const {validateNativeStatus}=await import('./collaborationStatusWorker');
 const flight=validateNativeStatus(value()),assertion=expect(flight).rejects.toMatchObject({retryable:true});await vi.advanceTimersByTimeAsync(30000);await assertion;expect(TestWorker.instances[0].terminated).toBe(true);
});
it('actual worker sends only changed fields and advances its baseline only after successful publication',async()=>{
 const messages:Record<string,unknown>[]=[];let fail=false;
 const scope={onmessage:null as unknown as (event:{data:{id:number;value:unknown}})=>void,postMessage:(message:Record<string,unknown>)=>{if(fail){fail=false;throw new Error('publication failed');}messages.push(structuredClone(message));}};
 vi.stubGlobal('self',scope);await import('./collaborationValidation.worker');
 const send=(id:number,time:number)=>scope.onmessage({data:{id,value:{...value(),lastSuccessMs:time}}});
 send(1,1);expect(messages.at(-1)).toMatchObject({id:1,base:0,ok:true});
 send(2,2);expect(messages.at(-1)).toEqual({id:2,base:1,ok:true,patch:{lastSuccessMs:2}});
 fail=true;send(3,3);expect(messages.at(-1)).toEqual({id:3,ok:false});
 send(4,3);expect(messages.at(-1)).toEqual({id:4,base:2,ok:true,patch:{lastSuccessMs:3}});
 scope.onmessage({data:{id:5,value:{...value(),formatVersion:2}}});expect(messages.at(-1)).toEqual({id:5,ok:false});
 send(6,4);expect(messages.at(-1)).toEqual({id:6,base:4,ok:true,patch:{lastSuccessMs:4}});
});
