import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import fixture from '../../../tests/fixtures/document-v2.json';
import { ExportDialog } from './ExportDialog';
import { ImportDialog } from './ImportDialog';
import { useProjectLifecycle } from '../project/useProjectLifecycle';
import type { LocalProjectCommands, OpenedProject } from '../../bridge/projects';
import { parseProjectDocument } from '../../bridge/types';
import type { ProjectCommands } from '../../app/commands';
import { useExchange } from './useExchange';
import { mediaDialogs } from '../../bridge/media';
import { exchangeClient, exchangeDialogs, type ExchangeEvent } from '../../bridge/exchange';
import type { ProjectLifecycleUI } from '../project/useProjectLifecycle';
afterEach(()=>vi.useRealTimers());
it.each([['exchange','SaveFailed'],['normalSave','SaveFailed'],['normalSave','RevisionConflict']] as const)('successful export clears a prior %s %s save failure on the same active owner',async(origin,code)=>{
 const doc=parseProjectDocument(structuredClone(fixture));const opened:OpenedProject={snapshot:{document:doc,canUndo:false,canRedo:false},path:'same',persistedRevision:0,recovery:null};
 const api:LocalProjectCommands={choose:vi.fn(async()=> 'same'),create:vi.fn(async()=>opened),open:vi.fn(async()=>opened),recover:vi.fn(),saveAs:vi.fn(),cancelRecovery:vi.fn(),onCloseRequested:vi.fn(async()=>()=>{}),destroyWindow:vi.fn(),save:vi.fn(async(_id,revision)=>revision),close:vi.fn()};
 const commands:ProjectCommands={applyChange:vi.fn(),getSnapshot:vi.fn(),undo:vi.fn(),redo:vi.fn()};
 const {result,unmount}=renderHook(()=>useProjectLifecycle(api,commands));await act(async()=>result.current.open('open'));const active=result.current.active!;
 const diskError={code,message:'save unavailable',retryable:true};vi.mocked(api.save).mockRejectedValueOnce(diskError);
 const exportAction=vi.fn(async()=>null);
 await act(async()=>{if(origin==='normalSave')await result.current.save();else await expect(result.current.performExchange(exportAction)).rejects.toEqual(diskError);});
 expect(active.lifecycle.status).toBe('failed');expect(result.current.error).toEqual(diskError);expect(exportAction).not.toHaveBeenCalled();
 await act(async()=>result.current.performExchange(exportAction));
 expect(result.current.active).toBe(active);expect(active.lifecycle.error).toBeNull();expect(result.current.error).toBeNull();expect(active.lifecycle.status).toBe('saved');expect(active.lifecycle.savedAt).toBeInstanceOf(Date);expect(api.close).not.toHaveBeenCalled();
 const editError={code:'InvalidInput' as const,message:'rejected category',retryable:false};vi.mocked(commands.applyChange).mockRejectedValueOnce(editError);
 await act(async()=>{await expect(active.queue.enqueue({type:'removeCategory',id:fixture.categories[0].id})).rejects.toEqual(editError);});const failure=active.queue.unresolvedFailures[0];exportAction.mockClear();
 await act(async()=>{await expect(result.current.performExchange(exportAction)).rejects.toEqual(editError);});expect(exportAction).not.toHaveBeenCalled();expect(active.queue.unresolvedFailures[0]).toEqual(failure);expect(active.lifecycle.error).toEqual(editError);expect(active.lifecycle.status).toBe('failed');unmount();
});
it('explains JSON versus complete packages and exposes progress, cancellation and result location',()=>{
 const start=vi.fn(), cancel=vi.fn();const {rerender}=render(<ExportDialog busy={false} phase="" completed={0} result={null} error={null} cancelled={false} onStart={start} onCancel={cancel} onClose={()=>{}} />);
 expect(screen.getAllByRole('radio').map(r=>r.getAttribute('aria-label'))).toEqual(['完整项目包（含音频）','仅标注（不含音频）']);
 expect(screen.getByLabelText('完整项目包（含音频）')).toBeChecked();
 fireEvent.click(screen.getByRole('button',{name:'选择保存位置…'}));expect(start).toHaveBeenCalledWith('bundle');
 fireEvent.click(screen.getByLabelText('仅标注（不含音频）'));fireEvent.click(screen.getByRole('button',{name:'选择保存位置…'}));expect(start).toHaveBeenLastCalledWith('annotations');
 expect(screen.getByText(/接收方需要同一批原始音频/)).toBeInTheDocument();
 rerender(<ExportDialog busy phase="复制原始媒体" completed={1024} result={null} error={null} cancelled={false} onStart={start} onCancel={cancel} onClose={()=>{}} />);
 expect(screen.getByRole('status').textContent).toContain('复制原始媒体');fireEvent.click(screen.getByRole('button',{name:'取消任务'}));expect(cancel).toHaveBeenCalled();
 rerender(<ExportDialog busy={false} phase="" completed={0} result="D:/shared/test.zip" error={null} cancelled={false} onStart={start} onCancel={cancel} onClose={()=>{}} />);expect(screen.getByText('D:/shared/test.zip')).toBeInTheDocument();
});
it('a terminal event before start acknowledgement cannot attach an old task ID to the next attempt',async()=>{
 const save=vi.spyOn(exchangeDialogs,'save').mockResolvedValue('D:/new.json');const cancel=vi.spyOn(exchangeClient,'cancel').mockResolvedValue();
 const receivers:((e:ExchangeEvent)=>void)[]=[];const acknowledgements:((id:string)=>void)[]=[];
 const start=vi.spyOn(exchangeClient,'start').mockImplementation(async(_request,receive)=>{receivers.push(receive);return new Promise<string>(r=>acknowledgements.push(r));});
 const project={performExchange:async(action:Parameters<ProjectLifecycleUI['performExchange']>[0])=>{await action({projectId:fixture.projectId,expectedRevision:0});}} as ProjectLifecycleUI;
 const {result,unmount}=renderHook(()=>useExchange(project));
 await act(async()=>result.current.startExport('annotations'));
 await act(async()=>receivers[0]({type:'completed',taskId:'first',path:'D:/new.json',opened:null}));expect(result.current.busy).toBe(false);
 await act(async()=>result.current.startExport('annotations'));await act(async()=>acknowledgements[0]('first'));
 await act(async()=>result.current.onCancel());await act(async()=>acknowledgements[1]('second'));
 expect(cancel.mock.calls.map(c=>c[0])).not.toContain('first');expect(cancel).toHaveBeenCalledWith('second');
 await act(async()=>receivers[1]({type:'cancelled',taskId:'second'}));expect(result.current.cancelled).toBe(true);expect(result.current.error).toBeNull();
 unmount();save.mockRestore();cancel.mockRestore();start.mockRestore();
});
it('import describes an independent copy and keeps failure, cancelled and success states distinct',()=>{
 const props={busy:false,phase:'',completed:0,result:null,error:null,cancelled:false,onStart:vi.fn(),onCancel:vi.fn(),onClose:vi.fn()};const {rerender}=render(<ImportDialog {...props}/>);
 expect(screen.getByText(/独立项目副本/)).toBeInTheDocument();fireEvent.click(screen.getByRole('button',{name:'选择交换文件…'}));expect(props.onStart).toHaveBeenCalled();
 rerender(<ImportDialog {...props} error={{code:'InvalidArchive',message:'无效包',retryable:false}}/>);expect(screen.getByRole('alert').textContent).toContain('无效包');
 rerender(<ImportDialog {...props} cancelled/>);expect(screen.getByRole('status').textContent).toContain('已取消');expect(screen.queryByRole('alert')).toBeNull();
});
it('exchange drains admitted edits and drafts, saves, freezes admission, and retains the active project on failure',async()=>{
 const doc=parseProjectDocument(structuredClone(fixture));const opened:OpenedProject={snapshot:{document:doc,canUndo:false,canRedo:false},path:'old',persistedRevision:0,recovery:null};
 const order:string[]=[];
 const api:LocalProjectCommands={choose:vi.fn(async()=> 'old'),create:vi.fn(async()=>opened),open:vi.fn(async()=>opened),recover:vi.fn(),saveAs:vi.fn(),cancelRecovery:vi.fn(),onCloseRequested:vi.fn(async()=>()=>{}),destroyWindow:vi.fn(),save:vi.fn(async(_id,rev)=>{order.push('save');return rev;}),close:vi.fn()};
 const commands:ProjectCommands={applyChange:vi.fn(async()=>opened.snapshot!),getSnapshot:vi.fn(),undo:vi.fn(),redo:vi.fn()};
 const {result,unmount}=renderHook(()=>useProjectLifecycle(api,commands));await act(async()=>result.current.open('open'));const active=result.current.active!;
 let release!:()=>void;const gate=new Promise<void>(r=>release=r);
 const accepted=active.lifecycle.enqueueEdit(async()=>{await gate;order.push('edit');});active.store.setDraft('test','draft');active.lifecycle.registerDraft('test',async()=>{order.push('draft');active.store.clearDraftIfUnchanged('test','draft');});
 let exchange:Promise<void>;await act(async()=>{exchange=result.current.performExchange(async()=>{order.push('import');expect(active.store.editingDisabled).toBe(true);throw {code:'SaveFailed',message:'disk full',retryable:true};});void exchange.catch(()=>{});});
 expect(order).toEqual([]);await expect(active.lifecycle.enqueueEdit(async()=>{})).rejects.toMatchObject({code:'InvalidInput'});
 await act(async()=>{release();await accepted;await expect(exchange!).rejects.toMatchObject({code:'SaveFailed'});});
 expect(order).toEqual(['edit','draft','save','import']);expect(result.current.active).toBe(active);expect(active.store.editingDisabled).toBe(false);expect(active.lifecycle.error).toBeNull();expect(api.close).not.toHaveBeenCalled();
 const external=vi.fn(async()=>null);vi.mocked(api.save).mockRejectedValueOnce({code:'SaveFailed',message:'current disk full',retryable:true});
 await act(async()=>{await expect(result.current.performExchange(external)).rejects.toMatchObject({code:'SaveFailed'});});expect(external).not.toHaveBeenCalled();expect(result.current.active).toBe(active);expect(active.store.editingDisabled).toBe(false);
 const imported={...opened,path:'new',snapshot:{...opened.snapshot!,document:{...doc,projectId:'00000000-0000-4000-8000-000000000088'}}};
 await act(async()=>result.current.performExchange(async()=>imported));expect(result.current.active?.path).toBe('new');expect(result.current.active?.store.snapshot.document.projectId).toBe(imported.snapshot.document.projectId);expect(active.store.editingDisabled).toBe(true);expect(api.close).not.toHaveBeenCalled();unmount();
});

it('JSON sourcesRequired preserves the active owner and continues with fresh expected revision and corrected bindings',async()=>{
 const source=vi.spyOn(exchangeDialogs,'source').mockResolvedValue('D:/share.json'),parent=vi.spyOn(exchangeDialogs,'parent').mockResolvedValue('D:/imports'),choose=vi.spyOn(mediaDialogs,'choose').mockResolvedValue('D:/correct.wav');
 const media=fixture.media.map(({id,displayName,sha256,byteLength,sampleRate,frameCount,channelCount,channelLayout})=>({id,displayName,sha256,byteLength,sampleRate,frameCount,channelCount,channelLayout}));let revision=0;
 const owner={} as never,adopt=vi.fn();const project={active:owner,performExchange:async(action:Parameters<ProjectLifecycleUI['performExchange']>[0])=>{const opened=await action({projectId:fixture.projectId,expectedRevision:revision++});if(opened)adopt(opened);}} as unknown as ProjectLifecycleUI;
 const start=vi.spyOn(exchangeClient,'start').mockImplementation(async(request,receive)=>{if(!request.bindings)receive({type:'sourcesRequired',taskId:'preflight',sourceSha256:'a'.repeat(64),media});else receive({type:'failed',taskId:'binding',error:{code:'MissingMedia',message:'wrong file',retryable:true}});return request.bindings?'binding':'preflight';});
 const hook=renderHook(()=>useExchange(project));await act(async()=>hook.result.current.startImport());expect(adopt).not.toHaveBeenCalled();expect(hook.result.current.sources?.media).toEqual(media);
 await act(async()=>hook.result.current.chooseSource(media[0].id));await act(async()=>hook.result.current.continueImport());
 expect(start.mock.calls[1][0]).toMatchObject({expected:{expectedRevision:1},bindings:{sourceSha256:'a'.repeat(64),media:[{mediaId:media[0].id,path:'D:/correct.wav'}]}});expect(hook.result.current.error?.message).toBe('wrong file');expect(hook.result.current.sources?.media).toEqual(media);expect(adopt).not.toHaveBeenCalled();
 await act(async()=>hook.result.current.onCancel());expect(hook.result.current.sources).toBeNull();hook.unmount();source.mockRestore();parent.mockRestore();choose.mockRestore();start.mockRestore();
});

it('changed JSON source can restart preflight and only verified completion adopts a default project',async()=>{
 const source=vi.spyOn(exchangeDialogs,'source').mockResolvedValue('D:/share.json'),parent=vi.spyOn(exchangeDialogs,'parent').mockResolvedValue('D:/imports'),choose=vi.spyOn(mediaDialogs,'choose').mockResolvedValue('D:/correct.wav');
 const media=fixture.media.map(({id,displayName,sha256,byteLength,sampleRate,frameCount,channelCount,channelLayout})=>({id,displayName,sha256,byteLength,sampleRate,frameCount,channelCount,channelLayout}));let digest='a'.repeat(64),fail=true;
 const opened={snapshot:{document:parseProjectDocument(structuredClone(fixture)),canUndo:false,canRedo:false},persistedRevision:0,path:'D:/imports/new',recovery:null,collaboration:{runtimeNonce:'11111111-1111-4111-8111-111111111111',actor:{authorId:'11111111-1111-4111-8111-111111111111',normalizedLogin:'local',displayName:'本机作者',createdAt:'2026-10-25T00:00:00Z'},preferences:null,projectFlavor:'default',identityMode:'local',canWriteAnnotations:true,canImportMedia:true,hiddenMediaIds:[],catalogPending:false}} as OpenedProject;
 const adopt=vi.fn(),project={active:null,performExchange:async(action:Parameters<ProjectLifecycleUI['performExchange']>[0])=>{const result=await action(null);if(result)adopt(result);}} as unknown as ProjectLifecycleUI;
 const start=vi.spyOn(exchangeClient,'start').mockImplementation(async(request,receive)=>{if(!request.bindings)receive({type:'sourcesRequired',taskId:crypto.randomUUID(),sourceSha256:digest,media});else if(fail)receive({type:'failed',taskId:crypto.randomUUID(),error:{code:'InvalidArchive',message:'exchange source changed',retryable:true}});else receive({type:'completed',taskId:crypto.randomUUID(),path:opened.path,opened});return 'ack';});
 const hook=renderHook(()=>useExchange(project));await act(async()=>hook.result.current.startImport());await act(async()=>hook.result.current.chooseSource(media[0].id));await act(async()=>hook.result.current.continueImport());expect(adopt).not.toHaveBeenCalled();expect(hook.result.current.sources?.sourceSha256).toBe(digest);
 digest='b'.repeat(64);fail=false;await act(async()=>hook.result.current.startImport());expect(hook.result.current.bindings).toEqual({});await act(async()=>hook.result.current.chooseSource(media[0].id));await act(async()=>hook.result.current.continueImport());expect(adopt).toHaveBeenCalledTimes(1);expect(adopt.mock.calls[0][0].collaboration).toMatchObject({projectFlavor:'default',identityMode:'local'});expect(start.mock.calls.at(-1)![0].bindings?.sourceSha256).toBe(digest);expect(hook.result.current.sources).toBeNull();hook.unmount();source.mockRestore();parent.mockRestore();choose.mockRestore();start.mockRestore();
});
