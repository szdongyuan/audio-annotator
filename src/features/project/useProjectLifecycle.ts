import { admitted, suspendRefresh } from '../collaboration/admission';
import { retryAdmission } from '../../bridge/admission';
import { collaborationClient, type CopyProgress } from '../../bridge/collaboration';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { CommandQueue, type ProjectCommands } from '../../app/commands';
import { ProjectStore } from '../../app/store';
import { normalizeError, projectClient } from '../../bridge/client';
import { localProjects, type LocalProjectCommands, type OpenedProject, type RecoverySource } from '../../bridge/projects';
import type { AppError } from '../../bridge/types';
import { ProjectLifecycle } from './lifecycle';
import { createRuntimeCommands, type RuntimeCommands } from '../../bridge/runtime';
import type { ExpectedProject } from '../../bridge/exchange';
import type { SharedContext, Transition } from '../../bridge/collaboration';
import { PreferenceDraft } from '../collaboration/controller';
import type { ProfileResponse } from '../../bridge/profiles';
import { matchingSessionUI, SessionStore, type ProjectSession, type SessionUI } from './session';

export interface ActiveProject { store: ProjectStore; queue: CommandQueue; lifecycle: ProjectLifecycle; path: string; readonly restoredUI?: SessionUI; readonly collaboration?: SharedContext; readonly commands?: RuntimeCommands; readonly preferences?: PreferenceDraft }
const noopSubscribe = () => () => {};
const zero = () => 0;

export function useProjectLifecycle(api: LocalProjectCommands = localProjects, commands: ProjectCommands = projectClient) {
  const [session] = useState(() => new SessionStore());
  const [restorePrompt, setRestorePrompt] = useState(session.record);
  const restoring = useRef<ProjectSession | null>(null);
  const openingReadOnly = useRef(false);
  const [active, setActive] = useState<ActiveProject | null>(null);
  const current = useRef<ActiveProject | null>(null);
  const [recovery, setRecovery] = useState<OpenedProject | null>(null);
  const pendingRecovery = useRef(false);
  const recoveryCommands = useRef(api);
  const mounted = useRef(true);
  const [error, setError] = useState<AppError | null>(null);
  const [busy, setBusy] = useState(false);
  const occupied = useRef(false);
  const [copyProgress,setCopyProgress]=useState<CopyProgress|null>(null);
  const copyOperation=useRef<{id:string;cancelled:boolean}|null>(null);
  const deferredClose = useRef(false);
  const closeWindow = useRef<() => void>(() => {});
  const [closePending, setClosePending] = useState(false);
  const continuation = useRef<(() => Promise<void>) | null>(null);
  useSyncExternalStore(active?.lifecycle.subscribe ?? noopSubscribe, active?.lifecycle.getVersion ?? zero);

  const adopt = useCallback((opened: OpenedProject) => {
    if (!mounted.current) return;
    current.current?.lifecycle.dispose();
    current.current = null;
    pendingRecovery.current = opened.recovery !== null;
    setRecovery(opened.recovery ? opened : null);
    recoveryCommands.current = opened.collaboration ? createRuntimeCommands(opened.collaboration.runtimeNonce).projects : api;
    if (opened.snapshot) {
      const store = new ProjectStore(opened.snapshot, opened.persistedRevision);
      const runtime = opened.collaboration ? createRuntimeCommands(opened.collaboration.runtimeNonce) : undefined;
      let owner:ActiveProject;
      const base=runtime?.project??commands;
      const queue = new CommandQueue(store, {...base,applyChange:async(id,revision,change)=>{
        if(change.type!=='importMedia' && change.type!=='importMediaBatch')return base.applyChange(id,revision,change);
        const resume=await suspendRefresh(owner.lifecycle);
        try{return await admitted(owner,()=>base.applyChange(id,revision,change),()=>current.current===owner&&mounted.current);}finally{resume?.();}
      }});
      const lifecycle = new ProjectLifecycle(store, queue, runtime?.projects ?? api);
      owner = { store, queue, lifecycle, path: opened.path, ...(opened.collaboration ? { collaboration: Object.freeze(opened.collaboration), commands: runtime } : {}) };
      const restoredUI = restoring.current && matchingSessionUI(restoring.current, opened);
      if (restoredUI) Object.assign(owner, { restoredUI });
      if (opened.collaboration) Object.assign(owner, { preferences: new PreferenceDraft(owner) });
      current.current = owner;
      if (!opened.recovery) {
        session.adopt(opened, openingReadOnly.current);
        restoring.current = null; openingReadOnly.current = false; setRestorePrompt(null);
      }
    }
    setActive(current.current);
  }, [api, commands, session]);
  const operation = useCallback(async (action: () => Promise<void>) => {
    if (!mounted.current || occupied.current) return;
    occupied.current = true; setBusy(true); setError(null);
    try { await action(); } catch (e) { if (mounted.current) setError(normalizeError(e)); }
    finally {
      occupied.current = false;
      if (mounted.current) {
        setBusy(false);
        if (deferredClose.current) { deferredClose.current = false; queueMicrotask(() => { if (mounted.current) closeWindow.current(); }); }
      } else deferredClose.current = false;
    }
  }, []);
  const finishCurrent = useCallback(async (next: () => Promise<void>, discard = false) => {
    try {
      if (current.current) await current.current.lifecycle.close(discard);
      else if (pendingRecovery.current) await recoveryCommands.current.cancelRecovery();
    } catch (e) {
      continuation.current = next; setClosePending(true); throw e;
    }
    current.current = null; setActive(null); pendingRecovery.current = false; setRecovery(null);
    continuation.current = null; setClosePending(false);
    await next();
  }, [api]);
  const openChosenPath = async (path: string, kind: 'create' | 'open' | 'viewOnly', restore: ProjectSession | null = null) => {
    const resume = await suspendRefresh(current.current?.lifecycle);
    try { await finishCurrent(async () => {
      restoring.current = restore; openingReadOnly.current = kind === 'viewOnly';
      adopt(await retryAdmission(() => kind === 'viewOnly' ? (api.openViewOnly ?? localProjects.openViewOnly)(path) : api[kind](path), { valid: () => mounted.current }));
    }); } finally { resume?.(); if (!pendingRecovery.current) { restoring.current = null; openingReadOnly.current = false; } }
  };
  const openPath = (path: string, mode: 'open' | 'viewOnly' = 'open', restore: ProjectSession | null = null) => operation(() => openChosenPath(path, mode, restore));
  const open = (kind: 'create' | 'open' | 'viewOnly') => operation(async () => {
    const path = await api.choose(kind==='viewOnly'?'open':kind);
    if (path) await openChosenPath(path, kind);
  });
  const save = () => operation(async () => { await current.current?.lifecycle.save(); });
  const saveAs = () => operation(async () => {
    const project = current.current;
    if (!project) return;
    const path = await api.choose('saveAs');
    if (!path) return;
    const op={id:crypto.randomUUID(),cancelled:false};copyOperation.current=op;
    setCopyProgress({operationId:op.id,phase:'准备复制',completed:0});
    const resume=await suspendRefresh(project.lifecycle);
    let copyError:unknown;
    try{await project.lifecycle.transition(async () => {
      const { projectId, revision } = project.store.snapshot.document;
      let opened:OpenedProject;
      try{opened = await admitted(project,()=>(project.commands?.projects ?? api).saveAs(path,projectId,revision,{operationId:op.id,onProgress:p=>{if(mounted.current&&copyOperation.current===op)setCopyProgress(p);}}),()=>!op.cancelled&&current.current===project&&mounted.current);}catch(cause){copyError=cause;return;}
      // Admission stays frozen through native publication and retirement of this runtime.
      adopt(opened);
    });}finally{resume?.();copyOperation.current=null;setCopyProgress(null);}
    if(copyError)throw copyError;
    if (continuation.current) await finishCurrent(continuation.current);
  });
  const close = () => operation(() => finishCurrent(async () => { session.forget(); setRestorePrompt(null); }));
  /** Exchange keeps the current native session alive until the replacement is fully published. */
  const performExchange = async (action: (expected: ExpectedProject | null) => Promise<OpenedProject | null>) => {
    if (occupied.current || pendingRecovery.current) throw { code: 'InvalidInput', message: '请先完成当前项目操作', retryable: true } satisfies AppError;
    occupied.current = true; setBusy(true);
    const resume=await suspendRefresh(current.current?.lifecycle);
    try {
      const project = current.current;
      const acknowledgedError = project?.lifecycle.error;
      let exchangeError: unknown;
      const run = async () => {
        const doc = project?.store.snapshot.document;
        // The lifecycle has acknowledged this save; dismiss only the same error mirrored outside it.
        setError(previous => previous === acknowledgedError ? null : previous);
        try {
          const opened = await admitted(project,()=>action(doc ? { projectId: doc.projectId, expectedRevision: doc.revision, ...(project?.collaboration ? { runtimeNonce: project.collaboration.runtimeNonce } : {}) } : null),()=>mounted.current&&current.current===project);
          if (opened) adopt(opened);
        } catch (cause) { exchangeError = cause; }
      };
      if (project) await project.lifecycle.transitionAfterSave(run); else await run();
      // Archive/cancellation failures belong to the exchange dialog, not the saved project's ledger.
      if (exchangeError) throw exchangeError;
    } finally {
      resume?.();
      occupied.current = false; setBusy(false);
      if (deferredClose.current) { deferredClose.current = false; queueMicrotask(() => closeWindow.current()); }
    }
  };
  const performCollaboration = async (owner: ActiveProject, action: () => Promise<Transition>, background: boolean | (() => boolean) = false) => {
    if (occupied.current || current.current !== owner || pendingRecovery.current) throw { code:'InvalidInput',message:'请先完成当前项目操作',retryable:true } satisfies AppError;
    occupied.current = true; setBusy(true);
    try {
      let operationError: unknown;
      const apply = async () => {
        let result: Transition;
        try { result = await action(); } catch (cause) { operationError = cause; return; }
        if (!mounted.current || current.current !== owner) return;
        if (result.opened.collaboration?.runtimeNonce === owner.collaboration?.runtimeNonce) {
          if (!result.opened.snapshot) throw new Error('Missing personal copy result');
          if(result.opened.snapshot.document.revision!==owner.store.snapshot.document.revision||result.opened.snapshot.canUndo!==owner.store.snapshot.canUndo||result.opened.snapshot.canRedo!==owner.store.snapshot.canRedo)owner.store.accept(result.opened.snapshot);
          owner.store.markPersisted(result.opened.snapshot.document.projectId,result.opened.persistedRevision);
        } else adopt(result.opened);
      };
      if (background) await owner.lifecycle.transitionAfterSave(apply, () => mounted.current && current.current === owner && owner.lifecycle.allowsBackgroundTransition && (typeof background !== 'function' || background()));
      else await owner.lifecycle.transitionAfterSave(apply);
      // An authentication/cancellation error does not undo the acknowledged local save.
      if (operationError) throw operationError;
    } finally {
      occupied.current = false; if(mounted.current)setBusy(false);
      if (deferredClose.current) { deferredClose.current = false; queueMicrotask(() => closeWindow.current()); }
    }
  };
  /** Profile management shares admission with new/open even with no project.
   * Only a native selection transition replaces the editor. Metadata updates
   * keep the owner, history, selection, preferences and lease intact. */
  const performIdentity = async (owner:ActiveProject|null, action:()=>Promise<ProfileResponse|null>, save:boolean) => {
    if (!mounted.current || occupied.current || current.current!==owner || pendingRecovery.current) throw {code:'InvalidInput',message:'请先完成当前项目操作',retryable:true} satisfies AppError;
    occupied.current=true;setBusy(true);
    let resume:(()=>void)|undefined;
    try {
      resume=await suspendRefresh(owner?.lifecycle);
      let result:ProfileResponse|null=null,operationError:unknown;
      const run=async()=>{
        try {result=await action();}catch(cause){operationError=cause;return;}
        if(result?.transition&&mounted.current&&current.current===owner)adopt(result.transition.opened);
      };
      if(owner){if(save)await owner.lifecycle.transitionAfterSave(run);else await owner.lifecycle.transition(run);}else await run();
      if(operationError)throw operationError;
      return result;
    } finally {
      resume?.();occupied.current=false;if(mounted.current)setBusy(false);
      if(deferredClose.current){deferredClose.current=false;queueMicrotask(()=>{if(mounted.current)closeWindow.current();});}
    }
  };
  closeWindow.current = () => {
    if (occupied.current) { deferredClose.current = true; return; }
    void operation(() => finishCurrent(() => { session.flush(); return api.destroyWindow(); }));
  };
  const shortcut = useRef(save); shortcut.current = save;
  useEffect(() => {
    let disposed = false; let unlisten: (() => void) | undefined;
    void api.onCloseRequested(() => closeWindow.current()).then(unsubscribe => {
      if (disposed) unsubscribe(); else unlisten = unsubscribe;
    }).catch(e => setError(normalizeError(e)));
    const keydown = (event: KeyboardEvent) => {
      if (!event.defaultPrevented && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void shortcut.current(); }
    };
    window.addEventListener('keydown', keydown);
    return () => { disposed = true; unlisten?.(); window.removeEventListener('keydown', keydown); };
  }, [api]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false;session.flush();const op=copyOperation.current;if(op){op.cancelled=true;void collaborationClient.cancel(op.id).catch(()=>{});} current.current?.lifecycle.dispose(); };
  }, []);
  return {
    active, recovery, busy, editingDisabled: active?.store.editingDisabled ?? true,
    error: error ?? active?.lifecycle.error ?? null, closePending,
    copyProgress,cancelCopy:()=>{const op=copyOperation.current;if(op){op.cancelled=true;void collaborationClient.cancel(op.id).catch(e=>setError(normalizeError(e)));}},
    open, openPath, save, saveAs, close, performExchange, performCollaboration, performIdentity,
    restorePrompt,
    restoreLast: () => restorePrompt ? openPath(restorePrompt.path, restorePrompt.readOnly ? 'viewOnly' : 'open', restorePrompt) : Promise.resolve(),
    startEmpty: () => { setRestorePrompt(null); setError(null); },
    forgetSession: () => { session.forget(); setRestorePrompt(null); setError(null); },
    acknowledgeSessionUI: (owner: ActiveProject, ui: SessionUI, excluded: readonly string[]) => { if (current.current === owner && !pendingRecovery.current) session.update(owner, ui, excluded); },
    recover: (source: RecoverySource | null) => operation(async () => adopt(await recoveryCommands.current.recover(source))),
    cancelRecovery: () => operation(async () => { await recoveryCommands.current.cancelRecovery(); pendingRecovery.current = false; setRecovery(null); restoring.current = null; openingReadOnly.current = false; }),
    retry: () => operation(async () => {
      await current.current?.lifecycle.retryFailures();
      if (continuation.current) await finishCurrent(continuation.current);
    }),
    discard: () => operation(async () => { if (continuation.current) await finishCurrent(continuation.current, true); }),
    cancelClose: () => { continuation.current = null; setClosePending(false); setError(null); },
    dismissError: () => setError(null),
  };
}
export type ProjectLifecycleUI = ReturnType<typeof useProjectLifecycle>;
