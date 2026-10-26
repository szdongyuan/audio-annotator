import { useSelection } from '../selection/useSelection';
import { render,screen } from '@testing-library/react';
import { CategoryManager } from '../annotations/CategoryManager';
import { NotesEditor } from '../annotations/NotesEditor';
import { useAnnotations } from '../annotations/useAnnotations';
import { renderHook,act } from '@testing-library/react';
import { useWorkspace } from '../spectrogram/useWorkspace';
import { describe, expect, it, vi } from 'vitest';
import { parseSharedContext, parseCollaborationStatus } from '../../bridge/collaboration';
import { projectMenuItems } from '../project/ProjectActions';
import { collaborationMenu } from './CollaborationMenu';
import fixture from '../../../tests/fixtures/document-v2.json';
import { ProjectStore } from '../../app/store';
import { CommandQueue } from '../../app/commands';
import { ProjectLifecycle } from '../project/lifecycle';
import type { ActiveProject } from '../project/useProjectLifecycle';
function owner():ActiveProject{const store=new ProjectStore({document:structuredClone(fixture) as never,canUndo:false,canRedo:false});const queue=new CommandQueue(store,{getSnapshot:async()=>store.snapshot,applyChange:vi.fn(),undo:vi.fn(),redo:vi.fn()});return{store,queue,lifecycle:new ProjectLifecycle(store,queue,{save:async(_id,r)=>r,close:async()=>{}}),path:'shared',collaboration:{runtimeNonce:'11111111-1111-4111-8111-111111111111',actor:{authorId:'11111111-1111-4111-8111-111111111111',displayName:'本机身份',createdAt:'2026-10-26T00:00:00Z'},preferences:null,projectFlavor:'default',identityMode:'profile',canWriteAnnotations:true,canImportMedia:true,hiddenMediaIds:[],catalogPending:false}};}
const status=(o:ActiveProject)=>({formatVersion:1,...o.collaboration!,projectId:fixture.projectId,shared:true,pending:false,recoveryRequired:false,busy:false,lastSuccessMs:null,error:null,snapshot:null});
export const defaults = {projectFlavor:'default' as const,identityMode:'profile' as const,canWriteAnnotations:true,canImportMedia:true,hiddenMediaIds:[],catalogPending:false};
const actor={authorId:'22222222-2222-4222-8222-222222222222',displayName:'本机作者 · ABCD',createdAt:'2026-10-25T00:00:00Z'};
describe('default projects',()=>{
 it('parses explicit capabilities and rejects unknown/secret fields and invalid hidden lists',()=>{
  const o=owner(),context={...o.collaboration,...defaults,actor};
  expect(parseSharedContext(context)).toEqual(context);
  for(const patch of [{password:'secret'},{unknown:true},{hiddenMediaIds:['invalid']},{hiddenMediaIds:[actor.authorId,actor.authorId]}])expect(()=>parseSharedContext({...context,...patch})).toThrow();
  expect(()=>parseSharedContext({...context,canImportMedia:undefined})).toThrow();
  expect(parseCollaborationStatus({...status(o),...defaults,actor}).identityMode).toBe('profile');o.lifecycle.dispose();
 });
 it('enables default media and folder imports and hides legacy copy and guest actions',()=>{
  const active=owner();Object.assign(active.collaboration!,defaults,{actor});
  const project={active,busy:false,open:vi.fn(),save:vi.fn(),saveAs:vi.fn()} as never;
  const menu=projectMenuItems({project,onImport:vi.fn(),onImportFolder:vi.fn(),importDisabled:false,onCreateCollaboration:vi.fn()});
  expect(menu.find(i=>i.id==='import')?.disabled).toBe(false);expect(menu.find(i=>i.id==='import-folder')?.disabled).toBe(false);
  expect(menu.some(i=>i.id==='collaboration-create')).toBe(false);
  const collab=collaborationMenu({active,busy:false,show:vi.fn(),controller:{status:{catalogPending:true}}} as never);
  expect(collab.items.some(i=>i.id==='guest')).toBe(false);expect(collab.items.some(i=>i.id==='catalog')).toBe(true);
  active.lifecycle.dispose();
 });
});

it('view-only disables public category and note inputs without disabling the project store',()=>{
 const active=owner();Object.assign(active.collaboration!,defaults,{identityMode:'viewOnly',actor:null,canWriteAnnotations:false,canImportMedia:false});
 const hook=renderHook(()=>useAnnotations(active));render(<><CategoryManager ui={hook.result.current}/><NotesEditor ui={hook.result.current} media={active.store.snapshot.document.media[0]}/></>);
 expect(screen.getByRole('textbox',{name:'音频备注'})).toBeDisabled();expect(active.store.editingDisabled).toBe(false);expect(screen.getByRole('button',{name:'添加类别'})).toBeDisabled();hook.unmount();active.lifecycle.dispose();
});
it('hidden media is excluded from both pane choices and fallback without filtering document data, and can be revealed',async()=>{
 const active=owner();const id=active.store.snapshot.document.media[0].id;const reveal=vi.fn(async()=>{});const original=active.store.snapshot;
 const hook=renderHook(({hidden})=>useWorkspace(active,hidden,reveal),{initialProps:{hidden:[] as string[]}});hook.rerender({hidden:[id]});expect(hook.result.current.state.activeMediaId).toBeNull();expect(hook.result.current.visibleMedia).toEqual([]);expect(active.store.snapshot).toBe(original);
 await act(async()=>{await hook.result.current.revealMedia(id);hook.result.current.selectPane('primary',id);});expect(reveal).toHaveBeenCalledWith(id);expect(hook.result.current.state.activeMediaId).toBe(id);hook.unmount();active.lifecycle.dispose();
});

it('supports all 4096 hidden IDs while bounding and correlating context capabilities',()=>{
 const o=owner(),context={...o.collaboration,...defaults,actor,hiddenMediaIds:Array.from({length:4096},(_,i)=>`00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`)};
 expect(parseSharedContext(context).hiddenMediaIds).toHaveLength(4096);expect(()=>parseSharedContext({...context,hiddenMediaIds:[...context.hiddenMediaIds,actor.authorId]})).toThrow();
 for(const patch of [{identityMode:'viewOnly'},{actor:null},{canImportMedia:false}])expect(()=>parseSharedContext({...context,...patch})).toThrow();
 expect(()=>parseCollaborationStatus({...status(o),...context},o.store.snapshot.document)).toThrow();o.lifecycle.dispose();
});

it('hiding primary and comparison clears the selected hidden region and uses a visible fallback',()=>{
 const active=owner(),doc=active.store.snapshot.document,id=doc.media[0].id,second='33333333-3333-4333-8333-333333333333',third='44444444-4444-4444-8444-444444444444';doc.media.push({...doc.media[0],id:second},{...doc.media[0],id:third});doc.viewState.activeMediaId=id;doc.viewState.compareMediaId=second;
 const hook=renderHook(({hidden})=>{const workspace=useWorkspace(active,hidden);const selection=useSelection(active,workspace.state.activeMediaId,[workspace.state.activeMediaId,workspace.state.compareMediaId].filter((id):id is string=>!!id).map(mediaId=>({mediaId,channels:[0,1]})));return{workspace,selection};},{initialProps:{hidden:[] as string[]}});
 act(()=>hook.result.current.selection.selectObject('annotation',doc.annotations[0].id));expect(hook.result.current.selection.selection).not.toBeNull();hook.rerender({hidden:[id,second]});expect(hook.result.current.workspace.state).toMatchObject({activeMediaId:third,compareMediaId:null});expect(hook.result.current.workspace.visibleMedia.map(m=>m.id)).toEqual([third]);expect(hook.result.current.selection.selection).toBeNull();expect(doc.media).toHaveLength(3);hook.unmount();active.lifecycle.dispose();
});
