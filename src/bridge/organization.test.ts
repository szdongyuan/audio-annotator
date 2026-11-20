import { expect, it, vi } from 'vitest';
const invoked = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke: invoked }));
import { createOrganizationClient, parseOrganizationOperation, parseOrganizationSnapshot, type OrganizationOperation } from './organization';
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

it('strictly validates the batch move wire contract', async () => {
    const batch: OrganizationOperation = { type: 'moveMediaBatch', mediaIds: [id, folder], folderId: null };
    expect(parseOrganizationOperation(batch)).toEqual(batch);
    expect(parseOrganizationOperation({ ...batch, folderId: folder })).toEqual({ ...batch, folderId: folder });
    const maxIds = Array.from({ length: 10000 }, (_, index) => `00000000-0000-4000-8000-${(index + 1).toString(16).padStart(12, '0')}`);
    expect(parseOrganizationOperation({ ...batch, mediaIds: maxIds })).toEqual({ ...batch, mediaIds: maxIds });
    const invalid = [
        { ...batch, mediaIds: [] },
        { ...batch, mediaIds: [id, id] },
        { ...batch, mediaIds: [id, 'bad'] },
        { ...batch, mediaIds: Array(1) },
        { ...batch, mediaIds: [id, '00000000-0000-0000-0000-000000000000'] },
        { ...batch, mediaIds: [...maxIds, '00000000-0000-4000-8000-000000002711'] },
        { ...batch, folderId: 'bad' },
        { type: batch.type, mediaIds: [id] },
        { ...batch, extra: true },
        { ...batch, mediaId: id },
        { ...batch, mediaIds: null },
    ];
    for (const operation of invalid) expect(() => parseOrganizationOperation(operation)).toThrow();
    invoked.mockResolvedValue(snapshot());
    await createOrganizationClient(id).apply(id, 1, batch);
    expect(invoked).toHaveBeenCalledWith('organization_apply', { binding: { runtimeNonce: id, projectId: id }, expectedRevision: 1, operation: batch });
});
it('preserves unknown write failures separately from definite native InvalidInput',async()=>{
 const client=createOrganizationClient(id),transport=new Error('connection lost'),native={code:'InvalidInput',message:'invalid target',retryable:false};
 invoked.mockRejectedValueOnce(transport);await expect(client.apply(id,1,{type:'moveMediaBatch',mediaIds:[id],folderId:null})).rejects.toBe(transport);
 invoked.mockRejectedValueOnce(native);await expect(client.apply(id,1,{type:'moveMediaBatch',mediaIds:[id],folderId:null})).rejects.toEqual(native);
});
