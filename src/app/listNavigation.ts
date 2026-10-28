import type { ClassificationTarget } from '../features/annotations/classification';
import type { Selection, SelectionState } from '../features/selection/state';

export type NavigationScope = { owner: object | null; authorId: string | null; state: SelectionState };
type NavigationSnapshot = NavigationScope & { intent: number; signature: string; context: ClassificationTarget | null; mediaId?: string };

function signature(state: SelectionState) {
  const target = (value: Selection | null) => value && [value.object?.kind, value.object?.id, value.region.mediaId, value.region.channelIndex, value.region.startSeconds, value.region.endSeconds, value.region.lowHz, value.region.highHz];
  const context = state.getContext();
  return JSON.stringify([target(state.getActiveSelection()), target(state.getCandidate()), context?.mediaId, context?.channelIndex]);
}
function capture(scope: NavigationScope): NavigationSnapshot {
  return { ...scope, intent: scope.state.intentVersion, signature: signature(scope.state), context: scope.state.getContext() };
}
function sameScope(a: NavigationScope, b: NavigationScope) {
  return a.owner === b.owner && a.authorId === b.authorId && a.state === b.state;
}
function matches(snapshot: NavigationSnapshot, scope: NavigationScope) {
  return sameScope(snapshot, scope) && snapshot.intent === scope.state.intentVersion && snapshot.signature === signature(scope.state);
}

/** Each AppShell owns its requests and the exact list intent that may retain its tab. */
export class ListNavigation {
  private pending: NavigationSnapshot | null = null;
  private selection: NavigationSnapshot | null = null;
  begin(scope: NavigationScope, mediaId?: string) {
    this.selection = null;
    return this.pending = { ...capture(scope), mediaId };
  }
  current(request: NavigationSnapshot, scope: NavigationScope) {
    if (this.pending !== request || !sameScope(request, scope) || request.intent !== scope.state.intentVersion) return false;
    const context = scope.state.getContext();
    if (request.context?.mediaId === context?.mediaId && request.context?.channelIndex === context?.channelIndex) return true;
    // Only an absent context may be established by revealing the first pane.
    // Once established, another pane/channel interaction supersedes the request.
    if (!request.context && context?.mediaId === request.mediaId) { request.context = context; return true; }
    this.finish(request);
    return false;
  }
  applied(request: NavigationSnapshot, scope: NavigationScope) {
    if (this.pending !== request || !sameScope(request, scope)) return;
    this.pending = null;
    this.selection = capture(scope);
  }
  suppresses(scope: NavigationScope) {
    if (this.selection && matches(this.selection, scope)) return true;
    // Revealing the first visible pane may passively establish its context before
    // the reveal promise resolves. That context still belongs to this list intent.
    return !!this.pending?.mediaId && this.current(this.pending, scope) && scope.state.getContext()?.mediaId === this.pending.mediaId;
  }
  finish(request: NavigationSnapshot) { if (this.pending === request) this.pending = null; }
  cancel() { this.pending = null; this.selection = null; }
}
