import { ImportAcknowledgements, ImportProgress } from './ImportProgress';
import { expect, it, vi } from 'vitest';
import { render, screen, fireEvent, renderHook, act, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import fixture from '../../../tests/fixtures/document-v2.json';
import { ProjectStore } from '../../app/store';
import { CommandQueue, type ProjectCommands } from '../../app/commands';
import { parseProjectDocument, type ProjectSnapshot } from '../../bridge/types';
import type { MediaCommands, MediaEvent } from '../../bridge/media';
import { MediaImportController } from './imports';
import { MediaList } from './MediaList';
import { MediaTextDetails } from './MediaTextDetails';
import { useMedia } from './useMedia';
import { mediaClient } from '../../bridge/media';
import type { ActiveProject } from '../project/useProjectLifecycle';

function setup() {
  const store = new ProjectStore({ document: parseProjectDocument(structuredClone(fixture)), canUndo: false, canRedo: false });
  const commands: ProjectCommands = { applyChange: vi.fn(async (_id, revision, change) => {
    const snapshot: ProjectSnapshot = structuredClone(store.snapshot); snapshot.document.revision = revision + 1;
    if (change.type === 'importMedia') snapshot.document.media.push(change.media);
    return snapshot;
  }), getSnapshot: vi.fn(), undo: vi.fn(), redo: vi.fn() };
  const queue = new CommandQueue(store, commands);
  let emit!: (event: MediaEvent) => void;
  const api: MediaCommands = { start: vi.fn(async (_id, _paths, callback) => { emit = callback; return 'task'; }), cancel: vi.fn(async () => {}), release: vi.fn(async () => {}), status: vi.fn(async () => []) };
  const controller = new MediaImportController(store, queue, api);
  return { store, queue, commands, api, controller, emit: (event: MediaEvent) => emit(event) };
}
const candidate = { ...fixture.media[0], id: '00000000-0000-4000-8000-000000000077' };

it('commits decoded results through the queue at the latest revision and retains per-file failure', async () => {
  const s = setup(); await s.controller.start(['good.wav', 'bad.wav']);
  await s.queue.enqueue({ type: 'updateMediaNote', mediaId: fixture.media[0].id, note: 'latest', mergeKey: null });
  s.emit({ type: 'ready', taskId: 'task', index: 0, media: candidate });
  s.emit({ type: 'failed', taskId: 'task', index: 1, path: 'bad.wav', error: { code: 'DecodeFailed', message: 'bad file', retryable: false } });
  s.emit({ type: 'finished', taskId: 'task', cancelled: false });
  await s.controller.settled();
  expect(s.commands.applyChange).toHaveBeenLastCalledWith(fixture.projectId, 1, { type: 'importMedia', media: candidate });
  expect(s.controller.items.map(i => i.state)).toEqual(['success', 'failed']);
  s.controller.dispose();
});

it.each(['transition', 'deactivate', 'dispose'] as const)('ignores late media when owner %s occurs, even when project ID is unchanged', async action => {
  const s = setup(); await s.controller.start(['good.wav']);
  if (action === 'transition') s.store.beginTransition();
  if (action === 'deactivate') s.store.deactivate();
  if (action === 'dispose') s.controller.dispose();
  s.emit({ type: 'ready', taskId: 'task', index: 0, media: candidate });
  s.emit({ type: 'finished', taskId: 'task', cancelled: true });
  await s.controller.settled();
  expect(s.commands.applyChange).not.toHaveBeenCalled();
  expect(s.api.cancel).toHaveBeenCalledWith('task');
  expect(s.api.release).toHaveBeenCalledWith('task', candidate.id);
  s.controller.dispose();
});

it('cancels promptly, rejects late ready, and leaves remaining files visibly cancelled', async () => {
  const s = setup(); await s.controller.start(['one.wav', 'two.wav']);
  s.controller.cancel(); expect(s.controller.cancelling).toBe(true);
  s.emit({ type: 'ready', taskId: 'task', index: 0, media: candidate });
  s.emit({ type: 'finished', taskId: 'task', cancelled: true }); await s.controller.settled();
  expect(s.commands.applyChange).not.toHaveBeenCalled();
  expect(s.controller.items.every(i => i.state === 'cancelled')).toBe(true);
  s.controller.dispose();
});

it('keeps admission busy until both native completion and the start response arrive', async () => {
  const s = setup(); let resolve!: (id: string) => void; let emit!: (event: MediaEvent) => void;
  vi.mocked(s.api.start).mockImplementation((_id, _paths, callback) => { emit = callback; return new Promise(r => { resolve = r; }); });
  const starting = s.controller.start(['one.wav']);
  emit({ type: 'finished', taskId: 'task', cancelled: false });
  await s.controller.settled();
  expect(s.controller.busy).toBe(true);
  resolve('task'); await starting;
  expect(s.controller.busy).toBe(false); s.controller.dispose();
});

it('searches real document metadata and preserves missing media notes', () => {
  render(<MediaList media={fixture.media} annotations={fixture.annotations} statuses={[{ mediaId: fixture.media[0].id, status: 'missing' }]} selectedId={null} disabled={false} onSelect={() => {}} onImport={() => {}} onRelink={() => {}} />);
  expect(screen.getByText('源文件缺失')).toBeInTheDocument();
  expect(screen.getByText(fixture.media[0].displayName)).toBeInTheDocument();
  fireEvent.change(screen.getByRole('textbox', { name: '搜索音频' }), { target: { value: 'nothing matches' } });
  expect(screen.getByText('没有匹配的音频')).toBeInTheDocument();
});

it('renders saved annotation and media text without requiring a decoded source', () => {
  render(<MediaTextDetails media={fixture.media[0]} annotations={fixture.annotations} categories={fixture.categories} />);
  expect(screen.getByText('区域备注')).toBeInTheDocument();
  expect(screen.getByText('鸟声')).toBeInTheDocument();
  expect(screen.getByText('音频备注', { selector: 'p' })).toBeInTheDocument();
});

it('remains usable after StrictMode effect replay and retires replaced runtime', async () => {
  const s = setup();
  const status = vi.spyOn(mediaClient, 'status').mockResolvedValue([]);
  const start = vi.spyOn(mediaClient, 'start').mockResolvedValue('strict-task');
  const cancel = vi.spyOn(mediaClient, 'cancel').mockResolvedValue();
  const active = { store: s.store, queue: s.queue, path: 'D:/project' } as ActiveProject;
  const hook = renderHook(({ owner }) => useMedia(owner), { initialProps: { owner: active }, wrapper: StrictMode });
  await waitFor(() => expect(hook.result.current.controller).not.toBeNull());
  await act(() => hook.result.current.controller!.start(['a.wav']));
  expect(start).toHaveBeenCalledOnce();
  hook.rerender({ owner: { ...active } });
  expect(cancel).toHaveBeenCalledWith('strict-task');
  hook.unmount(); status.mockRestore(); start.mockRestore(); cancel.mockRestore(); s.controller.dispose();
});

it('acknowledges confirmed Ready and retains accepted adoption-pending capabilities for original-ID retry',async()=>{
 const s=setup();vi.mocked(s.commands.applyChange).mockRejectedValueOnce({code:'SaveFailed',message:'adoption pending',retryable:true,details:{catalogCommitted:true,catalogAdoptionRequired:true,mediaId:candidate.id}});
 await s.controller.start(['good.wav']);s.emit({type:'ready',taskId:'task',index:0,media:candidate});s.emit({type:'finished',taskId:'task',cancelled:false});await s.controller.settled();
 expect(s.controller.items[0].state).toBe('accepted');expect(s.api.release).not.toHaveBeenCalled();expect(s.queue.unresolvedFailures).toHaveLength(1);
 await s.controller.retry();expect(s.api.start).toHaveBeenCalledTimes(1);expect(s.commands.applyChange).toHaveBeenLastCalledWith(fixture.projectId,0,{type:'importMedia',media:candidate});expect(s.api.release).toHaveBeenCalledWith('task',candidate.id);expect(s.controller.items[0].state).toBe('success');s.controller.dispose();
});
it('global Retry then own Retry/End acknowledges only confirmed success; release failure never changes accepted import to failed',async()=>{
 const s=setup();vi.mocked(s.commands.applyChange).mockRejectedValueOnce({code:'SaveFailed',message:'lost ack',retryable:true});
 await s.controller.start(['good.wav']);s.emit({type:'ready',taskId:'task',index:0,media:candidate});s.emit({type:'finished',taskId:'task',cancelled:false});await s.controller.settled();
 vi.mocked(s.api.release).mockRejectedValueOnce({code:'SaveFailed',message:'service release failed',retryable:true});
 await s.queue.retry(s.queue.unresolvedFailures[0].id);await s.controller.retry();await s.controller.discard();
 expect(s.api.start).toHaveBeenCalledTimes(1);expect(s.controller.items[0].state).toBe('success');expect(s.commands.applyChange).toHaveBeenCalledTimes(2);expect(s.api.release).toHaveBeenCalled();s.controller.dispose();
});

it('failed acknowledgement retains a visible retry without republishing or failing the accepted item',async()=>{
 const s=setup();vi.mocked(s.api.release).mockRejectedValueOnce({code:'SaveFailed',message:'release service unavailable',retryable:true});await s.controller.start(['good.wav']);s.emit({type:'ready',taskId:'task',index:0,media:candidate});s.emit({type:'finished',taskId:'task',cancelled:false});await s.controller.settled();
 expect(s.controller.items[0].state).toBe('success');expect(s.controller.pendingAcknowledgements).toHaveLength(1);await s.controller.retry();expect(s.controller.pendingAcknowledgements).toHaveLength(0);expect(s.controller.error).toBeNull();expect(s.commands.applyChange).toHaveBeenCalledTimes(1);s.controller.dispose();
});
it('End keeps a durable accepted item and its ledger if adoption still fails, then retries the original Ready',async()=>{
 const s=setup(),error={code:'SaveFailed',message:'adoption pending',retryable:true,details:{catalogCommitted:true,catalogAdoptionRequired:true,mediaId:candidate.id}};vi.mocked(s.commands.applyChange).mockRejectedValueOnce(error).mockRejectedValueOnce(error);
 await s.controller.start(['good.wav']);s.emit({type:'ready',taskId:'task',index:0,media:candidate});s.emit({type:'finished',taskId:'task',cancelled:false});await s.controller.settled();await expect(s.controller.discard()).rejects.toMatchObject(error);expect(s.controller.items[0].state).toBe('accepted');expect(s.queue.unresolvedFailures).toHaveLength(1);expect(s.api.release).not.toHaveBeenCalled();await s.controller.retry();expect(s.api.start).toHaveBeenCalledTimes(1);expect(s.api.release).toHaveBeenCalledTimes(1);s.controller.dispose();
});

it('Retry releases retained acknowledgements from an earlier direct import using the original task/media pair',async()=>{
 const s=setup(),callbacks:((event:MediaEvent)=>void)[]=[];vi.mocked(s.api.start).mockImplementation(async(_id,_paths,receive)=>{callbacks.push(receive);return `task${callbacks.length}`;});
 const second={...candidate,id:'00000000-0000-4000-8000-000000000078'};vi.mocked(s.api.release).mockRejectedValueOnce({code:'SaveFailed',message:'release unavailable',retryable:true});
 for(const [index,media] of [candidate,second].entries()){await s.controller.start([`${index}.wav`]);callbacks[index]({type:'ready',taskId:`task${index+1}`,index:0,media});callbacks[index]({type:'finished',taskId:`task${index+1}`,cancelled:false});await s.controller.settled();}
 expect(s.controller.items[0].mediaId).toBe(second.id);expect(s.controller.pendingAcknowledgements.map(i=>i.mediaId)).toEqual([candidate.id]);await s.controller.retry();
 expect(vi.mocked(s.api.release).mock.calls).toEqual([['task1',candidate.id],['task2',second.id],['task1',candidate.id]]);expect(s.controller.pendingAcknowledgements).toHaveLength(0);expect(s.commands.applyChange).toHaveBeenCalledTimes(2);expect(s.api.start).toHaveBeenCalledTimes(2);s.controller.dispose();
});
it('acknowledgement recovery remains visible after closing or replacing result panels',async()=>{
 const s=setup();vi.mocked(s.api.release).mockRejectedValueOnce({code:'SaveFailed',message:'release unavailable',retryable:true});await s.controller.start(['good.wav']);s.emit({type:'ready',taskId:'task',index:0,media:candidate});s.emit({type:'finished',taskId:'task',cancelled:false});await s.controller.settled();
 const view=render(<><ImportProgress controller={s.controller}/><ImportAcknowledgements controller={s.controller}/></>);fireEvent.click(screen.getByRole('button',{name:'关闭导入结果'}));expect(screen.queryByRole('region',{name:'导入进度'})).toBeNull();expect(screen.getByRole('button',{name:'重试导入确认'})).toBeEnabled();
 view.rerender(<ImportAcknowledgements controller={s.controller}/>);fireEvent.click(screen.getByRole('button',{name:'重试导入确认'}));await waitFor(()=>expect(s.controller.pendingAcknowledgements).toHaveLength(0));expect(screen.queryByRole('region',{name:'导入确认'})).toBeNull();expect(s.commands.applyChange).toHaveBeenCalledTimes(1);s.controller.dispose();
});

it('acknowledgement-only Retry and scoped End never replay or discard another failed edit',async()=>{
 const s=setup(),callbacks:((event:MediaEvent)=>void)[]=[];vi.mocked(s.api.start).mockImplementation(async(_id,_paths,receive)=>{callbacks.push(receive);return `task${callbacks.length}`;});const second={...candidate,id:'00000000-0000-4000-8000-000000000078'};
 vi.mocked(s.api.release).mockRejectedValueOnce({code:'SaveFailed',message:'release unavailable',retryable:true});await s.controller.start(['one.wav']);callbacks[0]({type:'ready',taskId:'task1',index:0,media:candidate});callbacks[0]({type:'finished',taskId:'task1',cancelled:false});await s.controller.settled();
 vi.mocked(s.commands.applyChange).mockRejectedValueOnce({code:'SaveFailed',message:'second publication failed',retryable:true});await s.controller.start(['two.wav']);callbacks[1]({type:'ready',taskId:'task2',index:0,media:second});callbacks[1]({type:'finished',taskId:'task2',cancelled:false});await s.controller.settled();const failure=s.queue.unresolvedFailures[0];
 // The controller-wide control releases only confirmed successes, not pending edits.
 await s.controller.retryAcknowledgements();expect(s.queue.unresolvedFailures).toEqual([failure]);expect(s.commands.applyChange).toHaveBeenCalledTimes(2);expect(vi.mocked(s.api.release).mock.calls).toEqual([['task1',candidate.id],['task1',candidate.id]]);
 await s.controller.discard();expect(s.queue.unresolvedFailures).toHaveLength(0);expect(s.api.release).toHaveBeenLastCalledWith('task2',second.id);expect(s.commands.applyChange).toHaveBeenCalledTimes(2);s.controller.dispose();
});
it('ending the current failed import leaves older acknowledgement recovery reachable',async()=>{
 const s=setup();vi.mocked(s.api.release).mockRejectedValueOnce({code:'SaveFailed',message:'release unavailable',retryable:true});await s.controller.start(['one.wav']);s.emit({type:'ready',taskId:'task',index:0,media:candidate});s.emit({type:'finished',taskId:'task',cancelled:false});await s.controller.settled();
 await s.controller.start(['bad.wav']);s.emit({type:'failed',taskId:'task',index:0,path:'bad.wav',error:{code:'DecodeFailed',message:'invalid audio',retryable:false}});s.emit({type:'finished',taskId:'task',cancelled:false});await s.controller.discard();
 render(<ImportAcknowledgements controller={s.controller}/>);fireEvent.click(screen.getByRole('button',{name:'重试导入确认'}));await waitFor(()=>expect(s.controller.pendingAcknowledgements).toHaveLength(0));expect(s.api.release).toHaveBeenLastCalledWith('task',candidate.id);expect(s.commands.applyChange).toHaveBeenCalledTimes(1);s.controller.dispose();
});
