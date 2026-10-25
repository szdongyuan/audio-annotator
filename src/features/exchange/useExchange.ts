import { mediaDialogs } from '../../bridge/media';
import { useEffect, useRef, useState } from 'react';
import { exchangeClient, exchangeDialogs, type ExchangeEvent, type ExchangeRequest } from '../../bridge/exchange';
import type { OpenedProject } from '../../bridge/projects';
import { normalizeError } from '../../bridge/client';
import type { AppError } from '../../bridge/types';
import type { ProjectLifecycleUI } from '../project/useProjectLifecycle';
export function useExchange(project: ProjectLifecycleUI) {
  const [dialog, setDialog] = useState<'export' | 'import' | null>(null);
  const [busy, setBusy] = useState(false); const running = useRef(false);
  const [phase, setPhase] = useState(''); const [completed, setCompleted] = useState(0);
  const [result, setResult] = useState<string | null>(null); const [error, setError] = useState<AppError | null>(null);
  const [cancelled, setCancelled] = useState(false); const cancelRequested = useRef(false); const task = useRef<string | null>(null);
  type Sources=Extract<ExchangeEvent,{type:'sourcesRequired'}>;
  const [sources,setSources]=useState<Sources|null>(null),[bindings,setBindings]=useState<Record<string,string>>({});
  const pending=useRef<{request:Omit<ExchangeRequest,'expected'>;owner:typeof project.active}|null>(null);
  const current=useRef(project.active);current.current=project.active;
  const mounted=useRef(true),generation=useRef(0);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;generation.current++;if(task.current)void exchangeClient.cancel(task.current).catch(()=>{});};},[]);
  useEffect(()=>{if(pending.current&&pending.current.owner!==project.active){pending.current=null;setSources(null);setBindings({});}},[project.active]);
  const reset = () => { setPhase(''); setCompleted(0); setResult(null); setError(null); setCancelled(false); cancelRequested.current = false; task.current = null; };
  const startNative = (request: ExchangeRequest) => new Promise<OpenedProject | null>((resolve, reject) => {
    let terminal = false;const attempt=++generation.current;task.current=null;
    if(cancelRequested.current){reject({code:'Cancelled',message:'任务已取消',retryable:true});return;}
    const receive = (event: ExchangeEvent) => {
      if(!mounted.current||attempt!==generation.current)return;
      task.current ??= event.taskId;
      if (event.taskId !== task.current || terminal) return;
      if (event.type === 'progress') { setPhase(event.phase); setCompleted(event.completed); return; }
      terminal = true;
      if(event.type==='sourcesRequired'){setSources(event);resolve(null);}
      else if (event.type === 'completed') { setSources(null);pending.current=null;setResult(event.path); resolve(event.opened); }
      else reject(event.type === 'failed' ? event.error : { code: 'Cancelled', message: '任务已取消', retryable: true });
    };
    void exchangeClient.start(request, receive).then(id => { if (terminal||attempt!==generation.current||!mounted.current) return; task.current ??= id; if (cancelRequested.current) void exchangeClient.cancel(id).catch(e => setError(normalizeError(e))); }).catch(reject);
  });
  const start = async (kind: 'annotations' | 'bundle' | 'import') => {
    if (running.current) return;
    running.current = true; setBusy(true); reset();setSources(null);setBindings({});pending.current=null;
    try {
      let request: Omit<ExchangeRequest, 'expected'>;
      if (kind === 'import') { const source = await exchangeDialogs.source(); if (typeof source !== 'string' || cancelRequested.current) return; const parent = await exchangeDialogs.parent(); if (typeof parent !== 'string' || cancelRequested.current) return; request = { kind, source, parent };pending.current={request,owner:current.current}; }
      else { const path = await exchangeDialogs.save(kind); if (!path || cancelRequested.current) return; request = { kind, path }; }
      await project.performExchange(async expected => {
        if (cancelRequested.current) throw { code: 'Cancelled', message: '任务已取消', retryable: true };
        if (kind !== 'import' && !expected) throw { code: 'InvalidInput', message: '请先打开项目', retryable: false };
        return startNative({ ...request, expected });
      });
    } catch (cause) { const e = normalizeError(cause); if (e.code === 'Cancelled') setCancelled(true); else setError(e); }
    finally { setBusy(false); running.current = false; task.current = null; }
  };
  const continueImport=async()=>{
    const saved=pending.current;if(running.current||!sources||!saved||saved.owner!==current.current)return;
    if(sources.media.some(m=>!bindings[m.id]))return;
    running.current=true;setBusy(true);reset();
    try{await project.performExchange(expected=>{if(saved.owner!==current.current)throw {code:'Cancelled',message:'项目已切换',retryable:true};return startNative({...saved.request,expected,bindings:{sourceSha256:sources.sourceSha256,media:sources.media.map(m=>({mediaId:m.id,path:bindings[m.id]}))}});});}
    catch(cause){const e=normalizeError(cause);if(e.code==='Cancelled')setCancelled(true);else setError(e);}
    finally{running.current=false;if(mounted.current)setBusy(false);task.current=null;}
  };
  return { dialog, busy, phase, completed, result, error, cancelled,sources,bindings,continueImport,
    chooseSource:async(mediaId:string)=>{const saved=pending.current;if(running.current||!sources?.media.some(m=>m.id===mediaId)||!saved)return;const path=await mediaDialogs.choose(false);if(typeof path==='string'&&pending.current===saved&&saved.owner===current.current)setBindings(old=>({...old,[mediaId]:path}));},
    show: (kind: 'export' | 'import') => { if (!running.current) { reset();setSources(null);setBindings({});pending.current=null; setDialog(kind); } },
    onClose: () => { if (!running.current){setDialog(null);setSources(null);pending.current=null;} }, onCancel: () => { cancelRequested.current = true;if(!running.current){setSources(null);pending.current=null;setBindings({});setCancelled(true);} setPhase('正在取消'); if (task.current) void exchangeClient.cancel(task.current).catch(e => setError(normalizeError(e))); },
    startExport: (kind: 'annotations' | 'bundle') => void start(kind), startImport: () => void start('import'),
  };
}
export type ExchangeUI = ReturnType<typeof useExchange>;
