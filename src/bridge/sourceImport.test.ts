import { expect, it, vi } from 'vitest';
const invoked=vi.hoisted(()=>vi.fn());
vi.mock('@tauri-apps/api/core',()=>({invoke:invoked,Channel:class{onmessage=(_v:unknown)=>{};}}));
import { createSourceClient, parseSourceEvent, parseSourcePage, parseSourceToken, parseSourceRules, parseSourceMediaEvent } from './sourceImport';
export const token = { runtimeNonce: '11111111-1111-4111-8111-111111111111', projectId: '22222222-2222-4222-8222-222222222222', taskId: '33333333-3333-4333-8333-333333333333' };
const counts = { checked: 1, candidates: 1, skipped: 0, issues: 0, selectedBytes: 20 };
it('validates exact native scan payloads including runtime ownership and nullable position', () => {
 expect(parseSourceToken(token)).toEqual(token);
 expect(parseSourceEvent({ type: 'result', token, counts }).type).toBe('result');
 const candidate = { index: 0, sourceIndex: 0, sourceName: 'a.zip', relativePath: 'record/audio/CH2.wav', displayName: 'a.zip/record/audio/CH2.wav', byteLength: 20, logicalPosition: 1 };
 expect(parseSourcePage({ candidates: [candidate], issues: [], counts }).candidates[0]).toEqual(candidate);
 expect(() => parseSourcePage({ candidates: [{ ...candidate, logicalPosition: undefined }], issues: [], counts })).toThrow();
 expect(() => parseSourceToken({ ...token, ownerId: token.taskId })).toThrow();
 expect(() => parseSourceEvent({ type: 'result', token, counts: { ...counts, candidates: 10001 } })).toThrow();
 expect(() => parseSourcePage({ candidates: [{ ...candidate, relativePath: '../CH2.wav' }], issues: [], counts })).toThrow();
});
it('binds scan and token operations to the captured runtime, and delivers events before acknowledgement',async()=>{
 const rules={mode:'generic' as const,recursive:true,extensions:['wav'],include:['*/CH1'],exclude:[],includeSecond:true};
 const events:unknown[]=[];invoked.mockImplementation(async(command,args)=>{if(command==='scan_import_sources'){args.onEvent.onmessage({type:'result',token,counts});expect(events).toHaveLength(1);return token;}return null;});
 const client=createSourceClient(token.runtimeNonce);await client.start(token.projectId,{kind:'zip',paths:['D:/a.zip'],rules},e=>events.push(e));
 expect(invoked).toHaveBeenCalledWith('scan_import_sources',expect.objectContaining({runtimeNonce:token.runtimeNonce,projectId:token.projectId}),undefined);
 await client.release(token);expect(invoked).toHaveBeenCalledWith('release_import_source_scan',{token},undefined);
 expect(()=>client.release({...token,runtimeNonce:token.taskId})).toThrow();
 expect(parseSourceMediaEvent({type:'progress',taskId:token.taskId,index:0,path:'a.zip/r/CH2.wav',phase:'extract',completed:1})).toMatchObject({phase:'extract'});
 expect(()=>parseSourceMediaEvent({type:'progress',taskId:token.taskId,index:256,path:'x',phase:'extract',completed:1})).toThrow();
});
it('accepts shorthand rules and rejects unsupported or excessive rules', () => {
 const rules = { mode: 'generic', recursive: true, extensions: ['wav'], include: ['*/CH1','*/CH2'], exclude: [], includeSecond: true };
 expect(parseSourceRules(rules)).toEqual(rules);
 expect(() => parseSourceRules({ ...rules, include: ['[abc]'] })).toThrow();
 expect(() => parseSourceRules({ ...rules, extensions: [] })).toThrow();
 expect(() => parseSourceRules({ ...rules, include: Array(257).fill('*') })).toThrow();
});
