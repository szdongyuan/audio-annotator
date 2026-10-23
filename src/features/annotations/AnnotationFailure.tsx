import type { AnnotationUI } from './useAnnotations';
export function AnnotationFailure({ ui }: { ui: AnnotationUI }) {
  const active = ui.active;
  if (!active?.lifecycle.error) return null;
  return <div className="annotation-failure" role="alert"><span>{active.lifecycle.error.message}</span>{active.queue.unresolvedFailures.map(f => <div key={f.id}><button className="button" disabled={active.store.editingDisabled} onClick={() => { const key = f.draftKey; void active.lifecycle.retryFailure(f.id, key && ui.drafts?.owns(key) ? () => ui.drafts!.submit(key) : undefined).catch(() => {}); }}>重试更改 #{f.id}</button>{f.owner && ['annotations','masks','playback'].includes(f.owner) && <button className="button button-quiet" disabled={active.store.editingDisabled} onClick={() => active.queue.discardFailure(f.id)}>放弃此次更改</button>}</div>)}</div>;
}
