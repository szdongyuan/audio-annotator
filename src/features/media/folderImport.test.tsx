import { afterEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import fixture from '../../../tests/fixtures/document-v2.json';
import { ProjectStore } from '../../app/store';
import { CommandQueue, type ProjectCommands } from '../../app/commands';
import { parseProjectDocument } from '../../bridge/types';
import type { FolderCommands, FolderEvent } from '../../bridge/folders';
import type { MediaCommands, MediaEvent } from '../../bridge/media';
import { ProjectLifecycle } from '../project/lifecycle';
import { MediaImportController } from './imports';
import { FolderImportController } from './folderImport';
import { FolderImportDialog } from './FolderImportDialog';
import { FolderImportProgress } from './FolderImportProgress';
import { useMedia } from './useMedia';
import { folderClient, folderDialogs } from '../../bridge/folders';
import { mediaClient, mediaDialogs } from '../../bridge/media';
import { useSyncExternalStore } from 'react';
import { AnnotationFailure } from '../annotations/AnnotationFailure';
import { useAnnotations } from '../annotations/useAnnotations';

const token = { taskId: 'scan', ownerId: 'owner' };
const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach(fn => fn()); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function setup(count = 257) {
  const store = new ProjectStore({ document: parseProjectDocument(structuredClone(fixture)), canUndo: false, canRedo: false });
  const commands: ProjectCommands = { applyChange: vi.fn(async (_id, rev, change) => {
    const snapshot = structuredClone(store.snapshot); snapshot.document.revision = rev + 1;
    if (change.type === 'importMedia') snapshot.document.media.push(change.media);
    return snapshot;
  }), getSnapshot: vi.fn(), undo: vi.fn(), redo: vi.fn() };
  const queue = new CommandQueue(store, commands);
  const lifecycle = new ProjectLifecycle(store, queue, { save: vi.fn(async (_id, rev) => rev), close: vi.fn() });
  const owner = { store, queue, lifecycle, path: 'D:/project' };
  let scan!: (event: FolderEvent) => void;
  const candidates = Array.from({ length: count }, (_, i) => ({ path: `D:/audio/${i}.wav`, relativePath: `${i}.wav` }));
  const folder: FolderCommands = {
    start: vi.fn(async (_id, _path, receive) => { scan = receive; return token; }),
    page: vi.fn(async (_token, kind, offset, limit = 256) => ({ token, kind, offset, total: kind === 'candidates' ? count : 0, candidates: kind === 'candidates' ? candidates.slice(offset, offset + limit) : [], issues: [] })),
    cancel: vi.fn(async () => {}), release: vi.fn(async () => {}),
  };
  const callbacks: ((event: MediaEvent) => void)[] = [];
  const media: MediaCommands = { start: vi.fn(async (_id, _paths, receive) => { callbacks.push(receive); return `batch${callbacks.length}`; }), cancel: vi.fn(async () => {}), release: vi.fn(async () => {}), status: vi.fn(async () => []) };
  const imports = new MediaImportController(store, queue, media, lifecycle);
  const controller = new FolderImportController(owner, imports, folder);
  cleanups.push(() => { controller.dispose(); imports.dispose(); lifecycle.dispose(); });
  const result = (extra = {}) => scan({ type: 'result', token, root: 'D:/audio', counts: { checked: count, candidates: count, existing: 0, skipped: 0, failed: 0, issues: 0, ...extra }, retainedIssues: 0 });
  const finish = (batch: number, indexes?: number[]) => {
    const paths = vi.mocked(media.start).mock.calls[batch - 1][1];
    (indexes ?? paths.map((_, i) => i)).forEach(i => callbacks[batch - 1]({ type: 'ready', taskId: `batch${batch}`, index: i, media: { ...fixture.media[0], id: `00000000-0000-4000-8000-${String(batch * 1000 + i).padStart(12, '0')}`, sourceRef: paths[i] } }));
    callbacks[batch - 1]({ type: 'finished', taskId: `batch${batch}`, cancelled: false });
  };
  return { owner, store, queue, commands, lifecycle, folder, media, imports, controller, result, finish, callbacks, candidates, scan: (e: FolderEvent) => scan(e) };
}

it('scans nonrecursively by default then imports all 257 candidates in serial batches and releases scan', async () => {
  const s = setup(); await s.controller.choose(async () => 'D:/audio'); s.result();
  await waitFor(() => expect(s.media.start).toHaveBeenCalledTimes(1));
  expect(s.folder.start).toHaveBeenCalledWith(fixture.projectId, 'D:/audio', expect.any(Function), false);
  expect(vi.mocked(s.media.start).mock.calls[0][1]).toHaveLength(256);
  s.finish(1); await waitFor(() => expect(s.media.start).toHaveBeenCalledTimes(2));
  expect(vi.mocked(s.media.start).mock.calls[1][1]).toEqual(['D:/audio/256.wav']);
  s.finish(2); await waitFor(() => expect(s.controller.state).toBe('finished'));
  expect(s.controller.items).toHaveLength(257); expect(s.controller.items[256].index).toBe(256);
  expect(s.controller.items.every(i => i.state === 'success')).toBe(true);
  expect(s.folder.release).toHaveBeenCalledWith(token);
});

it('waits for early scan result acknowledgement and finished-before-start plus publishing work', async () => {
  const s = setup(); const scanAck = deferred<typeof token>(), startAck = deferred<string>(), publish = deferred<void>();
  vi.mocked(s.folder.start).mockImplementation((_id, _path, receive) => { receive({ type: 'result', token, root: 'D:/audio', counts: { checked: 257, candidates: 257, existing: 0, skipped: 0, failed: 0, issues: 0 }, retainedIssues: 0 }); return scanAck.promise; });
  const original = s.commands.applyChange;
  vi.mocked(s.commands.applyChange).mockImplementationOnce(async (...args) => { await publish.promise; return original(...args); });
  vi.mocked(s.media.start).mockImplementationOnce((_id, paths, emit) => { emit({ type: 'ready', taskId: 'batch1', index: 0, media: { ...fixture.media[0], id: '00000000-0000-4000-8000-000000000099', sourceRef: paths[0] } }); emit({ type: 'finished', taskId: 'batch1', cancelled: false }); return startAck.promise; });
  const choosing = s.controller.choose(async () => 'D:/audio', true);
  await waitFor(() => expect(s.folder.start).toHaveBeenCalled()); expect(s.media.start).not.toHaveBeenCalled();
  scanAck.resolve(token); await choosing; await waitFor(() => expect(s.media.start).toHaveBeenCalledOnce());
  startAck.resolve('batch1'); await Promise.resolve(); expect(s.media.start).toHaveBeenCalledOnce();
  publish.resolve(); await waitFor(() => expect(s.media.start).toHaveBeenCalledTimes(2));
});

it.each(['picker', 'page', 'decode'] as const)('cancels at %s without late work or a hanging reset waiter', async stage => {
  const s = setup(); const picker = deferred<string>(), page = deferred<Awaited<ReturnType<FolderCommands['page']>>>();
  if (stage === 'page') vi.mocked(s.folder.page).mockReturnValueOnce(page.promise);
  const choosing = s.controller.choose(stage === 'picker' ? () => picker.promise : async () => 'D:/audio');
  if (stage !== 'picker') { await choosing; s.result(); await waitFor(() => expect(stage === 'page' ? s.folder.page : s.media.start).toHaveBeenCalled()); }
  s.controller.cancel(); expect(s.controller.state).toBe('cancelled');
  if (stage === 'picker') { picker.resolve('D:/audio'); await choosing; expect(s.folder.start).not.toHaveBeenCalled(); }
  if (stage === 'page') { page.resolve({ token, kind: 'candidates', offset: 0, total: 257, candidates: s.candidates.slice(0, 256), issues: [] }); await Promise.resolve(); expect(s.media.start).not.toHaveBeenCalled(); }
  if (stage === 'decode') { s.store.deactivate(); await s.imports.completed(); s.finish(1, [0]); await s.imports.settled(); expect(s.media.cancel).toHaveBeenCalledWith('batch1'); expect(s.media.release).toHaveBeenCalled(); expect(s.commands.applyChange).not.toHaveBeenCalled(); }
});

it('pauses on document failures, retries only owned prepared media and waits for other owners before resuming', async () => {
  const s = setup(); const error = { code: 'SaveFailed', message: 'disk failed', retryable: true };
  vi.mocked(s.commands.applyChange).mockRejectedValueOnce(error);
  await s.queue.enqueue({ type: 'updateMediaNote', mediaId: fixture.media[0].id, note: 'keep', mergeKey: null }, { owner: 'annotations' }).catch(() => {});
  vi.mocked(s.commands.applyChange).mockRejectedValueOnce(error);
  await s.controller.choose(async () => 'D:/audio'); s.result(); await waitFor(() => expect(s.media.start).toHaveBeenCalledOnce());
  s.finish(1, [0]); await waitFor(() => expect(s.controller.state).toBe('paused'));
  expect(s.queue.unresolvedFailures).toHaveLength(2); expect(s.media.start).toHaveBeenCalledOnce(); expect(s.media.release).not.toHaveBeenCalled();
  await s.controller.retry(); expect(s.media.start).toHaveBeenCalledOnce(); expect(s.controller.state).toBe('paused');
  expect(s.controller.items[0].state).toBe('success'); expect(s.queue.unresolvedFailures).toHaveLength(1); expect(s.queue.unresolvedFailures[0].owner).toBe('annotations');
  await s.queue.retry(s.queue.unresolvedFailures[0].id); await s.controller.retry(); await waitFor(() => expect(s.media.start).toHaveBeenCalledTimes(2));
  s.controller.cancel(); expect(s.queue.unresolvedFailures).toHaveLength(0);
});

it('cancellation retains failed edits until explicit end, which discards only owned ledger and releases PCM', async () => {
  const s = setup(1); vi.mocked(s.commands.applyChange).mockRejectedValueOnce({ code: 'SaveFailed', message: 'disk failed', retryable: true });
  await s.controller.choose(async () => 'D:/audio'); s.result(); await waitFor(() => expect(s.media.start).toHaveBeenCalled()); s.finish(1);
  await waitFor(() => expect(s.controller.state).toBe('paused')); s.controller.cancel();
  expect(s.queue.unresolvedFailures).toHaveLength(1); expect(s.media.release).not.toHaveBeenCalled();
  await s.controller.end(); expect(s.queue.unresolvedFailures).toHaveLength(0); expect(s.media.release).toHaveBeenCalledWith('batch1', s.controller.items[0].mediaId);
});

it('offers unchecked subfolders before native picker and renders bounded pages with honest issue truncation', async () => {
  const s = setup(300); const picker = vi.fn(async () => 'D:/audio'); s.controller.begin();
  const dialog = render(<FolderImportDialog controller={s.controller} picker={picker} />);
  expect(screen.getByRole('checkbox', { name: '包含子文件夹' })).not.toBeChecked(); expect(picker).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('checkbox')); fireEvent.click(screen.getByRole('button', { name: '选择文件夹…' }));
  await waitFor(() => expect(s.folder.start).toHaveBeenCalledWith(fixture.projectId, 'D:/audio', expect.any(Function), true));
  dialog.unmount(); s.result(); await waitFor(() => expect(s.media.start).toHaveBeenCalled()); s.finish(1);
  await waitFor(() => expect(s.media.start).toHaveBeenCalledTimes(2)); s.finish(2); await waitFor(() => expect(s.controller.state).toBe('finished'));
  s.controller.counts.issues = 400; s.controller.issues = Array.from({length:256},(_,i)=>({path:`skip${i}`,kind:'unsupported',message:'unsupported'}));
  render(<FolderImportProgress controller={s.controller} />); fireEvent.click(screen.getByRole('button', { name: '查看详情' }));
  expect(screen.getAllByRole('listitem')).toHaveLength(50); expect(screen.getByText(/仅保留前 256/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', {name:'下一页'})); expect(screen.getAllByRole('listitem')[0]).toHaveTextContent('51.');
});

it('locks direct/relink and folder pickers mutually and rejects late picker after same-id runtime replacement', async () => {
  const s = setup(); const picker = deferred<string>();
  vi.spyOn(mediaClient,'status').mockResolvedValue([]); const start = vi.spyOn(mediaClient,'start').mockResolvedValue('direct');
  vi.spyOn(mediaClient,'cancel').mockResolvedValue(); vi.spyOn(mediaDialogs,'choose').mockReturnValue(picker.promise);
  const scan = vi.spyOn(folderClient,'start').mockResolvedValue(token); vi.spyOn(folderDialogs,'choose').mockResolvedValue('D:/audio');
  cleanups.push(() => vi.restoreAllMocks());
  const hook = renderHook(({owner}) => useMedia(owner), { initialProps: {owner:s.owner} });
  act(() => hook.result.current.choose()); expect(hook.result.current.disabled).toBe(true);
  act(() => hook.result.current.chooseFolder()); expect(hook.result.current.folder?.state).toBe('idle');
  hook.rerender({owner:{...s.owner,path:'D:/save-as'}});
  await act(async () => picker.resolve('D:/late.wav')); expect(start).not.toHaveBeenCalled(); expect(scan).not.toHaveBeenCalled();
  act(() => hook.result.current.chooseFolder()); expect(hook.result.current.folder?.state).toBe('choosing');
  act(() => { hook.result.current.setRelink(fixture.media[0]); }); act(() => hook.result.current.verify());
  act(() => hook.result.current.choose()); expect(start).not.toHaveBeenCalled(); expect(mediaDialogs.choose).toHaveBeenCalledOnce();
  hook.unmount();
});

it('cancels as a lifecycle transition begins, drains accepted publication and releases later ready', async () => {
  const s = setup(2), published = deferred<void>();
  const apply = vi.mocked(s.commands.applyChange).getMockImplementation()!;
  vi.mocked(s.commands.applyChange).mockImplementationOnce(async (...args) => { await published.promise; return apply(...args); });
  await s.controller.choose(async () => 'D:/audio'); s.result(); await waitFor(() => expect(s.media.start).toHaveBeenCalled());
  s.callbacks[0]({type:'ready',taskId:'batch1',index:0,media:{...fixture.media[0],id:'00000000-0000-4000-8000-000000000088'}});
  const transition = vi.fn(async () => {}); const closing = s.lifecycle.transition(transition);
  expect(s.controller.state).toBe('cancelled'); expect(s.media.cancel).toHaveBeenCalledWith('batch1'); expect(transition).not.toHaveBeenCalled();
  s.callbacks[0]({type:'ready',taskId:'batch1',index:1,media:{...fixture.media[0],id:'00000000-0000-4000-8000-000000000089'}});
  published.resolve(); await closing; await s.imports.completed(); await s.imports.settled();
  expect(s.controller.items.map(i=>i.state)).toEqual(['success','cancelled']); expect(s.media.release).toHaveBeenCalledWith('batch1','00000000-0000-4000-8000-000000000089'); expect(transition).toHaveBeenCalledOnce();
});

it('keeps scan failure/overflow from importing and releases its owner', async () => {
  const s = setup(); await s.controller.choose(async () => 'D:/audio');
  s.scan({type:'failed',token,error:{code:'ResourceLimit',message:'too many candidates',retryable:false}});
  expect(s.controller.state).toBe('failed'); expect(s.folder.release).toHaveBeenCalledWith(token); expect(s.media.start).not.toHaveBeenCalled();
});

it('continues valid files after decoder failure and leaves completed folder results independent of later jobs', async () => {
  const s = setup(2); await s.controller.choose(async () => 'D:/audio'); s.result({existing:3,skipped:2}); await waitFor(()=>expect(s.media.start).toHaveBeenCalled());
  s.callbacks[0]({type:'failed',taskId:'batch1',index:0,path:'D:/audio/0.wav',error:{code:'DecodeFailed',message:'corrupt',retryable:false}});
  s.finish(1,[1]); await waitFor(()=>expect(s.controller.state).toBe('finished'));
  expect(s.controller.successCount).toBe(1); expect(s.controller.failedCount).toBe(1); expect(s.controller.counts.existing).toBe(3); expect(s.controller.counts.skipped).toBe(2);
  const results = structuredClone(s.controller.items); await s.imports.start(['D:/later.wav']); s.finish(2); await s.imports.completed();
  expect(s.controller.items).toEqual(results); expect(s.controller.successCount).toBe(1); expect(s.controller.ownsCurrentBatch).toBe(false);
  s.callbacks[0]({type:'ready',taskId:'batch1',index:0,media:{...fixture.media[0],id:'00000000-0000-4000-8000-000000000090'}}); await s.imports.settled();
  expect(s.media.release).toHaveBeenCalledWith('batch1','00000000-0000-4000-8000-000000000090');
  expect(s.controller.items).toEqual(results);
});

it.each(['zero-candidates', 'cancel-scan'] as const)('keeps prior folder results hidden after a later %s, without hiding a genuine direct import', async outcome => {
  const s=setup(1);
  vi.mocked(s.media.release).mockRejectedValueOnce({code:'SaveFailed',message:'owned acknowledgement failure',retryable:true});
  await s.controller.choose(async()=>'D:/first');s.result();await waitFor(()=>expect(s.media.start).toHaveBeenCalledTimes(1));s.finish(1);
  await waitFor(()=>expect(s.controller.state).toBe('finished'));s.controller.dismiss();
  expect(s.controller.ownsCurrentBatch).toBe(true);
  expect(s.imports.pendingAcknowledgements).toHaveLength(1);
  await s.controller.choose(async()=>'D:/next');
  expect(s.controller.ownsCurrentBatch).toBe(true);
  if(outcome==='zero-candidates'){
    s.result({checked:1,candidates:0,existing:1});await waitFor(()=>expect(s.controller.state).toBe('finished'));
  }else{s.controller.cancel();expect(s.controller.state).toBe('cancelled');}
  s.controller.dismiss();expect(s.controller.state).toBe('idle');expect(s.controller.items).toEqual([]);
  expect(s.controller.ownsCurrentBatch).toBe(true);
  // The global acknowledgement panel keeps authority even though folder result rows changed.
  expect(s.imports.pendingAcknowledgements).toHaveLength(1);await s.imports.retryAcknowledgements();
  expect(s.imports.pendingAcknowledgements).toHaveLength(0);expect(s.commands.applyChange).toHaveBeenCalledTimes(1);
  await s.imports.start(['D:/genuine-direct.wav']);expect(s.controller.ownsCurrentBatch).toBe(false);
  s.finish(2);await s.imports.completed();expect(s.imports.items[0].path).toBe('D:/genuine-direct.wav');
  expect(s.controller.ownsCurrentBatch).toBe(false);expect(s.commands.applyChange).toHaveBeenCalledTimes(2);
});

it.each(['start','result'] as const)('rejects late scan %s after same-id save-as owner disposal', async stage => {
  const s = setup(); const ack=deferred<typeof token>();
  if(stage==='start')vi.mocked(s.folder.start).mockReturnValueOnce(ack.promise);
  const choosing=s.controller.choose(async ()=>'D:/audio'); await waitFor(()=>expect(s.folder.start).toHaveBeenCalled());
  s.controller.dispose();
  if(stage==='start'){ack.resolve(token);await choosing;expect(s.folder.release).toHaveBeenCalledWith(token);}
  else {s.result();expect(s.media.start).not.toHaveBeenCalled();}
  expect(s.controller.state).toBe('cancelled'); expect(s.folder.page).not.toHaveBeenCalled();
});

it('retains failed ledger when explicit end cannot release PCM and retries cleanup inside lifecycle', async () => {
  const s=setup(1); vi.mocked(s.commands.applyChange).mockRejectedValueOnce({code:'SaveFailed',message:'disk failed',retryable:true});
  await s.controller.choose(async ()=>'D:/audio');s.result();await waitFor(()=>expect(s.media.start).toHaveBeenCalled());s.finish(1);await waitFor(()=>expect(s.controller.state).toBe('paused'));
  vi.mocked(s.media.release).mockRejectedValueOnce({code:'SaveFailed',message:'release failed',retryable:true}); await s.controller.end();
  expect(s.queue.unresolvedFailures).toHaveLength(1);expect(s.controller.failures).toHaveLength(1);expect(s.controller.error?.message).toBe('release failed');
  const release=deferred<void>(); vi.mocked(s.media.release).mockReturnValueOnce(release.promise);
  const ending=s.controller.end(), action=vi.fn(async()=>{}), transition=s.lifecycle.transition(action);
  await Promise.resolve();expect(action).not.toHaveBeenCalled();release.resolve();await ending;await transition;
  expect(s.queue.unresolvedFailures).toHaveLength(0);expect(action).toHaveBeenCalledOnce();expect(s.media.release).toHaveBeenCalledTimes(2);
});

it('rechecks the document ledger after a delayed next-page response', async () => {
  const s=setup(), page=deferred<Awaited<ReturnType<FolderCommands['page']>>>();
  const original=vi.mocked(s.folder.page).getMockImplementation()!;
  vi.mocked(s.folder.page).mockImplementation((...args)=>args[2]===256?page.promise:original(...args));
  await s.controller.choose(async ()=>'D:/audio');s.result();await waitFor(()=>expect(s.media.start).toHaveBeenCalledOnce());s.finish(1);await waitFor(()=>expect(s.folder.page).toHaveBeenCalledWith(token,'candidates',256,256));
  vi.mocked(s.commands.applyChange).mockRejectedValueOnce({code:'SaveFailed',message:'note write failed',retryable:true});
  await s.queue.enqueue({type:'updateMediaNote',mediaId:fixture.media[0].id,note:'retain',mergeKey:null},{owner:'annotations'}).catch(()=>{});
  page.resolve({token,kind:'candidates',offset:256,total:257,candidates:s.candidates.slice(256),issues:[]});
  await waitFor(()=>expect(s.controller.state).toBe('paused'));expect(s.media.start).toHaveBeenCalledOnce();expect(s.controller.items).toHaveLength(256);
});

function RecoveryButtons({ owner, controller }: Pick<ReturnType<typeof setup>, 'owner' | 'controller'>) {
  useSyncExternalStore(owner.lifecycle.subscribe, owner.lifecycle.getVersion);
  const annotations = useAnnotations(owner);
  return <><AnnotationFailure ui={annotations} /><FolderImportProgress controller={controller} /></>;
}

it.each(['retry-first', 'end-first'] as const)('serializes actual global Retry and folder End buttons (%s) before PCM release', async order => {
  const s = setup(1), retryGate = deferred<void>(), releaseGate = deferred<void>();
  let prepared = true;
  const apply = vi.mocked(s.commands.applyChange).getMockImplementation()!;
  vi.mocked(s.commands.applyChange).mockRejectedValueOnce({ code: 'SaveFailed', message: 'publication failed', retryable: true });
  await s.controller.choose(async () => 'D:/audio'); s.result(); await waitFor(() => expect(s.media.start).toHaveBeenCalled()); s.finish(1);
  await waitFor(() => expect(s.controller.state).toBe('paused'));
  vi.mocked(s.commands.applyChange).mockImplementation(async (...args) => {
    await retryGate.promise;
    if (!prepared) throw { code: 'Cancelled', message: 'prepared PCM expired', retryable: true };
    return apply(...args);
  });
  vi.mocked(s.media.release).mockImplementation(async () => { prepared = false; await releaseGate.promise; });
  render(<RecoveryButtons owner={s.owner} controller={s.controller} />);
  const retry = screen.getByRole('button', { name: '重试更改 #1' });
  const end = screen.getByRole('button', { name: '结束并放弃失败项' });
  if (order === 'retry-first') {
    fireEvent.click(retry); await waitFor(() => expect(s.commands.applyChange).toHaveBeenCalledTimes(2));
    fireEvent.click(end); fireEvent.click(retry); // A queued stale second retry must become a no-op.
    await act(async () => { await Promise.resolve(); });
    expect(s.media.release).not.toHaveBeenCalled();
  } else {
    fireEvent.click(end); await waitFor(() => expect(s.media.release).toHaveBeenCalledOnce());
    fireEvent.click(retry); await act(async () => { await Promise.resolve(); });
    expect(s.commands.applyChange).toHaveBeenCalledOnce();
  }
  const replace = vi.fn(async () => {}); let transition!: Promise<void>;
  act(() => { transition = s.lifecycle.transition(replace); });
  expect(replace).not.toHaveBeenCalled();
  await act(async () => { retryGate.resolve(); releaseGate.resolve(); await transition; });
  await waitFor(() => expect(s.queue.unresolvedFailures).toHaveLength(0));
  expect(replace).toHaveBeenCalledOnce(); expect(s.controller.error).toBeNull();
  expect(s.controller.successCount).toBe(order === 'retry-first' ? 1 : 0);
  expect(s.commands.applyChange).toHaveBeenCalledTimes(order === 'retry-first' ? 2 : 1);
  expect(s.media.release).toHaveBeenCalledTimes(1);
});

it.each(['retry-first', 'end-first'] as const)('serializes project-wide Retry with folder abandonment (%s)', async order => {
  const s = setup(1), release = deferred<void>(), retry = deferred<void>();
  const apply = vi.mocked(s.commands.applyChange).getMockImplementation()!;
  vi.mocked(s.commands.applyChange).mockRejectedValueOnce({ code: 'SaveFailed', message: 'publication failed', retryable: true });
  await s.controller.choose(async () => 'D:/audio'); s.result(); await waitFor(() => expect(s.media.start).toHaveBeenCalled()); s.finish(1);
  await waitFor(() => expect(s.controller.state).toBe('paused'));
  vi.mocked(s.media.release).mockReturnValueOnce(release.promise);
  vi.mocked(s.commands.applyChange).mockImplementation(async (...args) => { await retry.promise; return apply(...args); });
  let ending: Promise<void>, retrying: Promise<void>;
  if (order === 'end-first') {
    ending = s.controller.end(); await waitFor(() => expect(s.media.release).toHaveBeenCalledOnce());
    retrying = s.lifecycle.retryFailures(); await Promise.resolve(); expect(s.commands.applyChange).toHaveBeenCalledOnce();
  } else {
    retrying = s.lifecycle.retryFailures(); await waitFor(() => expect(s.commands.applyChange).toHaveBeenCalledTimes(2));
    ending = s.controller.end(); await Promise.resolve(); expect(s.media.release).not.toHaveBeenCalled();
  }
  release.resolve(); retry.resolve(); await ending; await retrying;
  expect(s.commands.applyChange).toHaveBeenCalledTimes(order === 'retry-first' ? 2 : 1); expect(s.queue.unresolvedFailures).toHaveLength(0);
});

it('keeps the actual global Retry button draft-aware inside shared recovery admission', async () => {
  const s = setup(); const hook = renderHook(() => useAnnotations(s.owner));
  const change = { type: 'updateMediaNote' as const, mediaId: fixture.media[0].id, note: 'old draft', mergeKey: null };
  vi.mocked(s.commands.applyChange).mockRejectedValueOnce({ code: 'SaveFailed', message: 'note failed', retryable: true });
  hook.result.current.drafts!.write('media-note', change); await hook.result.current.drafts!.submit('media-note').catch(() => {});
  hook.result.current.drafts!.write('media-note', { ...change, note: 'newer draft' });
  render(<AnnotationFailure ui={hook.result.current} />); fireEvent.click(screen.getByRole('button', { name: '重试更改 #1' }));
  await waitFor(() => expect(s.queue.unresolvedFailures).toHaveLength(0));
  expect(s.commands.applyChange).toHaveBeenLastCalledWith(fixture.projectId, fixture.revision, { ...change, note: 'newer draft' });
  expect(s.store.drafts.size).toBe(0); hook.unmount();
});

it('default writable and ordinary owners can folder-import; view-only cannot',()=>{
 const a=setup(1);Object.assign(a.owner,{collaboration:{projectFlavor:'default',canImportMedia:true}});expect(a.controller.begin()).toBe(true);a.controller.cancel();
 const b=setup(1);Object.assign(b.owner,{collaboration:{projectFlavor:'default',canImportMedia:false}});expect(b.controller.begin()).toBe(false);
 const c=setup(1);expect(c.controller.begin()).toBe(true);c.controller.cancel();
});
it('acknowledgement service errors do not turn an accepted folder import into a failed file',async()=>{
 const s=setup(1);vi.mocked(s.media.release).mockRejectedValueOnce({code:'SaveFailed',message:'release unavailable',retryable:true});await s.controller.choose(async()=>'D:/audio');s.result();await waitFor(()=>expect(s.media.start).toHaveBeenCalled());s.finish(1);await waitFor(()=>expect(s.controller.state).toBe('finished'));expect(s.controller.successCount).toBe(1);expect(s.controller.failedCount).toBe(0);expect(s.controller.pendingAcknowledgements).toHaveLength(1);await s.controller.retry();expect(s.controller.pendingAcknowledgements).toHaveLength(0);
});

it.each(['folder-folder','folder-direct','direct-folder'] as const)('retained acknowledgement recovery crosses %s result ownership without replaying accepted media',async route=>{
 const s=setup(1);vi.mocked(s.media.release).mockRejectedValueOnce({code:'SaveFailed',message:'release unavailable',retryable:true});
 for(const [index,kind] of route.split('-').entries()){
  if(kind==='folder'){await s.controller.choose(async()=>`D:/audio${index}`);s.result();await waitFor(()=>expect(s.media.start).toHaveBeenCalledTimes(index+1));s.finish(index+1);await waitFor(()=>expect(s.controller.state).toBe('finished'));s.controller.dismiss();}
  else{await s.imports.start([`D:/direct${index}.wav`]);s.finish(index+1);await s.imports.settled();}
 }
 const original=['batch1','00000000-0000-4000-8000-000000001000'];expect(s.imports.pendingAcknowledgements).toHaveLength(1);await s.controller.retry();expect(s.imports.pendingAcknowledgements).toHaveLength(0);expect(vi.mocked(s.media.release).mock.calls.filter(call=>call[0]===original[0])).toEqual([original,original]);expect(s.media.start).toHaveBeenCalledTimes(2);expect(s.commands.applyChange).toHaveBeenCalledTimes(2);
});

it('Retry from the latest folder batch acknowledges an earlier batch capability without replay',async()=>{
 const s=setup(257);vi.mocked(s.media.release).mockRejectedValueOnce({code:'SaveFailed',message:'release unavailable',retryable:true});await s.controller.choose(async()=>'D:/audio');s.result();await waitFor(()=>expect(s.media.start).toHaveBeenCalledTimes(1));s.finish(1);await waitFor(()=>expect(s.media.start).toHaveBeenCalledTimes(2));s.finish(2);await waitFor(()=>expect(s.controller.state).toBe('finished'));
 const old=s.imports.pendingAcknowledgements[0];expect(s.imports.items).not.toContain(old);await s.imports.retry();expect(s.imports.pendingAcknowledgements).toHaveLength(0);expect(s.media.release).toHaveBeenLastCalledWith('batch1','00000000-0000-4000-8000-000000001000');expect(s.media.start).toHaveBeenCalledTimes(2);expect(s.commands.applyChange).toHaveBeenCalledTimes(257);
});
