import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AxisRulers } from './AxisRulers';
import { wheelViewPatch } from './wheel';
import { coordinates } from './coordinates';
import { defaultSettings, defaultView } from './workspace';
import fixture from '../../../tests/fixtures/document-v2.json';
import { SpectrogramCanvas } from './SpectrogramCanvas';
import type { ActiveProject } from '../project/useProjectLifecycle';
const media = fixture.media[0], view = { ...defaultView(media), startSeconds: 10, endSeconds: 30, lowHz: 100, highHz: 10000 };
let resize: ResizeObserverCallback;
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { constructor(cb: ResizeObserverCallback) { resize = cb; } observe() {} disconnect() {} });
  vi.stubGlobal('PointerEvent', MouseEvent);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) { return { x: 20, y: 30, left: 20, top: 30, width: this.className === 'frequency-ruler' ? 42 : 800, height: this.className === 'time-ruler' ? 23 : 300, right: 820, bottom: 330, toJSON() {} }; });
  HTMLElement.prototype.setPointerCapture = vi.fn(); HTMLElement.prototype.releasePointerCapture = vi.fn(); HTMLElement.prototype.hasPointerCapture = () => true;
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const wheel = (patch = {}) => ({ deltaY: 100, deltaMode: 0, ctrlKey: false, shiftKey: false, ...patch });
it('normalizes pixel/line/page, prioritizes Ctrl, and clamps continuous STFT mixing', () => {
  for (const [deltaY, deltaMode] of [[16, 0], [1, 1], [16 / 300, 2]]) expect(wheelViewPatch(view, 100, 24000, wheel({ deltaY, deltaMode, ctrlKey: true, shiftKey: true }), .4, .4, 300)).toEqual({ frequencyMix: view.frequencyMix - .008 });
  expect(wheelViewPatch(view, 100, 24000, wheel({ ctrlKey: true, deltaY: -.25 }), .5, .5, 300)).toEqual({ frequencyMix: view.frequencyMix + .000125 });
  for (const [deltaY, frequencyMix] of [[1e6, 0], [-1e6, 1]]) expect(wheelViewPatch(view, 100, 24000, wheel({ ctrlKey: true, deltaY }), .5, .5, 300)).toEqual({ frequencyMix });
  expect(wheelViewPatch({ ...view, spectrumKind: 'mel' }, 100, 24000, wheel({ ctrlKey: true }), .5, .5, 300)).toBeNull();
});
it('ordinary/Shift wheel preserves its physical anchor and only patches the chosen axis', () => {
  for (const shiftKey of [false, true]) {
    const patch = wheelViewPatch(view, 100, 24000, wheel({ deltaY: -120, shiftKey }), .4, .3, 300)!;
    expect(Object.keys(patch).sort()).toEqual(shiftKey ? ['highHz', 'lowHz'] : ['endSeconds', 'startSeconds']);
    const before = coordinates(view, 24000, 800, 300), after = coordinates({ ...view, ...patch }, 24000, 800, 300);
    expect(after.xToSeconds(320)).toBeCloseTo(before.xToSeconds(320), 7); expect(after.yToHz(90)).toBeCloseTo(before.yToHz(90), 7);
  }
});
vi.mock('./useTiles', () => ({ useTiles: () => ({ keys: [], total: 0, completed: 0, phase: '', error: null }) }));
it('cancels browser Ctrl zoom in Mel without a view update', () => {
  const onView = vi.fn();
  render(<SpectrogramCanvas active={{ store: { editingDisabled: false } } as ActiveProject} media={media} settings={defaultSettings} view={{ ...view, spectrumKind: 'mel' }} channel={0} status="ready" timeLimit={100} onView={onView} />);
  const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: 100 });
  fireEvent(screen.getByLabelText('通道 1 频谱'), event); expect(event.defaultPrevented).toBe(true); expect(onView).not.toHaveBeenCalled();
});
function mount() { const onView = vi.fn(); const result = render(<AxisRulers view={view} nyquist={24000} timeLimit={100} onView={onView} />); return { ...result, onView, time: screen.getByLabelText('时间刻度（秒）'), frequency: screen.getByLabelText('频率刻度（Hz）') }; }
it('uses measured sizes and start-time mapping for reverse/clamped axis-only drags at the 6px threshold', () => {
  const s = mount();
  act(() => resize([{ target: s.time, contentRect: { width: 800, height: 23 } }, { target: s.frequency, contentRect: { width: 42, height: 300 } }] as unknown as ResizeObserverEntry[], {} as ResizeObserver));
  expect(s.time.querySelectorAll('[data-tick]')).not.toHaveLength(0);
  fireEvent.pointerDown(s.time, { button: 0, clientX: 220 }); fireEvent.pointerUp(s.time, { clientX: 225 }); expect(s.onView).not.toHaveBeenCalled();
  fireEvent.pointerDown(s.time, { button: 0, clientX: 220 }); fireEvent.pointerUp(s.time, { clientX: 226 }); expect(s.onView).toHaveBeenLastCalledWith({ startSeconds: 15, endSeconds: 15.15 });
  fireEvent.pointerDown(s.time, { button: 0, clientX: 620 });
  s.rerender(<AxisRulers view={{ ...view, startSeconds: 0, endSeconds: 100 }} nyquist={24000} timeLimit={100} onView={s.onView} />);
  fireEvent.pointerUp(s.time, { clientX: -30 }); expect(s.onView).toHaveBeenLastCalledWith({ startSeconds: 10, endSeconds: 25 });
  fireEvent.pointerDown(s.frequency, { button: 0, clientY: 270 }); fireEvent.pointerUp(s.frequency, { clientY: -50 });
  const patch = s.onView.mock.lastCall![0], c = coordinates(view, 24000, 800, 300);
  expect(Object.keys(patch).sort()).toEqual(['highHz', 'lowHz']); expect(patch.highHz).toBeCloseTo(view.highHz, 7); expect(patch.lowHz).toBeCloseTo(c.yToHz(240), 7);
});
it('cancels capture/Escape without edits and blocks disabled rulers', () => {
  const s = mount();
  for (const cancel of ['pointerCancel', 'lostPointerCapture', 'keyDown'] as const) {
    fireEvent.pointerDown(s.time, { button: 0, clientX: 100 }); fireEvent.pointerMove(s.time, { clientX: 600 });
    fireEvent[cancel](s.time, { key: 'Escape' }); fireEvent.pointerUp(s.time, { clientX: 600 });
  }
  expect(s.onView).not.toHaveBeenCalled();
  s.rerender(<AxisRulers view={view} nyquist={24000} timeLimit={100} onView={s.onView} disabled />);
  fireEvent.pointerDown(s.time, { button: 0, clientX: 100 }); fireEvent.pointerUp(s.time, { clientX: 600 }); expect(s.onView).not.toHaveBeenCalled();
});
it('opens anchored axis menus, resets only that axis and disables Mel mixing with an explanation', () => {
  const s = mount();
  fireEvent.contextMenu(s.time, { clientX: 340, clientY: 40 }); fireEvent.click(screen.getByRole('menuitem', { name: '放大时间轴' }));
  expect(s.onView).toHaveBeenLastCalledWith({ startSeconds: 14, endSeconds: 24 });
  fireEvent.contextMenu(s.frequency, { clientX: 25, clientY: 180 }); fireEvent.click(screen.getByRole('menuitem', { name: '重置频率轴' })); expect(s.onView).toHaveBeenLastCalledWith({ lowHz: 0, highHz: 24000 });
  fireEvent.contextMenu(s.frequency); fireEvent.click(screen.getByRole('menuitem', { name: '完全线性' })); expect(s.onView).toHaveBeenLastCalledWith({ frequencyMix: 0 });
  s.rerender(<AxisRulers view={{ ...view, spectrumKind: 'mel' }} nyquist={24000} timeLimit={100} onView={s.onView} />);
  fireEvent.contextMenu(s.frequency); expect(screen.getByRole('menuitem', { name: '完全对数' })).toHaveAttribute('aria-disabled', 'true'); expect(screen.getByRole('menuitem', { name: '完全对数' })).toHaveAttribute('title', '梅尔频谱使用固定梅尔映射');
});
it('retires captures and menus when the runtime owner changes with the same media/view', () => {
  const onView = vi.fn(), first = {}, second = {};
  const s = render(<AxisRulers owner={first} view={view} nyquist={24000} timeLimit={100} onView={onView} />);
  const time = screen.getByLabelText('时间刻度（秒）');
  fireEvent.pointerDown(time, { button: 0, clientX: 100 });
  s.rerender(<AxisRulers owner={second} view={view} nyquist={24000} timeLimit={100} onView={onView} />);
  fireEvent.pointerUp(time, { clientX: 600 }); expect(onView).not.toHaveBeenCalled();
  fireEvent.contextMenu(time);
  s.rerender(<AxisRulers owner={first} view={view} nyquist={24000} timeLimit={100} onView={onView} />);
  expect(screen.queryByRole('menu')).not.toBeInTheDocument();
});
