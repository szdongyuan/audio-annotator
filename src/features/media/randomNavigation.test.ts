import { describe, expect, it, vi } from 'vitest';
import fixture from '../../../tests/fixtures/document-v3.json';
import type { Annotation, MediaDescriptor } from '../../bridge/types';
import type { MediaStatus } from '../../bridge/media';
import { pickUnclassifiedMedia } from './randomNavigation';

function unclassified(id: string): MediaDescriptor {
  return { ...structuredClone(fixture.media[0]), id, categoryIds: [], channelCategoryIds: [[], []] };
}

function region(mediaId: string, categoryIds: string[] = []): Annotation {
  const annotation = structuredClone(fixture.annotations[0]);
  return { ...annotation, region: { ...annotation.region, mediaId }, categoryIds };
}

describe('pickUnclassifiedMedia', () => {
  it.each(['file', 'channel', 'region'] as const)('excludes a label on any %s, allows removing the last label, and excludes its restored snapshot', level => {
    const item = unclassified('target');
    const annotations = [region(item.id), { ...region(item.id), id: 'second-region' }];
    if (level === 'file') item.categoryIds = ['label'];
    if (level === 'channel') item.channelCategoryIds[1] = ['label'];
    if (level === 'region') annotations[1].categoryIds = ['label'];
    const tagged = structuredClone({ item, annotations });
    const geometry = structuredClone(annotations.map(annotation => annotation.region));

    expect(pickUnclassifiedMedia([item.id], [item], annotations, [], null)).toEqual({ kind: 'empty' });

    item.categoryIds = [];
    item.channelCategoryIds = [[], []];
    annotations.forEach(annotation => { annotation.categoryIds = []; });
    expect(pickUnclassifiedMedia([item.id], [item], annotations, [], null)).toEqual({ kind: 'selected', mediaId: item.id });
    expect(annotations.map(annotation => annotation.region)).toEqual(geometry);

    expect(pickUnclassifiedMedia([item.id], [tagged.item], tagged.annotations, [], null)).toEqual({ kind: 'empty' });
  });

  it('allows untagged region boxes, notes, private masks and gain edits', () => {
    const document = {
      ...structuredClone(fixture),
      media: [unclassified(fixture.media[0].id)],
      annotations: [region(fixture.media[0].id)],
    };
    const gainEdit = { ...document.edits[0], id: 'gain', operation: { type: 'gain', gainDb: -6 } };
    const ownDocument = { ...document, edits: [...document.edits, gainEdit] };
    expect(ownDocument.media[0].note).not.toBe('');
    expect(ownDocument.media[0].channelNotes.every(note => note.length > 0)).toBe(true);
    expect(ownDocument.annotations[0].note).not.toBe('');
    expect(pickUnclassifiedMedia([ownDocument.media[0].id], ownDocument.media, ownDocument.annotations, [], null)).toEqual({ kind: 'selected', mediaId: ownDocument.media[0].id });
  });

  it('uses only the supplied own media and annotations despite other authors having labels', () => {
    const own = unclassified('target');
    const other = { ...structuredClone(own), categoryIds: ['other-file'], channelCategoryIds: [[], ['other-channel']] };
    const document = { media: [own], annotations: [region(own.id)], authors: [{ media: [other], annotations: [region(own.id, ['other-region'])] }] };
    expect(pickUnclassifiedMedia([own.id], document.media, document.annotations, [], null)).toEqual({ kind: 'selected', mediaId: own.id });
  });

  it.each(['missing', 'changed', 'ready', 'unverified', undefined] as const)('handles media status %s', status => {
    const item = unclassified('target');
    const statuses: MediaStatus[] = status ? [{ mediaId: item.id, status }] : [];
    expect(pickUnclassifiedMedia([item.id], [item], [], statuses, null)).toEqual(
      status === 'missing' || status === 'changed' ? { kind: 'empty' } : { kind: 'selected', mediaId: item.id },
    );
  });

  it('intersects navigation IDs with known eligible media and never selects outside the supplied range', () => {
    const files = [unclassified('outside'), unclassified('inside')];
    expect(pickUnclassifiedMedia(['unknown', 'inside'], files, [], [], null)).toEqual({ kind: 'selected', mediaId: 'inside' });
    expect(pickUnclassifiedMedia(['inside'], files, [region('outside', ['label'])], [{ mediaId: 'outside', status: 'missing' }], null)).toEqual({ kind: 'selected', mediaId: 'inside' });
    expect(pickUnclassifiedMedia([], files, [], [], null)).toEqual({ kind: 'empty' });
    expect(pickUnclassifiedMedia(['unknown'], files, [], [], null)).toEqual({ kind: 'empty' });
  });

  it.each([[0, 'third'], [0.5, 'first'], [0.999, 'second']] as const)('keeps navigation order for random value %s', (value, expected) => {
    const files = ['first', 'second', 'third'].map(unclassified);
    const random = vi.fn(() => value);
    expect(pickUnclassifiedMedia(['third', 'first', 'second'], files, [], [], null, random)).toEqual({ kind: 'selected', mediaId: expected });
    expect(random).toHaveBeenCalledExactlyOnceWith();
  });

  it('avoids the current candidate while allowing a previously visited candidate again', () => {
    const files = ['first', 'second', 'third'].map(unclassified);
    const ids = files.map(item => item.id);
    expect(pickUnclassifiedMedia(ids, files, [], [], 'first', () => 0)).toEqual({ kind: 'selected', mediaId: 'second' });
    expect(pickUnclassifiedMedia(ids, files, [], [], 'second', () => 0)).toEqual({ kind: 'selected', mediaId: 'first' });
    expect(pickUnclassifiedMedia(ids, files, [], [], 'first', () => 0.999)).toEqual({ kind: 'selected', mediaId: 'third' });
  });

  it('returns current-only without drawing a random number or selecting the current media again', () => {
    const files = [unclassified('current')];
    const random = vi.fn(() => 0);
    expect(pickUnclassifiedMedia(['current'], files, [], [], 'current', random)).toEqual({ kind: 'current-only' });
    expect(random).not.toHaveBeenCalled();
  });

  it('returns empty without drawing a random number when there are no candidates', () => {
    const random = vi.fn(() => 0);
    expect(pickUnclassifiedMedia([], [], [], [], null, random)).toEqual({ kind: 'empty' });
    expect(random).not.toHaveBeenCalled();
  });

  it('selects the sole non-current candidate without mutating input arrays or their contents', () => {
    const files = [unclassified('current'), unclassified('other')];
    const ids = ['current', 'other'];
    const annotations = [region('other')];
    const statuses: MediaStatus[] = [{ mediaId: 'other', status: 'unverified' }];
    const snapshot = structuredClone({ ids, files, annotations, statuses });
    expect(pickUnclassifiedMedia(ids, files, annotations, statuses, 'current', () => 0.999)).toEqual({ kind: 'selected', mediaId: 'other' });
    expect({ ids, files, annotations, statuses }).toEqual(snapshot);
  });

  it('defaults to Math.random when no random source is supplied', () => {
    const files = ['first', 'second'].map(unclassified);
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.999);
    try {
      expect(pickUnclassifiedMedia(files.map(item => item.id), files, [], [], null)).toEqual({ kind: 'selected', mediaId: 'second' });
      expect(random).toHaveBeenCalledOnce();
    } finally {
      random.mockRestore();
    }
  });
});
