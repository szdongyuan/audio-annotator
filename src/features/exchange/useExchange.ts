import { awaitPreview } from './previewRequest';
import { mediaDialogs } from '../../bridge/media';
import { useEffect, useRef, useState } from 'react';
import { exchangeClient, exchangeDialogs, type ExchangeEvent, type ExchangeRequest, type ExportPreview, type ExportSelection } from '../../bridge/exchange';
import type { OpenedProject } from '../../bridge/projects';
import { normalizeError } from '../../bridge/client';
import type { AppError } from '../../bridge/types';
import type { ProjectLifecycleUI } from '../project/useProjectLifecycle';
export function useExchange(project: ProjectLifecycleUI) {
    const [selection, setSelection] = useState<ExportSelection|null>(null);
    const [mergeImport, setMergeImport] = useState(false);
    const canMerge = !!project.active?.collaboration?.canImportMedia;
    const [previewBusy, setPreviewBusy] = useState(false);
    const previewAbort = useRef<AbortController|null>(null), exportAbort = useRef<AbortController|null>(null);
    const [preview, setPreview] = useState<ExportPreview | null>(null);
    const previewGeneration = useRef(0);
    const invalidatePreview = () => { previewAbort.current?.abort(); previewAbort.current=null; previewGeneration.current++; setPreview(null); setPreviewBusy(false); };
    const [dialog, setDialog] = useState<'export' | 'import' | null>(null);
    const [busy, setBusy] = useState(false);
    const running = useRef(false);
    const [phase, setPhase] = useState('');
    const [completed, setCompleted] = useState(0);
    const [result, setResult] = useState<string | null>(null);
    const [error, setError] = useState<AppError | null>(null);
    const [cancelled, setCancelled] = useState(false);
    const cancelRequested = useRef(false);
    const task = useRef<string | null>(null);
    type Sources = Extract<ExchangeEvent, {
        type: 'sourcesRequired';
    }>;
    const [sources, setSources] = useState<Sources | null>(null), [bindings, setBindings] = useState<Record<string, string>>({});
    const pending = useRef<{
        request: Omit<ExchangeRequest, 'expected'>;
        owner: typeof project.active;
    } | null>(null);
    const returnFocus=useRef<HTMLElement|null>(null);
    const current = useRef(project.active);
    current.current = project.active;
    const mounted = useRef(true), generation = useRef(0);
    useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; previewAbort.current?.abort(); exportAbort.current?.abort(); if (task.current)
        void exchangeClient.cancel(task.current).catch(() => { }); }; }, []);
    useEffect(() => { invalidatePreview(); if (pending.current && pending.current.owner !== project.active) {
        pending.current = null;
        setSources(null);
        setBindings({});
    } }, [project.active]);
    const reset = () => { setPhase(''); setCompleted(0); setResult(null); setError(null); setCancelled(false); cancelRequested.current = false; task.current = null; };
    const startNative = (request: ExchangeRequest) => new Promise<OpenedProject | null>((resolve, reject) => {
        const owner = current.current;
        let terminal = false;
        const attempt = ++generation.current;
        task.current = null;
        if (cancelRequested.current) {
            reject({ code: 'Cancelled', message: '任务已取消', retryable: true });
            return;
        }
        const receive = (event: ExchangeEvent) => {
            if (!mounted.current || attempt !== generation.current)
                return;
            if (owner !== current.current) {
                terminal = true;
                reject({ code: 'Cancelled', message: '项目已切换，忽略旧任务结果', retryable: true });
                return;
            }
            task.current ??= event.taskId;
            if (event.taskId !== task.current || terminal)
                return;
            if (event.type === 'progress') {
                setPhase(event.phase);
                setCompleted(event.completed);
                return;
            }
            terminal = true;
            if (event.type === 'sourcesRequired') {
                setSources(event);
                resolve(null);
            }
            else if (event.type === 'completed') {
                setSources(null);
                pending.current = null;
                setResult(event.path);
                resolve(event.opened);
            }
            else
                reject(event.type === 'failed' ? event.error : { code: 'Cancelled', message: '任务已取消', retryable: true });
        };
        void exchangeClient.start(request, receive).then(id => { if (terminal || attempt !== generation.current || !mounted.current)
            return; task.current ??= id; if (cancelRequested.current)
            void exchangeClient.cancel(id).catch(e => setError(normalizeError(e))); }).catch(reject);
    });
    const prepareExport = (kind: 'annotations' | 'bundle', preserveFolders = true) => {
        if (running.current)
            return Promise.resolve();
        invalidatePreview();
        const abort = new AbortController(); previewAbort.current = abort;
        const owner = current.current, g = ++previewGeneration.current;
        const valid = () => mounted.current && g === previewGeneration.current && owner === current.current;

        setPreview(null);
        setPreviewBusy(true);
        setError(null);
        setResult(null);
        setCancelled(false);
        const pendingPreview = (async () => {
            if (!owner) throw { code:'InvalidInput',message:'请先打开项目',retryable:false };
            const doc = owner.store.snapshot.document;
            const expected = { projectId: doc.projectId, expectedRevision: doc.revision, ...(owner.collaboration ? { runtimeNonce: owner.collaboration.runtimeNonce } : {}) };
            const value = await awaitPreview(exchangeClient.preview(expected, kind === 'bundle', preserveFolders, selection ?? undefined), abort.signal);
            if (!valid())
                return;
            if (owner.store.snapshot.document.revision !== value.documentRevision)
                throw { code: 'RevisionConflict', message: '项目已改变，请刷新导出预览', retryable: true };
            setPreview(value);
        })().catch(cause => { if (valid())
            setError(normalizeError(cause)); }).finally(() => { if (valid())
            setPreviewBusy(false); });
        return pendingPreview;
    };
    const start = async (kind: 'annotations' | 'bundle' | 'import', preserveFolders = true) => {
        if (running.current)
            return;
        const owner = current.current;
        invalidatePreview();
        const abort = new AbortController(); exportAbort.current=abort;
        running.current = true;
        setBusy(true);
        reset();
        setSources(null);
        setBindings({});
        pending.current = null;
        try {
            let request: Omit<ExchangeRequest, 'expected'>;
            if (kind === 'import') {
                const source = await exchangeDialogs.source();
                if (typeof source !== 'string' || cancelRequested.current)
                    return;
                if (mergeImport && !canMerge) throw {code:'InvalidInput',message:'请先打开可写的目标项目',retryable:false};
                const parent = mergeImport ? undefined : await exchangeDialogs.parent();
                if ((!mergeImport && typeof parent !== 'string') || cancelRequested.current) return;
                request = { kind, source, ...(typeof parent === 'string' ? {parent} : {}), ...(mergeImport ? {merge:true} : {}) };
                pending.current = { request, owner: current.current };
            }
            else {
                const path = await exchangeDialogs.save(kind, selection?.audioOnly ?? false);
                if (!path || cancelRequested.current || owner !== current.current)
                    return;
                request = { kind, path, preserveFolders };
            }
            await project.performExchange(async (expected) => {
                if (cancelRequested.current)
                    throw { code: 'Cancelled', message: '任务已取消', retryable: true };
                if (kind !== 'import' && !expected)
                    throw { code: 'InvalidInput', message: '请先打开项目', retryable: false };
                if (owner !== current.current)
                    throw { code: 'Cancelled', message: '项目已切换', retryable: true };
                if (kind !== 'import') {
                    setPhase('准备导出目录');
                    const plan = await awaitPreview(exchangeClient.preview(expected!, kind === 'bundle', preserveFolders, selection ?? undefined), abort.signal);
                    if (cancelRequested.current || owner !== current.current) throw {code:'Cancelled',message:'任务已取消',retryable:true};
                    request = {...request, previewToken:plan.token};
                }
                return startNative({ ...request, expected });
            }, {exportOnly:kind !== 'import',signal:abort.signal,onPhase:setPhase});
        }
        catch (cause) {
            const e = normalizeError(cause);
            if (e.code === 'Cancelled')
                setCancelled(true);
            else {
                setError(e);
                if (kind !== 'import' && e.code === 'RevisionConflict')
                    invalidatePreview();
            }
        }
        finally {
            setBusy(false);
            running.current = false;
            if(exportAbort.current===abort)exportAbort.current=null;
            task.current = null;
        }
    };
    const continueImport = async () => {
        const saved = pending.current;
        if (running.current || !sources || !saved || saved.owner !== current.current)
            return;
        if (sources.media.some(m => !bindings[m.id]))
            return;
        running.current = true;
        setBusy(true);
        reset();
        try {
            await project.performExchange(expected => { if (saved.owner !== current.current)
                throw { code: 'Cancelled', message: '项目已切换', retryable: true }; return startNative({ ...saved.request, expected, bindings: { sourceSha256: sources.sourceSha256, media: sources.media.map(m => ({ mediaId: m.id, path: bindings[m.id] })) } }); });
        }
        catch (cause) {
            const e = normalizeError(cause);
            if (e.code === 'Cancelled')
                setCancelled(true);
            else
                setError(e);
        }
        finally {
            running.current = false;
            if (mounted.current)
                setBusy(false);
            task.current = null;
        }
    };
    return { dialog, selection, canMerge, mergeImport, setMergeImport, updateSelection:(value:ExportSelection)=>{setSelection(value);invalidatePreview();},
        showSelected:(mediaIds:string[],trigger?:HTMLElement|null)=>{if(running.current||!current.current)return;returnFocus.current=trigger??null;reset();invalidatePreview();setSources(null);setBindings({});pending.current=null;setSelection({mediaIds:[...mediaIds],authorIds:current.current.collaboration?.actor?[current.current.collaboration.actor.authorId]:[],audioOnly:false});setDialog('export');},
        returnFocus:returnFocus.current, previewBusy, preview, prepareExport, invalidatePreview, busy, phase, completed, result, error, cancelled, sources, bindings, continueImport,
        chooseSource: async (mediaId: string) => { const saved = pending.current; if (running.current || !sources?.media.some(m => m.id === mediaId) || !saved)
            return; const path = await mediaDialogs.choose(false); if (typeof path === 'string' && pending.current === saved && saved.owner === current.current)
            setBindings(old => ({ ...old, [mediaId]: path })); },
        show: (kind: 'export' | 'import',trigger?:HTMLElement|null) => { if (!running.current) {
            returnFocus.current=trigger??(document.activeElement instanceof HTMLElement?document.activeElement:null);
            reset();
            setSelection(null);
            invalidatePreview();
            setSources(null);
            setBindings({});
            pending.current = null;
            setDialog(kind);
        } },
        onClose: () => { if (!running.current) {
            invalidatePreview();
            setDialog(null);
            setSources(null);
            pending.current = null;
        } }, onCancel: () => { cancelRequested.current = true; exportAbort.current?.abort(); if (!running.current) {
            invalidatePreview();
            setSources(null);
            pending.current = null;
            setBindings({});
            setCancelled(true);
        } setPhase('正在取消'); if (task.current)
            void exchangeClient.cancel(task.current).catch(e => setError(normalizeError(e))); },
        startExport: (kind: 'annotations' | 'bundle', preserveFolders=true) => void start(kind,preserveFolders), startImport: () => void start('import'),
    };
}
export type ExchangeUI = ReturnType<typeof useExchange>;
