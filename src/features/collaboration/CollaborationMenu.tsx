import type { WorkspaceMenu } from '../../app/AppMenu';
import type { CollaborationUI } from './useCollaboration';
import type { IdentityController, IdentityDialogKind } from '../identity/controller';
export function collaborationMenu(ui:CollaborationUI,identity?:IdentityController,projectBusy=false):WorkspaceMenu{
 const shared=ui.active?.collaboration?.projectFlavor==='default',actor=ui.active?.collaboration?.actor;
 const disabled=!shared||ui.busy||projectBusy||!!identity?.busy||!!ui.active?.store.editingDisabled;
 const identityDisabled=!!identity?.busy||ui.busy||projectBusy;
 const actions:[IdentityDialogKind,string][]=[['create','创建身份…'],['switch','切换身份…'],['rename','修改昵称…'],['import','导入身份…'],['export','导出当前身份…']];
 return{id:'collaboration',label:'协作',items:[
  {id:'identity',label:identity?.selected?`当前身份 · ${identity.selected.displayName}`:identity?.error?'身份加载失败':'正在加载身份…',disabled:true},
  ...actions.map(([kind,label])=>({id:`identity-${kind}`,label,disabled:identityDisabled||!identity,action:(returnFocus?:HTMLElement|null)=>identity?.show(kind,returnFocus)})),
  {id:'sync',label:'保存并同步',disabled:disabled||!actor,action:ui.sync},
  {id:'authors',label:'作者显示与同步状态…',disabled,action:()=>void ui.show('status')},
  ...(shared&&ui.controller?.status?.catalogPending?[{id:'catalog',label:'更新音频列表',disabled:disabled||!actor,action:ui.adoptCatalog}]:[]),
  {id:'personal',label:'另存我的项目副本…',disabled,action:ui.saveAs},
  {id:'load',label:'加载共享版本…',disabled:disabled||!actor,action:()=>void ui.show('conflict')},
 ]};
}
