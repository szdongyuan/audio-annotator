import { useSyncExternalStore } from 'react';
import { AppMenu } from '../../app/AppMenu';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { IdentityDialog } from './IdentityDialog';
import { IdentityController } from './controller';
import { collaborationMenu } from '../collaboration/CollaborationMenu';
import { parseProfileResponse } from '../../bridge/profiles';
function controller(){const c=new IdentityController({owner:()=>null,perform:async(_o,a)=>a(),acceptStatus:()=>{}});c.dialog='switch';c.snapshot={storeRevision:1,runtimeNonce:'11111111-1111-4111-8111-111111111111',project:null,selectedAuthorId:'11111111-1111-4111-8111-111111111111',profiles:['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222'].map(authorId=>({authorId,displayName:'同名',createdAt:'2026-10-26T00:00:00Z'}))};return c;}
it('identity menu works without a project while project actions stay disabled',()=>{const c=controller();const menu=collaborationMenu({active:null,busy:false} as never,c);for(const id of ['identity-create','identity-switch','identity-rename','identity-import','identity-export'])expect(menu.items.find(i=>i.id===id)?.disabled).toBe(false);expect(menu.items.find(i=>i.id==='sync')?.disabled).toBe(true);expect(menu.items.find(i=>i.id==='identity')?.label).toContain('同名');});
it('distinguishes duplicate nicknames and exposes full UUID for inspection and copy',()=>{const c=controller();render(<IdentityDialog controller={c}/>);expect(screen.getAllByText('同名')).toHaveLength(2);expect(screen.getByText('11111111')).toBeVisible();expect(screen.getByText('22222222')).toBeVisible();expect(screen.getAllByLabelText('完整身份 UUID')[1]).toHaveValue(c.snapshot!.profiles[1].authorId);expect(screen.getAllByRole('button',{name:'复制 UUID'})).toHaveLength(2);});
it('supports Unicode nickname validation, focus return, outside and Escape dismissal, and explicit busy cancellation',()=>{const c=controller();c.dialog='create';const close=vi.spyOn(c,'close'),cancel=vi.spyOn(c,'cancel'),create=vi.spyOn(c,'create').mockResolvedValue();const previous=document.createElement('button');document.body.append(previous);previous.focus();const view=render(<IdentityDialog controller={c}/>);fireEvent.change(screen.getByLabelText('身份昵称'),{target:{value:'😀'.repeat(64)}});fireEvent.submit(screen.getByLabelText('身份昵称').closest('form')!);expect(create).toHaveBeenCalledWith('😀'.repeat(64));expect(screen.queryByLabelText(/密码/)).toBeNull();fireEvent.keyDown(screen.getByRole('dialog'),{key:'Escape'});expect(close).toHaveBeenCalledTimes(1);c.dialog='create';view.rerender(<IdentityDialog controller={c}/>);fireEvent.pointerDown(document.querySelector('.dialog-backdrop')!);expect(close).toHaveBeenCalledTimes(2);c.dialog='create';c.busy=true;view.rerender(<IdentityDialog controller={c}/>);fireEvent.keyDown(screen.getByRole('dialog'),{key:'Escape'});expect(close).toHaveBeenCalledTimes(2);fireEvent.click(screen.getByText('取消任务'));expect(cancel).toHaveBeenCalledTimes(1);view.unmount();expect(previous).toHaveFocus();previous.remove();});
it('shows duplicate import metadata, an explicit Use action, and accurate post-selection feedback',()=>{const c=controller();c.dialog='import';const imported=c.snapshot!.profiles[1];c.result={profiles:c.snapshot!,profile:imported,alreadyExists:true,status:null,transition:null,warning:null};const select=vi.spyOn(c,'select').mockResolvedValue();const view=render(<IdentityDialog controller={c}/>);expect(screen.getByRole('status')).toHaveTextContent('该身份已存在');fireEvent.click(screen.getByRole('button',{name:'使用此身份'}));expect(select).toHaveBeenCalledWith(imported.authorId);c.snapshot!.selectedAuthorId=imported.authorId;c.result={...c.result,profile:null,alreadyExists:false};view.rerender(<IdentityDialog controller={c}/>);expect(screen.getByRole('status')).toHaveTextContent('当前身份已更新');expect(screen.queryByText('身份已导入，当前身份未改变。')).toBeNull();});
it('shows the native partial rename cause beside successful local metadata feedback',()=>{
 const c=controller();c.dialog='rename';
 const cause={code:'SaveFailed',message:'共享目录不可写，请检查项目目录权限。',retryable:true};
 c.result=parseProfileResponse({profiles:c.snapshot!,profile:c.selected,alreadyExists:false,status:null,transition:null,warning:{code:'SaveFailed',message:'昵称已保存在本机，项目显示名称未更新',retryable:true,details:{cause}}});
 c.warning=c.result.warning;const before=c.snapshot;render(<IdentityDialog controller={c}/>);
 expect(screen.getByRole('alert')).toHaveTextContent(c.warning!.message);expect(screen.getByRole('alert')).toHaveTextContent(cause.message);
 expect(screen.getByRole('status')).toHaveTextContent('昵称已保存');expect(c.snapshot).toBe(before);expect(c.error).toBeNull();
});
it.each([undefined,null,'not an error',[],{}, {message:17},{code:'NotNative',message:'invalid cause',retryable:true},{code:'SaveFailed',message:'x'.repeat(16385),retryable:true}])('keeps partial rename feedback safe when optional cause is absent or malformed (%#)',cause=>{
 const c=controller();c.dialog='rename';c.result={profiles:c.snapshot!,profile:c.selected,alreadyExists:false,status:null,transition:null,warning:null};
 c.warning={code:'SaveFailed',message:'昵称已保存在本机，项目显示名称未更新',retryable:true,...(cause===undefined?{}:{details:{cause}})};
 render(<IdentityDialog controller={c}/>);expect(screen.getByRole('alert')).toHaveTextContent(/^昵称已保存在本机，项目显示名称未更新$/);expect(screen.getByRole('status')).toHaveTextContent('昵称已保存');
});

it('returns focus from a real AppMenu identity action after its workspace becomes inert',()=>{
 const c=controller();c.dialog=null;vi.spyOn(c,'refresh').mockResolvedValue();
 // jsdom does not implement inert. Model its focus prohibition so the menu's
 // passive cleanup cannot focus a trigger after App has made the root inert.
 const focus=HTMLElement.prototype.focus;
 const guarded=vi.spyOn(HTMLElement.prototype,'focus').mockImplementation(function(this:HTMLElement,options?:FocusOptions){if(!this.closest('[inert]'))focus.call(this,options);});
 function Integrated(){useSyncExternalStore(c.subscribe,c.getVersion);return <><div inert={!!c.dialog}><AppMenu owner={null} menus={[collaborationMenu({active:null,busy:false} as never,c)]}/></div><IdentityDialog controller={c}/></>;}
 try{
  render(<Integrated/>);const trigger=screen.getByRole('menuitem',{name:'协作'});
  for(const dismiss of ['escape','outside']){
   fireEvent.click(trigger);fireEvent.click(screen.getByRole('menuitem',{name:'切换身份…'}));
   expect(screen.getByRole('dialog',{name:'切换身份'})).toHaveFocus();expect(trigger.closest('[inert]')).not.toBeNull();
   if(dismiss==='escape')fireEvent.keyDown(document.activeElement!,{key:'Escape'});else fireEvent.pointerDown(document.querySelector('.dialog-backdrop')!);
   expect(screen.queryByRole('dialog')).toBeNull();expect(trigger).toHaveFocus();
  }
 }finally{guarded.mockRestore();}
});
