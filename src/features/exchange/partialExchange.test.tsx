import {act,fireEvent,render,renderHook,screen} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {ExportDialog} from './ExportDialog';
import {ImportDialog} from './ImportDialog';
import {useExchange} from './useExchange';
import {exchangeClient,exchangeDialogs,type ExchangeEvent} from '../../bridge/exchange';
import type {AuthorSnapshot} from '../../bridge/collaboration';
import type {ProjectLifecycleUI} from '../project/useProjectLifecycle';
afterEach(()=>vi.restoreAllMocks());
const author=(id:string,name:string):AuthorSnapshot=>({identity:{authorId:id,displayName:name,createdAt:'2026-11-06T00:00:00.000Z'},layer:null,error:null});
const state={busy:false,phase:'',completed:0,result:null,error:null,cancelled:false,onCancel:vi.fn(),onClose:vi.fn()};
it('partial export offers audio or package, selects authors independently and blocks empty author preview',()=>{
 const change=vi.fn(),preview=vi.fn();const selection={mediaIds:['a','b'],authorIds:['alice'],audioOnly:false};
 const props={...state,authors:[author('alice','Alice'),author('bob','Bob')],selection,updateSelection:change,onPreview:preview,onStart:vi.fn()};
 const h=render(<ExportDialog {...props}/>);
 expect(screen.getByRole('dialog',{name:'导出所选音频'})).toBeInTheDocument();
 expect(screen.getByLabelText('Alice')).toBeChecked();expect(screen.getByLabelText('Bob')).not.toBeChecked();
 fireEvent.click(screen.getByLabelText('Bob'));expect(change).toHaveBeenLastCalledWith({...selection,authorIds:['alice','bob']});
 fireEvent.click(screen.getByRole('button',{name:'全选'}));expect(change).toHaveBeenLastCalledWith({...selection,authorIds:['alice','bob']});
 h.rerender(<ExportDialog {...props} selection={{...selection,authorIds:[]}}/>);
 expect(screen.getByRole('button',{name:'导出…'})).toBeDisabled();
 fireEvent.click(screen.getByLabelText('原始音频 ZIP'));expect(change).toHaveBeenLastCalledWith({...selection,authorIds:[],audioOnly:true});
 h.rerender(<ExportDialog {...props} selection={{...selection,authorIds:[],audioOnly:true}}/>);
 expect(screen.queryByRole('group',{name:'包含的作者'})).toBeNull();expect(screen.getByRole('button',{name:'导出…'})).toBeEnabled();
 expect(screen.getByLabelText('保留项目文件夹层级')).toBeChecked();
});
it('merge import is available only in a writable project',()=>{
 const setMergeImport=vi.fn();const h=render(<ImportDialog {...state} canMerge={false} mergeImport={false} setMergeImport={setMergeImport} onStart={()=>{}}/>);
 expect(screen.getByLabelText('合并到当前项目')).toBeDisabled();
 h.rerender(<ImportDialog {...state} canMerge mergeImport={false} setMergeImport={setMergeImport} onStart={()=>{}}/>);
 fireEvent.click(screen.getByLabelText('合并到当前项目'));expect(setMergeImport).toHaveBeenCalledWith(true);
});
it('selection is sent to frozen preview and changing it invalidates previous acceptance',async()=>{
 const owner={collaboration:{actor:{authorId:'alice'},runtimeNonce:'nonce',canImportMedia:true},store:{snapshot:{document:{projectId:'project',revision:3}}},queue:{flush:vi.fn(async()=>{})},lifecycle:{submitDrafts:vi.fn(async()=>{})}};
 const project={active:owner,performExchange:vi.fn()} as unknown as ProjectLifecycleUI;
 const preview=vi.spyOn(exchangeClient,'preview').mockResolvedValue({token:'token',runtimeNonce:'nonce',projectId:'project',documentRevision:3,organizationRevision:1,bundle:true,preserveFolders:true,directories:['audio/'],mediaPaths:{},changes:[]});
 const h=renderHook(()=>useExchange(project));act(()=>h.result.current.showSelected(['a','b']));
 expect(h.result.current.selection?.authorIds).toEqual(['alice']);await act(()=>h.result.current.prepareExport('bundle'));
 expect(preview).toHaveBeenCalledWith({projectId:'project',expectedRevision:3,runtimeNonce:'nonce'},true,true,{mediaIds:['a','b'],authorIds:['alice'],audioOnly:false});
 expect(h.result.current.preview?.token).toBe('token');
 act(()=>h.result.current.updateSelection({...h.result.current.selection!,audioOnly:true}));expect(h.result.current.preview).toBeNull();
});
it('merge sends no new-project directory request and retains merge mode on retry',async()=>{
 const owner={collaboration:{actor:{authorId:'alice'},runtimeNonce:'nonce',canImportMedia:true},store:{snapshot:{document:{projectId:'project',revision:3}}}};
 const project={active:owner,performExchange:async(action:Parameters<ProjectLifecycleUI['performExchange']>[0])=>{await action({projectId:'project',expectedRevision:3,runtimeNonce:'nonce'});}} as unknown as ProjectLifecycleUI;
 vi.spyOn(exchangeDialogs,'source').mockResolvedValue('D:/part.audioproj.zip');const parent=vi.spyOn(exchangeDialogs,'parent');
 const start=vi.spyOn(exchangeClient,'start').mockImplementation(async(_request,receive)=>{receive({type:'completed',taskId:'t',path:'D:/target',opened:null} satisfies ExchangeEvent);return 't';});
 const h=renderHook(()=>useExchange(project));act(()=>h.result.current.setMergeImport(true));await act(async()=>h.result.current.startImport());
 expect(parent).not.toHaveBeenCalled();expect(start.mock.calls[0][0]).toMatchObject({kind:'import',merge:true,source:'D:/part.audioproj.zip'});expect(start.mock.calls[0][0]).not.toHaveProperty('parent');
 expect(h.result.current.result).toBe('D:/target');
});
it('opens the save picker before planning and exports without visiting directory preview',async()=>{
 const owner={store:{snapshot:{document:{projectId:'project',revision:4}}}};
 const order:string[]=[];
 const project={active:owner,performExchange:async(action:Parameters<ProjectLifecycleUI['performExchange']>[0])=>{order.push('save-project');await action({projectId:'project',expectedRevision:4});}} as unknown as ProjectLifecycleUI;
 vi.spyOn(exchangeDialogs,'save').mockImplementation(async()=>{order.push('choose-output');return 'D:/audio.zip';});
 vi.spyOn(exchangeClient,'preview').mockImplementation(async()=>{order.push('plan');return {token:'fresh',runtimeNonce:'nonce',projectId:'project',documentRevision:4,organizationRevision:1,bundle:true,preserveFolders:false,directories:['audio/'],mediaPaths:{},changes:[]};});
 const start=vi.spyOn(exchangeClient,'start').mockImplementation(async(request,receive)=>{order.push('export');receive({type:'completed',taskId:'t',path:request.path!,opened:null});return 't';});
 const h=renderHook(()=>useExchange(project));await act(async()=>h.result.current.startExport('bundle',false));
 expect(order).toEqual(['choose-output','save-project','plan','export']);expect(start.mock.calls[0][0]).toMatchObject({previewToken:'fresh',preserveFolders:false});
});
it('a hung optional preview cannot delay the save picker or a fresh export plan',async()=>{
 const owner={store:{snapshot:{document:{projectId:'project',revision:1}}}};
 const project={active:owner,performExchange:async(action:Parameters<ProjectLifecycleUI['performExchange']>[0])=>{await action({projectId:'project',expectedRevision:1});}} as unknown as ProjectLifecycleUI;
 const value={token:'fresh',runtimeNonce:'nonce',projectId:'project',documentRevision:1,organizationRevision:1,bundle:true,preserveFolders:true,directories:['audio/'],mediaPaths:{},changes:[]};
 const native=vi.spyOn(exchangeClient,'preview').mockImplementationOnce(()=>new Promise(()=>{})).mockResolvedValue(value);
 const save=vi.spyOn(exchangeDialogs,'save').mockResolvedValue('D:/out.zip');
 vi.spyOn(exchangeClient,'start').mockImplementation(async(_r,receive)=>{receive({type:'completed',taskId:'t',path:'D:/out.zip',opened:null});return 't';});
 const h=renderHook(()=>useExchange(project));act(()=>{void h.result.current.prepareExport('bundle');});expect(h.result.current.previewBusy).toBe(true);
 await act(async()=>h.result.current.startExport('bundle'));expect(save).toHaveBeenCalledOnce();expect(native).toHaveBeenCalledTimes(2);expect(h.result.current.result).toBe('D:/out.zip');
});
it('times out a stalled directory read and allows an immediate retry',async()=>{
 vi.useFakeTimers();
 try {
  const owner={store:{snapshot:{document:{projectId:'project',revision:1}}}};
  const native=vi.spyOn(exchangeClient,'preview').mockImplementation(()=>new Promise(()=>{}));
  const h=renderHook(()=>useExchange({active:owner} as unknown as ProjectLifecycleUI));
  act(()=>{void h.result.current.prepareExport('bundle');});
  await act(()=>vi.advanceTimersByTimeAsync(20001));expect(h.result.current.previewBusy).toBe(false);expect(h.result.current.error?.message).toContain('超时');
  act(()=>{void h.result.current.prepareExport('bundle');});expect(native).toHaveBeenCalledTimes(2);h.unmount();
 } finally {vi.useRealTimers();}
});
