import { act,fireEvent,render,renderHook,screen,waitFor } from '@testing-library/react';
import { expect,it,vi } from 'vitest';
import fixture from '../../../tests/fixtures/document-v2.json';
import { IdentityDialog } from './IdentityDialog';
import { useCollaboration, type CollaborationUI } from './useCollaboration';
import type { CollaborationCommands, CollaborationStatus } from '../../bridge/collaboration';
import type { ActiveProject, ProjectLifecycleUI } from '../project/useProjectLifecycle';
import { ProjectStore } from '../../app/store';
import { CommandQueue } from '../../app/commands';
import { ProjectLifecycle } from '../project/lifecycle';
function setup(){const store=new ProjectStore({document:structuredClone(fixture) as never,canUndo:false,canRedo:false}),queue=new CommandQueue(store,{getSnapshot:async()=>store.snapshot,applyChange:vi.fn(),undo:vi.fn(),redo:vi.fn()});const active:ActiveProject={store,queue,lifecycle:new ProjectLifecycle(store,queue,{save:async(_id,r)=>r,close:async()=>{}}),path:'ordinary'};return active;}
it('cancellation during status admission cannot start a later credential operation',async()=>{
 const active=setup();let resolve!:(s:CollaborationStatus)=>void;
 const api={status:vi.fn(()=>new Promise<CollaborationStatus>(r=>{resolve=r;})),identity:vi.fn(),cancel:vi.fn(async()=>{}),chooseTarget:async()=>'/empty'} as unknown as CollaborationCommands;
 const project={active,performCollaboration:async(_o:ActiveProject,action:()=>Promise<unknown>)=>active.lifecycle.transitionAfterSave(action)} as unknown as ProjectLifecycleUI;
 const hook=renderHook(()=>useCollaboration(project,api));await act(()=>hook.result.current.show('login'));
 act(()=>hook.result.current.submit({login:'alice',displayName:'',password:'password123'}));await waitFor(()=>expect(api.status).toHaveBeenCalled());act(()=>hook.result.current.cancel());
 await act(async()=>resolve({projectId:fixture.projectId,runtimeNonce:'11111111-1111-4111-8111-111111111111',busy:false} as CollaborationStatus));
 await waitFor(()=>expect(hook.result.current.busy).toBe(false));expect(api.identity).not.toHaveBeenCalled();hook.unmount();active.lifecycle.dispose();
});
it('pure identity forms close outside and on Escape, while submitted forms require explicit cancellation',()=>{
 const cancel=vi.fn(),ui={dialog:{kind:'login',owner:setup()},busy:false,cancel,submit:vi.fn(),error:null} as unknown as CollaborationUI;
 const view=render(<IdentityDialog ui={ui}/>);fireEvent.keyDown(screen.getByRole('dialog'),{key:'Escape'});expect(cancel).toHaveBeenCalledTimes(1);fireEvent.pointerDown(document.querySelector('.dialog-backdrop')!);expect(cancel).toHaveBeenCalledTimes(2);
 view.rerender(<IdentityDialog ui={{...ui,busy:true}}/>);fireEvent.keyDown(screen.getByRole('dialog'),{key:'Escape'});fireEvent.pointerDown(document.querySelector('.dialog-backdrop')!);expect(cancel).toHaveBeenCalledTimes(2);fireEvent.click(screen.getByText('取消任务'));expect(cancel).toHaveBeenCalledTimes(3);ui.dialog!.owner.lifecycle.dispose();
});
it('a submitted create is single-flight and cancellation keeps the saved source active',async()=>{
 const active=setup();let reject!:(e:unknown)=>void;const create=vi.fn(()=>new Promise<never>((_r,j)=>{reject=j;}));
 const api={status:async()=>({projectId:fixture.projectId,runtimeNonce:'11111111-1111-4111-8111-111111111111',busy:false}),create,cancel:vi.fn(async()=>{}),chooseTarget:async()=>'/empty'} as unknown as CollaborationCommands;
 const project={active,performCollaboration:async(_o:ActiveProject,action:()=>Promise<unknown>)=>active.lifecycle.transitionAfterSave(action)} as unknown as ProjectLifecycleUI;
 const hook=renderHook(()=>useCollaboration(project,api));await act(()=>hook.result.current.show('create'));
 act(()=>{hook.result.current.submit({login:'alice',displayName:'Alice',password:'password123'});hook.result.current.submit({login:'alice',displayName:'Alice',password:'password123'});});await waitFor(()=>expect(create).toHaveBeenCalledTimes(1));act(()=>hook.result.current.cancel());expect(api.cancel).toHaveBeenCalledTimes(1);
 await act(async()=>reject({code:'Cancelled',message:'cancelled',retryable:true}));await waitFor(()=>expect(hook.result.current.busy).toBe(false));expect(hook.result.current.active).toBe(active);expect(hook.result.current.error?.code).toBe('Cancelled');expect(active.store.editingDisabled).toBe(false);hook.unmount();active.lifecycle.dispose();
});
it('credentials stay in the form and are cleared immediately on submit',()=>{
 const active=setup(),submit=vi.fn(),ui={dialog:{kind:'register',owner:active},busy:false,cancel:vi.fn(),submit,error:null} as unknown as CollaborationUI;
 render(<IdentityDialog ui={ui}/>);fireEvent.change(screen.getByLabelText('协作账号名'),{target:{value:'alice'}});fireEvent.change(screen.getByLabelText('协作显示名称'),{target:{value:'Alice'}});fireEvent.change(screen.getByLabelText('协作密码'),{target:{value:'password123'}});fireEvent.submit(screen.getByLabelText('协作密码').closest('form')!);expect(submit).toHaveBeenCalledWith({login:'alice',displayName:'Alice',password:'password123'});expect(screen.getByLabelText('协作密码')).toHaveValue('');expect(active.store.drafts.size).toBe(0);expect(localStorage.length).toBe(0);active.lifecycle.dispose();
});

it('hard resource limits fail once instead of being mistaken for retryable admission',async()=>{
 const active=setup(),identity=vi.fn().mockRejectedValue({code:'ResourceLimit',message:'catalog limit',retryable:true});
 const api={status:async()=>({projectId:fixture.projectId,runtimeNonce:'11111111-1111-4111-8111-111111111111',busy:false}),identity,cancel:vi.fn()} as unknown as CollaborationCommands;
 const project={active,performCollaboration:async(_o:ActiveProject,action:()=>Promise<unknown>)=>active.lifecycle.transitionAfterSave(action)} as unknown as ProjectLifecycleUI;
 const hook=renderHook(()=>useCollaboration(project,api));await act(()=>hook.result.current.show('login'));act(()=>hook.result.current.submit({login:'alice',displayName:'',password:'password123'}));await waitFor(()=>expect(hook.result.current.error?.message).toBe('catalog limit'));expect(identity).toHaveBeenCalledTimes(1);hook.unmount();active.lifecycle.dispose();
});
