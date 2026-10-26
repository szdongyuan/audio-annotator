import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/react';
import fixture from '../../../tests/fixtures/document-v3.json';
import type { MediaDescriptor, ViewState } from '../../bridge/types';
import { defaultView, changeView, toggleLinked, analysisError, tilePlan, analysisKey } from './workspace';
import { TileCache } from './tileCache';
import { AnalysisSettings } from './AnalysisSettings';
const media = { ...fixture.media[0], channelCount: 6, channelNotes: Array(6).fill(''), channelCategoryIds: Array(6).fill(null), channelLayout: null } as MediaDescriptor;
const short = { ...media, id: 'other', frameCount: 22050, sampleRate: 22050 };
describe('workspace semantics', () => {
  it('defaults to first two actual channels and each file keeps its Nyquist', () => {
    expect(defaultView(media).visibleChannels).toEqual([0, 1]); expect(defaultView({ ...media, channelCount: 1 }).visibleChannels).toEqual([0]);
    expect(defaultView(short).highHz).toBe(11025);
  });
  it('links seconds without stretching short data, unlink clamps every view', () => {
    const state: ViewState = { compareLayout: 'horizontal', compareSplit: .5, media: { [media.id]: defaultView(media), other: defaultView(short) }, activeMediaId: media.id, compareMediaId: 'other', linkedTime: false };
    const linked = toggleLinked(state, [media, short], true);
    const moved = changeView(linked, [media, short], media.id, { startSeconds: .4, endSeconds: 1.8, gainDb: 8 });
    expect(moved.media.other.endSeconds).toBe(1.8); expect(moved.media.other.gainDb).toBe(0); expect(moved.media.other.highHz).toBe(11025);
    const unlinked = toggleLinked(moved, [media, short], false);
    expect(unlinked.media.other.endSeconds).toBe(1); expect(unlinked.media.other.startSeconds).toBe(0);
  });
  it('validates real STFT and mel combinations before committing', () => {
    const s = fixture.analysis[media.id as keyof typeof fixture.analysis];
    expect(analysisError(s)).toBeNull();
    for (const change of [{ hopSize: 0 }, { windowSize: 63 }, { fftSize: 2000 }, { fftSize: 1024 }, { melBands: 513 }]) expect(analysisError({ ...s, ...change })).toBeTruthy();
  });
  it('bounds linked time by the displayed pair when either file is replaced', () => {
    const long = { ...media, id: 'long', frameCount: 600 * media.sampleRate };
    const two = { ...media, id: 'two' };
    const state: ViewState = { compareLayout: 'horizontal', compareSplit: .5, media: {
      [short.id]: { ...defaultView(short), startSeconds: 100, endSeconds: 110 },
      [long.id]: { ...defaultView(long), startSeconds: 100, endSeconds: 110 },
      [two.id]: { ...defaultView(two), startSeconds: 100, endSeconds: 110 },
    }, activeMediaId: short.id, compareMediaId: long.id, linkedTime: true };
    for (const changed of [{ ...state, compareMediaId: two.id }, { ...state, activeMediaId: two.id, compareMediaId: short.id }]) {
      const next = toggleLinked(changed, [short, long, two], true);
      expect(next.media[short.id]).toMatchObject({ startSeconds: 0, endSeconds: 2 });
      expect(next.media[two.id]).toMatchObject({ startSeconds: 0, endSeconds: 2 });
      expect(next.media[long.id]).toMatchObject({ startSeconds: 100, endSeconds: 110 });
    }
  });
  it('uses stable default frequency data and bounded high-FFT refinement partitions', () => {
    const s = { window: 'hann' as const, windowSize: 2048, hopSize: 512, fftSize: 2048, melBands: 128 };
    const full = tilePlan(media, s, defaultView(media), 800, 0, 'hash');
    for (const range of [[100, 8000], [1500, 3000], [16000, 20000]]) {
      expect(tilePlan(media, s, { ...defaultView(media), lowHz: range[0], highHz: range[1] }, 800, 0, 'hash')).toEqual(full);
    }
    const large = { ...s, fftSize: 65536 };
    const refined = tilePlan(media, large, { ...defaultView(media), lowHz: 100, highHz: 400 }, 800, 0, 'large');
    expect(refined.every(r => r.frequencyLod === 0)).toBe(true);
    expect(refined.every(r => r.frequencyStart >= 0 && r.frequencyStart + r.frequencyCount <= 32769 && r.frequencyCount <= 1025)).toBe(true);
    expect(tilePlan(media, large, { ...defaultView(media), lowHz: 120, highHz: 410 }, 800, 0, 'large')).toEqual(refined);
  });
  it('plans bounded aligned tiles for visible seconds plus adjacent low priority prefetch', () => {
    const s = { window: 'hann' as const, windowSize: 2048, hopSize: 512, fftSize: 65536, melBands: 128 };
    const long = { ...media, frameCount: 48000 * 600 };
    const requests = tilePlan(long, s, { ...defaultView(long), startSeconds: 100, endSeconds: 110 }, 800, 0, 'hash');
    expect(requests.some(r => !r.visible)).toBe(true);
    for (const r of requests) expect(r.frameCount * Math.ceil(r.frequencyCount / 2 ** r.frequencyLod) * 4 + 16384).toBeLessThanOrEqual(4194304);
    for (const r of requests) expect(Math.ceil(r.frequencyCount / 2 ** r.frequencyLod)).toBeLessThanOrEqual(1025);
    expect(requests.filter(r => r.visible).every(r => r.startFrame * 512 / 48000 < 110)).toBe(true);
    expect(tilePlan(short, s, { ...defaultView(short), startSeconds: 1.2, endSeconds: 2 }, 800, 0, 'hash')).toEqual([]);
    expect(analysisKey(s)).toBe(analysisKey({ ...s }));
  });
  it('evicts least recently used entries under one byte budget', () => {
    const cache = new TileCache<number>(10);
    cache.set('a', 1, 4); cache.set('b', 2, 4); cache.get('a'); cache.set('c', 3, 4);
    expect(cache.get('b')).toBeUndefined(); expect(cache.get('a')).toBe(1); expect(cache.bytes).toBe(8);
    cache.set('large', 4, 11); expect(cache.bytes).toBeLessThanOrEqual(10);
  });
});
it('keeps invalid settings out of apply, exposes samples/ms and disables mel-only axis mixing by file mode', () => {
  const onApply = vi.fn(), onView = vi.fn();
  const settings = { window: 'hann' as const, windowSize: 2048, hopSize: 512, fftSize: 2048, melBands: 128 };
  render(<AnalysisSettings media={media} settings={settings} view={defaultView(media)} disabled={false} onApply={onApply} onView={onView} onClose={() => {}} />);
  expect(screen.getAllByText(/2048 samples · 42.67 ms/)).toHaveLength(2);
  fireEvent.change(screen.getByRole('spinbutton', { name: '步长' }), { target: { value: '2049' } });
  expect(screen.getByRole('button', { name: '应用分析参数' })).toBeDisabled(); expect(screen.getByRole('alert')).toHaveTextContent('步长');
  fireEvent.change(screen.getByRole('spinbutton', { name: '步长' }), { target: { value: '1024' } });
  fireEvent.click(screen.getByRole('button', { name: '应用分析参数' }));
  expect(onApply).toHaveBeenCalledWith({ ...settings, hopSize: 1024 });
  fireEvent.change(screen.getByRole('slider', { name: '显示增益' }), { target: { value: '12' } });
  expect(onView).toHaveBeenCalledWith({ gainDb: 12 }); expect(onApply).toHaveBeenCalledTimes(1);
});
it('chooses time detail from actual backing width instead of an implicit 1024 cap', () => {
  const s = { window: 'hann' as const, windowSize: 2048, hopSize: 512, fftSize: 2048, melBands: 128 };
  const long = { ...media, frameCount: 48000 * 600 };
  const v = { ...defaultView(long), spectrumKind: 'mel' as const, endSeconds: 16 };
  expect(tilePlan(long, s, v, 1920, 0, 'h')[0].timeLod).toBe(0);
  expect(tilePlan(long, s, v, 800, 0, 'h')[0].timeLod).toBe(1);
});
it('requires real one-row neighbors at a time tile edge and grouped frequency neighbors', () => {
  const s = { window: 'hann' as const, windowSize: 2048, hopSize: 512, fftSize: 65536, melBands: 128 };
  const long = { ...media, frameCount: 48000 * 600 };
  const v = { ...defaultView(long), spectrumKind: 'mel' as const, startSeconds: 256 * 512 / 48000, endSeconds: 512 * 512 / 48000 };
  const visible = tilePlan(long, s, v, 800, 0, 'h').filter(r => r.visible);
  expect(visible.some(r => r.startFrame === 512 && r.frameCount === 1)).toBe(true);
  const hz = (k: number) => k * 48000 / s.fftSize;
  const band = tilePlan(long, s, { ...defaultView(long), lowHz: hz(4100), highHz: hz(8198) }, 800, 0, 'h').filter(r => r.visible);
  const step = 2 ** band[0].frequencyLod;
  expect(Math.min(...band.map(r => r.frequencyStart)) + (step - 1) / 2).toBeLessThanOrEqual(4100);
  expect(Math.max(...band.map(r => r.frequencyStart + r.frequencyCount)) - (step + 1) / 2).toBeGreaterThanOrEqual(8198);
});
