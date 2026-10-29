import { expect, it, vi } from 'vitest';
import fixture from '../../tests/fixtures/document-v3.json';
import { parseProjectDocument, parseProjectSnapshot, type Change, type ProjectSnapshot } from '../bridge/types';
import { ProjectStore } from './store';
import { CommandQueue } from './commands';
import { ProjectLifecycle } from '../features/project/lifecycle';
import { AnnotationDrafts } from '../features/annotations/drafts';
const base = (): ProjectSnapshot => ({ document: parseProjectDocument(structuredClone(fixture)), canUndo: true, canRedo: false });
function setup() { const s = base(), a = s.document.media[0].id, b = '22222222-2222-4222-8222-222222222222'; s.document.media.push({ ...structuredClone(s.document.media[0]), id: b }); s.document.analysis[b] = structuredClone(s.document.analysis[a]); s.document.playbackMix[b] = structuredClone(s.document.playbackMix[a]); return { s, a, b }; }
function retirement(s: ProjectSnapshot, a: string, revision: number): ProjectSnapshot { const d = s.document; return parseProjectSnapshot({ ...s, document: { ...d, revision, media: d.media.filter(m => m.id !== a), annotations: d.annotations.filter(o => o.region.mediaId !== a), edits: d.edits.filter(o => o.region.mediaId !== a), analysis: Object.fromEntries(Object.entries(d.analysis).filter(([id]) => id !== a)), playbackMix: Object.fromEntries(Object.entries(d.playbackMix).filter(([id]) => id !== a)), viewState: { ...d.viewState, activeMediaId: null, compareMediaId: null, media: {} } } }); }
for (const kind of ['annotation', 'edit'] as const) {
    const targetChange = (s: ProjectSnapshot): Change => kind === 'annotation'
        ? { type: 'updateAnnotationNote', id: s.document.annotations[0].id, note: 'A', mergeKey: null }
        : { type: 'setEditEnabled', id: s.document.edits[0].id, enabled: false };
    it(`retains admitted ${kind} draft/failure identity across ordinary snapshot shrink until trusted retirement`, async () => {
        const { s, a, b } = setup(), store = new ProjectStore(s);
        const errorA = { code: 'InvalidInput', message: 'A failed', retryable: false };
        const errorB = { code: 'SaveFailed', message: 'B failed', retryable: true };
        const api = { applyChange: vi.fn().mockRejectedValueOnce(errorB).mockRejectedValueOnce(errorA), getSnapshot: vi.fn(), undo: vi.fn(), redo: vi.fn() };
        const queue = new CommandQueue(store, api), change = targetChange(s);
        const bDraft = JSON.stringify({ type: 'updateMediaNote', mediaId: b, note: a, mergeKey: null });
        store.setDraft('B', bDraft); store.setDraft('A', JSON.stringify(change));
        await expect(queue.enqueue(JSON.parse(bDraft), { draftKey: 'B' })).rejects.toEqual(errorB);
        await expect(queue.enqueue(change, { draftKey: 'A' })).rejects.toEqual(errorA);
        store.accept(retirement(s, a, 1));
        expect(store.drafts.has('A')).toBe(true); expect(queue.unresolvedFailures).toHaveLength(2);
        store.setDraft('A', JSON.stringify(kind === 'annotation' ? { ...change, note: 'A newer' } : { ...change, enabled: true }));
        store.retire([a], retirement(s, a, 1));
        expect(store.drafts.has('A')).toBe(false);
        expect(store.drafts.get('B')).toBe(bDraft);
        expect(queue.unresolvedFailures).toHaveLength(1);
        await expect(queue.flush()).rejects.toEqual(errorB);
    });
    it(`fences late ${kind} acknowledgement and queued targets after snapshot shrink, preserving newer B draft and callbacks`, async () => {
        const { s, a, b } = setup(), store = new ProjectStore(s);
        let resolve!: (value: ProjectSnapshot) => void;
        const flight = new Promise<ProjectSnapshot>(r => { resolve = r; });
        const api = { applyChange: vi.fn().mockReturnValueOnce(flight).mockResolvedValueOnce(retirement(s, a, 3)), getSnapshot: vi.fn(), undo: vi.fn(), redo: vi.fn() };
        const queue = new CommandQueue(store, api), callbackA = vi.fn(), queuedCallbackA = vi.fn(), callbackB = vi.fn();
        const change = targetChange(s); store.setDraft('shared', JSON.stringify(change));
        const pending = queue.enqueue(change, { draftKey: 'shared', onAccepted: callbackA });
        await Promise.resolve();
        const queued = queue.enqueue(change, { onAccepted: queuedCallbackA });
        const survivor: Change = { type: 'updateMediaNote', mediaId: b, note: 'new B', mergeKey: null };
        store.setDraft('shared', JSON.stringify(survivor));
        const bPending = queue.enqueue(survivor, { onAccepted: callbackB });
        store.accept(retirement(s, a, 2)); store.retire([a], retirement(s, a, 2));
        expect(store.drafts.get('shared')).toBe(JSON.stringify(survivor));
        resolve({ ...s, document: { ...s.document, revision: 1 } });
        await Promise.all([pending, queued, bPending]);
        expect(callbackA).not.toHaveBeenCalled(); expect(queuedCallbackA).not.toHaveBeenCalled();
        expect(callbackB).toHaveBeenCalledOnce(); expect(api.applyChange).toHaveBeenCalledTimes(2);
        expect(store.drafts.get('shared')).toBe(JSON.stringify(survivor));
        await expect(queue.flush()).resolves.toBeUndefined();
    });
    it(`clears only the ${kind} conflict cause after ordinary shrink while a conflict read is pending`, async () => {
        const { s, a } = setup(), store = new ProjectStore(s);
        let reject!: (error: unknown) => void;
        const refresh = new Promise<ProjectSnapshot>((_r, j) => { reject = j; });
        const api = { applyChange: vi.fn().mockRejectedValueOnce({ code: 'RevisionConflict', message: 'A conflict', retryable: true }).mockResolvedValueOnce(retirement(s, a, 3)), getSnapshot: vi.fn(() => refresh), undo: vi.fn(), redo: vi.fn() };
        const queue = new CommandQueue(store, api), callback = vi.fn();
        const pending = queue.enqueue(targetChange(s));
        await vi.waitFor(() => expect(api.getSnapshot).toHaveBeenCalledOnce());
        const global = queue.enqueue({ type: 'addCategory', category: { id: '33333333-3333-4333-8333-333333333333', name: 'global', color: '#aabbcc' } }, { onAccepted: callback });
        const outcomes = Promise.all([pending, global]);
        store.accept(retirement(s, a, 2)); store.retire([a], retirement(s, a, 2));
        reject({ code: 'SaveFailed', message: 'offline', retryable: true });
        await outcomes;
        expect(queue.needsRefresh).toBe(false); expect(queue.unresolvedFailures).toHaveLength(0);
        expect(callback).toHaveBeenCalledOnce(); await expect(queue.flush()).resolves.toBeUndefined();
    });
}
it('projects exact change identities, mixed view and preferences drafts and preserves survivor text containing A', () => {
    const { s, a, b } = setup(), store = new ProjectStore(s), annotation = s.document.annotations[0];
    store.setDraft('arbitrary-a', JSON.stringify({ type: 'updateAnnotationNote', id: annotation.id, note: 'x', mergeKey: null }));
    store.setDraft('arbitrary-b', JSON.stringify({ type: 'updateMediaNote', mediaId: b, note: a, mergeKey: null }));
    store.setDraft('view', JSON.stringify({ type: 'updateViewState', viewState: { ...s.document.viewState, activeMediaId: a, compareMediaId: b } }));
    store.setDraft('collaboration:playback-preferences', JSON.stringify({ mediaMonitorGainDb: { [a]: 1, [b]: 2 }, volume: .5 }));
    store.setDraft('spectrogram-view', JSON.stringify({ ...s.document.viewState, activeMediaId: a, compareMediaId: b }));
    store.retire([a], retirement(s, a, 1));
    expect(store.drafts.has('arbitrary-a')).toBe(false);
    expect(store.drafts.get('arbitrary-b')).toContain(a);
    expect(JSON.parse(store.drafts.get('view')!).viewState.compareMediaId).toBe(b);
    expect(JSON.parse(store.drafts.get('view')!).viewState.activeMediaId).toBeNull();
    expect(JSON.parse(store.drafts.get('collaboration:playback-preferences')!).mediaMonitorGainDb).toEqual({ [b]: 2 });
    expect(JSON.parse(store.drafts.get('spectrogram-view')!).activeMediaId).toBeNull();
    expect(JSON.parse(store.drafts.get('spectrogram-view')!).compareMediaId).toBe(b);
});
it('fences deferred retired A acknowledgement/callback and failure while queued B callback and failed B draft survive', async () => {
    const { s, a, b } = setup(), store = new ProjectStore(s);
    let resolve!: (s: ProjectSnapshot) => void;
    const flight = new Promise<ProjectSnapshot>(r => { resolve = r; });
    const callbackA = vi.fn(), callbackB = vi.fn();
    const api = { applyChange: vi.fn().mockImplementationOnce(() => flight).mockRejectedValueOnce({ code: 'SaveFailed', message: 'B failed', retryable: true }), getSnapshot: vi.fn(async () => s), undo: vi.fn(), redo: vi.fn() }, queue = new CommandQueue(store, api);
    const note = (mediaId: string) => ({ type: 'updateMediaNote' as const, mediaId, note: 'draft', mergeKey: null });
    store.setDraft('B', JSON.stringify(note(b)));
    const pa = queue.enqueue(note(a), { onAccepted: callbackA });
    await Promise.resolve();
    const pb = queue.enqueue(note(b), { draftKey: 'B', owner: 'annotations', onAccepted: callbackB });
    const failureB = pb.catch(e => e);
    store.retire([a], retirement(s, a, 2));
    resolve({ ...s, document: { ...s.document, revision: 1 } });
    await pa;
    await failureB;
    expect(store.snapshot.document.media.map(m => m.id)).toEqual([b]);
    expect(callbackA).not.toHaveBeenCalled();
    expect(queue.unresolvedFailures).toHaveLength(1);
    expect(store.drafts.has('B')).toBe(true);
    api.applyChange.mockResolvedValueOnce({ ...s, document: { ...s.document, revision: 3 } });
    await queue.retry(queue.unresolvedFailures[0].id);
    expect(callbackB).toHaveBeenCalledOnce();
    expect(store.snapshot.document.media.map(m => m.id)).toEqual([b]);
    await queue.refresh();
    expect(store.snapshot.document.media.map(m => m.id)).toEqual([b]);
});

for (const kind of ['annotation', 'edit'] as const) {
    const changeFor = (s: ProjectSnapshot): Change => kind === 'annotation'
        ? { type: 'updateAnnotationNote', id: s.document.annotations[0].id, note: 'initial', mergeKey: null }
        : { type: 'setEditEnabled', id: s.document.edits[0].id, enabled: false };
    it(`retires first ${kind} draft submission after shrink and continued typing, then drains real survivor submitters`, async () => {
        const { s, a, b } = setup(), store = new ProjectStore(s), failure = { code: 'InvalidInput', message: 'missing target', retryable: false };
        const api = { applyChange: vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(retirement(s, a, 2)), getSnapshot: vi.fn(), undo: vi.fn(), redo: vi.fn() };
        const queue = new CommandQueue(store, api), lifecycle = new ProjectLifecycle(store, queue, { save: async (_, revision) => revision, close: async () => {} });
        const drafts = new AnnotationDrafts({ store, queue, lifecycle, path: '' });
        try {
            const change = changeFor(s), survivor: Change = { type: 'updateMediaNote', mediaId: b, note: a, mergeKey: null };
            drafts.write('arbitrary', change); store.accept(retirement(s, a, 1));
            drafts.write('arbitrary', kind === 'annotation' ? { ...change, note: 'continued after shrink' } as Change : { ...change, enabled: true } as Change);
            drafts.write('B', survivor);
            drafts.write('global', { type: 'addCategory', category: { id: '33333333-3333-4333-8333-333333333333', name: a, color: '#aabbcc' } });
            await expect(drafts.submit('arbitrary')).rejects.toEqual(failure);
            expect(queue.unresolvedFailures).toHaveLength(1); expect(store.drafts.has('arbitrary')).toBe(true);
            store.retire([a], retirement(s, a, 1));
            expect(drafts.owns('arbitrary')).toBe(false); expect(store.drafts.get('B')).toBe(JSON.stringify(survivor));
            expect(queue.unresolvedFailures).toHaveLength(0);
            await lifecycle.submitDrafts(); await expect(queue.flush()).resolves.toBeUndefined();
            expect(api.applyChange.mock.calls.slice(1).map(call => call[2].type)).toEqual(['updateMediaNote', 'addCategory']);
        } finally { drafts.dispose(); lifecycle.dispose(); }
    });
    for (const outcome of ['ack', 'failure'] as const) it(`fences late ${outcome} and queued ${kind} callbacks first admitted from retained draft after shrink`, async () => {
        const { s, a, b } = setup(), store = new ProjectStore(s);
        let finish!: (value: ProjectSnapshot) => void, fail!: (error: unknown) => void;
        const flight = new Promise<ProjectSnapshot>((resolve, reject) => { finish = resolve; fail = reject; });
        const api = { applyChange: vi.fn().mockReturnValueOnce(flight).mockResolvedValue(retirement(s, a, 3)), getSnapshot: vi.fn(), undo: vi.fn(), redo: vi.fn() };
        const queue = new CommandQueue(store, api), lifecycle = new ProjectLifecycle(store, queue, { save: async (_, revision) => revision, close: async () => {} });
        const drafts = new AnnotationDrafts({ store, queue, lifecycle, path: '' }), callbackA = vi.fn(), callbackB = vi.fn(), callbackGlobal = vi.fn();
        try {
            const change = changeFor(s); drafts.write('shared', change); store.accept(retirement(s, a, 1));
            const submitted = drafts.submit('shared'); await vi.waitFor(() => expect(api.applyChange).toHaveBeenCalledOnce());
            const queued = queue.enqueue(change, { draftKey: 'shared', onAccepted: callbackA });
            const survivor: Change = { type: 'updateMediaNote', mediaId: b, note: 'new B', mergeKey: null };
            drafts.write('shared', survivor);
            const surviving = queue.enqueue(survivor, { onAccepted: callbackB });
            const global = queue.enqueue({ type: 'removeCategory', id: s.document.categories[0].id }, { onAccepted: callbackGlobal });
            const all = Promise.all([submitted, queued, surviving, global]);
            store.retire([a], retirement(s, a, 2));
            if (outcome === 'ack') finish(s); else fail({ code: 'InvalidInput', message: 'late missing A', retryable: false });
            await all;
            expect(callbackA).not.toHaveBeenCalled(); expect(callbackB).toHaveBeenCalledOnce(); expect(callbackGlobal).toHaveBeenCalledOnce();
            expect(api.applyChange).toHaveBeenCalledTimes(3); expect(queue.unresolvedFailures).toHaveLength(0);
            expect(store.drafts.get('shared')).toBe(JSON.stringify(survivor)); expect(drafts.owns('shared')).toBe(true);
            await expect(queue.flush()).resolves.toBeUndefined();
        } finally { drafts.dispose(); lifecycle.dispose(); }
    });
    it(`retires retained ${kind} first-admission conflict cause while its read is pending`, async () => {
        const { s, a } = setup(), store = new ProjectStore(s), change = changeFor(s);
        let reject!: (error: unknown) => void;
        const read = new Promise<ProjectSnapshot>((_resolve, fail) => { reject = fail; });
        const api = { applyChange: vi.fn().mockRejectedValueOnce({ code: 'RevisionConflict', message: 'missing A generation', retryable: true }).mockResolvedValue(retirement(s, a, 3)), getSnapshot: vi.fn(() => read), undo: vi.fn(), redo: vi.fn() };
        const queue = new CommandQueue(store, api), callback = vi.fn();
        store.setDraft('retained', JSON.stringify(change)); store.accept(retirement(s, a, 1));
        const pending = queue.enqueue(change, { draftKey: 'retained' });
        await vi.waitFor(() => expect(api.getSnapshot).toHaveBeenCalledOnce());
        const global = queue.enqueue({ type: 'removeCategory', id: s.document.categories[0].id }, { onAccepted: callback });
        const all = Promise.all([pending, global]); store.retire([a], retirement(s, a, 2));
        reject({ code: 'SaveFailed', message: 'offline', retryable: true }); await all;
        expect(queue.needsRefresh).toBe(false); expect(queue.unresolvedFailures).toHaveLength(0); expect(callback).toHaveBeenCalledOnce();
        await expect(queue.flush()).resolves.toBeUndefined();
    });
}
it.each(['different-value', 'different-operation', 'different-domain', 'reused-key', 'invalid-value', 'missing-key'] as const)('does not borrow retained ownership from a %s draft admission', async mismatch => {
    const { s, a, b } = setup(), store = new ProjectStore(s), id = s.document.annotations[0].id;
    const original: Change = { type: 'updateAnnotationNote', id, note: 'A', mergeKey: null };
    const error = { code: 'InvalidInput', message: 'unowned command failure', retryable: false };
    const api = { applyChange: vi.fn().mockRejectedValue(error), getSnapshot: vi.fn(), undo: vi.fn(), redo: vi.fn() }, queue = new CommandQueue(store, api);
    store.setDraft('arbitrary', JSON.stringify(original)); store.accept(retirement(s, a, 1));
    let command: Change = original;
    if (mismatch === 'different-value') command = { ...original, note: 'not current draft value' };
    if (mismatch === 'different-operation') command = { type: 'removeAnnotation', id };
    if (mismatch === 'different-domain') command = { type: 'setEditEnabled', id, enabled: true };
    if (mismatch === 'reused-key') store.setDraft('arbitrary', JSON.stringify({ type: 'updateMediaNote', mediaId: b, note: id, mergeKey: null }));
    if (mismatch === 'invalid-value') store.setDraft('arbitrary', JSON.stringify({ ...original, note: null }));
    await expect(queue.enqueue(command, mismatch === 'missing-key' ? {} : { draftKey: 'arbitrary' })).rejects.toEqual(error);
    store.retire([a], retirement(s, a, 1));
    expect(queue.unresolvedFailures).toHaveLength(1); await expect(queue.flush()).rejects.toEqual(error);
    if (mismatch === 'reused-key') expect(store.drafts.get('arbitrary')).toContain(b);
    expect(() => queue.enqueue({ ...original, note: null } as unknown as Change, { draftKey: 'arbitrary' })).toThrow();
});
