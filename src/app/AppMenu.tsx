import { useEffect, useRef, useState } from 'react';
import { Menu } from '../components/menu/Menu';
import type { MenuItem } from '../components/menu/menuModel';
import type { ActiveProject } from '../features/project/useProjectLifecycle';
import '../styles/menus.css';
export type WorkspaceMenu = { id: string; label: string; items: MenuItem[] };
export function AppMenu({ menus, owner, contextKey }: { contextKey?: string; menus: WorkspaceMenu[]; owner: ActiveProject | null }) {
 const [opened,setOpened]=useState<{id:string;x:number;y:number;owner:ActiveProject|null;items:MenuItem[]}|null>(null);
 const triggers=useRef<(HTMLButtonElement|null)[]>([]);
 useEffect(()=>{setOpened(null);return owner?.store.subscribe(()=>{if(owner.store.editingDisabled)setOpened(null);});},[owner,contextKey]);
 const open=(index:number)=>{const button=triggers.current[index]; if(!button)return;button.focus();const r=button.getBoundingClientRect();setOpened({id:menus[index].id,x:r.left,y:r.bottom,owner,items:menus[index].items});};
 const menu=opened?.owner===owner?menus.find(m=>m.id===opened.id):null;
 return <><nav className={`main-menu ${menu ? 'is-open' : ''}`} role="menubar" aria-label="主菜单">{menus.map((m,i)=><button key={m.id} ref={el=>{triggers.current[i]=el;}} role="menuitem" aria-haspopup="menu" aria-expanded={menu?.id===m.id} onClick={()=>menu?.id===m.id?setOpened(null):open(i)} onPointerEnter={()=>{if(menu&&menu.id!==m.id)open(i);}} onKeyDown={e=>{if(['ArrowDown','Enter',' '].includes(e.key)){e.preventDefault();open(i);}else if(e.key==='ArrowRight'||e.key==='ArrowLeft'){e.preventDefault();triggers.current[(i+(e.key==='ArrowRight'?1:-1)+menus.length)%menus.length]?.focus();}}}>{m.label}</button>)}</nav>
 {menu&&opened&&<Menu panelKey={menu.id} returnFocus={triggers.current[menus.indexOf(menu)]} items={opened.items} anchor={opened} onClose={()=>setOpened(null)} onNavigate={direction=>open((menus.indexOf(menu)+direction+menus.length)%menus.length)}/>}</>;
}
