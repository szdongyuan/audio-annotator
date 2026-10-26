import { invoke } from '@tauri-apps/api/core';
import { normalizeError } from './client';
export interface OrganizationFolder {
    id: string;
    parentId: string | null;
    name: string;
}
export interface OrganizationMembership {
    mediaId: string;
    folderId: string | null;
    originalFilename: string;
}
export interface Organization {
    kind: 'audio-annotator-organization';
    formatVersion: 1;
    projectId: string;
    revision: number;
    layoutRevision: number;
    folders: OrganizationFolder[];
    media: OrganizationMembership[];
}
export interface OrganizationSnapshot {
    runtimeNonce: string;
    projectId: string;
    organization: Organization;
}
export type OrganizationOperation = {
    type: 'createFolder';
    id: string;
    parentId: string | null;
    name: string;
} | {
    type: 'renameFolder';
    id: string;
    name: string;
} | {
    type: 'moveFolder';
    id: string;
    parentId: string | null;
} | {
    type: 'removeFolder';
    id: string;
} | {
    type: 'moveMedia';
    mediaId: string;
    folderId: string | null;
};
export function organizationCheck(v: unknown): asserts v { if (!v)
    throw new Error('无效的共享目录数据'); }
type Check = (v: unknown) => void;
export function organizationShape(v: unknown, fields: Record<string, Check>) { organizationCheck(v !== null && typeof v === 'object' && !Array.isArray(v)); const o = v as Record<string, unknown>; organizationCheck(Object.keys(o).length === Object.keys(fields).length); for (const [k, c] of Object.entries(fields)) {
    organizationCheck(Object.hasOwn(o, k));
    c(o[k]);
} }
export const organizationUuid: Check = v => organizationCheck(typeof v === 'string' && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(v) && v !== '00000000-0000-0000-0000-000000000000');
const integer: Check = v => organizationCheck(Number.isSafeInteger(v) && (v as number) >= 0);
const nullable = (f: Check): Check => v => { if (v !== null)
    f(v); };
export const organizationName = (folder: boolean): Check => v => { organizationCheck(typeof v === 'string' && v.length > 0 && [...v].length <= (folder ? 128 : 255) && new TextEncoder().encode(v).length <= (folder ? 512 : 1024) && !/[/\\\x00-\x1f\x7f-\x9f]/.test(v) && v !== '.' && v !== '..' && (!folder || v.trim() === v)); };
const array = (f: Check): Check => v => { organizationCheck(Array.isArray(v) && v.length <= 10000); v.forEach(f); };
export function parseOrganization(v: unknown): Organization {
    organizationShape(v, { kind: v => organizationCheck(v === 'audio-annotator-organization'), formatVersion: v => organizationCheck(v === 1), projectId: organizationUuid, revision: integer, layoutRevision: integer, folders: array(v => organizationShape(v, { id: organizationUuid, parentId: nullable(organizationUuid), name: organizationName(true) })), media: array(v => organizationShape(v, { mediaId: organizationUuid, folderId: nullable(organizationUuid), originalFilename: organizationName(false) })) });
    const head = v as Organization;
    organizationCheck(head.layoutRevision <= head.revision);
    const folders = new Map(head.folders.map(f => [f.id, f]));
    organizationCheck(folders.size === head.folders.length);
    const siblings = new Set<string>();
    for (const f of head.folders) {
        const key = JSON.stringify([f.parentId, f.name.toLowerCase()]);
        organizationCheck(!siblings.has(key));
        siblings.add(key);
        let parent: string | null = f.id, depth = 0;
        while (parent !== null) {
            organizationCheck(++depth <= 16);
            const node = folders.get(parent);
            organizationCheck(node);
            parent = node.parentId;
        }
    }
    const media = new Set<string>();
    for (const m of head.media) {
        organizationCheck(!media.has(m.mediaId) && (m.folderId === null || folders.has(m.folderId)));
        media.add(m.mediaId);
    }
    organizationCheck(new TextEncoder().encode(JSON.stringify(head)).length <= 16 * 1024 * 1024);
    return head;
}
export function parseOrganizationSnapshot(v: unknown): OrganizationSnapshot { organizationShape(v, { runtimeNonce: organizationUuid, projectId: organizationUuid, organization: parseOrganization }); const s = v as OrganizationSnapshot; organizationCheck(s.projectId === s.organization.projectId); return s; }
export function parseOrganizationOperation(v: unknown): OrganizationOperation { const type = (v as {
    type?: unknown;
})?.type; const exact = (value: string): Check => v => organizationCheck(v === value); switch (type) {
    case 'createFolder':
        organizationShape(v, { type: exact(type), id: organizationUuid, parentId: nullable(organizationUuid), name: organizationName(true) });
        break;
    case 'renameFolder':
        organizationShape(v, { type: exact(type), id: organizationUuid, name: organizationName(true) });
        break;
    case 'moveFolder':
        organizationShape(v, { type: exact(type), id: organizationUuid, parentId: nullable(organizationUuid) });
        break;
    case 'removeFolder':
        organizationShape(v, { type: exact(type), id: organizationUuid });
        break;
    case 'moveMedia':
        organizationShape(v, { type: exact(type), mediaId: organizationUuid, folderId: nullable(organizationUuid) });
        break;
    default: throw new Error('无效的共享目录操作');
} return v as OrganizationOperation; }
export function createOrganizationClient(runtimeNonce: string) { organizationUuid(runtimeNonce); const binding = (projectId: string) => { organizationUuid(projectId); return { runtimeNonce, projectId }; }; const call = async (name: string, args: Record<string, unknown>, projectId: string) => { try {
    const result = parseOrganizationSnapshot(await invoke(name, args));
    organizationCheck(result.runtimeNonce === runtimeNonce && result.projectId === projectId);
    return result;
}
catch (e) {
    throw normalizeError(e);
} }; return { get: (projectId: string) => call('organization_get', { binding: binding(projectId) }, projectId), apply: (projectId: string, expectedRevision: number, operation: OrganizationOperation) => { integer(expectedRevision); parseOrganizationOperation(operation); return call('organization_apply', { binding: binding(projectId), expectedRevision, operation }, projectId); } }; }
export type OrganizationCommands = ReturnType<typeof createOrganizationClient>;
