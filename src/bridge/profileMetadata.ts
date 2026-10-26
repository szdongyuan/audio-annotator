/** Shared by global profiles and project author records; never includes credentials. */
export interface Profile { authorId:string; displayName:string; createdAt:string }
export function requireProfile(value:unknown):asserts value { if(!value)throw new Error('Invalid profile response'); }
export function profileShape(value:unknown,fields:string[]):Record<string,unknown>{
 requireProfile(value!==null&&typeof value==='object'&&!Array.isArray(value));
 const o=value as Record<string,unknown>;requireProfile(Object.keys(o).length===fields.length&&fields.every(k=>Object.hasOwn(o,k)));return o;
}
export function profileUuid(value:unknown):asserts value is string {requireProfile(typeof value==='string'&&/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value)&&value!=='00000000-0000-0000-0000-000000000000');}
const encoder=new TextEncoder();
// Rust str::trim uses Unicode White_Space, which differs from JavaScript trim
// for U+0085 and U+FEFF. Reject controls before trimming, as native does.
export function normalizeNickname(value:unknown):string {
 requireProfile(typeof value==='string'&&!/[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(value));
 const name=value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu,'');
 requireProfile([...name].length>=1&&[...name].length<=64&&encoder.encode(name).length<=256);return name;
}
function timestamp(value:unknown){
 requireProfile(typeof value==='string'&&value.length<=1024*1024);
 // chrono accepts a space or lowercase t separator and arbitrary fractional
 // precision, including leap seconds; Date.parse rejects/truncates these.
 const m=/^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/.exec(value);requireProfile(m);
 const [year,month,day,hour,minute,second]=m.slice(1).map(Number);
 const leap=year%4===0&&(year%100!==0||year%400===0);
 const days=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31];
 requireProfile(month>=1&&month<=12&&day>=1&&day<=days[month-1]&&hour<=23&&minute<=59&&second<=60);
}
export function parseProfile(value:unknown):Profile {
 const p=profileShape(value,['authorId','displayName','createdAt']);profileUuid(p.authorId);
 requireProfile(normalizeNickname(p.displayName)===p.displayName);timestamp(p.createdAt);return value as Profile;
}
/** Only bounded, already validated profile metadata is serialized. */
export function metadataBytes(value:unknown){const bytes=encoder.encode(JSON.stringify(value)).length;requireProfile(bytes<=1024*1024);return bytes;}
