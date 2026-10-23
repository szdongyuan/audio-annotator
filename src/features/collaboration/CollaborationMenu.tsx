import type { WorkspaceMenu } from '../../app/AppMenu';
import type { CollaborationUI } from './useCollaboration';
export function collaborationMenu(ui:CollaborationUI):WorkspaceMenu{
 const shared=!!ui.active?.collaboration,actor=ui.active?.collaboration?.actor,disabled=!shared||ui.busy||!!ui.active?.store.editingDisabled;
 return{id:'collaboration',label:'协作',items:[
  {id:'identity',label:actor?`当前身份 · ${actor.displayName}`:'访客',disabled:true},
  {id:'register',label:'注册项目账号…',disabled,action:()=>void ui.show('register')},
  {id:'login',label:'登录…',disabled,action:()=>void ui.show('login')},
  {id:'logout',label:'退出登录',disabled:disabled||!actor,action:ui.logout},
  {id:'sync',label:'保存并同步',disabled,action:ui.sync},
  {id:'authors',label:'作者显示与同步状态…',disabled,action:()=>void ui.show('status')},
  {id:'guest',label:'发布本机访客标注到我的图层…',disabled:disabled||!actor,action:()=>void ui.show('guest')},
  {id:'personal',label:'另存我的本机副本…',disabled,action:ui.saveAs},
  {id:'load',label:'加载共享版本…',disabled:disabled||!actor,action:()=>void ui.show('conflict')},
 ]};
}
