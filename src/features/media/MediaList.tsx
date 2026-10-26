import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { FileAudio2, ListMusic, Plus, Search, MoreHorizontal } from 'lucide-react';
import type { Annotation, Category, MediaDescriptor } from '../../bridge/types';
import type { MediaStatus } from '../../bridge/media';
import type { OrganizationOperation } from '../../bridge/organization';
import { Menu } from '../../components/menu/Menu';
import type { MenuItem } from '../../components/menu/menuModel';
import { organizationIndex, type OrganizationController, type OrganizationDraft } from './organization';
import { MediaDialog } from './MediaDialog';
export const statusLabel = { ready: '已校验', missing: '源文件缺失', changed: '源文件已改变', unverified: '等待校验' };
function StructuredName({ name }: {
    name: string;
}) { const parts = name.split('/'); if (parts.length < 2)
    return <>{name}</>; const filename = parts.pop()!; if (parts.at(-1)?.toLowerCase() === 'audio')
    parts.pop(); return <><span className="media-record-name">{parts.at(-1) ?? ''}</span><span className="media-file-name">{filename}</span></>; }
const noop = () => () => { }, zero = () => 0;
function FolderEdit({ controller: c, draft, trigger, resolveReturnFocus, onClose }: {
    controller: OrganizationController;
    draft: OrganizationDraft;
    trigger: HTMLElement | null;
    resolveReturnFocus: (previous: HTMLElement | null) => HTMLElement | null;
    onClose: () => void;
}) {
    useSyncExternalStore(c.subscribe, c.getVersion);
    const [operation, setOperation] = useState(draft.operation);
    const index = useMemo(() => organizationIndex(c.snapshot, new Set()), [c.snapshot]);
    const naming = operation.type === 'createFolder' || operation.type === 'renameFolder', removing = operation.type === 'removeFolder';
    const title = operation.type === 'createFolder' ? '新建文件夹' : operation.type === 'renameFolder' ? '重命名文件夹' : removing ? '删除空文件夹' : '移动到文件夹';
    const excluded = new Set<string>();
    if (operation.type === 'moveFolder') {
        const visit = (id: string) => { excluded.add(id); for (const child of index.children.get(id) ?? [])
            visit(child); };
        visit(operation.id);
    }
    const target = operation.type === 'moveFolder' ? operation.parentId : operation.type === 'moveMedia' ? operation.folderId : null;
    return <MediaDialog title={title} returnFocus={trigger} resolveReturnFocus={resolveReturnFocus} busy={c.pending} onClose={onClose}><header><h2>{title}</h2></header><div className="source-import-body">{naming && <label>文件夹名称<input aria-label="文件夹名称" maxLength={128} value={operation.name} onChange={e => setOperation({ ...operation, name: e.target.value })}/></label>}{!naming && !removing && <label>目标文件夹<select aria-label="移动目标文件夹" value={target ?? ''} onChange={e => setOperation(operation.type === 'moveFolder' ? { ...operation, parentId: e.target.value || null } : operation.type === 'moveMedia' ? { ...operation, folderId: e.target.value || null } : operation)}><option value="">全部音频</option>{[...index.paths].filter(([id]) => !excluded.has(id)).map(([id, path]) => <option key={id} value={id}>{path}</option>)}</select></label>}{removing && <p>仅可删除没有音频（包括隐藏音频）和子文件夹的目录。</p>}{c.error && <p role="alert">{c.error.message}{c.error.code === 'RevisionConflict' ? ' · 已刷新目录，保留输入，请核对后重试。' : ''}</p>}</div><footer className="dialog-actions"><button className="button" disabled={c.pending} onClick={onClose}>取消</button><button className="button button-accent" disabled={c.pending || (naming && !operation.name.trim())} onClick={() => { draft.operation = operation; void c.submit(draft).then(ok => { if (ok)
        onClose(); }); }}>{c.error?.code === 'RevisionConflict' ? '核对并重试' : '确认'}</button></footer></MediaDialog>;
}
export function MediaList({ organization: c, hiddenMediaIds = [], onHide, onRestore, categories = [], catalogLocked = false, media, annotations, statuses, selectedId, disabled, onSelect, onImport, onRelink }: {
    organization?: OrganizationController | null;
    hiddenMediaIds?: readonly string[];
    onHide?: (id: string) => void;
    onRestore?: (id: string) => void;
    catalogLocked?: boolean;
    categories?: Category[];
    media: MediaDescriptor[];
    annotations: Annotation[];
    statuses: MediaStatus[];
    selectedId: string | null;
    disabled: boolean;
    onSelect: (id: string) => void;
    onImport: () => void;
    onRelink: (media: MediaDescriptor) => void;
}) {
    useSyncExternalStore(c?.subscribe ?? noop, c?.getVersion ?? zero);
    const rootMenu = useRef<HTMLButtonElement>(null);
    const searchInput = useRef<HTMLInputElement>(null);
    const currentOrganization = useRef(c);
    currentOrganization.current = c;
    const latestMedia = useRef({ media, hiddenMediaIds });
    latestMedia.current = { media, hiddenMediaIds };
    const [search, setSearch] = useState(''), [expanded, setExpanded] = useState<Set<string>>(new Set());
    const [menuState, setMenu] = useState<{
        owner: OrganizationController | null;
        x: number;
        y: number;
        trigger: HTMLElement;
        folderId?: string | null;
        media?: MediaDescriptor;
    } | null>(null);
    const menu = menuState?.owner === (c ?? null) ? menuState : null;
    const [edit, setEdit] = useState<{
        owner: OrganizationController;
        draft: OrganizationDraft;
        trigger: HTMLElement | null;
    } | null>(null);
    useEffect(() => { setMenu(null); setEdit(null); setExpanded(new Set()); }, [c]);
    const index = useMemo(() => organizationIndex(c?.snapshot ?? null, new Set(media.map(m => m.id))), [c?.snapshot, media]);
    const hidden = useMemo(() => new Set(hiddenMediaIds), [hiddenMediaIds]), query = search.toLocaleLowerCase();
    const menuMedia = menu?.media ? media.find(m => m.id === menu.media!.id && !hidden.has(m.id)) : undefined;
    const menuFolder = menu?.folderId ? index.folders.get(menu.folderId) : undefined;
    const menuTargetExists = !!menu && (menu.media ? !!menuMedia : menu.folderId === null || !!menuFolder);
    useEffect(() => {
        if (menu && (!menuTargetExists || !menu.trigger.isConnected)) {
            setMenu(null);
            rootMenu.current?.focus();
        }
    }, [menu, menuTargetExists, c?.snapshot, media, hiddenMediaIds]);

    const statusMap = useMemo(() => new Map(statuses.map(s => [s.mediaId, s.status])), [statuses]);
    const categoryMap = useMemo(() => new Map(categories.map(v => [v.id, v.name])), [categories]);
    const annotationCounts = useMemo(() => { const result = new Map<string, number>(); for (const a of annotations)
        result.set(a.region.mediaId, (result.get(a.region.mediaId) ?? 0) + 1); return result; }, [annotations]);
    const selectedFolder = c?.selectedFolderId ?? null;
    const inScope = (id: string | null) => { if (!selectedFolder || query)
        return true; while (id !== null) {
        if (id === selectedFolder)
            return true;
        id = index.folders.get(id)?.parentId ?? null;
    } return false; };
    const matched = new Set<string>(), mediaByFolder = new Map<string | null, MediaDescriptor[]>();
    for (const m of media) {
        if (hidden.has(m.id))
            continue;
        const folder = c?.snapshot ? index.mediaFolder.get(m.id) ?? null : null;
        if (!inScope(folder))
            continue;
        if (query && !`${m.displayName}/${folder ? index.paths.get(folder) : ''}`.toLocaleLowerCase().includes(query))
            continue;
        const list = mediaByFolder.get(folder) ?? [];
        list.push(m);
        mediaByFolder.set(folder, list);
        let id = folder;
        while (id) {
            matched.add(id);
            id = index.folders.get(id)?.parentId ?? null;
        }
    }
    if (query)
        for (const [id, path] of index.paths)
            if (path.toLocaleLowerCase().includes(query)) {
                let ancestor: string | null = id;
                while (ancestor) {
                    matched.add(ancestor);
                    ancestor = index.folders.get(ancestor)?.parentId ?? null;
                }
            }
    const openMenu = (event: React.MouseEvent<HTMLElement> | React.KeyboardEvent<HTMLElement>, context: {
        folderId?: string | null;
        media?: MediaDescriptor;
    }) => { event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect(); setMenu({ owner: c ?? null, ...context, trigger: event.currentTarget, x: 'clientX' in event && event.type === 'contextmenu' ? event.clientX : rect.right, y: 'clientY' in event && event.type === 'contextmenu' ? event.clientY : rect.bottom }); };
    const retireMenu = () => { setMenu(null); rootMenu.current?.focus(); };
    const currentMedia = () => {
        const target = latestMedia.current.media.find(m => m.id === menu?.media?.id && !latestMedia.current.hiddenMediaIds.includes(m.id));
        if (!target) retireMenu();
        return target;
    };
    const currentFolder = () => {
        const target = c?.snapshot?.folders.find(f => f.id === menu?.folderId);
        if (!target) retireMenu();
        return target;
    };
    const canEdit = !!c?.writable && !disabled;
    const begin = (operation: OrganizationOperation, trigger?: HTMLElement | null) => {
        const head = c?.snapshot;
        if (!c || !head || !canEdit) return;
        const hasFolder = (id: string | null) => id === null || head.folders.some(f => f.id === id);
        const valid = operation.type === 'createFolder' ? hasFolder(operation.parentId)
            : operation.type === 'moveMedia' ? !!currentMedia() && head.media.some(m => m.mediaId === operation.mediaId) && hasFolder(operation.folderId)
            : hasFolder(operation.id) && (operation.type !== 'moveFolder' || hasFolder(operation.parentId));
        if (!valid) { retireMenu(); return; }
        setEdit({ owner: c, draft: c.beginEdit(operation), trigger: trigger?.isConnected ? trigger : rootMenu.current });
    };
    const items: MenuItem[] = menu?.media ? [
        { id: 'move-media', label: '移动到文件夹…', disabled: !canEdit || !menuTargetExists, action: trigger => { const target = currentMedia(); if (target) begin({ type: 'moveMedia', mediaId: target.id, folderId: c?.snapshot?.media.find(m => m.mediaId === target.id)?.folderId ?? null }, trigger); } },
        ...(onHide ? [{ id: 'hide', label: '从我的列表隐藏', disabled: disabled || !menuTargetExists, action: () => { const target = currentMedia(); if (target) onHide(target.id); } }] : []),
        { id: 'relink', label: '重新关联…', disabled: disabled || !menuTargetExists, action: () => { const target = currentMedia(); if (target) onRelink(target); } }
    ] : [
        { id: 'create', label: '新建子文件夹…', disabled: !canEdit || !menuTargetExists, action: trigger => begin({ type: 'createFolder', id: crypto.randomUUID(), parentId: menu?.folderId ?? null, name: '' }, trigger) },
        { id: 'rename', label: '重命名文件夹…', disabled: !canEdit || !menuFolder, action: trigger => { const target = currentFolder(); if (target) begin({ type: 'renameFolder', id: target.id, name: target.name }, trigger); } },
        { id: 'move', label: '移动文件夹…', disabled: !canEdit || !menuFolder, action: trigger => { const target = currentFolder(); if (target) begin({ type: 'moveFolder', id: target.id, parentId: target.parentId }, trigger); } },
        { id: 'remove', label: '删除空文件夹…', disabled: !canEdit || !menuFolder || (index.counts.get(menu?.folderId ?? null) ?? 0) > 0 || (index.children.get(menu?.folderId ?? null)?.length ?? 0) > 0, action: trigger => { const target = currentFolder(); if (target) begin({ type: 'removeFolder', id: target.id }, trigger); } }
    ];
    const card = (m: MediaDescriptor) => { const status = statusMap.get(m.id) ?? 'unverified'; const title = `${m.displayName}\n${m.channelCount} 通道 · ${(m.frameCount / m.sampleRate).toFixed(3)} 秒 · ${m.sampleRate / 1000} kHz\n${m.categoryIds.map(id => categoryMap.get(id)).filter(Boolean).join(' · ') || '未分类'} · ${annotationCounts.get(m.id) ?? 0} 个标注\n${statusLabel[status]}\n${JSON.stringify(m.sourceRef)}`; return <div key={m.id} className={`media-card ${selectedId === m.id ? 'is-selected' : ''}`} onContextMenu={e => openMenu(e, { media: m })}><button className="media-select" onKeyDown={e => { if (e.key === 'ContextMenu' || e.key === 'F10' && e.shiftKey) openMenu(e, { media: m }); }} onClick={() => onSelect(m.id)} aria-pressed={selectedId === m.id} title={title} aria-label={m.displayName}><FileAudio2 size={14}/><strong className={m.displayName.includes('/') ? 'media-display-name' : undefined}><StructuredName name={m.displayName}/></strong><span className={`media-row-status ${status}`} aria-label={statusLabel[status]} title={statusLabel[status]}>{status === 'ready' ? '✓' : status === 'unverified' ? '·' : '!'}</span></button></div>; };
    const renderFolder = (id: string, depth: number): React.ReactNode => { if (query && !matched.has(id))
        return null; const folder = index.folders.get(id)!, open = query ? matched.has(id) : expanded.has(id); return <div className="media-folder" key={id}><div className={`media-folder-row ${selectedFolder === id ? 'is-selected' : ''}`} style={{ paddingLeft: depth * 10 }}><button className="icon-button media-folder-disclosure" aria-label={`${open ? '折叠' : '展开'}文件夹 · ${folder.name}`} aria-expanded={open} onClick={() => setExpanded(old => { const next = new Set(old); if (next.has(id))
        next.delete(id);
    else
        next.add(id); return next; })}>{open ? '▾' : '▸'}</button><button className="media-folder-select" aria-pressed={selectedFolder === id} onClick={() => { c?.select(id); setExpanded(old => { const next = new Set(old); let parent: string | null = id; while (parent) {
        next.add(parent);
        parent = index.folders.get(parent)?.parentId ?? null;
    } return next; }); }} onContextMenu={e => openMenu(e, { folderId: id })} title={index.paths.get(id)}>{folder.name}<span className="count">{index.counts.get(id) ?? 0}</span></button><button className="icon-button" aria-label={`文件夹操作 · ${folder.name}`} onClick={e => openMenu(e, { folderId: id })}><MoreHorizontal size={14}/></button></div>{open && <div className="media-folder-content">{(index.children.get(id) ?? []).map(child => renderFolder(child, depth + 1))}{(mediaByFolder.get(id) ?? []).map(card)}</div>}</div>; };
    return <><div className="panel-heading"><h2><ListMusic size={16}/>音频文件<span className="count">{media.filter(m => !hidden.has(m.id)).length}</span></h2><button className="icon-button" aria-label="添加音频" onClick={onImport} disabled={disabled || catalogLocked}><Plus size={17}/></button></div><div className="media-filters"><label className="search-field"><Search size={15} aria-hidden="true"/><input ref={searchInput} aria-label="搜索音频" placeholder="搜索音频或目录…" value={search} onChange={e => setSearch(e.target.value)}/></label></div>{hiddenMediaIds.length > 0 && <details className="media-filters"><summary>显示隐藏音频（{hiddenMediaIds.length}）</summary>{media.filter(m => hidden.has(m.id)).map(m => <button className="button button-quiet" disabled={disabled} key={m.id} onClick={() => onRestore?.(m.id)} title={m.displayName}>恢复 · {m.displayName}</button>)}</details>}
 {c?.error && !edit && <div className="media-filters" role="alert">{c.error.message}<button className="button button-quiet" onClick={() => void c.refresh()}>刷新目录</button></div>}
 <div className="media-items">{c && <div className="media-folder-row"><button className="media-folder-select" aria-pressed={!selectedFolder} onClick={() => c.select(null)} onContextMenu={e => openMenu(e, { folderId: null })}>全部音频<span className="count">{index.counts.get(null) ?? media.length}</span></button><button ref={rootMenu} className="icon-button" aria-label="根目录操作" onClick={e => openMenu(e, { folderId: null })}><MoreHorizontal size={14}/></button></div>}{(index.children.get(null) ?? []).map(id => renderFolder(id, 0))}{(mediaByFolder.get(null) ?? []).map(card)}{!media.length && !index.folders.size && <div className="sidebar-empty"><FileAudio2 size={30}/><p>还没有音频文件</p></div>}{query && !mediaByFolder.size && !matched.size && <div className="sidebar-empty">没有匹配的音频</div>}</div>
 {menu && <Menu anchor={menu} returnFocus={menuTargetExists ? menu.trigger : rootMenu.current} onClose={() => setMenu(null)} items={items}/>}{edit && c && edit.owner === c && <FolderEdit controller={c} draft={edit.draft} trigger={edit.trigger} resolveReturnFocus={previous => currentOrganization.current === c && previous?.isConnected ? previous : currentOrganization.current && rootMenu.current?.isConnected ? rootMenu.current : searchInput.current} onClose={() => setEdit(current => current === edit ? null : current)}/>}</>;
}
