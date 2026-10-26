import { useSyncExternalStore } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import fixture from '../../../tests/fixtures/document-v3.json';
import { parseProjectDocument, type Change } from '../../bridge/types';
import { ProjectStore } from '../../app/store';
import { CommandQueue } from '../../app/commands';
import { ProjectLifecycle } from '../project/lifecycle';
import { useAnnotations, AnnotationContext } from './useAnnotations';
import { useSelection, SelectionContext, type SelectionUI } from '../selection/useSelection';
import { AnnotationInspector } from './AnnotationInspector';
import { ClassificationControl } from './ClassificationControl';
import { AppMenu } from '../../app/AppMenu';
import { workspaceMenus } from '../../app/WorkspaceActions';
import { RegionMenu } from '../selection/RegionMenu';
import { defaultView } from '../spectrogram/workspace';
import { labelColor } from './labels';
function mount(entry:'inspector'|'file'|'channel'|'main'|'context'){
 const doc=parseProjectDocument(structuredClone(fixture)),m=doc.media[0];doc.categories.push({id:'00000000-0000-4000-8000-000000000077',name:'风声',color:'#123456'});doc.annotations[0].categoryIds=[];m.categoryIds=[];m.channelCategoryIds[0]=[];
 const store=new ProjectStore({document:doc,canUndo:false,canRedo:false}),apply=vi.fn(async(_id:string,r:number,c:Change)=>{const d=structuredClone(store.snapshot.document);d.revision=r+1;
 if(c.type==='addAnnotation')d.annotations.push(c.annotation);if(c.type==='updateAnnotation')d.annotations=d.annotations.map(a=>a.id===c.annotation.id?c.annotation:a);if(c.type==='updateAnnotationNote')d.annotations[0].note=c.note;if(c.type==='setMediaCategories')d.media[0].categoryIds=c.categoryIds;if(c.type==='setChannelCategories')d.media[0].channelCategoryIds[c.channelIndex]=c.categoryIds;return{...store.snapshot,document:d};});
 const queue=new CommandQueue(store,{applyChange:apply,getSnapshot:async()=>store.snapshot,undo:async()=>store.snapshot,redo:async()=>store.snapshot}),lifecycle=new ProjectLifecycle(store,queue,{save:async(_,r)=>r,close:async()=>{}}),owner={store,queue,lifecycle,path:''};let ui!:SelectionUI;
 function App(){useSyncExternalStore(store.subscribe,()=>store.snapshot);ui=useSelection(owner,m.id);const annotations=useAnnotations(owner,ui),document=store.snapshot.document;const workspace={state:{activeMediaId:m.id},view:()=>defaultView(m)};
 const menus=workspaceMenus({project:{active:owner},annotations,selection:ui,workspace,playback:{options:{}},focusNote:()=>{}} as never);
 return <SelectionContext.Provider value={ui}><AnnotationContext.Provider value={annotations}>{entry==='inspector'?<AnnotationInspector ui={annotations} annotation={document.annotations[0]}/>:entry==='main'?<AppMenu menus={menus} owner={owner} contextKey={String(ui.state.intentVersion)}/>:entry==='context'?<RegionMenu ui={ui} playback={{} as never} workspace={workspace as never} statuses={[]} focusNote={()=>{}}/>:<ClassificationControl ui={annotations} target={{mediaId:m.id,channelIndex:entry==='file'?null:0}}/>}</AnnotationContext.Provider></SelectionContext.Provider>;
 }
 const view=render(<App/>);act(()=>ui.state.select({region:doc.annotations[0].region,object:entry==='main'?null:{kind:'annotation',id:doc.annotations[0].id}}));
 if(entry==='main'){fireEvent.click(screen.getByRole('menuitem',{name:'标注'}));fireEvent.click(screen.getByRole('menuitem',{name:'标注类型'}));}
 if(entry==='context'){act(()=>ui.openMenu({x:5,y:5,target:ui.selection,overlaps:[],mediaId:m.id,channelIndex:0}));fireEvent.click(screen.getByRole('menuitem',{name:'标注类型'}));}
 if(entry==='file'||entry==='channel'){fireEvent.click(screen.getByRole('button'));fireEvent.click(screen.getByRole('menuitem',{name:entry==='file'?'文件类别':'通道类别'}));}
 const ids=()=>entry==='file'?store.snapshot.document.media[0].categoryIds:entry==='channel'?store.snapshot.document.media[0].channelCategoryIds[0]:store.snapshot.document.annotations.at(-1)!.categoryIds;
 return{doc,owner,apply,ui:()=>ui,ids,settle:()=>act(async()=>{await lifecycle.submitDrafts();}),dispose:()=>{view.unmount();lifecycle.dispose();}};
}
it.each(['inspector','file','channel','main','context'] as const)('%s supports continuous labels, latest-state double toggle, clear all and preserved notes',async entry=>{
 const s=mount(entry);const role=entry==='inspector'?'checkbox':'menuitemcheckbox';const first=screen.getByRole(role,{name:'鸟声'}),second=screen.getByRole(role,{name:'风声'});
 let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});const hold=s.owner.lifecycle.enqueueEdit(()=>gate);
 if(entry==='inspector')fireEvent.change(screen.getByLabelText('区域备注'),{target:{value:'保留备注'}});
 fireEvent.click(first);fireEvent.click(second);fireEvent.click(first);await act(async()=>{release();await hold;});await s.settle();expect(s.ids()).toEqual([s.doc.categories[1].id]);
 expect(screen.getByRole(role,{name:'风声'})).toHaveAttribute(entry==='inspector'?'type':'aria-checked',entry==='inspector'?'checkbox':'true');
 if(entry==='main')expect(s.apply.mock.calls.filter(c=>c[2].type==='addAnnotation')).toHaveLength(1);
 if(entry==='inspector')expect(s.owner.store.snapshot.document.annotations[0].note).toBe('保留备注');
 fireEvent.click(screen.getByRole(entry==='inspector'?'button':'menuitemcheckbox',{name:'清空标签'}));await s.settle();expect(s.ids()).toEqual([]);s.dispose();
});
it('an open main label menu retires on a genuinely newer selection while legitimate first binding keeps it open',async()=>{
 const s=mount('main');fireEvent.click(screen.getByRole('menuitemcheckbox',{name:'鸟声'}));await s.settle();expect(screen.getByRole('menuitemcheckbox',{name:'鸟声'})).toHaveAttribute('aria-checked','true');
 const old=screen.getByRole('menuitemcheckbox',{name:'风声'});act(()=>s.ui().state.select({region:{...s.doc.annotations[0].region,lowHz:2},object:null}));expect(screen.queryAllByRole('menu')).toHaveLength(0);fireEvent.click(old);await s.settle();expect(s.owner.store.snapshot.document.annotations).toHaveLength(2);s.dispose();
});
it('color uses category definition order regardless of toggle order',()=>{const s=mount('inspector');expect(labelColor(s.doc.categories,[s.doc.categories[1].id,s.doc.categories[0].id])).toBe(s.doc.categories[0].color);s.dispose();});
it('an open context label menu retires when a newer selection arrives and a late label cannot retarget it',async()=>{
 const s=mount('context'),old=screen.getByRole('menuitemcheckbox',{name:'鸟声'});act(()=>s.ui().state.select({region:{...s.doc.annotations[0].region,lowHz:2},object:null}));expect(screen.queryAllByRole('menu')).toHaveLength(0);fireEvent.click(old);await s.settle();expect(s.owner.store.snapshot.document.annotations).toHaveLength(1);s.dispose();
});
