import { expect,it,vi,afterEach } from 'vitest';
import { retryAdmission } from './admission';
afterEach(()=>vi.useRealTimers());
it('retries only structured busy admission with a new invocation factory',async()=>{
 vi.useFakeTimers();const start=vi.fn().mockRejectedValueOnce({code:'ResourceLimit',message:'busy',retryable:true,details:{operationBusy:true,operationKind:'mediaPreparation'}}).mockResolvedValue('ready');
 const result=retryAdmission(start);await vi.runAllTimersAsync();expect(await result).toBe('ready');expect(start).toHaveBeenCalledTimes(2);
 const hard=vi.fn().mockRejectedValue({code:'ResourceLimit',message:'capacity',retryable:true});await expect(retryAdmission(hard)).rejects.toMatchObject({message:'capacity'});expect(hard).toHaveBeenCalledTimes(1);
});
it('bounds admission waits and observes cancellation before another attempt',async()=>{
 vi.useFakeTimers();let cancelled=false;const start=vi.fn().mockRejectedValue({code:'ResourceLimit',message:'busy',retryable:true,details:{operationBusy:true}});
 const result=retryAdmission(start,{valid:()=>!cancelled});const assertion=expect(result).rejects.toMatchObject({code:'Cancelled'});await Promise.resolve();cancelled=true;await vi.runAllTimersAsync();await assertion;expect(start).toHaveBeenCalledTimes(1);
});

it('terminates a bounded busy retry without treating exhaustion as success',async()=>{
 vi.useFakeTimers();const start=vi.fn().mockRejectedValue({code:'ResourceLimit',message:'busy',retryable:true,details:{operationBusy:true}});const check=expect(retryAdmission(start,{attempts:2})).rejects.toMatchObject({code:'ResourceLimit'});await vi.runAllTimersAsync();await check;expect(start).toHaveBeenCalledTimes(2);
});
