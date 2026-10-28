import { it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MediaList } from './MediaList';
import { OrganizationController } from './organization';
import { RecycleController } from './recycle';
import { parseRecycleSnapshot, type RecycleSnapshot, type Recycle } from '../../bridge/recycle';
import fixture from '../../../tests/fixtures/document-v3.json';
const nonce='11111111-1111-4111-8111-111111111111';
const media=[0,1,2].map(i=>({...fixture.media[0],id:`00000000-0000-4000-8000-00000000000${i+1}`,displayName:`audio-${i}.wav`}));
function setup() {
  const head:Recycle={kind:'audio-annotator-recycle' as const,formatVersion:1 as const,projectId:fixture.projectId,revision:0,trashed:[],recentOperations:[]};
  const response:RecycleSnapshot={runtimeNonce:nonce,projectId:fixture.projectId,recycle:head};
  const api={get:vi.fn(async()=>response),apply:vi.fn(async()=>({...response,recycle:{...head,revision:1}}))};
  const recycle=new RecycleController(fixture.projectId,nonce,true,api);recycle.snapshot=head;
  const props={recycle,media,annotations:[],statuses:[],selectedId:media[0].id,disabled:false,onSelect:vi.fn(),onImport:vi.fn(),onRelink:vi.fn(),onHideBatch:vi.fn(async()=>{})};
  const view=render(<MediaList {...props}/>);return {props,api,recycle,view};
}
it('search limits Ctrl+A, scope changes clear selection and hide commits one batch with undo',async()=>{
  const {props}=setup();fireEvent.click(screen.getByLabelText('多选音频'));
  fireEvent.click(screen.getByLabelText('全选筛选结果'));expect(screen.getByText('已选 3')).toBeVisible();
  fireEvent.change(screen.getByLabelText('搜索音频'),{target:{value:'audio-1'}});expect(screen.getByText('已选 0')).toBeVisible();
  fireEvent.change(screen.getByLabelText('搜索音频'),{target:{value:''}});expect(screen.getByText('已选 0')).toBeVisible();
  fireEvent.change(screen.getByLabelText('搜索音频'),{target:{value:'audio-1'}});
  fireEvent.keyDown(screen.getByRole('button',{name:'audio-1.wav'}),{key:'a',ctrlKey:true});expect(screen.getByText('已选 1')).toBeVisible();
  fireEvent.click(screen.getByRole('button',{name:'隐藏'}));await waitFor(()=>expect(props.onHideBatch).toHaveBeenCalledWith([media[1].id],true));
  await screen.findByRole('button',{name:'撤销'});fireEvent.click(screen.getByRole('button',{name:'撤销'}));await waitFor(()=>expect(props.onHideBatch).toHaveBeenCalledWith([media[1].id],false));
});
it('filename previews, ctrl/shift selects range, and Delete is scoped to file list',()=>{
  const {props,api}=setup();const row=screen.getByRole('button',{name:'audio-0.wav'});fireEvent.click(row);expect(props.onSelect).toHaveBeenCalledWith(media[0].id);
  fireEvent.click(row,{ctrlKey:true});fireEvent.click(screen.getByRole('button',{name:'audio-2.wav'}),{shiftKey:true});expect(screen.getByText('已选 3')).toBeVisible();
  const other=vi.fn();window.addEventListener('keydown',other);
  fireEvent.keyDown(row,{key:'Delete'});expect(screen.getByRole('dialog',{name:'移入共享回收站'})).toBeVisible();expect(other).not.toHaveBeenCalled();expect(api.apply).not.toHaveBeenCalled();window.removeEventListener('keydown',other);
});
it('context-menu batch entry anchors the next Shift range within the existing scope',()=>{
 const {props}=setup();fireEvent.contextMenu(screen.getByRole('button',{name:'audio-0.wav'}));
 fireEvent.click(screen.getByRole('menuitem',{name:'选择多个音频'}));
 fireEvent.click(screen.getByRole('button',{name:'audio-2.wav'}),{shiftKey:true});
 for(const file of media)expect(screen.getByLabelText(`选择音频 · ${file.displayName}`)).toBeChecked();
 expect(screen.getByText('已选 3')).toBeVisible();expect(props.onSelect).not.toHaveBeenCalled();
});
it('offline delete keeps immutable selection/operation ID for explicit retry',async()=>{
  const {api}=setup();api.apply.mockRejectedValueOnce({code:'SaveFailed',message:'NAS offline',retryable:true});
  fireEvent.click(screen.getByLabelText('多选音频'));fireEvent.click(screen.getByLabelText('全选筛选结果'));fireEvent.click(screen.getByRole('button',{name:'移入回收站'}));
  fireEvent.click(screen.getAllByRole('button',{name:'移入回收站'}).at(-1)!);await screen.findByText(/NAS offline/);expect(screen.getByText('已选 3')).toBeVisible();
  fireEvent.click(screen.getByRole('button',{name:'核对并重试'}));await waitFor(()=>expect(api.apply).toHaveBeenCalledTimes(2));expect(api.apply.mock.calls[0]).toEqual(api.apply.mock.calls[1]);
  await waitFor(()=>expect(screen.queryByRole('dialog')).toBeNull());
});
it('trash view only contains trashed files and restores rather than deleting twice',async()=>{
  const {recycle,api}=setup();recycle.snapshot={...recycle.snapshot!,revision:1,trashed:[{mediaId:media[1].id,deletedBy:nonce}]};
  fireEvent.change(screen.getByLabelText('音频列表视图'),{target:{value:'trash'}});expect(screen.queryByRole('button',{name:'audio-0.wav'})).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'audio-1.wav'}));fireEvent.keyDown(screen.getByRole('button',{name:'audio-1.wav'}),{key:'Delete'});expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'恢复'}));fireEvent.click(screen.getByRole('button',{name:'恢复音频'}));await waitFor(()=>expect(api.apply).toHaveBeenCalled());expect((api.apply.mock.calls[0] as unknown[])[2]).toMatchObject({trash:false,mediaIds:[media[1].id]});
});
it('controller refreshes conflict but retains operation, refuses late old owner responses',async()=>{
  const {recycle,api}=setup();const draft=recycle.beginEdit({operationId:nonce,mediaIds:[media[0].id],trash:true});api.apply.mockRejectedValueOnce({code:'RevisionConflict',message:'changed',retryable:true});
  api.get.mockResolvedValue({...await api.get(),recycle:{...recycle.snapshot!,revision:3,trashed:[]}});
  await act(async()=>{expect(await recycle.submit(draft)).toBe(false);});expect(draft.expectedRevision).toBe(3);expect(recycle.error?.code).toBe('RevisionConflict');
  const before=recycle.snapshot;recycle.dispose();expect(await recycle.submit(draft)).toBe(false);expect(recycle.snapshot).toBe(before);
});
it('bridge rejects malformed and duplicate tombstones',()=>{
  const {recycle}=setup();const value={runtimeNonce:nonce,projectId:fixture.projectId,recycle:recycle.snapshot};expect(parseRecycleSnapshot(value)).toBe(value);
  expect(()=>parseRecycleSnapshot({...value,recycle:{...recycle.snapshot,trashed:[{mediaId:media[0].id,deletedBy:nonce},{mediaId:media[0].id,deletedBy:nonce}]}})).toThrow();
});

it('Shift range follows tree order rather than catalog insertion order',()=>{
 const {props,view}=setup();const c=new OrganizationController(fixture.projectId,nonce,true,{get:vi.fn(),apply:vi.fn()});
 c.snapshot={kind:'audio-annotator-organization',formatVersion:1,projectId:fixture.projectId,revision:0,layoutRevision:0,folders:[{id:nonce,parentId:null,name:'folder'}],media:media.map((m,i)=>({mediaId:m.id,folderId:i?nonce:null,originalFilename:m.displayName}))};
 view.rerender(<MediaList {...props} organization={c}/>);fireEvent.click(screen.getByLabelText('展开文件夹 · folder'));
 fireEvent.click(screen.getByRole('button',{name:'audio-0.wav'}),{ctrlKey:true});fireEvent.click(screen.getByRole('button',{name:'audio-2.wav'}),{shiftKey:true});
 expect(screen.getByText('已选 2')).toBeVisible();expect(screen.getByLabelText('选择音频 · audio-1.wav')).not.toBeChecked();
});
