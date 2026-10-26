import { describe, expect, it, vi } from 'vitest';
import { normalizeNickname, parseProfile, parseProfileExpected, parseProfileResponse, parseProfileSnapshot, profileClient } from './profiles';
import { parseSharedContext } from './collaboration';
import fixture from '../../tests/fixtures/document-v3.json';
const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke, Channel: class {} }));
export const a = '11111111-1111-4111-8111-111111111111';
export const b = '22222222-2222-4222-8222-222222222222';
export const profile = { authorId:a, displayName:'名字', createdAt:'2026-10-26T00:00:00Z' };
export const snapshot = () => ({ storeRevision:1, selectedAuthorId:a, profiles:[{...profile}], runtimeNonce:b, project:null });
export const response = () => ({ profiles:snapshot(), transition:null, status:null, warning:null, profile:null, alreadyExists:false });
describe('native profile boundary', () => {
 it('requires explicit nullable project expectations and strictly validates snapshots', () => {
  const expected={storeRevision:1,runtimeNonce:b,project:null};expect(parseProfileExpected(expected)).toEqual(expected);
  for(const v of [{storeRevision:1,runtimeNonce:b},{...expected,extra:1},{...expected,project:{projectId:a}},{...expected,storeRevision:-1}])expect(()=>parseProfileExpected(v)).toThrow();
  expect(parseProfileSnapshot(snapshot()).selectedAuthorId).toBe(a);
  for(const patch of [{profiles:[]},{profiles:[profile,profile]},{profiles:Array(129).fill(profile)},{selectedAuthorId:b},{profiles:[{...profile,normalizedLogin:'old'}]}])expect(()=>parseProfileSnapshot({...snapshot(),...patch})).toThrow();
 });
 it('matches Unicode scalar, UTF-8, native trim and control rules', () => {
  expect(normalizeNickname('  '+ '😀'.repeat(64)+'  ')).toBe('😀'.repeat(64));
  for(const value of ['😀'.repeat(65),'a\u0085','a\n'])expect(()=>normalizeNickname(value)).toThrow();
  expect(normalizeNickname('\u2000name\u2000')).toBe('name');expect(normalizeNickname('\uFEFF')).toBe('\uFEFF');
 });
 it('accepts maximal portable profile timestamps and leap seconds in author records', () => {
  const transfer={kind:'annotator.portable-profile',formatVersion:1,profile:{...profile,createdAt:'2016-12-31T23:59:60.Z'}};
  const base=new TextEncoder().encode(JSON.stringify(transfer)).length;transfer.profile.createdAt='2016-12-31T23:59:60.'+'1'.repeat(4096-base)+'Z';
  expect(new TextEncoder().encode(JSON.stringify(transfer))).toHaveLength(4096);
  expect(parseProfile(transfer.profile)).toEqual(transfer.profile);
  expect(parseSharedContext({runtimeNonce:b,actor:transfer.profile,preferences:null,projectFlavor:'default',identityMode:'profile',canWriteAnnotations:true,canImportMedia:true,hiddenMediaIds:[],catalogPending:false}).actor).toEqual(transfer.profile);
  for(const createdAt of ['2025-02-29T00:00:00Z','2026-01-01T24:00:00Z','2026-01-01T00:00:61Z','2026-01-01T00:00:00+00:00'])expect(()=>parseProfile({...profile,createdAt})).toThrow();
 });
 it('preserves partial rename warnings and rejects unknown response fields', () => {
  const value={...response(),profile,warning:{code:'Io',message:'昵称已保存在本机，项目显示名称未更新',retryable:true}};
  // A known native error code is required.
  value.warning.code='SaveFailed';expect(parseProfileResponse(value).warning?.message).toContain('已保存在本机');
  expect(()=>parseProfileResponse({...value,extra:true})).toThrow();
 });
 it('sends the exact credential-free native profile commands', async () => {
  invoke.mockResolvedValue(response());const expected={storeRevision:1,runtimeNonce:b,project:null};
  await profileClient.create(expected,a,' 名字 ');expect(invoke).toHaveBeenLastCalledWith('profile_create',{expected,operationId:a,displayName:'名字'});
  await profileClient.import(expected,a,null);expect(invoke).toHaveBeenLastCalledWith('profile_import',{expected,operationId:a,path:null});
  await profileClient.select(expected,a,b);expect(invoke).toHaveBeenLastCalledWith('profile_select',{expected,operationId:a,authorId:b});
 });
 it('bounds malformed warning metadata independently from valid large annotation transitions',()=>{
  const document=structuredClone(fixture);document.annotations[0].note='n'.repeat(1048577);
  const context={runtimeNonce:b,actor:profile,preferences:null,projectFlavor:'default',identityMode:'profile',canWriteAnnotations:true,canImportMedia:true,hiddenMediaIds:[],catalogPending:false};
  const status={...context,formatVersion:1,projectId:document.projectId,shared:true,pending:false,recoveryRequired:false,busy:false,lastSuccessMs:null,error:null,snapshot:null};
  const value={...response(),profiles:{...snapshot(),project:{projectId:document.projectId,expectedRevision:document.revision}},transition:{opened:{snapshot:{document,canUndo:true,canRedo:false},persistedRevision:document.revision,path:'shared',recovery:null,collaboration:context},status}};
  expect(parseProfileResponse(value).transition?.opened.snapshot?.document.annotations[0].note).toHaveLength(1048577);
  const details:Record<string,unknown>={};details.cycle=details;
  for(const bad of [details,{huge:'x'.repeat(65537)}])expect(()=>parseProfileResponse({...response(),warning:{code:'SaveFailed',message:'warning',retryable:true,details:bad}})).toThrow();
 });
 it('accepts a maximal native store even when runtime/project envelope adds bytes',()=>{
  const p={...profile,createdAt:'2026-10-26T00:00:00.Z'};
  const store={kind:'annotator.profile-store',formatVersion:1,revision:1,lastSelectedAuthorId:a,profiles:[p]};
  const size=new TextEncoder().encode(JSON.stringify(store)).length;p.createdAt='2026-10-26T00:00:00.'+'1'.repeat(1048576-size)+'Z';
  expect(new TextEncoder().encode(JSON.stringify(store))).toHaveLength(1048576);
  const value={...snapshot(),profiles:[p],project:{projectId:a,expectedRevision:0}};
  expect(parseProfileSnapshot(value)).toEqual(value);
  expect(()=>parseProfileSnapshot({...value,profiles:[{...p,createdAt:p.createdAt.replace('Z','1Z')}]})).toThrow();
 });
});

