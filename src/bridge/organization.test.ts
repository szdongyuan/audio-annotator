import { expect, it, vi } from 'vitest';
const invoked = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke: invoked }));
import { createOrganizationClient, parseOrganizationSnapshot } from './organization';
const id = '11111111-1111-4111-8111-111111111111', folder = '22222222-2222-4222-8222-222222222222';
const snapshot = () => ({ runtimeNonce: id, projectId: id, organization: { kind: 'audio-annotator-organization', formatVersion: 1, projectId: id, revision: 1, layoutRevision: 1, folders: [{ id: folder, parentId: null, name: '目录' }], media: [{ mediaId: id, folderId: folder, originalFilename: 'CH2.wav' }] } });
it('strictly validates separate project/runtime organization snapshots and invariants', () => {
    expect(parseOrganizationSnapshot(snapshot())).toEqual(snapshot());
    for (const change of [(s: ReturnType<typeof snapshot>) => { delete (s.organization.folders[0] as Partial<typeof s.organization.folders[0]>).parentId; }, (s: ReturnType<typeof snapshot>) => { s.organization.folders[0].parentId = folder as never; }, (s: ReturnType<typeof snapshot>) => { s.organization.layoutRevision = 2; }, (s: ReturnType<typeof snapshot>) => { s.organization.media[0].originalFilename = '../x.wav'; }, (s: ReturnType<typeof snapshot>) => { s.organization.projectId = folder; }]) {
        const value = snapshot();
        change(value);
        expect(() => parseOrganizationSnapshot(value)).toThrow();
    }
    expect(() => parseOrganizationSnapshot({ ...snapshot(), document: {} })).toThrow();
});
it('binds requests and replies without private document revision and refuses forged owner replies', async () => {
    const client = createOrganizationClient(id);
    invoked.mockResolvedValue(snapshot());
    await client.get(id);
    expect(invoked).toHaveBeenCalledWith('organization_get', { binding: { runtimeNonce: id, projectId: id } });
    await client.apply(id, 1, { type: 'renameFolder', id: folder, name: 'renamed' });
    expect(invoked).toHaveBeenCalledWith('organization_apply', { binding: { runtimeNonce: id, projectId: id }, expectedRevision: 1, operation: { type: 'renameFolder', id: folder, name: 'renamed' } });
    invoked.mockResolvedValue({ ...snapshot(), runtimeNonce: folder });
    await expect(client.get(id)).rejects.toThrow();
    expect(() => client.apply(id, NaN, { type: 'removeFolder', id: folder })).toThrow();
});
