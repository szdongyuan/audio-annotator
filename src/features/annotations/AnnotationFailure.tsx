import type { AnnotationUI } from './useAnnotations';
export function AnnotationFailure({ ui }: { ui: AnnotationUI }) {
  const active = ui.active;
  if (!active?.lifecycle.error) return null;
  return <div className="annotation-failure" role="alert"><span>{active.lifecycle.error.message}</span>{active.queue.unresolvedFailures.map(f => <div key={f.id}><button className="button" disabled={active.store.editingDisabled} onClick={() => { void (async () => { if (active.queue.needsRefresh) await active.queue.refresh(); await (f.draftKey && ui.drafts!.owns(f.draftKey) ? ui.drafts!.submit(f.draftKey) : active.queue.retry(f.id)); })().catch(() => {}); }}>重试更改 #{f.id}</button>{f.owner && ['annotations','masks','playback'].includes(f.owner) && <button className="button button-quiet" disabled={active.store.editingDisabled} onClick={() => active.queue.discardFailure(f.id)}>放弃此次更改</button>}</div>)}</div>;
}
