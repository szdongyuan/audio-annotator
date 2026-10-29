import { expect, it } from 'vitest';
import fixture from '../../../tests/fixtures/document-v3.json';
import { ProjectStore } from '../../app/store';
import type { ActiveProject } from '../project/useProjectLifecycle';
import { inspectionBinding, resolveOwnInspection } from './targets';
it('resolves live own region, file and channel data without a collaboration actor', () => {
 const owner = { store: new ProjectStore({ document: structuredClone(fixture) as never, canUndo: false, canRedo: false }) } as ActiveProject;
 const region = { owner, scope: 'region' as const, annotationId: fixture.annotations[0].id };
 expect(resolveOwnInspection(region)?.note).toBe('区域备注');
 expect(resolveOwnInspection({ owner, scope: 'file', mediaId: fixture.media[0].id })?.media.id).toBe(fixture.media[0].id);
 expect(resolveOwnInspection({ owner, scope: 'channel', mediaId: fixture.media[0].id, channelIndex: 99 })).toBeNull();
 owner.store.accept({ ...owner.store.snapshot, document: { ...owner.store.snapshot.document, annotations: [] } });
 expect(resolveOwnInspection(region)).toBeNull();
});
it('uses the bound runtime or legacy identity runtime, including read-only actor none', () => {
 const owner = { store: new ProjectStore({ document: structuredClone(fixture) as never, canUndo: false, canRedo: false }) } as ActiveProject;
 expect(inspectionBinding(owner, 'legacy')).toEqual({ runtimeNonce: 'legacy', projectId: fixture.projectId });
 expect(inspectionBinding(owner)).toBeNull();
 const shared = { ...owner, collaboration: { runtimeNonce: 'bound', actor: null } } as ActiveProject;
 expect(inspectionBinding(shared, 'legacy')?.runtimeNonce).toBe('bound');
});
