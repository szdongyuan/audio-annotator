import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { CommandQueue, type ProjectCommands } from '../../app/commands';
import { ProjectStore } from '../../app/store';
import { normalizeError, projectClient } from '../../bridge/client';
import { localProjects, type LocalProjectCommands, type OpenedProject, type RecoverySource } from '../../bridge/projects';
import type { AppError } from '../../bridge/types';
import { ProjectLifecycle } from './lifecycle';

export interface ActiveProject { store: ProjectStore; queue: CommandQueue; lifecycle: ProjectLifecycle; path: string }
const noopSubscribe = () => () => {};
const zero = () => 0;

export function useProjectLifecycle(api: LocalProjectCommands = localProjects, commands: ProjectCommands = projectClient) {
  const [active, setActive] = useState<ActiveProject | null>(null);
  const current = useRef<ActiveProject | null>(null);
  const [recovery, setRecovery] = useState<OpenedProject | null>(null);
  const pendingRecovery = useRef(false);
  const mounted = useRef(true);
  const [error, setError] = useState<AppError | null>(null);
  const [busy, setBusy] = useState(false);
  const occupied = useRef(false);
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
    if (opened.snapshot) {
      const store = new ProjectStore(opened.snapshot, opened.persistedRevision);
      const queue = new CommandQueue(store, commands);
      current.current = { store, queue, lifecycle: new ProjectLifecycle(store, queue, api), path: opened.path };
    }
    setActive(current.current);
  }, [api, commands]);
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
      else if (pendingRecovery.current) await api.cancelRecovery();
    } catch (e) {
      continuation.current = next; setClosePending(true); throw e;
    }
    current.current = null; setActive(null); pendingRecovery.current = false; setRecovery(null);
    continuation.current = null; setClosePending(false);
    await next();
  }, [api]);
  const open = (kind: 'create' | 'open') => operation(async () => {
    const path = await api.choose(kind);
    if (path) await finishCurrent(async () => adopt(await api[kind](path)));
  });
  const save = () => operation(async () => { await current.current?.lifecycle.save(); });
  const saveAs = () => operation(async () => {
    const project = current.current;
    if (!project) return;
    const path = await api.choose('saveAs');
    if (!path) return;
    await project.lifecycle.transition(async () => {
      const { projectId, revision } = project.store.snapshot.document;
      const opened = await api.saveAs(path, projectId, revision);
      // Admission stays frozen through native publication and retirement of this runtime.
      adopt(opened);
    });
    if (continuation.current) await finishCurrent(continuation.current);
  });
  const close = () => operation(() => finishCurrent(async () => {}));
  /** Exchange keeps the current native session alive until the replacement is fully published. */
  const performExchange = async (action: (expected: { projectId: string; expectedRevision: number } | null) => Promise<OpenedProject | null>) => {
    if (occupied.current || pendingRecovery.current) throw { code: 'InvalidInput', message: '请先完成当前项目操作', retryable: true } satisfies AppError;
    occupied.current = true; setBusy(true);
    try {
      const project = current.current;
      const acknowledgedError = project?.lifecycle.error;
      let exchangeError: unknown;
      const run = async () => {
        const doc = project?.store.snapshot.document;
        // The lifecycle has acknowledged this save; dismiss only the same error mirrored outside it.
        setError(previous => previous === acknowledgedError ? null : previous);
        try {
          const opened = await action(doc ? { projectId: doc.projectId, expectedRevision: doc.revision } : null);
          if (opened) adopt(opened);
        } catch (cause) { exchangeError = cause; }
      };
      if (project) await project.lifecycle.transitionAfterSave(run); else await run();
      // Archive/cancellation failures belong to the exchange dialog, not the saved project's ledger.
      if (exchangeError) throw exchangeError;
    } finally {
      occupied.current = false; setBusy(false);
      if (deferredClose.current) { deferredClose.current = false; queueMicrotask(() => closeWindow.current()); }
    }
  };
  closeWindow.current = () => {
    if (occupied.current) { deferredClose.current = true; return; }
    void operation(() => finishCurrent(() => api.destroyWindow()));
  };
  const shortcut = useRef(save); shortcut.current = save;
  useEffect(() => {
    let disposed = false; let unlisten: (() => void) | undefined;
    void api.onCloseRequested(() => closeWindow.current()).then(unsubscribe => {
      if (disposed) unsubscribe(); else unlisten = unsubscribe;
    }).catch(e => setError(normalizeError(e)));
    const keydown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void shortcut.current(); }
    };
    window.addEventListener('keydown', keydown);
    return () => { disposed = true; unlisten?.(); window.removeEventListener('keydown', keydown); };
  }, [api]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; current.current?.lifecycle.dispose(); };
  }, []);
  return {
    active, recovery, busy, editingDisabled: active?.store.editingDisabled ?? true,
    error: error ?? active?.lifecycle.error ?? null, closePending,
    open, save, saveAs, close, performExchange,
    recover: (source: RecoverySource | null) => operation(async () => adopt(await api.recover(source))),
    cancelRecovery: () => operation(async () => { await api.cancelRecovery(); pendingRecovery.current = false; setRecovery(null); }),
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
