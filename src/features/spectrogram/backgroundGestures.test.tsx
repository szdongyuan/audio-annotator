import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fixture from '../../../tests/fixtures/document-v3.json';
import { ProjectStore } from '../../app/store';
import { CommandQueue } from '../../app/commands';
import { ProjectLifecycle } from '../project/lifecycle';
import { AxisRulers } from './AxisRulers';
import { CompareSplitter } from './CompareSplitter';
import { defaultView } from './workspace';

function lifecycle() {
 const store = new ProjectStore({ document: structuredClone(fixture) as never, canUndo: false, canRedo: false });
 const queue = new CommandQueue(store, { applyChange: vi.fn(), getSnapshot: async () => store.snapshot, undo: vi.fn(), redo: vi.fn() });
 return new ProjectLifecycle(store, queue, { save: async (_id, revision) => revision, close: async () => {} });
}
function controls(kind: 'ruler' | 'splitter', owner: ProjectLifecycle) {
 const background = { lifecycle: owner };
 return kind === 'ruler'
  ? <AxisRulers {...background} owner={owner} view={defaultView(fixture.media[0])} nyquist={24000} timeLimit={2} onView={vi.fn()} />
  : <div><CompareSplitter {...background} layout="horizontal" value={.5} disabled={false} onChange={vi.fn()} /></div>;
}
beforeEach(() => {
 vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
 vi.stubGlobal('PointerEvent', MouseEvent);
 vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, width: 800, height: 300, right: 800, bottom: 300, toJSON() {} });
 HTMLElement.prototype.setPointerCapture = vi.fn(); HTMLElement.prototype.releasePointerCapture = vi.fn(); HTMLElement.prototype.hasPointerCapture = () => true;
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

for (const kind of ['ruler', 'splitter'] as const) {
 it.each(['up', 'cancel', 'capture loss', 'unmount'] as const)(`${kind} defers background adoption during drag and releases on %s`, async ending => {
  const owner = lifecycle(), view = render(controls(kind, owner));
  const target = kind === 'ruler' ? screen.getByLabelText('时间刻度（秒）') : screen.getByRole('separator');
  expect(owner.allowsBackgroundTransition).toBe(true);
  fireEvent.pointerDown(target, { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
  expect(owner.allowsBackgroundTransition).toBe(false);
  const adopt = vi.fn(); await owner.transitionAfterSave(adopt, () => owner.allowsBackgroundTransition);
  expect(adopt).not.toHaveBeenCalled(); expect(owner.store.editingDisabled).toBe(false);
  if (ending === 'up') fireEvent.pointerUp(target, { button: 0, pointerId: 1, clientX: 200, clientY: 100 });
  else if (ending === 'cancel') fireEvent.pointerCancel(target, { pointerId: 1 });
  else if (ending === 'capture loss') fireEvent(target, new Event('lostpointercapture', { bubbles: true }));
  else view.unmount();
  expect(owner.allowsBackgroundTransition).toBe(true);
  await owner.transitionAfterSave(adopt, () => owner.allowsBackgroundTransition); expect(adopt).toHaveBeenCalledOnce();
  view.unmount(); owner.dispose();
 });

 it(`${kind} removes the old guard and starts idle after runtime replacement`, () => {
  const first = lifecycle(), second = lifecycle(), view = render(controls(kind, first));
  const target = kind === 'ruler' ? screen.getByLabelText('时间刻度（秒）') : screen.getByRole('separator');
  fireEvent.pointerDown(target, { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
  expect(first.allowsBackgroundTransition).toBe(false);
  view.rerender(controls(kind, second));
  expect(first.allowsBackgroundTransition).toBe(true); expect(second.allowsBackgroundTransition).toBe(true);
  view.unmount(); first.dispose(); second.dispose();
 });
}
