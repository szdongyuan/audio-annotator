import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { flushSync } from 'react-dom';
import fixture from '../../../tests/fixtures/document-v3.json';
import { parseProjectDocument, type Change } from '../../bridge/types';
import { ProjectStore } from '../../app/store';
import { CommandQueue } from '../../app/commands';
import { ProjectLifecycle } from '../project/lifecycle';
import { AnnotationOverlay } from '../annotations/AnnotationOverlay';
import { defaultView } from '../spectrogram/workspace';
import { SelectionContext, useSelection, type SelectionUI } from './useSelection';
import { useAnnotations } from '../annotations/useAnnotations';
import { useMasks } from '../playback/useMasks';
import { coordinates } from '../spectrogram/coordinates';
import { CollaborationContext, type CollaborationUI } from '../collaboration/useCollaboration';
import { RemoteContext } from '../collaboration/remote';
import { PlaybackContext } from '../playback/usePlayback';
function setup() {
  const doc = parseProjectDocument(structuredClone(fixture)), store = new ProjectStore({ document: doc, canUndo: true, canRedo: false });
  const applyChange = vi.fn(async (_id: string, revision: number, c: Change) => {
    const d = structuredClone(store.snapshot.document); d.revision = revision + 1;
    if (c.type === 'updateAnnotation') d.annotations = d.annotations.map(a => a.id === c.annotation.id ? c.annotation : a);
    if (c.type === 'removeAnnotation') d.annotations = d.annotations.filter(a => a.id !== c.id);
    if (c.type === 'addEdit') d.edits.push(c.edit);
    return { ...store.snapshot, document: d };
  });
  const queue = new CommandQueue(store, { applyChange, undo: async () => store.snapshot, redo: async () => store.snapshot, getSnapshot: async () => store.snapshot });
  const lifecycle = new ProjectLifecycle(store, queue, { save: async (_id, r) => r, close: async () => {} });
  return { active: { store, queue, lifecycle, path: '' }, applyChange, doc };
}
beforeEach(() => {
  vi.stubGlobal('PointerEvent', MouseEvent);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
});
function mounted(shared = false) {
  const s = setup(), media = s.doc.media[0]; let ui!: SelectionUI;
  const inspect=vi.fn(),setCue=vi.fn(),remote=structuredClone(s.doc.annotations[0]);
  const collaboration=shared?{active:s.active,controller:{owner:s.active,visible:()=>true,status:{snapshot:{authors:[{identity:{authorId:'bob',displayName:'Bob'},layer:{payload:{annotations:[remote],categories:s.doc.categories}},error:null}]}}}} as unknown as CollaborationUI:null;
  if(shared)Object.assign(s.active,{collaboration:{actor:null,runtimeNonce:'nonce'}});
  function Workspace() { ui = useSelection(s.active, media.id); useAnnotations(s.active, ui); useMasks(s.active, ui); return <PlaybackContext.Provider value={{setCue} as never}><CollaborationContext.Provider value={collaboration}><RemoteContext.Provider value={{inspect} as never}><SelectionContext.Provider value={ui}><AnnotationOverlay media={media} channel={1} view={defaultView(media)} /></SelectionContext.Provider></RemoteContext.Provider></CollaborationContext.Provider></PlaybackContext.Provider>; }
  const component = render(<Workspace />), surface = screen.getByLabelText('通道 2 标注图层');
  surface.setPointerCapture = vi.fn();
  vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue({ left: 100, top: 100, width: 800, height: 400 } as DOMRect);
  const pointer = (kind: 'pointerDown' | 'pointerMove' | 'pointerUp', x: number, y: number, target = surface) => fireEvent[kind](target, { button: 0, pointerId: 1, clientX: x, clientY: y });
  return { ...s, component, surface, pointer, inspect,setCue,remote,collaboration, refresh:()=>component.rerender(<Workspace/>), ui: () => ui, finish: () => { component.unmount(); s.active.lifecycle.dispose(); } };
}
it.each([false, true])('first blank gesture in another channel deactivates global selection (shared=%s)', shared => {
 const s=mounted(shared), selected={region:{...s.doc.annotations[0].region,channelIndex:0},object:null};
 act(()=>s.ui().state.select(selected));
 s.pointer('pointerDown',740,140);s.pointer('pointerUp',800,170);
 expect(s.ui().selection).toBeNull();expect(s.ui().candidate).toBeNull();expect(s.setCue).not.toHaveBeenCalled();
 expect(s.applyChange).not.toHaveBeenCalled();
 s.pointer('pointerDown',740,140);s.pointer('pointerUp',800,170);
 expect(s.ui().selection?.region.channelIndex).toBe(1);s.finish();
});
it('foreign click and context open qualified details without selecting or mutating; dragging still draws privately',()=>{
 const s=mounted(true);s.remote.region={...s.remote.region,startSeconds:1.2,endSeconds:1.7,lowHz:5000,highHz:10000};s.refresh();
 const c=coordinates(defaultView(s.doc.media[0]),s.doc.media[0].sampleRate/2,800,400),x=100+c.secondsToX(1.4),y=100+c.hzToY(7500);
 s.pointer('pointerDown',x,y);s.pointer('pointerUp',x,y);expect(s.inspect).toHaveBeenCalledWith({owner:s.active,authorId:'bob',scope:'region',annotationId:s.remote.id});expect(s.ui().selection).toBeNull();expect(s.applyChange).not.toHaveBeenCalled();
 fireEvent.contextMenu(s.surface,{clientX:x,clientY:y});expect(s.inspect).toHaveBeenCalledTimes(2);expect(s.ui().menu).toBeNull();
 s.pointer('pointerDown',x,y);s.pointer('pointerUp',x+30,y+20);expect(s.ui().selection?.object).toBeNull();expect(s.ui().selection?.region).toBeTruthy();expect(s.inspect).toHaveBeenCalledTimes(2);expect(s.applyChange).not.toHaveBeenCalled();s.finish();
});
it('own selected overlapping frame keeps drag/handle priority, and unselected own clicks win over foreign geometry',async()=>{
 const s=mounted(true),p=objectPoint(s);expect(document.querySelectorAll('[data-remote-key]')).toHaveLength(1);
 s.pointer('pointerDown',p.x,p.y);s.pointer('pointerUp',p.x,p.y);expect(s.ui().selection?.object?.id).toBe(s.doc.annotations[0].id);expect(s.inspect).not.toHaveBeenCalled();
 s.pointer('pointerDown',p.x,p.y);s.pointer('pointerUp',p.x+20,p.y);await waitFor(()=>expect(s.applyChange).toHaveBeenCalledOnce());expect(s.inspect).not.toHaveBeenCalled();expect(document.querySelectorAll('.region-handle')).toHaveLength(8);s.finish();
});
it('author filter hides own and foreign frames without clearing own selection or editable data',()=>{
 const s=mounted(true),p=objectPoint(s);s.pointer('pointerDown',p.x,p.y);s.pointer('pointerUp',p.x,p.y);const before=s.active.store.snapshot,selected=s.ui().selection;
 s.collaboration!.controller!.visible=()=>false;s.refresh();expect(document.querySelectorAll('[data-remote-key],[data-annotation-id]')).toHaveLength(0);expect(s.ui().selection).toBe(selected);expect(s.active.store.snapshot).toBe(before);s.finish();
});
function pendingAuthority(s: ReturnType<typeof mounted>, change: Change) {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const work = s.active.lifecycle.enqueueEdit(async () => { await gate; await s.active.queue.enqueue(change, { owner: 'annotations' }); });
  return () => act(async () => { release(); await work; });
}
function objectPoint(s: ReturnType<typeof mounted>, edge = false) {
  const r = s.doc.annotations[0].region, c = coordinates(defaultView(s.doc.media[0]), s.doc.media[0].sampleRate / 2, 800, 400);
  return { x: 100 + c.secondsToX(edge ? r.startSeconds : (r.startSeconds + r.endSeconds) / 2), y: 100 + c.hzToY((r.lowHz + r.highHz) / 2) };
}
it.each(['move', 'remove'] as const)('stationary release resolves a saved target after accepted %s completes between pointer down and up', async operation => {
  const s = mounted(), a = s.doc.annotations[0], p = objectPoint(s);
  act(() => s.ui().selectObject('annotation', a.id));
  const finish = pendingAuthority(s, operation === 'move' ? { type: 'updateAnnotation', annotation: { ...a, region: { ...a.region, lowHz: 200 } } } : { type: 'removeAnnotation', id: a.id });
  s.pointer('pointerDown', p.x, p.y); await finish(); s.pointer('pointerUp', p.x, p.y);
  if (operation === 'move') expect(s.ui().selection?.region.lowHz).toBe(200); else expect(s.ui().selection).toBeNull();
  expect(s.applyChange).toHaveBeenCalledOnce(); s.finish();
});
it('stationary release preserves a valid temporary snapshot through an unrelated authority update', async () => {
  const s = mounted(), a = s.doc.annotations[0], p = objectPoint(s), temporary = { region: { ...a.region }, object: null };
  act(() => s.ui().state.select(temporary));
  const finish = pendingAuthority(s, { type: 'updateAnnotation', annotation: { ...a, region: { ...a.region, lowHz: 200 } } });
  s.pointer('pointerDown', p.x, p.y); await finish(); s.pointer('pointerUp', p.x, p.y);
  expect(s.ui().selection).toBe(temporary); s.finish();
});
it.each([['move', 'held'], ['move', 'queued'], ['resize', 'held'], ['resize', 'queued']] as const)('%s cannot overwrite changed authoritative geometry while its gesture is %s', async (gesture, phase) => {
  const s = mounted(), a = s.doc.annotations[0], p = objectPoint(s, true);
  act(() => s.ui().selectObject('annotation', a.id));
  if (gesture === 'resize') p.x = 100 + coordinates(defaultView(s.doc.media[0]), s.doc.media[0].sampleRate / 2, 800, 400).secondsToX(a.region.endSeconds);
  const target = gesture === 'resize' ? document.querySelector<HTMLElement>('.annotation-rect.is-selected .handle-e')! : s.surface;
  const finish = pendingAuthority(s, { type: 'updateAnnotation', annotation: { ...a, region: { ...a.region, lowHz: 200 } } });
  s.pointer('pointerDown', p.x, p.y, target); s.pointer('pointerMove', p.x + 20, p.y);
  if (phase === 'held') await finish();
  s.pointer('pointerUp', p.x + 20, p.y);
  if (phase === 'queued') await finish();
  await act(async () => s.active.lifecycle.save());
  expect(s.ui().selection?.region.lowHz).toBe(200); expect(s.active.store.snapshot.document.annotations[0].region.lowHz).toBe(200);
  expect(s.applyChange).toHaveBeenCalledOnce(); s.finish();
});
it.each(['pointerCancel', 'lostPointerCapture'] as const)('%s restores latest authority after a pending update during a drag', async event => {
  const s = mounted(), a = s.doc.annotations[0], p = objectPoint(s, true);
  act(() => s.ui().selectObject('annotation', a.id));
  const finish = pendingAuthority(s, { type: 'updateAnnotation', annotation: { ...a, region: { ...a.region, lowHz: 200 } } });
  s.pointer('pointerDown', p.x, p.y); s.pointer('pointerMove', p.x + 20, p.y); await finish(); fireEvent[event](s.surface); s.pointer('pointerUp', p.x + 20, p.y);
  expect(s.ui().selection?.region.lowHz).toBe(200); expect(s.applyChange).toHaveBeenCalledOnce(); s.finish();
});
it.each(['move', 'resize'] as const)('%s release cannot restore or mutate a target removed while its command was pending', async gesture => {
  const s = mounted(), a = s.doc.annotations[0], p = objectPoint(s, true);
  act(() => s.ui().selectObject('annotation', a.id));
  if (gesture === 'resize') p.x = 100 + coordinates(defaultView(s.doc.media[0]), s.doc.media[0].sampleRate / 2, 800, 400).secondsToX(a.region.endSeconds);
  const target = gesture === 'resize' ? document.querySelector<HTMLElement>('.annotation-rect.is-selected .handle-e')! : s.surface;
  const finish = pendingAuthority(s, { type: 'removeAnnotation', id: a.id });
  s.pointer('pointerDown', p.x, p.y, target); s.pointer('pointerUp', p.x + 20, p.y); await finish();
  await act(async () => s.active.lifecycle.save());
  expect(s.ui().selection).toBeNull(); expect(s.active.store.snapshot.document.annotations).toHaveLength(0); expect(s.applyChange).toHaveBeenCalledOnce(); s.finish();
});
it('a new temporary draw validates its channel again when released after channel invalidation', () => {
  const s = mounted(); s.pointer('pointerDown', 700, 200); s.pointer('pointerMove', 800, 300);
  act(() => s.active.store.accept({ ...s.active.store.snapshot, document: { ...s.doc, revision: s.doc.revision + 1, media: s.doc.media.map(m => ({ ...m, channelCount: 1 })) } }));
  s.pointer('pointerUp', 800, 300);
  expect(s.ui().selection).toBeNull(); expect(s.applyChange).not.toHaveBeenCalled(); s.finish();
});
it('offset CSS drag creates only a temporary physical selection and Escape restores drag-start state', async () => {
  const s = mounted();
  s.pointer('pointerDown', 300, 200); s.pointer('pointerMove', 500, 300); s.pointer('pointerUp', 500, 300);
  expect(s.ui().selection).toMatchObject({ object: null, region: { startSeconds: .5, endSeconds: 1, channelIndex: 1 } });
  const before = s.ui().selection;
  s.pointer('pointerDown', 400, 250); s.pointer('pointerMove', 450, 270); expect(document.querySelector('.is-selected')).not.toBeNull();
  fireEvent.keyDown(window, { key: 'Escape' }); s.pointer('pointerUp', 800, 300);
  expect(s.ui().selection).toBe(before); expect(document.querySelector('.is-preview')).toBeNull();
  await s.active.lifecycle.save(); expect(s.applyChange).not.toHaveBeenCalled(); s.finish();
});
it('single click activates an object, interior and border move it once on release, handles resize it', async () => {
  const s = mounted(), a = s.doc.annotations[0];
  // Linear view in fixture: region .2–.8 seconds, 300–3000 Hz; use actual mapper.
  const { coordinates } = await import('../spectrogram/coordinates');
  const c = coordinates(defaultView(s.doc.media[0]), s.doc.media[0].sampleRate / 2, 800, 400);
  const x = 100 + c.secondsToX((a.region.startSeconds + a.region.endSeconds) / 2), y = 100 + c.hzToY((a.region.lowHz + a.region.highHz) / 2);
  s.pointer('pointerDown', x, y); s.pointer('pointerUp', x, y); expect(s.ui().selection?.object?.id).toBe(a.id);
  s.pointer('pointerDown', x, y); s.pointer('pointerMove', x + 20, y); expect(s.applyChange).not.toHaveBeenCalled(); s.pointer('pointerUp', x + 20, y);
  await waitFor(() => expect(s.applyChange).toHaveBeenCalledOnce()); expect(s.ui().selection?.object?.id).toBe(a.id);
  expect(s.active.store.snapshot.document.annotations[0].region.startSeconds).toBeCloseTo(a.region.startSeconds + .05);
  act(() => s.ui().selectObject('annotation', a.id));
  const edgeX = 100 + c.secondsToX(a.region.startSeconds + .05);
  s.pointer('pointerDown', edgeX, y); s.pointer('pointerUp', edgeX + 20, y);
  await waitFor(() => expect(s.applyChange).toHaveBeenCalledTimes(2));
  const moved = s.active.store.snapshot.document.annotations[0]; expect(moved.region.startSeconds).toBeCloseTo(a.region.startSeconds + .1);
  const handle = document.querySelector<HTMLElement>('.annotation-rect.is-selected .handle-e')!;
  const right = 100 + c.secondsToX(moved.region.endSeconds);
  s.pointer('pointerDown', right, y, handle); s.pointer('pointerUp', right + 20, y);
  await waitFor(() => expect(s.applyChange).toHaveBeenCalledTimes(3)); expect(s.active.store.snapshot.document.annotations[0].region.endSeconds).toBeCloseTo(moved.region.endSeconds + .05); s.finish();
});
it.each(['pointerCancel', 'lostPointerCapture'] as const)('%s discards a preview and cannot commit a late pointer-up', event => {
  const s = mounted(); s.pointer('pointerDown', 300, 200); s.pointer('pointerMove', 500, 300); fireEvent[event](s.surface); s.pointer('pointerUp', 500, 300);
  expect(s.ui().selection).toBeNull(); expect(s.applyChange).not.toHaveBeenCalled(); s.finish();
});
it('Alt-left and middle drags reach the pan surface without starting a selection', () => {
  const s = mounted();
  const bubble = vi.fn(); s.surface.parentElement!.addEventListener('pointerdown', bubble);
  fireEvent.pointerDown(s.surface, { button: 0, altKey: true, clientX: 300, clientY: 200 }); s.pointer('pointerMove', 500, 300); s.pointer('pointerUp', 500, 300);
  fireEvent.pointerDown(s.surface, { button: 1, clientX: 300, clientY: 200 }); s.pointer('pointerMove', 500, 300); s.pointer('pointerUp', 500, 300);
  expect(bubble).toHaveBeenCalledTimes(2); expect(s.ui().selection).toBeNull(); expect(s.applyChange).not.toHaveBeenCalled(); s.finish();
});
it('publishes the interacted channel even when a click creates no rectangle', () => {
  const s = mounted();
  s.pointer('pointerDown', 850, 120); s.pointer('pointerUp', 850, 120);
  expect(s.ui().selection).toBeNull(); expect(s.ui().context).toEqual({ mediaId: s.doc.media[0].id, channelIndex: 1 }); s.finish();
});
it('right click prioritizes the selected overlapping object and exposes all captured targets', async () => {
  const s = mounted(), a = s.doc.annotations[0];
  s.doc.edits = [{ ...s.doc.edits[0], region: a.region }];
  act(() => s.ui().selectObject('annotation', a.id));
  const { coordinates } = await import('../spectrogram/coordinates');
  const c = coordinates(defaultView(s.doc.media[0]), s.doc.media[0].sampleRate / 2, 800, 400);
  fireEvent.contextMenu(s.surface, { clientX: 100 + c.secondsToX((a.region.startSeconds + a.region.endSeconds) / 2), clientY: 100 + c.hzToY((a.region.lowHz + a.region.highHz) / 2) });
  expect(s.ui().menu?.target?.object?.id).toBe(a.id); expect(s.ui().menu?.overlaps.map(s => s.object?.kind)).toEqual(['annotation']); s.finish();
});
it('Delete masks the selection; text Escape/Delete do not act and later Escape clears only UI selection', async () => {
  const s = mounted(); s.pointer('pointerDown', 300, 200); s.pointer('pointerUp', 500, 300);
  const input = document.createElement('textarea'); document.body.append(input); fireEvent.keyDown(input, { key: 'Escape' }); fireEvent.keyDown(input, { key: 'Delete' });
  expect(s.ui().selection).not.toBeNull(); expect(s.applyChange).not.toHaveBeenCalled(); input.remove();
  fireEvent.keyDown(window, { key: 'Delete' }); await waitFor(() => expect(s.applyChange).toHaveBeenCalledOnce()); expect(s.ui().selection).toBeNull(); expect(s.ui().candidate).toBeNull();
  expect(s.doc.annotations).toHaveLength(1); fireEvent.keyDown(window, { key: 'Escape' }); fireEvent.keyDown(window, { key: 'Delete' });
  await s.active.lifecycle.save(); expect(s.applyChange).toHaveBeenCalledOnce(); expect(s.ui().selection).toBeNull(); s.finish();
});
it('Delete on a saved annotation removes only that annotation; a new temporary region still masks', async () => {
  const s=mounted(),p=objectPoint(s),id=s.doc.annotations[0].id,edits=structuredClone(s.doc.edits);
  s.pointer('pointerDown',p.x,p.y);s.pointer('pointerUp',p.x,p.y);
  expect(s.ui().selection?.object).toEqual({kind:'annotation',id});
  fireEvent.keyDown(window,{key:'Delete',repeat:true});expect(s.applyChange).not.toHaveBeenCalled();
  fireEvent.keyDown(window,{key:'Delete'});
  await waitFor(()=>expect(s.active.store.snapshot.document.annotations).toHaveLength(0));
  expect(s.active.store.snapshot.document.edits).toEqual(edits);expect(s.ui().selection).toBeNull();
  s.pointer('pointerDown',300,200);s.pointer('pointerUp',500,300);fireEvent.keyDown(window,{key:'Delete'});
  await waitFor(()=>expect(s.active.store.snapshot.document.edits).toHaveLength(edits.length+1));
  expect(s.active.store.snapshot.document.annotations).toHaveLength(0);s.finish();
});
it('one Escape listener remains correct even with synchronous React commits between native listeners', () => {
  const s = setup(), add = window.addEventListener.bind(window), remove = window.removeEventListener.bind(window), wrappers = new Map<EventListenerOrEventListenerObject, EventListener>();
  const addSpy = vi.spyOn(window, 'addEventListener').mockImplementation((type, listener, options) => { if (type === 'keydown' && typeof listener === 'function') { const wrapper: EventListener = e => flushSync(() => listener.call(window, e)); wrappers.set(listener, wrapper); add(type, wrapper, options); } else add(type, listener, options); });
  const removeSpy = vi.spyOn(window, 'removeEventListener').mockImplementation((type, listener, options) => remove(type, wrappers.get(listener) ?? listener, options));
  const hook = renderHook(() => { const selection = useSelection(s.active, s.doc.media[0].id); return { selection, masks: useMasks(s.active, selection), annotations: useAnnotations(s.active, selection) }; });
  try { act(() => hook.result.current.masks.select(s.doc.edits[0].id)); fireEvent.keyDown(window, { key: 'Escape' }); expect(hook.result.current.masks.selectedId).toBeNull(); expect(hook.result.current.annotations.selectedId).toBeNull(); }
  finally { hook.unmount(); addSpy.mockRestore(); removeSpy.mockRestore(); s.active.lifecycle.dispose(); }
});
it('clears for project identity/file changes while retaining an explicit newly located target', () => {
  const s = setup(), other = { ...s.doc.media[0], id: 'other' }; s.doc.media.push(other);
  const hook = renderHook(({ active, primary }) => useSelection(active, primary), { initialProps: { active: s.active, primary: s.doc.media[0].id } });
  act(() => hook.result.current.state.select({ region: { ...s.doc.annotations[0].region, mediaId: other.id }, object: null }));
  hook.rerender({ active: s.active, primary: other.id }); expect(hook.result.current.selection?.region.mediaId).toBe(other.id);
  expect(hook.result.current.state.context?.channelIndex).toBe(s.doc.annotations[0].region.channelIndex);
  hook.rerender({ active: s.active, primary: s.doc.media[0].id }); expect(hook.result.current.selection).toBeNull();
  act(() => hook.result.current.selectObject('annotation', s.doc.annotations[0].id));
  hook.rerender({ active: { ...s.active }, primary: s.doc.media[0].id }); expect(hook.result.current.selection).toBeNull(); hook.unmount(); s.active.lifecycle.dispose();
});
it('never renders a menu captured by an earlier runtime after same-project Save As', () => {
  const s = setup(), renders: boolean[] = [];
  const hook = renderHook(({ active }) => { const ui = useSelection(active, s.doc.media[0].id); renders.push(!!ui.menu); return ui; }, { initialProps: { active: s.active } });
  act(() => hook.result.current.openMenu({ x: 10, y: 10, target: null, overlaps: [], mediaId: s.doc.media[0].id, channelIndex: 0 }));
  expect(hook.result.current.menu).not.toBeNull(); renders.length = 0;
  hook.rerender({ active: { ...s.active } }); expect(renders.every(open => !open)).toBe(true); hook.unmount(); s.active.lifecycle.dispose();
});

it('first outside blank gesture clears temporary candidate; Delete is inert and next drag replaces', async () => {
  const s = mounted(); s.pointer('pointerDown', 300, 200); s.pointer('pointerUp', 500, 300);
  const first = s.ui().selection;
  s.pointer('pointerDown', 700, 150); s.pointer('pointerMove', 800, 250); s.pointer('pointerUp', 800, 250);
  expect(s.ui().selection).toBeNull(); expect(s.ui().state.getCandidate()).toBeNull();
  expect(document.querySelector('.is-temporary')).toBeNull(); expect(document.querySelector('.region-handle')).toBeNull();
  fireEvent.keyDown(window, { key: 'Delete' }); await s.active.lifecycle.save(); expect(s.applyChange).not.toHaveBeenCalled();
  s.pointer('pointerDown', 850, 120); s.pointer('pointerUp', 850, 120); expect(s.ui().selection).toBeNull();
  fireEvent.keyDown(window, { key: 'Escape' }); expect(s.ui().selection).toBeNull();
  s.pointer('pointerDown', 400, 250); s.pointer('pointerUp', 550, 320);
  expect(s.ui().selection?.object).toBeNull(); expect(s.ui().selection).not.toBe(first);
  expect(document.querySelectorAll('.is-temporary')).toHaveLength(1); s.finish();
});
it('clicking another saved object directly activates it while deactivation never disables a mask', () => {
  const s = mounted(), a = s.doc.annotations[0], edit = s.doc.edits[0], p = objectPoint(s);
  act(() => s.ui().selectObject('mask', edit.id));
  s.pointer('pointerDown', p.x, p.y); s.pointer('pointerUp', p.x, p.y);
  expect(s.ui().selection?.object?.id).toBe(a.id);
  act(() => s.ui().selectObject('mask', edit.id)); fireEvent.keyDown(window, { key: 'Escape' });
  expect(s.ui().selection).toBeNull(); expect(s.active.store.snapshot.document.edits[0].enabled).toBe(edit.enabled);
  expect(s.applyChange).not.toHaveBeenCalled(); s.finish();
});
it('nonplot buttons do not deactivate and an inactive candidate is cleared when its pane is replaced', () => {
  const s = setup(), media = s.doc.media[0];
  const hook = renderHook(({ panes }) => useSelection(s.active, media.id, panes), { initialProps: { panes: [{ mediaId: media.id, channels: [1] }] } });
  act(() => hook.result.current.state.select({ region: s.doc.annotations[0].region, object: null }));
  const button = document.createElement('button'); document.body.append(button); fireEvent.pointerDown(button); fireEvent.click(button); button.remove();
  expect(hook.result.current.selection).not.toBeNull();
  act(() => hook.result.current.state.deactivate()); hook.rerender({ panes: [] });
  expect(hook.result.current.state.getCandidate()).toBeNull(); hook.unmount(); s.active.lifecycle.dispose();
});

it('click reactivates the retained temporary outline even when it overlaps a saved annotation', () => {
  const s = mounted(), p = objectPoint(s), target = { region: s.doc.annotations[0].region, object: null };
  act(() => { s.ui().state.select(target); s.ui().state.deactivate(); });
  s.pointer('pointerDown', p.x, p.y); s.pointer('pointerUp', p.x, p.y);
  expect(s.ui().selection).toBe(target); s.finish();
});

it('a stale rendered active frame cannot begin a gesture after its target disappears from authority', () => {
  const s = mounted(), a = s.doc.annotations[0], p = objectPoint(s);
  act(() => s.ui().selectObject('annotation', a.id));
  // Model authority changing before the previously rendered pointer handler is replaced.
  s.active.store.snapshot.document.annotations = [];
  s.pointer('pointerDown', p.x, p.y);
  expect(s.ui().selection).toBeNull();
  s.pointer('pointerMove', p.x + 20, p.y); s.pointer('pointerUp', p.x + 20, p.y);
  expect(s.applyChange).not.toHaveBeenCalled(); s.finish();
});
it('one blank click clears temporary active and candidate and sets a precise cue; saved annotation survives',()=>{
 const s=mounted(),target={region:{...s.doc.annotations[0].region},object:null};
 act(()=>s.ui().state.select(target));s.pointer('pointerDown',850,120);s.pointer('pointerUp',850,120);
 expect(s.ui().selection).toBeNull();expect(s.ui().candidate).toBeNull();expect(document.querySelector('[data-temporary-selection]')).toBeNull();
 expect(s.setCue).toHaveBeenLastCalledWith(s.active,s.doc.media[0].id,1.875);
 act(()=>s.ui().selectObject('annotation',s.doc.annotations[0].id));s.pointer('pointerDown',850,120);s.pointer('pointerUp',850,120);
 expect(s.ui().selection).toBeNull();expect(s.active.store.snapshot.document.annotations).toHaveLength(1);expect(document.querySelector('[data-annotation-id]')).toBeTruthy();s.finish();
});
it('DSP edits have no persistent frames or overlap targets',()=>{
 const s=mounted();s.doc.edits[0].region=s.doc.annotations[0].region;s.refresh();expect(document.querySelector('[data-edit-id]')).toBeNull();
 const p=objectPoint(s);fireEvent.contextMenu(s.surface,{clientX:p.x,clientY:p.y});
 expect(s.ui().menu?.overlaps.every(o=>o.object?.kind==='annotation')).toBe(true);s.finish();
});
import { usePlayback, type PlaybackUI } from '../playback/usePlayback';
import { emptyPlayback, type PlaybackRequest } from '../../bridge/playback';
import { CueLine } from '../playback/CueLine';
it('real overlay plus playback replaces paused intent from a shared-channel cue and never interrupts a playing blank click',async()=>{
 const s=setup(),m=s.doc.media[0];s.doc.annotations=[];s.doc.edits=[];let ui!:SelectionUI,playback!:PlaybackUI,generation=0;
 const api={available:()=>true,devices:async()=>[],listen:async()=>()=>{},control:vi.fn(async(action:string)=>({...emptyPlayback,generation:++generation,state:action==='pause'?'paused' as const:'stopped' as const})),configure:vi.fn(async(q:PlaybackRequest)=>({...emptyPlayback,generation:++generation,projectId:q.projectId,mediaId:q.mediaId,state:'playing' as const}))};
 function App(){ui=useSelection(s.active,m.id);playback=usePlayback(s.active,m.id,ui.selection?.region,api);return <PlaybackContext.Provider value={playback}><SelectionContext.Provider value={ui}>{[0,1].map(channel=><div key={channel}><AnnotationOverlay media={m} channel={channel} view={defaultView(m)}/><CueLine mediaId={m.id} view={defaultView(m)}/></div>)}<button onClick={playback.toggle}>播放测试</button></SelectionContext.Provider></PlaybackContext.Provider>;}
 const view=render(<App/>),surface=screen.getByLabelText('通道 2 标注图层');surface.setPointerCapture=vi.fn();vi.spyOn(surface,'getBoundingClientRect').mockReturnValue({left:100,top:100,width:800,height:400} as DOMRect);
 const pointer=(kind:'pointerDown'|'pointerUp',x:number,y:number)=>fireEvent[kind](surface,{button:0,pointerId:1,clientX:x,clientY:y});
 pointer('pointerDown',300,200);pointer('pointerUp',500,300);fireEvent.click(screen.getByRole('button',{name:'播放测试'}));await waitFor(()=>expect(api.configure).toHaveBeenCalledOnce());
 const controls=api.control.mock.calls.length;pointer('pointerDown',850,120);pointer('pointerUp',850,120);await act(async()=>{});expect(playback.playing).toBe(true);expect(api.control).toHaveBeenCalledTimes(controls);expect(ui.selection).toBeNull();expect(ui.candidate).toBeNull();expect(document.querySelectorAll('.audio-cue')).toHaveLength(2);
 act(()=>playback.stop());await act(async()=>{});fireEvent.click(screen.getByRole('button',{name:'播放测试'}));await waitFor(()=>expect(api.configure).toHaveBeenCalledTimes(2));expect(api.configure.mock.calls[1][0]).toMatchObject({mediaId:m.id,seekSeconds:1.875,mode:{mode:'processed'}});
 fireEvent.click(screen.getByRole('button',{name:'播放测试'}));await act(async()=>{});pointer('pointerDown',700,120);pointer('pointerUp',700,120);fireEvent.click(screen.getByRole('button',{name:'播放测试'}));await waitFor(()=>expect(api.configure).toHaveBeenCalledTimes(3));expect(api.configure.mock.calls[2][0].seekSeconds).toBe(1.5);view.unmount();s.active.lifecycle.dispose();
});
it('explicit selection audition continues through a blank cue click, then pause/play starts the file at that new cue',async()=>{
 const s=setup(),m=s.doc.media[0];s.doc.annotations=[];s.doc.edits=[];let ui!:SelectionUI,playback!:PlaybackUI,generation=0;
 const api={available:()=>true,devices:async()=>[],listen:async()=>()=>{},control:vi.fn(async(action:string)=>({...emptyPlayback,generation:++generation,state:action==='pause'?'paused' as const:'stopped' as const})),configure:vi.fn(async(q:PlaybackRequest)=>({...emptyPlayback,generation:++generation,projectId:q.projectId,mediaId:q.mediaId,state:'playing' as const}))};
 function App(){ui=useSelection(s.active,m.id);playback=usePlayback(s.active,m.id,ui.selection?.region,api);return <PlaybackContext.Provider value={playback}><SelectionContext.Provider value={ui}><AnnotationOverlay media={m} channel={1} view={defaultView(m)}/><button onClick={()=>playback.playSelection(ui.selection!.region,'original')}>试听原始选区</button><button onClick={playback.toggle}>播放暂停</button></SelectionContext.Provider></PlaybackContext.Provider>;}
 const view=render(<App/>),surface=screen.getByLabelText('通道 2 标注图层');surface.setPointerCapture=vi.fn();vi.spyOn(surface,'getBoundingClientRect').mockReturnValue({left:100,top:100,width:800,height:400} as DOMRect);
 const pointer=(kind:'pointerDown'|'pointerUp',x:number,y:number)=>fireEvent[kind](surface,{button:0,pointerId:1,clientX:x,clientY:y});
 pointer('pointerDown',300,200);pointer('pointerUp',500,300);const region=ui.selection!.region;fireEvent.click(screen.getByRole('button',{name:'试听原始选区'}));await waitFor(()=>expect(api.configure).toHaveBeenCalledOnce());expect(api.configure.mock.calls[0][0]).toMatchObject({mediaId:m.id,mode:{mode:'selection',region,selectionSource:'original'}});
 const controls=api.control.mock.calls.length,stream=playback.status;pointer('pointerDown',850,120);pointer('pointerUp',850,120);await act(async()=>{});expect(ui.selection).toBeNull();expect(playback.playing).toBe(true);expect(playback.status).toBe(stream);expect(api.control).toHaveBeenCalledTimes(controls);expect(api.configure).toHaveBeenCalledOnce();expect(playback.sourceId).toBe(m.id);
 fireEvent.click(screen.getByRole('button',{name:'播放暂停'}));await waitFor(()=>expect(playback.status.state).toBe('paused'));expect(api.control).toHaveBeenLastCalledWith('pause');expect(api.configure).toHaveBeenCalledOnce();
 fireEvent.click(screen.getByRole('button',{name:'播放暂停'}));await waitFor(()=>expect(api.configure).toHaveBeenCalledTimes(2));expect(api.configure.mock.calls[1][0]).toMatchObject({mediaId:m.id,mode:{mode:'processed'},seekSeconds:1.875,play:true});expect(api.control).toHaveBeenLastCalledWith('stop');expect(api.control.mock.invocationCallOrder.at(-1)).toBeLessThan(api.configure.mock.invocationCallOrder.at(-1)!);view.unmount();s.active.lifecycle.dispose();
});
