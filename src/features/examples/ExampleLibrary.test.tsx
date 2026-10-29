import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { ExampleLibrary, ExampleLibraryPanel } from './ExampleLibrary';
import { StrictMode } from 'react';
import { exampleClient } from '../../bridge/examples';
import { ProjectStore } from '../../app/store';
import type { ActiveProject } from '../project/useProjectLifecycle';
import type { PlaybackUI } from '../playback/usePlayback';
import type { IdentityController } from '../identity/controller';
import { ExampleController } from './controller';
import type { ExampleAPI, ExampleEntry } from '../../bridge/examples';
import fixture from '../../../tests/fixtures/document-v3.json';
import { parseProjectDocument } from '../../bridge/types';
const actor='11111111-1111-4111-8111-111111111111',project='22222222-2222-4222-8222-222222222222';
const media=parseProjectDocument(fixture).media[0];
const entry={sampleId:actor,projectId:project,creatorId:actor,scope:'private',name:'OK1',revision:1,originalFilename:'原音.wav',media} satisfies ExampleEntry;
function setup(guest=false){const api={list:vi.fn(async()=>({entries:[{...entry,scope:guest?'shared':'private'}],revisions:{[actor]:1}})),rename:vi.fn(async()=>entry),remove:vi.fn(async()=>{}),copy:vi.fn(async()=>entry),import:vi.fn(async()=>entry),fromProject:vi.fn(async()=>entry)} as unknown as ExampleAPI;const c=new ExampleController({runtimeNonce:actor,projectId:project,actorId:guest?null:actor},api);return{c,api};}
it('filters compact named entries, plays directly and exposes creator context operations',async()=>{
 const {c,api}=setup();await c.refresh();const preview=vi.fn();render(<ExampleLibraryPanel controller={c} selected={media} onChoose={vi.fn()} onPreview={preview}/>);
 fireEvent.change(screen.getByRole('searchbox',{name:'筛选示例'}),{target:{value:'ng'}});expect(screen.queryByRole('button',{name:'OK1'})).not.toBeInTheDocument();fireEvent.change(screen.getByRole('searchbox'),{target:{value:'ok'}});
 fireEvent.click(screen.getByRole('button',{name:'播放示例 OK1'}));expect(preview).toHaveBeenCalledWith(entry,true,expect.any(HTMLElement));
 fireEvent.contextMenu(screen.getByRole('button',{name:'OK1'}),{clientX:20,clientY:30});fireEvent.click(screen.getByRole('menuitem',{name:'重命名'}));const input=screen.getByRole('textbox',{name:'示例名称'});fireEvent.change(input,{target:{value:''}});fireEvent.click(screen.getByRole('button',{name:'保存名称'}));expect(input).toHaveValue('');expect(screen.getByRole('alert')).toHaveTextContent('名称');
 fireEvent.change(input,{target:{value:'NG1'}});fireEvent.click(screen.getByRole('button',{name:'保存名称'}));await waitFor(()=>expect(api.rename).toHaveBeenCalled());
});
it('guests can read/play shared entries but cannot import, rename, remove, copy or use mine',async()=>{
 const {c}=setup(true);await c.refresh();render(<ExampleLibraryPanel controller={c} selected={media} onChoose={vi.fn()} onPreview={vi.fn()}/>);
 expect(screen.getByRole('tab',{name:'我的示例'})).toBeDisabled();expect(screen.getByRole('tab',{name:'共享示例'})).toHaveAttribute('aria-selected','true');expect(screen.getByRole('button',{name:'导入示例'})).toBeDisabled();expect(screen.getByRole('button',{name:'播放示例 OK1'})).toBeEnabled();
 fireEvent.contextMenu(screen.getByRole('button',{name:'OK1'}));expect(screen.queryByRole('menuitem',{name:'重命名'})).not.toBeInTheDocument();expect(screen.queryByRole('menuitem',{name:'移除示例'})).not.toBeInTheDocument();expect(screen.queryByRole('menuitem',{name:/复制到/})).not.toBeInTheDocument();
});
it('retains editable per-file import names and durable results without reinserting successful rows',async()=>{
 const {c,api}=setup();c.setImportPaths(['C:/ok.wav','C:/ng.wav']);vi.mocked(api.import).mockRejectedValueOnce({code:'SaveFailed',message:'磁盘忙',retryable:true});render(<ExampleLibraryPanel controller={c} selected={media} onChoose={vi.fn()} onPreview={vi.fn()}/>);
 fireEvent.change(screen.getByRole('textbox',{name:'导入名称 1'}),{target:{value:'OK2'}});fireEvent.click(screen.getByRole('button',{name:'导入待处理文件'}));await waitFor(()=>expect(screen.getByText('已导入')).toBeInTheDocument());expect(screen.getByRole('textbox',{name:'导入名称 1'})).toHaveValue('OK2');expect(screen.getByText('磁盘忙')).toBeInTheDocument();
 fireEvent.click(screen.getByRole('button',{name:'关闭'}));fireEvent.click(screen.getByRole('button',{name:'查看导入结果'}));expect(screen.getByText('磁盘忙')).toBeInTheDocument();
 await act(()=>c.importRows());expect(api.import).toHaveBeenCalledTimes(3);
});
it('keeps closed import results closed across panel remounts, with explicit reopen and new batch opening',async()=>{
 const {c}=setup();c.setImportPaths(['first.wav']);const props={controller:c,selected:media,onChoose:vi.fn(),onPreview:vi.fn()};
 const first=render(<ExampleLibraryPanel {...props}/>);fireEvent.click(screen.getByRole('button',{name:'导入待处理文件'}));await screen.findByText('已导入');fireEvent.click(screen.getByRole('button',{name:'关闭'}));first.unmount();
 const second=render(<ExampleLibraryPanel {...props}/>);expect(screen.queryByRole('dialog',{name:'导入示例'})).not.toBeInTheDocument();expect(c.rows[0].state).toBe('success');
 fireEvent.click(screen.getByRole('button',{name:'查看导入结果'}));expect(screen.getByText('已导入')).toBeInTheDocument();fireEvent.click(screen.getByRole('button',{name:'关闭'}));
 act(()=>c.setImportPaths(['second.wav']));expect(screen.getByRole('textbox',{name:'导入名称 1'})).toHaveValue('second');second.unmount();c.dispose();c.setImportPaths(['late.wav']);expect(c.importOpen).toBe(false);
 const next=setup().c;render(<ExampleLibraryPanel {...props} controller={next}/>);expect(screen.queryByRole('dialog',{name:'导入示例'})).not.toBeInTheDocument();
});
it('reopens partial private results with their retained destination after browsing shared and retries privately',async()=>{
 const {c,api}=setup();vi.mocked(api.import).mockResolvedValueOnce(entry).mockRejectedValueOnce({code:'SaveFailed',message:'磁盘忙',retryable:true});c.setImportPaths(['one.wav','two.wav']);render(<ExampleLibraryPanel controller={c} selected={media} onChoose={vi.fn()} onPreview={vi.fn()}/>);
 fireEvent.click(screen.getByRole('button',{name:'导入待处理文件'}));await waitFor(()=>expect(screen.getByText('磁盘忙')).toBeInTheDocument());fireEvent.click(screen.getByRole('button',{name:'关闭'}));fireEvent.click(screen.getByRole('tab',{name:'共享示例'}));fireEvent.click(screen.getByRole('button',{name:'查看导入结果'}));expect(screen.getByRole('combobox',{name:'保存示例到'})).toHaveValue('private');expect(screen.getByRole('combobox',{name:'保存示例到'})).toBeDisabled();expect(screen.getByRole('textbox',{name:'导入名称 2'})).toHaveValue('two');
 fireEvent.click(screen.getByRole('button',{name:'导入待处理文件'}));await waitFor(()=>expect(screen.getAllByText('已导入')).toHaveLength(2));expect(vi.mocked(api.import).mock.calls.map(call=>call[1])).toEqual(['private','private','private']);expect(c.scope).toBe('shared');
});
it('chooses batch and add-current destinations independently from browsing and earlier import results',async()=>{
 const {c,api}=setup();c.setImportPaths(['one.wav']);render(<ExampleLibraryPanel controller={c} selected={media} onChoose={vi.fn()} onPreview={vi.fn()}/>);
 fireEvent.change(screen.getByRole('combobox',{name:'保存示例到'}),{target:{value:'shared'}});expect(c.scope).toBe('private');fireEvent.click(screen.getByRole('button',{name:'导入待处理文件'}));await waitFor(()=>expect(screen.getByText('已导入')).toBeInTheDocument());expect(vi.mocked(api.import).mock.calls[0][1]).toBe('shared');
 fireEvent.click(screen.getByRole('button',{name:'关闭'}));fireEvent.click(screen.getByRole('button',{name:'添加当前音频为示例'}));const destination=screen.getByRole('combobox',{name:'保存示例到'});expect(destination).toHaveValue('private');expect(destination).toBeEnabled();fireEvent.change(destination,{target:{value:'shared'}});expect(c.scope).toBe('private');fireEvent.click(screen.getByRole('button',{name:'添加示例'}));await waitFor(()=>expect(api.fromProject).toHaveBeenCalledWith(c.owner,'shared',media.id,expect.any(String),1));expect(c.scope).toBe('private');
});
it('subscribes to stable ordinary identity changes and discards the prior private library',async()=>{
 let version=0;const listeners=new Set<()=>void>();const identity={snapshot:{runtimeNonce:actor},selected:{authorId:actor},subscribe:(f:()=>void)=>{listeners.add(f);return()=>listeners.delete(f);},getVersion:()=>version} as unknown as IdentityController;
 const list=vi.spyOn(exampleClient,'list').mockResolvedValueOnce({entries:[entry],revisions:{[actor]:1}}).mockResolvedValue({entries:[],revisions:{}});
 const active={store:new ProjectStore({document:parseProjectDocument(fixture),canUndo:false,canRedo:false})} as ActiveProject;
 const view=render(<ExampleLibrary active={active} identity={identity} playback={{} as PlaybackUI} visible/>);await waitFor(()=>expect(screen.getByRole('button',{name:'OK1'})).toBeInTheDocument());
 act(()=>{Object.assign(identity,{selected:{authorId:project}});version++;listeners.forEach(f=>f());});await waitFor(()=>expect(screen.getByText('暂无示例')).toBeInTheDocument());expect(screen.queryByRole('button',{name:'OK1'})).not.toBeInTheDocument();view.unmount();list.mockRestore();
});
it('keeps only one quiet poll in flight when NAS reads outlast the polling interval',async()=>{
 vi.useFakeTimers();let view:ReturnType<typeof render>|undefined;const list=vi.spyOn(exampleClient,'list');
 try{let resolve!:(v:Awaited<ReturnType<typeof exampleClient.list>>)=>void;list.mockResolvedValueOnce({entries:[entry],revisions:{[actor]:1}}).mockImplementation(()=>new Promise(r=>resolve=r));
  const active={store:new ProjectStore({document:parseProjectDocument(fixture),canUndo:false,canRedo:false}),collaboration:{runtimeNonce:actor,actor:{authorId:actor}}} as ActiveProject;
  await act(async()=>{view=render(<ExampleLibrary active={active} playback={{} as PlaybackUI} visible/>);});expect(screen.getByRole('button',{name:'OK1'})).toBeInTheDocument();
  await act(()=>vi.advanceTimersByTimeAsync(15000));expect(list).toHaveBeenCalledTimes(2);
  await act(async()=>{resolve({entries:[{...entry,name:'OK2'}],revisions:{[actor]:1}});});expect(screen.getByRole('button',{name:'OK2'})).toBeInTheDocument();await act(()=>vi.advanceTimersByTimeAsync(5000));expect(list).toHaveBeenCalledTimes(3);
 }finally{view?.unmount();list.mockRestore();vi.useRealTimers();}
});
it('survives React StrictMode effect replay and retires a pending project/identity owner read',async()=>{
 let resolve!:(v:Awaited<ReturnType<typeof exampleClient.list>>)=>void;const list=vi.spyOn(exampleClient,'list').mockImplementationOnce(()=>new Promise(r=>resolve=r)).mockResolvedValue({entries:[entry],revisions:{[actor]:1}});
 const active={store:new ProjectStore({document:parseProjectDocument(fixture),canUndo:false,canRedo:false}),collaboration:{runtimeNonce:actor,projectFlavor:'default',actor:{authorId:actor}}} as ActiveProject;
 const props={active,playback:{} as PlaybackUI,visible:true};const view=render(<StrictMode><ExampleLibrary {...props}/></StrictMode>);await waitFor(()=>expect(screen.getByRole('button',{name:'OK1'})).toBeInTheDocument());
 view.rerender(<StrictMode><ExampleLibrary {...props} active={{...active,collaboration:{...active.collaboration!,runtimeNonce:project,actor:null}}}/></StrictMode>);await act(async()=>{resolve({entries:[{...entry,name:'旧项目'}],revisions:{[actor]:1}});});expect(screen.queryByRole('button',{name:'旧项目'})).not.toBeInTheDocument();expect(screen.getByRole('tab',{name:'我的示例'})).toBeDisabled();view.unmount();list.mockRestore();
});
