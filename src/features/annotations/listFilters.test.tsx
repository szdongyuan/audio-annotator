import { act, renderHook } from '@testing-library/react';
import { expect, it } from 'vitest';
import fixture from '../../../tests/fixtures/document-v3.json';
import { parseProjectDocument, type ProjectDocument } from '../../bridge/types';
import { useAnnotationListFilters } from './listFilters';

function document() { return parseProjectDocument(structuredClone(fixture)); }

it('isolates projects, authors and the anonymous scope, and restores by UUID after closing', () => {
  const a = document(), b = { ...document(), projectId: '00000000-0000-4000-8000-000000000011' };
  const first = { category: a.categories[0].id, channel: '1', query: '  Bird 原文  ' };
  const hook = renderHook(({ doc, author }) => useAnnotationListFilters(doc, author), {
    initialProps: { doc: a as ProjectDocument | undefined, author: 'author-a' as string | null },
  });
  act(() => hook.result.current.onChange(first));
  const stale = hook.result.current.onChange;
  hook.rerender({ doc: b, author: 'author-a' });
  expect(hook.result.current.value).toEqual({ category: '*', channel: '*', query: '' });
  act(() => { hook.result.current.onChange({ category: '', channel: '0', query: 'project B' }); stale({ ...first, query: 'stale callback' }); });
  hook.rerender({ doc: a, author: 'author-b' });
  expect(hook.result.current.value).toEqual({ category: '*', channel: '*', query: '' });
  act(() => hook.result.current.onChange({ category: '', channel: '*', query: 'author B' }));
  hook.rerender({ doc: a, author: null });
  expect(hook.result.current.value.query).toBe('');
  act(() => hook.result.current.onChange({ category: '*', channel: '*', query: 'anonymous' }));
  hook.rerender({ doc: undefined, author: 'author-a' });
  act(() => hook.result.current.onChange({ category: '*', channel: '*', query: 'no project' }));
  hook.rerender({ doc: document(), author: 'author-a' });
  expect(hook.result.current.value).toEqual(first);
  hook.rerender({ doc: b, author: 'author-a' });
  expect(hook.result.current.value.query).toBe('project B');
  hook.rerender({ doc: a, author: 'author-b' });
  expect(hook.result.current.value.query).toBe('author B');
  hook.rerender({ doc: a, author: null });
  expect(hook.result.current.value.query).toBe('anonymous');
});

it('a new hook instance starts from defaults and resetting overwrites remembered filters', () => {
  const doc = document(), hook = renderHook(() => useAnnotationListFilters(doc, 'author-a'));
  act(() => hook.result.current.onChange({ category: '', channel: '1', query: 'old' }));
  const other = renderHook(() => useAnnotationListFilters(doc, 'author-a'));
  expect(other.result.current.value).toEqual({ category: '*', channel: '*', query: '' });
  act(() => hook.result.current.onChange({ category: '*', channel: '*', query: '' }));
  hook.rerender();
  expect(hook.result.current.value).toEqual({ category: '*', channel: '*', query: '' });
});

it('normalizes deleted categories independently and remembers the normalized value', () => {
  const doc = document(), hook = renderHook(({ doc }) => useAnnotationListFilters(doc, 'a'), { initialProps: { doc } });
  act(() => hook.result.current.onChange({ category: doc.categories[0].id, channel: '1', query: '  absent  ' }));
  hook.rerender({ doc: { ...doc, categories: [] } });
  expect(hook.result.current.value).toEqual({ category: '*', channel: '1', query: '  absent  ' });
  hook.rerender({ doc });
  expect(hook.result.current.value.category).toBe('*');
});

it('normalizes disappeared channels independently and preserves valid filters with zero matches', () => {
  const doc = document(), hook = renderHook(({ doc }) => useAnnotationListFilters(doc, 'a'), { initialProps: { doc } });
  const value = { category: doc.categories[0].id, channel: '1', query: 'no results' };
  act(() => hook.result.current.onChange(value));
  hook.rerender({ doc: { ...doc, annotations: [] } });
  expect(hook.result.current.value).toEqual(value);
  hook.rerender({ doc: { ...doc, media: doc.media.map(m => ({ ...m, channelCount: 1 })) } });
  expect(hook.result.current.value).toEqual({ ...value, channel: '*' });
  hook.rerender({ doc });
  expect(hook.result.current.value.channel).toBe('*');
  act(() => hook.result.current.onChange({ category: '', channel: '*', query: 'no results' }));
  hook.rerender({ doc: { ...doc, media: [], annotations: [] } });
  expect(hook.result.current.value).toEqual({ category: '', channel: '*', query: 'no results' });
});

it.each(['-1', '0.5', 'NaN', '2'])('rejects invalid channel %s without clearing the other filters', channel => {
  const doc = document(), hook = renderHook(() => useAnnotationListFilters(doc, null));
  act(() => hook.result.current.onChange({ category: '', channel, query: '原文' }));
  expect(hook.result.current.value).toEqual({ category: '', channel: '*', query: '原文' });
});
