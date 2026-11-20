import { expect, it, vi } from 'vitest';
const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
import { captureDropSession, parseDropPreflight, preflightDrop } from './dragDrop';
const session = {projectId:'11111111-1111-4111-8111-111111111111',runtimeNonce:'22222222-2222-4222-8222-222222222222',shared:true};
const target = {folderId:null,layoutRevision:4};
it('binds classification to the exact native session, paths and target', async () => {
  invoke.mockReset().mockResolvedValueOnce(session).mockResolvedValueOnce({session,kind:'zip',paths:['D:/a.zip'],target});
  const captured = await captureDropSession(session.projectId);
  expect(captured).toEqual(session);
  expect(await preflightDrop(captured,['D:/a.zip'],target)).toEqual({session,kind:'zip',paths:['D:/a.zip'],target});
  expect(invoke).toHaveBeenLastCalledWith('preflight_drop',{session,paths:['D:/a.zip'],target});
  invoke.mockResolvedValueOnce({session:{...session,runtimeNonce:session.projectId},kind:'zip',paths:['D:/a.zip'],target});
  await expect(preflightDrop(session,['D:/a.zip'],target)).rejects.toThrow();
});
it('accepts ordinary audio only and validates limits and targets', () => {
  const ordinary={...session,shared:false};
  expect(parseDropPreflight({session:ordinary,kind:'audio',paths:['D:/a.wav'],target:null}).kind).toBe('audio');
  for (const value of [
    {session:ordinary,kind:'folder',paths:['D:/folder'],target:null},
    {session:ordinary,kind:'audio',paths:['D:/a.wav'],target},
    {session,kind:'zip',paths:Array(33).fill('D:/a.zip'),target},
    {session,kind:'folder',paths:['D:/a','D:/b'],target},
    {session,kind:'audio',paths:['D:/a.wav'],target:{...target,layoutRevision:-1}},
  ]) expect(() => parseDropPreflight(value)).toThrow();
});
it('freezes submitted paths and target while native classification is in flight', async () => {
  let resolve!: (value:unknown)=>void;
  invoke.mockReset().mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));
  const owner={...session}, paths=['D:/a.zip'], destination={...target};
  const pending=preflightDrop(owner,paths,destination);
  paths[0]='D:/other.zip';destination.layoutRevision=8;owner.runtimeNonce=owner.projectId;
  resolve({session,kind:'zip',paths:['D:/a.zip'],target});
  expect(await pending).toEqual({session,kind:'zip',paths:['D:/a.zip'],target});
  expect(invoke.mock.calls[0][1]).toEqual({session,paths:['D:/a.zip'],target});
});
it('enforces the source scanner UTF-16 path limit without narrowing direct audio', () => {
  const valid = 'a'.repeat(16384), tooLong = valid + 'a';
  for (const kind of ['folder', 'zip'] as const) {
    expect(parseDropPreflight({session,kind,paths:[valid],target}).paths[0]).toHaveLength(16384);
    expect(() => parseDropPreflight({session,kind,paths:[tooLong],target})).toThrow();
    expect(parseDropPreflight({session,kind,paths:['😀'.repeat(8192)],target}).paths[0]).toHaveLength(16384);
    expect(() => parseDropPreflight({session,kind,paths:['😀'.repeat(8193)],target})).toThrow();
  }
  expect(parseDropPreflight({session:{...session,shared:false},kind:'audio',paths:[tooLong],target:null}).paths[0]).toHaveLength(16385);
});
