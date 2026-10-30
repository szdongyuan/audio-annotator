import { expect, it } from 'vitest';
import { SelectionState } from '../features/selection/state';
import { ListNavigation, type NavigationScope } from './listNavigation';

function setup() {
  const state = new SelectionState(); state.interact({ mediaId: 'a', channelIndex: null });
  const scope: NavigationScope = { owner: {}, authorId: 'author', state };
  return { state, scope, navigation: new ListNavigation() };
}
it('only the newest request in the same runtime, identity and live intent remains valid', () => {
  const { navigation, scope, state } = setup();
  const old = navigation.begin(scope), next = navigation.begin(scope);
  expect(navigation.current(old, scope)).toBe(false); expect(navigation.current(next, scope)).toBe(true);
  expect(navigation.current(next, { ...scope, owner: {} })).toBe(false);
  expect(navigation.current(next, { ...scope, authorId: 'other' })).toBe(false);
  expect(navigation.current(next, { ...scope, runtimeNonce: 'new-runtime' })).toBe(false);
  expect(navigation.current(next, { ...scope, state: new SelectionState() })).toBe(false);
  state.select(null); expect(navigation.current(next, scope)).toBe(false);
});
it('suppresses exactly the applied selection, tolerates equal passive context and observes same-target intent', () => {
  const { navigation, scope, state } = setup(), request = navigation.begin(scope);
  state.select(null); state.interact({ mediaId: 'a', channelIndex: 1 });
  navigation.applied(request, scope);
  expect(navigation.suppresses(scope)).toBe(true);
  state.interact({ mediaId: 'a', channelIndex: 1 }); expect(navigation.suppresses(scope)).toBe(true);
  state.select(null); expect(navigation.suppresses(scope)).toBe(false);
});
it('does not suppress changed objects, contexts, identities or owners', () => {
  const { navigation, scope, state } = setup();
  const request = navigation.begin(scope); navigation.applied(request, scope);
  expect(navigation.suppresses({ ...scope, authorId: 'other' })).toBe(false);
  expect(navigation.suppresses({ ...scope, owner: {} })).toBe(false);
  state.interact({ mediaId: 'b', channelIndex: null }); expect(navigation.suppresses(scope)).toBe(false);
});
it('failure, cancellation and a replaced completion cannot leave suppression for later operations', () => {
  const { navigation, scope } = setup();
  const old = navigation.begin(scope); navigation.finish(old); expect(navigation.suppresses(scope)).toBe(false);
  const next = navigation.begin(scope); navigation.applied(old, scope); expect(navigation.current(next, scope)).toBe(true); expect(navigation.suppresses(scope)).toBe(false);
  navigation.cancel(); expect(navigation.current(next, scope)).toBe(false); navigation.applied(next, scope); expect(navigation.suppresses(scope)).toBe(false);
});

it('allows passive context reconciliation while reveal is pending, but still rejects a newer selection intent', () => {
  const { navigation, scope, state } = setup();
  state.interact(null);
  const request = navigation.begin(scope, 'revealed');
  state.interact({ mediaId: 'revealed', channelIndex: 0 });
  expect(navigation.current(request, scope)).toBe(true);
  state.interact({ mediaId: 'revealed', channelIndex: 1 });
  expect(navigation.current(request, scope)).toBe(false);
  state.interact({ mediaId: 'revealed', channelIndex: 0 });
  expect(navigation.current(request, scope)).toBe(false);
});

it.each([{ mediaId: 'c', channelIndex: 0 }, { mediaId: 'a', channelIndex: 1 }, { mediaId: 'b', channelIndex: 0 }])('rejects a context-only interaction to %j during reveal', context => {
  const { navigation, scope, state } = setup(), request = navigation.begin(scope, 'b');
  state.interact(context);
  expect(navigation.current(request, scope)).toBe(false);
  expect(navigation.suppresses(scope)).toBe(false);
  state.interact({ mediaId: 'a', channelIndex: null });
  expect(navigation.current(request, scope)).toBe(false);
});
