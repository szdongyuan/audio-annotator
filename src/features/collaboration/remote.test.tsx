import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import fixture from '../../../tests/fixtures/document-v2.json';
import { ProjectStore } from '../../app/store';
import type { ActiveProject } from '../project/useProjectLifecycle';
import type { AuthorSnapshot } from '../../bridge/collaboration';
import { CollaborationController } from './controller';
import type { CollaborationUI } from './useCollaboration';
import { foreignAuthors, resolveRemote, useRemoteInspection } from './remote';
import { RemoteAnnotations } from './RemoteAnnotations';
import { RemoteInspector, RemoteList } from './RemoteInspector';
import { defaultView } from '../spectrogram/workspace';
import { CommandQueue } from '../../app/commands';
import { ProjectLifecycle } from '../project/lifecycle';
import { useAnnotations } from '../annotations/useAnnotations';
import { NoteField } from '../annotations/NotesEditor';
import { usePlayback } from '../playback/usePlayback';
export function remoteFixture() {
 const store=new ProjectStore({document:structuredClone(fixture) as never,canUndo:true,canRedo:false});
 const identity=(id:string,name:string)=>({authorId:id,normalizedLogin:name,displayName:name,createdAt:'2026-10-23T00:00:00Z'});
 const alice=identity('alice','Alice'),bob=identity('bob','Bob');
 const active={store,collaboration:{runtimeNonce:'session',actor:alice,preferences:null}} as ActiveProject;
 const author=(who:typeof alice):AuthorSnapshot=>({identity:who,error:null,layer:{kind:'audio-annotator-author-layer',formatVersion:1,projectId:fixture.projectId,authorId:who.authorId,revision:1,parent:null,hash:'hash',payload:{categories:[{...store.snapshot.document.categories[0],name:who.displayName+' category'}],annotations:structuredClone(store.snapshot.document.annotations),mediaLabels:store.snapshot.document.media.map(m=>({mediaId:m.id,note:who.displayName+' file',channelNotes:Array(m.channelCount).fill(who.displayName+' channel'),categoryId:store.snapshot.document.categories[0].id,channelCategoryIds:Array(m.channelCount).fill(null)}))}}});
 const authors=[author(alice),author(bob)],controller=new CollaborationController(active);
 controller.status={snapshot:{projectId:fixture.projectId,authors}} as never;
 const ui={active,controller} as CollaborationUI;
 const target={owner:active,authorId:'bob',scope:'region' as const,annotationId:fixture.annotations[0].id};
 return{active,ui,controller,authors,target};
}
it('keeps identical author IDs/geometries separate, excludes the own published layer and filters only display',()=>{
 const s=remoteFixture(),snapshot=s.active.store.snapshot;
 expect(foreignAuthors(s.ui).map(a=>a.identity.displayName)).toEqual(['Bob']);
 s.controller.setFilter({mode:'mine'});expect(foreignAuthors(s.ui)).toEqual([]);expect(resolveRemote(s.ui,s.target)?.author.identity.displayName).toBe('Bob');
 s.controller.setFilter({mode:'custom',authorIds:['bob']});expect(foreignAuthors(s.ui)).toHaveLength(1);expect(s.active.store.snapshot).toBe(snapshot);
 const third=structuredClone(s.authors[1]);third.identity.authorId='third';third.identity.displayName='Carol';s.authors.push(third);s.controller.setFilter({mode:'all'});
 const {container}=render(<RemoteAnnotations authors={foreignAuthors(s.ui)} media={snapshot.document.media[0]} channel={1} view={defaultView(snapshot.document.media[0])}/>);
 expect(container.querySelectorAll('[data-remote-key]')).toHaveLength(2);expect(container.querySelectorAll('[data-handle],[data-annotation-id]')).toHaveLength(0);expect(container.textContent).toContain('Bob · Bob category');expect(container.textContent).toContain('Carol');
});
it('delayed actions re-resolve current author-qualified data and reject deletion and retired owners',()=>{
 const s=remoteFixture(),playSelection=vi.fn(),locate=vi.fn(),workspace={state:{activeMediaId:fixture.media[0].id,compareMediaId:null},locate,selectPane:vi.fn(),view:()=>({visibleChannels:[1]}),patch:vi.fn()} as never;
 const playback={playSelection} as never;
 const hook=renderHook(({ui})=>useRemoteInspection(ui,workspace,playback),{initialProps:{ui:s.ui}});
 act(()=>hook.result.current.inspect(s.target));const delayed=hook.result.current.play;
 s.authors[1].layer!.payload.annotations[0].region.lowHz=450;act(()=>delayed(s.target));expect(playSelection.mock.calls[0][0].lowHz).toBe(450);expect(playSelection.mock.calls[0]).toHaveLength(1);
 s.authors[1].layer!.payload.annotations=[];act(()=>delayed(s.target));expect(playSelection).toHaveBeenCalledTimes(1);
 s.authors[1].layer!.payload.annotations=structuredClone(fixture.annotations) as never;
 hook.rerender({ui:{...s.ui,active:{...s.active}}});act(()=>delayed(s.target));expect(playSelection).toHaveBeenCalledTimes(1);expect(hook.result.current.selected).toBeNull();
});
it('shows three levels per author, retained-layer errors, no-data and read-only details without mutation controls',()=>{
 const s=remoteFixture(),inspect=vi.fn();s.authors[1].error={code:'InvalidInput',message:'broken latest revision',retryable:true};
 const empty={identity:{...s.authors[1].identity,authorId:'empty',displayName:'Empty'},layer:null,error:null};s.authors.push(empty);
 const unavailable:AuthorSnapshot={...empty,identity:{...empty.identity,authorId:'unavailable',displayName:'Unavailable'},error:{code:'InvalidInput',message:'unreadable',retryable:true}};s.authors.push(unavailable);
 render(<RemoteList ui={s.ui} inspect={inspect}/>);expect(screen.getByText(/保留上次已验证/)).toBeTruthy();expect(screen.getByText('尚无共享标注')).toBeTruthy();expect(screen.getByText(/图层不可用/)).toBeTruthy();expect(screen.getByText(/Bob file/)).toBeTruthy();expect(screen.getAllByText(/Bob channel/)).toHaveLength(2);
 fireEvent.click(screen.getByRole('button',{name:/Bob category.*通道 2/}));expect(inspect.mock.calls[0][0]).toMatchObject({authorId:'bob',scope:'region'});
 const {container}=render(<RemoteInspector target={s.target} value={resolveRemote(s.ui,s.target)!} close={()=>{}} play={()=>{}} locate={()=>{}}/>);
 expect(container.querySelectorAll('input,textarea,select,[data-handle]')).toHaveLength(0);expect(container.textContent).toContain('只读');expect(screen.getByRole('button',{name:'播放此区域'})).toBeTruthy();expect(screen.queryByRole('button',{name:'删除标注'})).toBeNull();
});
it('traps dialog Tab/ShiftTab and destructive keys, then restores prior focus on dismissal',()=>{
 const s=remoteFixture(),background=document.createElement('button');document.body.append(background);background.focus();const shortcut=vi.fn();window.addEventListener('keydown',shortcut);
 const component=render(<RemoteInspector target={s.target} value={resolveRemote(s.ui,s.target)!} close={()=>{}} play={()=>{}} locate={()=>{}}/>);
 const dialog=screen.getByRole('dialog'),first=screen.getByRole('button',{name:'播放此区域'}),last=screen.getByRole('button',{name:'关闭只读详情'});
 expect(document.activeElement).toBe(dialog);fireEvent.keyDown(dialog,{key:'Tab'});expect(document.activeElement).toBe(first);
 last.focus();fireEvent.keyDown(last,{key:'Tab'});expect(document.activeElement).toBe(first);fireEvent.keyDown(first,{key:'Tab',shiftKey:true});expect(document.activeElement).toBe(last);
 fireEvent.keyDown(last,{key:'Delete'});fireEvent.keyDown(last,{key:'z',ctrlKey:true});expect(shortcut).not.toHaveBeenCalled();component.unmount();expect(document.activeElement).toBe(background);window.removeEventListener('keydown',shortcut);background.remove();
});
it('remote rerender preserves mounted unsaved note, own undo snapshot and personal playback source',()=>{
 const s=remoteFixture(),store=s.active.store,queue=new CommandQueue(store,{getSnapshot:async()=>store.snapshot,applyChange:vi.fn(),undo:vi.fn(),redo:vi.fn()});
 const lifecycle=new ProjectLifecycle(store,queue,{save:async(_id,r)=>r,close:async()=>{}});Object.assign(s.active,{queue,lifecycle});
 const api={available:()=>false,devices:async()=>[],listen:async()=>()=>{}} as never;
 function Editor(){const own=useAnnotations(s.active),playback=usePlayback(s.active,fixture.media[0].id,undefined,api);return <><NoteField ui={own} draftKey="own-note" label="Own note" note="before" change={note=>({type:'updateAnnotationNote',id:fixture.annotations[0].id,note,mergeKey:null})}/><button onClick={()=>playback.updateWorkspaceSource('original')}>Original</button><output>{playback.workspaceSource}</output><RemoteAnnotations authors={foreignAuthors(s.ui)} media={store.snapshot.document.media[0]} channel={1} view={defaultView(store.snapshot.document.media[0])}/></>;}
 const component=render(<Editor/>);fireEvent.click(screen.getByText('Original'));const field=screen.getByLabelText('Own note');fireEvent.change(field,{target:{value:'unsubmitted draft'}});const snapshot=store.snapshot,draft=store.drafts.get('own-note');
 s.authors[1].layer!.payload.annotations[0].note='remote newer';s.authors[1].layer!.payload.annotations[0].region.lowHz=450;component.rerender(<Editor/>);
 expect(screen.getByLabelText('Own note')).toBe(field);expect(field).toHaveValue('unsubmitted draft');expect(store.drafts.get('own-note')).toBe(draft);expect(store.snapshot).toBe(snapshot);expect(store.snapshot.canUndo).toBe(true);expect(screen.getByText('original')).toBeTruthy();component.unmount();lifecycle.dispose();
});
it('keeps focus inside read-only details when a remote deletion removes the focused action',()=>{
 const s=remoteFixture(),props={target:s.target,close:()=>{},play:()=>{},locate:()=>{}};
 const component=render(<RemoteInspector {...props} value={resolveRemote(s.ui,s.target)}/>);screen.getByRole('button',{name:'播放此区域'}).focus();component.rerender(<RemoteInspector {...props} value={null}/>);
 expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);component.unmount();
});
