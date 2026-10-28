import { useSyncExternalStore } from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import fixture from '../../../tests/fixtures/document-v3.json';
import { parseProjectDocument } from '../../bridge/types';
import { ProjectStore } from '../../app/store';
import type { ActiveProject } from '../project/useProjectLifecycle';
import type { AuthorSnapshot } from '../../bridge/collaboration';
import { CollaborationController } from './controller';
import { CollaborationContext, type CollaborationUI } from './useCollaboration';
import { RemoteList } from './RemoteInspector';
import { authorsForInspector, foreignAuthors } from './remote';
import { AnnotationList } from '../annotations/AnnotationList';
import { CategoryManager } from '../annotations/CategoryManager';
import { AuthorFilter } from './AuthorFilter';

const alice = '11111111-1111-4111-8111-111111111111';
const bob = '22222222-2222-4222-8222-222222222222';
const carol = '33333333-3333-4333-8333-333333333333';
function setup() {
 const doc = parseProjectDocument(structuredClone(fixture)), category = doc.categories[0];
 category.name = ' Bird ';
 doc.categories.push({ ...category, id: 'other', name: 'Noise' });
 doc.annotations[0].categoryIds = [category.id, 'other'];
 doc.annotations.push({ ...structuredClone(doc.annotations[0]), id: 'unclassified', categoryIds: [], note: 'unclassified' });
 doc.media[0].categoryIds = [category.id]; doc.media[0].channelCategoryIds[0] = ['other', category.id];
 const store = new ProjectStore({ document: doc as never, canUndo: true, canRedo: false });
 const identity = (authorId: string, displayName: string) => ({ authorId, displayName, createdAt: '2026-10-23T00:00:00Z' });
 const active = { store, queue: { enqueue: vi.fn() }, lifecycle: { save: vi.fn(), enqueueEdit: vi.fn() }, collaboration: { runtimeNonce: 'runtime', actor: identity(alice, 'Alice') } } as unknown as ActiveProject;
 const foreign: AuthorSnapshot = { identity: identity(bob, 'Bob'), error: null, layer: { payload: { categories: [{ ...category, id: 'foreign-bird', name: 'Bird' }, { ...category, id: 'foreign-noise', name: 'Noise' }], annotations: doc.annotations.map(a => ({ ...structuredClone(a), categoryIds: a.categoryIds.length ? ['foreign-noise', 'foreign-bird'] : [] })), mediaLabels: [{ mediaId: doc.media[0].id, categoryIds: ['foreign-bird'], channelCategoryIds: [['foreign-noise', 'foreign-bird'], []], note: 'foreign file', channelNotes: ['foreign channel', ''] }] } } } as AuthorSnapshot;
 const controller = new CollaborationController(active); controller.status = { snapshot: { authors: [foreign] } } as never;
 const ui = { active, controller } as CollaborationUI;
 return { active, controller, ui, foreign, doc };
}
afterEach(() => localStorage.clear());

it('enumerates unpublished self and hidden authors for controls, independently from visible frame authors', () => {
 const s = setup();
 s.controller.setFilter({ mode: 'custom', authorIds: [] });
 expect(authorsForInspector(s.ui).map(a => a.identity.authorId)).toEqual([alice, bob]);
 expect(foreignAuthors(s.ui)).toEqual([]);
});

it('uses one author filter for individual/bulk controls, explicit include-self and old modes without shared writes', () => {
 const s = setup(), snapshot = structuredClone(s.active.store.snapshot), layers = JSON.stringify(s.controller.status);
 function Controls() { useSyncExternalStore(s.controller.subscribe, s.controller.getVersion); return <RemoteList ui={s.ui} inspect={vi.fn()}/>; }
 render(<Controls/>);
 fireEvent.click(screen.getByRole('button', { name: '隐藏作者 Bob' }));
 expect(s.controller.visible(bob)).toBe(false); expect(s.controller.visible(alice)).toBe(true);
 expect(screen.getByRole('button', { name: '显示作者 Bob' })).toBeVisible();
 expect(screen.getByRole('radio', { name: '勾选作者' })).toBeChecked();
 fireEvent.click(screen.getByRole('button', { name: '显示作者 Bob' }));
 expect(s.controller.visible(bob)).toBe(true);
 fireEvent.click(screen.getByRole('button', { name: '隐藏全部作者' }));
 expect(s.controller.visible(alice)).toBe(true); expect(s.controller.visible(bob)).toBe(false);
 fireEvent.click(screen.getByRole('checkbox', { name: '批量操作包括我' }));
 fireEvent.click(screen.getByRole('button', { name: '隐藏全部作者' }));
 expect(s.controller.visible(alice)).toBe(false);
 expect(screen.getByRole('button', { name: /Alice.*我/ })).toBeVisible();
 fireEvent.click(screen.getByRole('checkbox', { name: '批量操作包括我' }));
 fireEvent.click(screen.getByRole('button', { name: '显示全部作者' }));
 expect(s.controller.visible(alice)).toBe(false); expect(s.controller.visible(bob)).toBe(true);
 fireEvent.click(screen.getByRole('button', { name: '显示作者 Alice' }));
 expect(s.controller.visible(alice)).toBe(true);
 fireEvent.click(screen.getByRole('checkbox', { name: '批量操作包括我' }));
 fireEvent.click(screen.getByRole('button', { name: '显示全部作者' }));
 expect(s.controller.visible(alice)).toBe(true); expect(s.controller.visible(bob)).toBe(true);
 expect(screen.getByRole('radio', { name: '全部' })).toBeChecked();
 fireEvent.click(screen.getByRole('radio', { name: '仅我的' }));
 expect(s.controller.visible(bob)).toBe(false);
 fireEvent.click(screen.getByRole('button', { name: '显示作者 Bob' }));
 expect(s.controller.visible(bob)).toBe(true);
 expect(s.active.store.snapshot).toEqual(snapshot); expect(JSON.stringify(s.controller.status)).toBe(layers);
 expect(s.active.queue.enqueue).not.toHaveBeenCalled(); expect(s.active.lifecycle.save).not.toHaveBeenCalled(); expect(s.active.lifecycle.enqueueEdit).not.toHaveBeenCalled();
});

it('keeps category control groups across hidden authors, groups exact trimmed names and filters region/file/channel any-match results', () => {
 const s = setup(), command = vi.fn();
 s.foreign.layer!.payload.categories.push({ id: 'only-foreign', name: 'Foreign only', color: '#123456' });
 function Contents() { useSyncExternalStore(s.controller.subscribe, s.controller.getVersion); return <CollaborationContext.Provider value={s.ui}><CategoryManager ui={{ active: s.active, command } as never}/><RemoteList ui={s.ui} inspect={vi.fn()}/><AnnotationList doc={s.active.store.snapshot.document} selectedId={null} onLocate={vi.fn()}/></CollaborationContext.Provider>; }
 const rendered = render(<Contents/>), before = JSON.stringify(s.active.store.snapshot.document);
 const control = screen.getByRole('group', { name: '类别显示' });
 expect(within(control).getAllByRole('button', { name: '隐藏类别 Bird' })).toHaveLength(1);
 fireEvent.click(within(control).getByRole('button', { name: '隐藏类别 Bird' }));
 expect(rendered.container.querySelector('[data-remote-author="'+bob+'"] .remote-list-entry')).toBeNull();
 expect(rendered.container.querySelectorAll('.annotation-row').length).toBeGreaterThan(1);
 expect(s.controller.contentVisible(bob, s.foreign.layer!.payload.categories, ['foreign-noise','foreign-bird'])).toBe(false);
 expect(s.controller.contentVisible(bob, s.foreign.layer!.payload.categories, [])).toBe(true);
 fireEvent.click(within(control).getByRole('checkbox', { name: '类别过滤包括我的标注' }));
 expect(rendered.container.querySelectorAll('.annotation-row')).toHaveLength(2); // unclassified channel + unclassified region
 expect(rendered.container.querySelector('[data-remote-author="'+alice+'"] .remote-list-entry')).toBeNull();
 act(() => s.controller.setFilter({ mode: 'custom', authorIds: [] }));
 expect(within(control).getByRole('button', { name: '显示类别 Bird' })).toBeVisible();
 expect(within(control).getByRole('button', { name: '隐藏类别 Foreign only' })).toBeVisible();
 expect(rendered.container.querySelectorAll('.annotation-row')).toHaveLength(0);
 fireEvent.click(within(control).getByRole('button', { name: '显示类别 Bird' }));
 expect(JSON.stringify(s.active.store.snapshot.document)).toBe(before); expect(command).not.toHaveBeenCalled();
});

it('persists per project/actor and replacement runtime, keeps custom newcomers hidden and all newcomers visible', () => {
 const s = setup();
 s.controller.setAuthorVisible(bob, false);
 s.controller.setCategoryVisible(' Bird ', false);
 s.controller.setIncludeOwnCategories(true);
 const replacement = { ...s.active, collaboration: { ...s.active.collaboration!, runtimeNonce: 'replacement' } };
 const loaded = new CollaborationController(replacement);
 expect(loaded.visible(bob)).toBe(false); expect(loaded.visible(alice)).toBe(true); expect(loaded.visible(carol)).toBe(false);
 expect(loaded.contentVisible(alice, s.doc.categories, s.doc.annotations[0].categoryIds)).toBe(false);
 const otherActor = new CollaborationController({ ...replacement, collaboration: { ...replacement.collaboration!, actor: { ...replacement.collaboration!.actor!, authorId: carol } } });
 expect(otherActor.visible(bob)).toBe(true); expect(otherActor.contentVisible(carol, s.doc.categories, s.doc.annotations[0].categoryIds)).toBe(true);
 const otherStore = new ProjectStore({ ...s.active.store.snapshot, document: { ...s.active.store.snapshot.document, projectId: carol } });
 expect(new CollaborationController({ ...replacement, store: otherStore }).visible(bob)).toBe(true);
 loaded.setFilter({ mode: 'all' }); expect(loaded.visible(carol)).toBe(true);
});

it('keeps legacy custom checkboxes coherent with the same author visibility, including unpublished self', () => {
 const s = setup();
 function Controls() { useSyncExternalStore(s.controller.subscribe, s.controller.getVersion); return <AuthorFilter controller={s.controller}/>; }
 render(<Controls/>);
 fireEvent.click(screen.getByRole('radio', { name: '勾选作者' }));
 const self = screen.getByRole('checkbox', { name: 'Alice（我）' }), foreign = screen.getByRole('checkbox', { name: 'Bob' });
 expect(self).toBeChecked(); expect(foreign).toBeChecked();
 fireEvent.click(self); expect(s.controller.visible(alice)).toBe(false);
 fireEvent.click(foreign); expect(s.controller.visible(bob)).toBe(false);
 fireEvent.click(screen.getByRole('radio', { name: '全部' }));
 expect(s.controller.visible(alice)).toBe(true); expect(s.controller.visible(carol)).toBe(true);
});
