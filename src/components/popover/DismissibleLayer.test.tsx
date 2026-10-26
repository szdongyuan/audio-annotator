import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import fixture from '../../../tests/fixtures/document-v3.json';
import type { AnalysisSettings as Settings, MediaDescriptor } from '../../bridge/types';
import { AnalysisSettings } from '../../features/spectrogram/AnalysisSettings';
import { defaultView, defaultSettings } from '../../features/spectrogram/workspace';

function Harness({ outside = vi.fn(), apply = vi.fn() }) {
  const [id, setId] = useState<string | null>(null), [view, setView] = useState(defaultView(fixture.media[0] as MediaDescriptor));
  return <><button data-analysis-trigger onClick={() => setId(id === 'a' ? null : 'a')}>A settings</button><button data-analysis-trigger onClick={() => setId(id === 'b' ? null : 'b')}>B settings</button>
    <button onPointerDown={outside} onClick={outside}>underneath</button>
    <output>{view.gainDb}</output>
    {id && <AnalysisSettings key={id} media={{ ...fixture.media[0], id, displayName: id } as MediaDescriptor} settings={defaultSettings} view={view} disabled={false} onApply={apply} onView={patch => setView(v => ({ ...v, ...patch }))} onClose={() => setId(null)} />}</>;
}
function pointerClick(element: HTMLElement) { fireEvent.pointerDown(element, { pointerId: 1 }); fireEvent.pointerUp(element, { pointerId: 1 }); fireEvent.click(element); }
it('consumes the outside pointer sequence and discards unapplied compute drafts while preserving display', () => {
  const outside = vi.fn(), apply = vi.fn(); render(<Harness outside={outside} apply={apply} />);
  pointerClick(screen.getByText('A settings'));
  fireEvent.change(screen.getByRole('spinbutton', { name: '步长' }), { target: { value: '999' } });
  fireEvent.change(screen.getByRole('slider', { name: '显示增益' }), { target: { value: '12' } });
  pointerClick(screen.getByText('underneath'));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); expect(outside).not.toHaveBeenCalled(); expect(apply).not.toHaveBeenCalled();
  pointerClick(screen.getByText('A settings'));
  expect(screen.getByRole('spinbutton', { name: '步长' })).toHaveValue(defaultSettings.hopSize);
  expect(screen.getByRole('slider', { name: '显示增益' })).toHaveValue('12');
});
it('keeps internal pointer drags and native selects open; Escape closes and restores the trigger', () => {
  render(<Harness />); const trigger = screen.getByText('A settings'); trigger.focus(); pointerClick(trigger);
  const slider = screen.getByRole('slider', { name: '显示增益' });
  fireEvent.pointerDown(slider, { pointerId: 1 }); fireEvent.pointerUp(screen.getByText('underneath'), { pointerId: 1 });
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  const select = screen.getByLabelText('窗函数'); pointerClick(select); fireEvent.change(select, { target: { value: 'hamming' } });
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  slider.focus(); fireEvent.keyDown(slider, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); expect(trigger).toHaveFocus();
});
it('toggles the same trigger and switches directly to a different file trigger', () => {
  render(<Harness />); pointerClick(screen.getByText('A settings')); pointerClick(screen.getByText('B settings'));
  expect(screen.getByRole('dialog', { name: 'b 分析设置' })).toBeInTheDocument();
  pointerClick(screen.getByText('B settings')); expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});
it('leaves blocking decisions to their own dialog handlers', () => {
  const decision = vi.fn(), key = vi.fn();
  const ui = render(<Harness />); pointerClick(screen.getByText('A settings'));
  ui.rerender(<><Harness /><div role="dialog" aria-modal="true" aria-label="恢复决策" onKeyDown={key}><button onClick={decision}>恢复项目</button></div></>);
  pointerClick(screen.getByText('恢复项目'));
  expect(decision).toHaveBeenCalledOnce(); expect(screen.getByRole('dialog', { name: 'a 分析设置' })).toBeInTheDocument();
  fireEvent.keyDown(screen.getByText('恢复项目'), { key: 'Escape' }); expect(key).toHaveBeenCalledOnce();
});

function SnapshotSettings({ authority }: { authority: Settings }) {
  const media = fixture.media[0] as MediaDescriptor;
  const [view, setView] = useState(defaultView(media));
  // Native snapshots parse analysis objects afresh, including on view-only saves.
  return <AnalysisSettings media={media} settings={{ ...authority }} view={view} disabled={false} onApply={vi.fn()} onView={patch => setView(v => ({ ...v, ...patch }))} onClose={vi.fn()} />;
}
it('preserves unapplied compute drafts across display changes and equal cloned authority snapshots', () => {
  const ui = render(<SnapshotSettings authority={defaultSettings} />), dialog = screen.getByRole('dialog');
  fireEvent.change(screen.getByRole('spinbutton', { name: '步长' }), { target: { value: '777' } });
  fireEvent.change(screen.getByRole('slider', { name: '显示增益' }), { target: { value: '12' } });
  expect(screen.getByRole('spinbutton', { name: '步长' })).toHaveValue(777);
  ui.rerender(<SnapshotSettings authority={{ ...defaultSettings }} />);
  expect(screen.getByRole('spinbutton', { name: '步长' })).toHaveValue(777);
  expect(screen.getByRole('slider', { name: '显示增益' })).toHaveValue('12');
  expect(screen.getByRole('dialog')).toBe(dialog);
});
it('resets compute drafts when authoritative analysis values actually change without remounting the layer', () => {
  const ui = render(<SnapshotSettings authority={defaultSettings} />), dialog = screen.getByRole('dialog');
  fireEvent.change(screen.getByRole('spinbutton', { name: '步长' }), { target: { value: '777' } });
  ui.rerender(<SnapshotSettings authority={{ window: 'hamming', windowSize: 1024, hopSize: 256, fftSize: 4096, melBands: 64 }} />);
  expect(screen.getByLabelText('窗函数')).toHaveValue('hamming');
  for (const [label, value] of [['窗长', 1024], ['步长', 256], ['FFT 长度', 4096], ['梅尔频带', 64]] as const) expect(screen.getByRole('spinbutton', { name: label })).toHaveValue(value);
  expect(screen.getByRole('dialog')).toBe(dialog);
});
