import { normalizeError } from './client';
import type { AppError } from './types';
export const operationBusy=(error:unknown)=>{const e=normalizeError(error);return e.code==='ResourceLimit'&&(e.details as {operationBusy?:unknown}|undefined)?.operationBusy===true;};
export const admissionCancelled=():AppError=>({code:'Cancelled',message:'操作已取消或项目已切换',retryable:true});
/** The factory is called again, so dropped native Channels are never reused. */
export async function retryAdmission<T>(attempt:()=>Promise<T>,options:{valid?:()=>boolean;before?:()=>Promise<void>;attempts?:number}={}):Promise<T>{
 for(let n=0;n<(options.attempts??100);n++){
  if(options.valid&&!options.valid())throw admissionCancelled();
  if(options.before)await options.before();
  if(options.valid&&!options.valid())throw admissionCancelled();
  try{return await attempt();}catch(e){if(!operationBusy(e))throw e;}
  await new Promise(r=>setTimeout(r,100));
 }
 throw {code:'ResourceLimit',message:'任务仍在结束，请稍后重试。',retryable:true,details:{operationBusy:true}} satisfies AppError;
}
