import { useMediaBatch, TriCheckbox, BatchActions, BatchConfirmation } from './MediaBatch';
import type { RecycleController } from './recycle';
import type { AuthorSnapshot } from '../../bridge/collaboration';
import { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { FileAudio2, ListMusic, Plus, Search, MoreHorizontal, ListChecks, SlidersHorizontal } from 'lucide-react';
import type { Annotation, Category, MediaDescriptor } from '../../bridge/types';
import type { MediaStatus } from '../../bridge/media';
import type { OrganizationOperation } from '../../bridge/organization';
import { Menu } from '../../components/menu/Menu';
import type { MenuItem } from '../../components/menu/menuModel';
import { folderRemoval, organizationIndex, type OrganizationController, type OrganizationDraft } from './organization';
import { MediaDialog } from './MediaDialog';
import { useMediaNavigation } from './useMediaNavigation';
import { useListDisplay } from './listDisplay';
import { PurgeDialog } from './PurgeDialog';
import type { PurgeSelection } from '../../bridge/purge';
import {MediaRow,statusLabel,type MediaRowActions} from './MediaRow';
export {statusLabel} from './MediaRow';
const noop = () => () => { }, zero = () => 0;
function FolderEdit({ controller: c, recycled, draft, trigger, resolveReturnFocus, onClose }: {
    controller: OrganizationController;
    recycled: ReadonlySet<string> | null;
    draft: OrganizationDraft;
    trigger: HTMLElement | null;
    resolveReturnFocus: (previous: HTMLElement | null) => HTMLElement | null;
    onClose: () => void;
}) {
    useSyncExternalStore(c.subscribe, c.getVersion);
    const [operation, setOperation] = useState(draft.operation);
    const index = useMemo(() => organizationIndex(c.snapshot, new Set()), [c.snapshot]);
    const naming = operation.type === 'createFolder' || operation.type === 'renameFolder', removing = operation.type === 'removeFolder';
    const title = operation.type === 'createFolder' ? '新建文件夹' : operation.type === 'renameFolder' ? '重命名文件夹' : removing ? '删除文件夹' : '移动到文件夹';
    const removal = removing ? folderRemoval(c.snapshot, operation.id, recycled) : null;
    const excluded = new Set<string>();
    if (operation.type === 'moveFolder') {
        const visit = (id: string) => { excluded.add(id); for (const child of index.children.get(id) ?? [])
            visit(child); };
        visit(operation.id);
    }
    const target = operation.type === 'moveFolder' ? operation.parentId : operation.type === 'moveMedia' ? operation.folderId : null;
    return <MediaDialog title={title} returnFocus={trigger} resolveReturnFocus={resolveReturnFocus} busy={c.pending} onClose={onClose}><header><h2>{title}</h2></header><div className="source-import-body">{naming && <label>文件夹名称<input aria-label="文件夹名称" maxLength={128} value={operation.name} onChange={e => setOperation({ ...operation, name: e.target.value })}/></label>}{!naming && !removing && <label>目标文件夹<select aria-label="移动目标文件夹" value={target ?? ''} onChange={e => setOperation(operation.type === 'moveFolder' ? { ...operation, parentId: e.target.value || null } : operation.type === 'moveMedia' ? { ...operation, folderId: e.target.value || null } : operation)}><option value="">全部音频</option>{[...index.paths].filter(([id]) => !excluded.has(id)).map(([id, path]) => <option key={id} value={id}>{path}</option>)}</select></label>}{removal && <><p>将删除此目录及其子目录，共 {removal.folderCount} 个文件夹。只移除目录记录，不会删除音频文件、原始文件名或标注数据。</p>{removal.trashed > 0 && <p>{removal.trashed} 个已在共享回收站的音频将保留在回收站，目录归属移至「{removal.parentPath}」，恢复后将在该目录显示。</p>}{removal.reason && <p role="alert">{removal.reason}{removal.blocked > 0 && recycled !== null ? `：${removal.blocked} 个未进入共享回收站的音频（包括隐藏或未加载的音频）。` : '，请刷新后核对。'}</p>}</>}{c.error && <p role="alert">{c.error.message}{c.error.code === 'RevisionConflict' ? ' · 已刷新目录，保留输入，请核对后重试。' : ''}</p>}</div><footer className="dialog-actions"><button className="button" disabled={c.pending} onClick={onClose}>取消</button><button className="button button-accent" disabled={c.pending || (naming && !operation.name.trim()) || !!removal && !removal.allowed} onClick={() => { draft.operation = operation; void c.submit(draft).then(ok => { if (ok)
        onClose(); }); }}>{c.error?.code === 'RevisionConflict' ? '核对并重试' : '确认'}</button></footer></MediaDialog>;
}
function MediaListBody({ projectId, actorId = null, recycle, authors = [], onHideBatch, organization: c, hiddenMediaIds = [], onHide, onRestore, categories = [], catalogLocked = false, navigationExcludedId = null, navigationScope = null, media, annotations, statuses, selectedId, disabled, navigationDisabled = disabled, onSelect, onImport, onRelink }: {
    renderAuthority?: object;
    projectId?: string;
    actorId?: string | null;
    recycle?: RecycleController | null;
    authors?: AuthorSnapshot[];
    onHideBatch?: (ids:string[],hidden:boolean)=>Promise<void>;
    organization?: OrganizationController | null;
    hiddenMediaIds?: readonly string[];
    onHide?: (id: string) => void;
    onRestore?: (id: string) => void;
    catalogLocked?: boolean;
    navigationExcludedId?: string | null;
    navigationScope?: object | null;
    categories?: Category[];
    media: MediaDescriptor[];
    annotations: Annotation[];
    statuses: MediaStatus[];
    selectedId: string | null;
    disabled: boolean;
    navigationDisabled?: boolean;
    onSelect: (id: string, intent?: 'random') => boolean | void;
    onImport: () => void;
    onRelink: (media: MediaDescriptor) => void;
}) {
    useSyncExternalStore(c?.subscribe ?? noop, c?.getVersion ?? zero);
    useSyncExternalStore(recycle?.subscribe ?? noop, recycle?.getVersion ?? zero);
    useSyncExternalStore(recycle?.purge.subscribe ?? noop, recycle?.purge.getVersion ?? zero);
    const currentRecycle = useRef(recycle);
    currentRecycle.current = recycle;
    const [purgeDialog, setPurgeDialog] = useState<{ owner: RecycleController; trigger: HTMLElement | null; all: boolean } | null>(null);
    const activePurge = purgeDialog?.owner === recycle ? purgeDialog : null;
    const rootMenu = useRef<HTMLButtonElement>(null);
    const listRoot = useRef<HTMLDivElement>(null);
    const searchInput = useRef<HTMLInputElement>(null);
    const currentOrganization = useRef(c);
    currentOrganization.current = c;
    const latestMedia = useRef({ media, hiddenMediaIds });
    latestMedia.current = { media, hiddenMediaIds };
    const [listView,setListView]=useState('normal'),[filters,setFilters]=useState(false),[classification,setClassification]=useState('all'),[tag,setTag]=useState(''),[wholeProject,setWholeProject]=useState(false);
    const [search, setSearch] = useState('');
    const [display, setDisplay] = useListDisplay(projectId ?? c?.projectId, actorId, c?.selectedFolderId ?? null);
    const flat = display.mode === 'flat', expanded = new Set(display.expanded);
    const setExpanded = (action: (old: Set<string>) => Set<string>) => setDisplay(old => ({ ...old, expanded: [...action(new Set(old.expanded))] }));
    const [copyMessage, setCopyMessage] = useState<{ text: string; failed: boolean } | null>(null);
    useEffect(() => { if (!copyMessage) return; const timer = setTimeout(() => setCopyMessage(null), 4000); return () => clearTimeout(timer); }, [copyMessage]);
    useEffect(() => setCopyMessage(null), [c]);
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
    useEffect(() => { setMenu(null); setEdit(null); }, [c]);
    const index = useMemo(() => organizationIndex(c?.snapshot ?? null, new Set(media.map(m => m.id))), [c?.snapshot, media]);
    const displayScope = display.scope && c?.snapshot && !index.folders.has(display.scope) ? null : display.scope;
    useEffect(() => {
        if (displayScope !== display.scope) setDisplay(old => ({ ...old, scope: displayScope }));
    }, [displayScope, display.scope]);
    const hidden = useMemo(() => new Set(hiddenMediaIds), [hiddenMediaIds]), query = search.toLocaleLowerCase();
    const trash=new Set(recycle?.snapshot?.trashed.map(m=>m.mediaId)??[]);
    const menuMedia = menu?.media ? media.find(m => m.id === menu.media!.id) : undefined;
    const menuFolder = menu?.folderId ? index.folders.get(menu.folderId) : undefined;
    const menuTargetExists = !!menu && (menu.media ? !!menuMedia : menu.folderId === null || !!menuFolder);
    useEffect(() => {
        if (menu && (!menuTargetExists || !menu.trigger.isConnected)) {
            setMenu(null);
            (rootMenu.current ?? searchInput.current)?.focus();
        }
    }, [menu, menuTargetExists, c?.snapshot, media, hiddenMediaIds]);

    const statusMap = useMemo(() => new Map(statuses.map(s => [s.mediaId, s.status])), [statuses]);
    const categoryMap = useMemo(() => new Map(categories.map(v => [v.id, v.name])), [categories]);
    const annotationCounts = useMemo(() => { const result = new Map<string, number>(); for (const a of annotations)
        result.set(a.region.mediaId, (result.get(a.region.mediaId) ?? 0) + 1); return result; }, [annotations]);
    const tagged=new Set(annotations.filter(a=>a.categoryIds.includes(tag)).map(a=>a.region.mediaId));
    const selectedFolder = c?.selectedFolderId ?? null;
    const scopeFolder = flat ? displayScope : selectedFolder;
    const inScope = (id: string | null) => { if (!scopeFolder || !flat && wholeProject)
        return true; while (id !== null) {
        if (id === scopeFolder)
            return true;
        id = index.folders.get(id)?.parentId ?? null;
    } return false; };
    const viewCounts = new Map<string | null, number>();
    const matched = new Set<string>(), mediaByFolder = new Map<string | null, MediaDescriptor[]>(), navigationByFolder = new Map<string | null, MediaDescriptor[]>();
    for (const m of media) {
        if (listView==='trash' ? !trash.has(m.id) : trash.has(m.id) || (listView==='hidden' ? !hidden.has(m.id) : hidden.has(m.id))) continue;
        let countFolder = c?.snapshot ? index.mediaFolder.get(m.id) ?? null : null;
        viewCounts.set(null, (viewCounts.get(null) ?? 0) + 1);
        while (countFolder) {
            viewCounts.set(countFolder, (viewCounts.get(countFolder) ?? 0) + 1);
            countFolder = index.folders.get(countFolder)?.parentId ?? null;
        }
        if(classification==='annotated' && !(annotationCounts.get(m.id)||m.categoryIds.length||m.channelCategoryIds.some(c=>c.length)))continue;
        if(classification==='unannotated' && (annotationCounts.get(m.id)||m.categoryIds.length||m.channelCategoryIds.some(c=>c.length)))continue;
        if(tag && !m.categoryIds.includes(tag) && !m.channelCategoryIds.some(c=>c.includes(tag)) && !tagged.has(m.id))continue;
        const folder = c?.snapshot ? index.mediaFolder.get(m.id) ?? null : null;
        if (query && !`${m.displayName}/${folder ? index.paths.get(folder) : ''}`.toLocaleLowerCase().includes(query))
            continue;
        // Browsing spans the tree; search and batch actions retain the selected-folder scope.
        const candidates = navigationByFolder.get(folder) ?? [];
        candidates.push(m);
        navigationByFolder.set(folder, candidates);
        if (!inScope(folder))
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
    const filteredIds:string[]=[];const visitFiltered=(folder:string|null)=>{for(const child of index.children.get(folder)??[])visitFiltered(child);for(const m of mediaByFolder.get(folder)??[])filteredIds.push(m.id);};visitFiltered(null);
    const batch=useMediaBatch(JSON.stringify([c?.runtimeNonce,actorId,search,scopeFolder,listView,classification,tag,flat ? false : wholeProject]),filteredIds,disabled,onHideBatch,recycle);
    const batchEntry = useRef<{ owner: OrganizationController; folder: string | null; mediaId: string } | null>(null);
    useEffect(() => {
        const entry = batchEntry.current;
        if (!entry) return;
        batchEntry.current = null;
        if (entry.owner === c && entry.folder === selectedFolder) batch.selectOne(entry.mediaId);
    }, [c, selectedFolder]);
    const selectForBatch = (mediaId: string, event?: React.MouseEvent<HTMLElement>) => {
        if (batch.busy) return;
        const folder = index.mediaFolder.get(mediaId) ?? null;
        if (c && !inScope(folder)) {
            // Apply the explicit row selection after the new folder's batch scope resets.
            batchEntry.current = { owner: c, folder, mediaId };
            batch.setMode(true);
            c.select(folder);
        } else if (event) batch.pick(mediaId, event);
        else batch.selectOne(mediaId);
    };
    const scopedRendering = flat || batch.mode || !!query || classification !== 'all' || !!tag;
    const displayedMediaByFolder = scopedRendering ? mediaByFolder : navigationByFolder;
    const inRenderedScope = (folder: string | null) => !scopedRendering || inScope(folder);

    const purge = recycle?.purge;
    const purgeBusy = batch.busy || !!purge?.pending;
    const unresolvedCommit = !!purge?.committed && !purge.result;
    const requestPurge = (selection: PurgeSelection, trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null) => {
        if (!recycle?.writable || !recycle.snapshot || purgeBusy || unresolvedCommit) return;
        setPurgeDialog({ owner: recycle, trigger, all: selection.kind === 'all' });
        void recycle.purge.begin(selection);
    };
    const closePurge = () => {
        if (!activePurge || activePurge.owner.purge.pending) return;
        activePurge.owner.purge.cancel();
        setPurgeDialog(null);
    };
    const refreshAfterPurge = () => {
        if (currentRecycle.current !== recycle || currentOrganization.current !== c) return;
        void recycle?.refresh(true);
        void c?.refresh(true);
    };
    const cleanupOperations = purge?.maintenance.items.filter(i => i.committed) ?? [];
    const currentPending = purge?.committed && purge.operationId && (!purge.result || purge.result.cleanupPendingCount > 0) ? purge.operationId : null;
    const cleanupOperationIds = [...new Set([...cleanupOperations.map(i => i.operationId), ...(currentPending ? [currentPending] : [])])];
    const descendants=new Map<string,string[]>();for(const mediaId of filteredIds){let parent=index.mediaFolder.get(mediaId);while(parent){const list=descendants.get(parent)??[];list.push(mediaId);descendants.set(parent,list);parent=index.folders.get(parent)?.parentId;}}
    const folderIds=(id:string)=>descendants.get(id)??[];
    const navigation: string[] = [];
    const visitNavigation = (folder: string | null) => { for (const child of index.children.get(folder) ?? []) visitNavigation(child); for (const m of navigationByFolder.get(folder) ?? []) if (m.id !== navigationExcludedId) navigation.push(m.id); };
    visitNavigation(null);
    const reveal = (id: string) => {
        if (flat) {
            if (!inScope(index.mediaFolder.get(id) ?? null)) setDisplay(old => ({ ...old, scope: null }));
        } else {
            if (!inRenderedScope(index.mediaFolder.get(id) ?? null)) c?.select(null);
            setExpanded(old => { const result = new Set(old); let folder = index.mediaFolder.get(id); while (folder) { result.add(folder); folder = index.folders.get(folder)?.parentId; } return result; });
        }
    };
    const navigationMessage = useMediaNavigation({ scope: navigationScope, navigationIds: navigation, randomIds: filteredIds.filter(id => id !== navigationExcludedId), selectedId,
        navigationDisabled: navigationDisabled || listView !== 'normal', media, annotations, statuses, onSelect, root: listRoot, reveal });
    const openMenu = (event: React.MouseEvent<HTMLElement> | React.KeyboardEvent<HTMLElement>, context: {
        folderId?: string | null;
        media?: MediaDescriptor;
    }) => { event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect(); setMenu({ owner: c ?? null, ...context, trigger: event.currentTarget, x: 'clientX' in event && event.type === 'contextmenu' ? event.clientX : rect.right, y: 'clientY' in event && event.type === 'contextmenu' ? event.clientY : rect.bottom }); };
    const retireMenu = () => { setMenu(null); (rootMenu.current ?? searchInput.current)?.focus(); };
    const currentMedia = () => {
        const target = latestMedia.current.media.find(m => m.id === menu?.media?.id);
        if (!target) retireMenu();
        return target;
    };
    const currentFolder = () => {
        const target = c?.snapshot?.folders.find(f => f.id === menu?.folderId);
        if (!target) retireMenu();
        return target;
    };
    const canEdit = !!c?.writable && !disabled;
    const removalRecycle = c && recycle?.projectId === c.projectId && recycle.runtimeNonce === c.runtimeNonce && recycle.snapshot?.projectId === c.projectId && !recycle.error && !recycle.pending ? trash : null;
    const removal = menuFolder ? folderRemoval(c?.snapshot ?? null, menuFolder.id, removalRecycle) : null;
    const removeReason = removal?.reason ?? '';
    const removeTitle = removal && removeReason ? `${removal.associated} 个关联音频，${removal.trashed} 个在共享回收站。${removalRecycle === null ? '回收站状态不可用，请刷新后核对。' : `${removal.blocked} 个未进入共享回收站的音频（包括隐藏或未加载的音频）会阻止删除。`}目录旁的数字仅统计当前列表视图中可见的音频。` : undefined;
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
        { id: 'copy-name', label: '复制文件名', disabled: !menuTargetExists, action: () => { const target = currentMedia(); if (!target) return; const filename = c?.snapshot?.media.find(m => m.mediaId === target.id)?.originalFilename ?? target.displayName.split(/[\\/]/).at(-1) ?? target.displayName; void Promise.resolve().then(() => navigator.clipboard.writeText(filename)).then(() => { if (latestMedia.current.media.some(m => m.id === target.id)) setCopyMessage({ text: `已复制：${filename}`, failed: false }); }).catch(() => { if (latestMedia.current.media.some(m => m.id === target.id)) setCopyMessage({ text: `复制失败，请手动复制：${filename}`, failed: true }); }); } },
        { id: 'move-media', label: '移动到文件夹…', disabled: !canEdit || !menuTargetExists, action: trigger => { const target = currentMedia(); if (target) begin({ type: 'moveMedia', mediaId: target.id, folderId: c?.snapshot?.media.find(m => m.mediaId === target.id)?.folderId ?? null }, trigger); } },
        ...(onHide && listView === 'normal' ? [{ id: 'hide', label: '从我的列表隐藏', disabled: disabled || !menuTargetExists, action: () => { const target = currentMedia(); if (target) onHide(target.id); } }] : []),
        ...(onRestore && listView==='hidden' ? [{id:'unhide',label:'取消隐藏',disabled,action:()=>{const target=currentMedia();if(target)onRestore(target.id);}}] : []),
        {id:'batch',label:'选择多个音频',disabled,action:()=>{const target=currentMedia();if(target)selectForBatch(target.id);}},
        {id:'trash',label:listView==='trash'?'从回收站恢复':'移入共享回收站…',disabled:purgeBusy||!recycle?.writable||!recycle.snapshot,action:()=>{const target=currentMedia();if(target)batch.requestTrash(listView!=='trash',[target.id]);}},
        ...(listView === 'trash' ? [{ id: 'purge', label: '永久删除…', disabled: purgeBusy || unresolvedCommit || !recycle?.writable || !menuTargetExists, action: (trigger?: HTMLElement | null) => { const target = currentMedia(); if (target) requestPurge({ kind: 'selected', mediaIds: [target.id] }, trigger); } }] : []),
        { id: 'relink', label: '重新关联…', disabled: disabled || !menuTargetExists, action: () => { const target = currentMedia(); if (target) onRelink(target); } }
    ] : [
        { id: 'create', label: '新建子文件夹…', disabled: !canEdit || !menuTargetExists, action: trigger => begin({ type: 'createFolder', id: crypto.randomUUID(), parentId: menu?.folderId ?? null, name: '' }, trigger) },
        { id: 'rename', label: '重命名文件夹…', disabled: !canEdit || !menuFolder, action: trigger => { const target = currentFolder(); if (target) begin({ type: 'renameFolder', id: target.id, name: target.name }, trigger); } },
        { id: 'move', label: '移动文件夹…', disabled: !canEdit || !menuFolder, action: trigger => { const target = currentFolder(); if (target) begin({ type: 'moveFolder', id: target.id, parentId: target.parentId }, trigger); } },
        { id: 'remove', label: `删除文件夹…${removeReason ? `（${removeReason}）` : ''}`, title: removeTitle, disabled: !canEdit || !removal?.allowed, action: trigger => { const target = currentFolder(); if (target) begin({ type: 'removeFolder', id: target.id }, trigger); } }
    ];
    const mediaMap = new Map(media.map(m => [m.id, m]));
    const row=useRef({mediaMap,openMenu,onSelect,selectForBatch,batch,listView});row.current={mediaMap,openMenu,onSelect,selectForBatch,batch,listView};
    const rowActions=useMemo<MediaRowActions>(()=>({
      menu:(event,id)=>{const m=row.current.mediaMap.get(id);if(m)row.current.openMenu(event,{media:m});},
      select:(event,id)=>{const r=row.current;if(event.ctrlKey||event.metaKey||event.shiftKey||r.listView!=='normal')r.selectForBatch(id,event);else r.onSelect(id);},
      pick:(event,id)=>row.current.batch.pick(id,event),
    }),[]);
    const card=(m:MediaDescriptor)=>{const status=statusMap.get(m.id)??'unverified';const title = `${m.displayName}\n${m.channelCount} 通道 · ${(m.frameCount / m.sampleRate).toFixed(3)} 秒 · ${m.sampleRate / 1000} kHz\n${m.categoryIds.map(id => categoryMap.get(id)).filter(Boolean).join(' · ') || '未分类'} · ${annotationCounts.get(m.id) ?? 0} 个标注\n${statusLabel[status]}\n${JSON.stringify(m.sourceRef)}`;return <MediaRow key={m.id} id={m.id} name={m.displayName} title={title} status={status} selected={selectedId===m.id} batchSelected={batch.selected.has(m.id)} batchMode={batch.mode} batchBusy={batch.busy} actions={rowActions}/>;};
    const renderFolder = (id: string): React.ReactNode => { if (query && !matched.has(id))
        return null; const folder = index.folders.get(id)!, open = query ? matched.has(id) : expanded.has(id); return <div className="media-folder" key={id}><div className={`media-folder-row ${selectedFolder === id ? 'is-selected' : ''}`}>{batch.mode&&<TriCheckbox ids={folderIds(id)} selected={batch.selected} onToggle={batch.toggle} label={`选择文件夹 · ${folder.name}`}/>}<button className="icon-button media-folder-disclosure" aria-label={`${open ? '折叠' : '展开'}文件夹 · ${folder.name}`} aria-expanded={open} onClick={() => setExpanded(old => { const next = new Set(old); if (next.has(id))
        next.delete(id);
    else
        next.add(id); return next; })}>{open ? '▾' : '▸'}</button><button className="media-folder-select" aria-pressed={selectedFolder === id} onClick={() => { c?.select(id); setDisplay(old => ({ ...old, scope: id })); setExpanded(old => { const next = new Set(old); let parent: string | null = id; while (parent) {
        next.add(parent);
        parent = index.folders.get(parent)?.parentId ?? null;
    } return next; }); }} onContextMenu={e => openMenu(e, { folderId: id })} title={index.paths.get(id)}>{folder.name}<span className="count">{viewCounts.get(id) ?? 0}</span></button><button className="icon-button" aria-label={`文件夹操作 · ${folder.name}`} onClick={e => openMenu(e, { folderId: id })}><MoreHorizontal size={14}/></button></div>{open && <div className="media-folder-content">{(index.children.get(id) ?? []).map(child => renderFolder(child))}{(displayedMediaByFolder.get(id) ?? []).map(card)}</div>}</div>; };
    return <div ref={listRoot} className="media-list-content" data-media-list="true" onKeyDown={e => {
        const target = e.target as HTMLElement;
        if (target.closest('input:not([type="checkbox"]),textarea,select,[contenteditable]:not([contenteditable="false"]),[role="menu"],[role="dialog"]')) return;
        if (e.key === 'Delete' && listView === 'trash') {
            const row = target.closest<HTMLElement>('.media-card'), batchControl = target.closest('.media-batch-actions');
            if (!row && !(batchControl && batch.selected.size)) return;
            e.preventDefault(); e.stopPropagation();
            const id = row?.querySelector<HTMLElement>('[data-media-id]')?.dataset.mediaId;
            const ids = id && !batch.selected.has(id) ? [id] : [...batch.selected];
            if (ids.length) requestPurge({ kind: 'selected', mediaIds: ids });
        } else batch.keys(e);
    }}><div className="panel-heading"><h2><ListMusic size={16}/>音频文件<span className="count">{media.filter(m => !hidden.has(m.id)&&!trash.has(m.id)).length}</span></h2><button className="icon-button" aria-label="筛选音频" title="筛选音频" aria-expanded={filters} onClick={()=>setFilters(!filters)}><SlidersHorizontal size={15}/></button><button className="icon-button" aria-label="多选音频" title="多选音频" aria-pressed={batch.mode} onClick={()=>{batch.setMode(!batch.mode);batch.replace([]);}}><ListChecks size={16}/></button><button className="icon-button" aria-label="添加音频" onClick={onImport} disabled={disabled || catalogLocked}><Plus size={17}/></button></div><div className="media-filters"><label className="search-field"><Search size={15} aria-hidden="true"/><input ref={searchInput} aria-label="搜索音频" placeholder="搜索音频或目录…" value={search} onChange={e => setSearch(e.target.value)}/></label></div><div className="media-list-view"><select className="media-display-mode" aria-label="音频显示方式" value={display.mode} onChange={e => setDisplay(old => ({ ...old, mode: e.target.value as 'tree' | 'flat' }))}><option value="tree">目录树</option><option value="flat">平铺</option></select><select aria-label="音频列表视图" value={listView} onChange={e=>setListView(e.target.value)}><option value="normal">正常音频</option><option value="hidden">我的隐藏（{media.filter(m=>hidden.has(m.id)&&!trash.has(m.id)).length}）</option><option value="trash">共享回收站（{trash.size}）</option></select>{batch.mode&&<TriCheckbox ids={filteredIds} selected={batch.selected} onToggle={batch.toggle} label="全选筛选结果"/>}<span className="count">{filteredIds.length}</span></div>
 {flat && <div className="media-list-view"><select aria-label="平铺显示范围" value={displayScope ?? ''} onChange={e => setDisplay(old => ({ ...old, scope: e.target.value || null }))}><option value="">全部音频</option>{[...index.paths].map(([id, path]) => <option key={id} value={id}>{path}（含子目录）</option>)}</select></div>}
 {filters&&<div className="media-advanced-filters"><label>我的标注<select aria-label="标注状态筛选" value={classification} onChange={e=>setClassification(e.target.value)}><option value="all">全部</option><option value="annotated">已标注</option><option value="unannotated">未标注</option></select></label><label>我的标签<select aria-label="标签筛选" value={tag} onChange={e=>setTag(e.target.value)}><option value="">全部标签</option>{categories.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label><label><input type="checkbox" disabled={flat} checked={wholeProject} onChange={e=>setWholeProject(e.target.checked)}/>搜索整个项目</label></div>}
 {recycle?.error&&!batch.confirm&&<div className="media-copy-message" role="alert">{recycle.error.message}<button onClick={()=>void recycle.refresh()}>重试</button></div>}

 {c?.error && !edit && <div className="media-filters" role="alert">{c.error.message}<button className="button button-quiet" onClick={() => void c.refresh()}>刷新目录</button></div>}
 <div className="media-items">{!flat && c && <div className="media-folder-row"><button className="media-folder-select" aria-pressed={!selectedFolder} onClick={() => { c.select(null); setDisplay(old => ({ ...old, scope: null })); }} onContextMenu={e => openMenu(e, { folderId: null })}>全部音频<span className="count">{viewCounts.get(null) ?? 0}</span></button><button ref={rootMenu} className="icon-button" aria-label="根目录操作" onClick={e => openMenu(e, { folderId: null })}><MoreHorizontal size={14}/></button></div>}{flat ? filteredIds.map(id => card(mediaMap.get(id)!)) : <>{(index.children.get(null) ?? []).map(id => renderFolder(id))}{(displayedMediaByFolder.get(null) ?? []).map(card)}</>}{!media.length && !index.folders.size && <div className="sidebar-empty"><FileAudio2 size={30}/><p>还没有音频文件</p></div>}{query && !mediaByFolder.size && !matched.size && <div className="sidebar-empty">没有匹配的音频</div>}</div>
 {listView === 'trash' && <div className="media-batch-actions"><button disabled={purgeBusy || unresolvedCommit || !recycle?.writable || !recycle.snapshot || !trash.size} onClick={() => requestPurge({ kind: 'all' })}>清空回收站…</button>{cleanupOperationIds.map((operationId, i) => <button key={operationId} disabled={purgeBusy} aria-label={`查看待清理操作 ${i + 1}`} onClick={e => { if (!recycle) return; if (purge?.operationId === operationId && purge.committed || purge?.viewOperation(operationId)) setPurgeDialog({ owner: recycle, trigger: e.currentTarget, all: false }); }}>查看待清理操作 {i + 1}</button>)}</div>}
 <BatchActions batch={batch} view={listView} canHide={!!onHideBatch} canTrash={!!recycle?.writable&&!!recycle.snapshot} onPurge={ids => requestPurge({ kind: 'selected', mediaIds: ids })} canPurge={!!recycle?.writable && !purgeBusy && !unresolvedCommit}/>{recycle&&<BatchConfirmation batch={batch} recycle={recycle} annotations={annotations} authors={authors}/>}
 {activePurge && <PurgeDialog controller={activePurge.owner.purge} all={activePurge.all} trigger={activePurge.trigger} resolveReturnFocus={previous => {
     if (currentRecycle.current !== activePurge.owner || currentOrganization.current !== c) return null;
     return previous?.isConnected ? previous : rootMenu.current ?? searchInput.current;
 }} onClose={closePurge} onCommitted={refreshAfterPurge}/>}
 {navigationMessage && <span className="media-copy-message" role="status" aria-live="polite">{navigationMessage}</span>}
 {copyMessage && <span className="media-copy-message" role={copyMessage.failed ? "alert" : "status"}>{copyMessage.text}</span>}
 {menu && <Menu anchor={menu} returnFocus={menuTargetExists ? menu.trigger : rootMenu.current ?? searchInput.current} onClose={() => setMenu(null)} items={items}/>}{edit && c && edit.owner === c && <FolderEdit controller={c} recycled={removalRecycle} draft={edit.draft} trigger={edit.trigger} resolveReturnFocus={previous => currentOrganization.current === c && previous?.isConnected ? previous : currentOrganization.current && rootMenu.current?.isConnected ? rootMenu.current : searchInput.current} onClose={() => setEdit(current => current === edit ? null : current)}/>}</div>;
}

// Transport state and no-op native acknowledgements must not reconcile thousands
// of unchanged rows. Actions always read the latest owner, including when memoized.
const StableMediaList=memo(MediaListBody);
type MediaListProps=Omit<Parameters<typeof MediaListBody>[0],'renderAuthority'>;
function useStableDto<T>(source:T):T{
 const previous=useRef<{source:T;value:T;key:string|undefined}|null>(null);
 if(!previous.current||previous.current.source!==source){
  const key=JSON.stringify(source),value=previous.current&&previous.current.key===key?previous.current.value:source;
  previous.current={source,value,key};
 }
 return previous.current.value;
}
export function MediaList(props:MediaListProps){
 const latest=useRef(props);latest.current=props;
 // Controllers also publish through subscriptions. Preserve parent-driven authority
 // updates when a snapshot/permission changes without replacing the controller.
 const renderAuthority=useMemo(()=>({}),[props.organization?.snapshot,props.organization?.pending,props.organization?.writable,props.recycle?.snapshot,props.recycle?.pending,props.recycle?.writable,props.recycle?.purge.maintenance]);
 const actions=useMemo(()=>({
  onSelect:(...args:Parameters<MediaListProps['onSelect']>)=>latest.current.onSelect(...args),
  onImport:()=>latest.current.onImport(),onRelink:(media:MediaDescriptor)=>latest.current.onRelink(media),
  onHide:props.onHide?(id:string)=>latest.current.onHide?.(id):undefined,
  onRestore:props.onRestore?(id:string)=>latest.current.onRestore?.(id):undefined,
  onHideBatch:props.onHideBatch?async(ids:string[],hidden:boolean)=>{await latest.current.onHideBatch?.(ids,hidden);}:undefined,
 }),[!!props.onHide,!!props.onRestore,!!props.onHideBatch]);
 const media=useStableDto(props.media),categories=useStableDto(props.categories),annotations=useStableDto(props.annotations),statuses=useStableDto(props.statuses),hiddenMediaIds=useStableDto(props.hiddenMediaIds),authors=useStableDto(props.authors);
 return <StableMediaList {...props} {...actions} renderAuthority={renderAuthority} media={media} categories={categories} annotations={annotations} statuses={statuses} hiddenMediaIds={hiddenMediaIds} authors={authors}/>;
}
