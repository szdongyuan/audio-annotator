import { describe, expect, it, vi } from 'vitest';
import fixture from '../../tests/fixtures/document-v2.json';
import { parseProjectDocument, parseProjectSnapshot, parseChange, parseAppError } from './types';
import { folderClient, parseFolderEvent, parseFolderPage, parseScanToken } from './folders';

const nativeInvoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke: nativeInvoke, Channel: class { onmessage?: (value: unknown) => void } }));

it('folder client validates actual invocation responses and defaults to nonrecursive discovery', async () => {
  nativeInvoke.mockResolvedValue(scanToken);
  const receive = vi.fn();
  expect(await folderClient.start(fixture.projectId, 'C:\\audio', receive)).toEqual(scanToken);
  const [command, args] = nativeInvoke.mock.calls.at(-1)!;
  expect(command).toBe('scan_folder'); expect(args.recursive).toBe(false);
  args.onEvent.onmessage({ type: 'cancelled', token: scanToken }); expect(receive).toHaveBeenCalledOnce();
  expect(() => args.onEvent.onmessage({ type: 'cancelled', token: scanToken, extra: true })).toThrow();
  expect(receive).toHaveBeenCalledOnce();
  const page = { token: scanToken, kind: 'candidates', offset: 0, total: 1, candidates: [{ path: 'C:\\audio\\a.wav', relativePath: 'a.wav' }], issues: [] };
  nativeInvoke.mockResolvedValue(page); expect(await folderClient.page(scanToken, 'candidates', 0)).toEqual(page);
  for (const bad of [
    { ...page, token: { ...scanToken, ownerId: fixture.projectId } },
    { ...page, offset: 1, total: 2 }, { ...page, total: 2 },
  ]) { nativeInvoke.mockResolvedValue(bad); await expect(folderClient.page(scanToken, 'candidates', 0)).rejects.toThrow(); }
  nativeInvoke.mockResolvedValue({ taskId: 'bad' });
  await expect(folderClient.start(fixture.projectId, 'C:\\audio', receive)).rejects.toThrow();
  nativeInvoke.mockResolvedValue(undefined);
  await folderClient.cancel(scanToken); expect(nativeInvoke).toHaveBeenLastCalledWith('cancel_folder_scan', { token: scanToken });
  await folderClient.release(scanToken); expect(nativeInvoke).toHaveBeenLastCalledWith('release_folder_scan', { token: scanToken });
});

const scanToken = { taskId: '11111111-1111-4111-8111-111111111111', ownerId: '22222222-2222-4222-8222-222222222222' };
const scanCounts = { checked: 12, candidates: 3, existing: 2, skipped: 7, failed: 0, issues: 9 };
it('strictly validates every folder event, token, bounded page and nested field', () => {
  const events = [
    { type: 'progress', token: scanToken, counts: scanCounts },
    { type: 'result', token: scanToken, root: 'C:\\audio', counts: scanCounts, retainedIssues: 9 },
    { type: 'cancelled', token: scanToken },
    { type: 'failed', token: scanToken, error: { code: 'ResourceLimit', message: 'too large', retryable: false } },
  ];
  for (const event of events) {
    expect(parseFolderEvent(event)).toEqual(event);
    expect(() => parseFolderEvent({ ...event, unexpected: true })).toThrow();
    for (const field of Object.keys(event)) { const bad = { ...event } as Record<string, unknown>; delete bad[field]; expect(() => parseFolderEvent(bad)).toThrow(); }
  }
  for (const bad of [{ ...scanToken, taskId: 'bad' }, { taskId: scanToken.taskId }, { ...scanToken, ownerId: null }, { ...scanToken, extra: 1 }]) expect(() => parseScanToken(bad)).toThrow();
  for (const counts of [{ ...scanCounts, checked: 100001 }, { ...scanCounts, candidates: 10001 }, { ...scanCounts, skipped: NaN }, { ...scanCounts, existing: -1 }, { ...scanCounts, issues: 1.5 }, { ...scanCounts, extra: 1 }]) expect(() => parseFolderEvent({ ...events[0], counts })).toThrow();
  const candidate = { path: 'C:\\audio\\a.wav', relativePath: 'a.wav' };
  const page = { token: scanToken, kind: 'candidates', offset: 0, total: 1, candidates: [candidate], issues: [] };
  expect(parseFolderPage(page)).toEqual(page);
  const issue = { path: 'C:\\audio\\bad.wav', kind: 'access', message: 'denied' };
  expect(parseFolderPage({ ...page, kind: 'issues', candidates: [], issues: [issue] }).issues).toEqual([issue]);
  for (const bad of [
    { ...page, candidates: Array(257).fill(candidate), total: 257 }, { ...page, total: 0 }, { ...page, offset: 2 },
    { ...page, issues: [issue] }, { ...page, candidates: [{ ...candidate, path: 'relative.wav' }] },
    { ...page, candidates: [{ ...candidate, relativePath: '../escape.wav' }] },
    { ...page, candidates: [{ ...candidate, extra: true }] }, { ...page, kind: 'future' },
    { ...page, kind: 'issues', candidates: [], issues: [{ ...issue, kind: 'future' }] },
  ]) expect(() => parseFolderPage(bad)).toThrow();
  expect(() => parseFolderEvent({ ...events[1], retainedIssues: 257 })).toThrow();
});

describe('shared Rust/TypeScript document contract', () => {
  it('accepts the versioned fixture without losing semantic fields', () => {
    expect(parseProjectDocument(fixture)).toEqual(fixture);
    expect(parseProjectSnapshot({ document: fixture, canUndo: true, canRedo: false }).document).toEqual(fixture);
    expect(parseChange({ type: 'updatePlaybackMix', mediaId: fixture.media[0].id, mix: { soloChannels: [1], mutedChannels: [] } }).type).toBe('updatePlaybackMix');
    expect(parseAppError({ code: 'RevisionConflict', message: 'Refresh', retryable: false }).code).toBe('RevisionConflict');
  });
  it('rejects versions, unknown fields, malformed references and non-finite bounds', () => {
    for (const mutate of [
      (d: typeof fixture) => { d.formatVersion = 3; },
      (d: typeof fixture) => { d.annotations[0].region.highHz = Infinity; },
      (d: typeof fixture) => { d.annotations[0].region.channelIndex = 2; },
      (d: typeof fixture) => { d.annotations[0].categoryId = fixture.projectId; },
      (d: typeof fixture) => { d.analysis[fixture.media[0].id as keyof typeof d.analysis].hopSize = 0; },
      (d: typeof fixture) => { d.playbackMix[fixture.media[0].id as keyof typeof d.playbackMix].soloChannels = [1, 1]; },
    ]) {
      const invalid = structuredClone(fixture); mutate(invalid);
      expect(() => parseProjectDocument(invalid)).toThrow();
    }
    expect(() => parseProjectDocument({ ...fixture, playbackState: 'playing' })).toThrow();
    expect(() => parseChange({ type: 'deleteEverything' })).toThrow();
    expect(() => parseChange({ type: 'updateAnalysis', mediaId: fixture.media[0].id, settings: { ...Object.values(fixture.analysis)[0], fftSize: 2049 } })).toThrow();
    expect(() => parseAppError({ code: 'MadeUp', message: '', retryable: false })).toThrow();
  });
  it('rejects invalid calendar dates at the input boundary', () => {
    const invalid = structuredClone(fixture);
    invalid.createdAt = '2026-02-30T00:00:00Z';
    expect(() => parseProjectDocument(invalid)).toThrow();
  });
});

it('requires complete v2 classifications and comparison preferences', () => {
  for (const [pointer, key] of [['media', 'categoryId'], ['media', 'channelCategoryIds'], ['viewState', 'compareLayout'], ['viewState', 'compareSplit']]) {
    const d = structuredClone(fixture);
    const target = (pointer === 'media' ? d.media[0] : d.viewState) as unknown as Record<string, unknown>;
    delete target[key];
    expect(() => parseProjectDocument(d)).toThrow();
  }
  for (const value of [-.1, .24, .76, Infinity]) expect(() => parseProjectDocument({ ...fixture, viewState: { ...fixture.viewState, compareSplit: value } })).toThrow();
  expect(parseChange({ type: 'setMediaCategory', mediaId: fixture.media[0].id, categoryId: null }).type).toBe('setMediaCategory');
  expect(parseChange({ type: 'setChannelCategory', mediaId: fixture.media[0].id, channelIndex: 0, categoryId: fixture.categories[0].id }).type).toBe('setChannelCategory');
});

it('checks v2 classification references and channel-array lengths without accepting legacy native responses', () => {
  const base = parseProjectDocument(structuredClone(fixture));
  const id = base.categories[0].id;
  base.media[0].categoryId = id; base.media[0].channelCategoryIds[1] = id;
  expect(parseProjectDocument(base)).toBe(base);
  for (const mutate of [
    (d: typeof base) => { d.media[0].categoryId = d.projectId; },
    (d: typeof base) => { d.media[0].channelCategoryIds[0] = d.projectId; },
    (d: typeof base) => { d.media[0].channelCategoryIds.pop(); },
  ]) { const invalid = structuredClone(base); mutate(invalid); expect(() => parseProjectDocument(invalid)).toThrow(); }
  expect(() => parseProjectDocument({ ...fixture, formatVersion: 1 })).toThrow();
  expect(() => parseChange({ type: 'setMediaCategory', mediaId: base.media[0].id })).toThrow();
  expect(() => parseChange({ type: 'setChannelCategory', mediaId: base.media[0].id, channelIndex: 6, categoryId: null })).toThrow();
});
