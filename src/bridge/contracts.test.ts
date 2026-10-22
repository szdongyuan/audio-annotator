import { describe, expect, it } from 'vitest';
import fixture from '../../tests/fixtures/document-v1.json';
import { parseProjectDocument, parseProjectSnapshot, parseChange, parseAppError } from './types';

describe('shared Rust/TypeScript document contract', () => {
  it('accepts the versioned fixture without losing semantic fields', () => {
    expect(parseProjectDocument(fixture)).toEqual(fixture);
    expect(parseProjectSnapshot({ document: fixture, canUndo: true, canRedo: false }).document).toEqual(fixture);
    expect(parseChange({ type: 'updatePlaybackMix', mediaId: fixture.media[0].id, mix: { soloChannels: [1], mutedChannels: [] } }).type).toBe('updatePlaybackMix');
    expect(parseAppError({ code: 'RevisionConflict', message: 'Refresh', retryable: false }).code).toBe('RevisionConflict');
  });
  it('rejects versions, unknown fields, malformed references and non-finite bounds', () => {
    for (const mutate of [
      (d: typeof fixture) => { d.formatVersion = 2; },
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
