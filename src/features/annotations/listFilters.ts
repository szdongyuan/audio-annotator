import { useEffect, useRef, useState } from 'react';
import type { ProjectDocument } from '../../bridge/types';

export type ListFilters = { category: string; channel: string; query: string };
export type ListFilterControl = { value: ListFilters; onChange: (next: ListFilters) => void };

function normalize(value: ListFilters, doc: ProjectDocument): ListFilters {
  const category = value.category === '*' || value.category === '' || doc.categories.some(c => c.id === value.category) ? value.category : '*';
  const channelCount = Math.max(0, ...doc.media.map(m => m.channelCount));
  const index = Number(value.channel);
  const channel = value.channel === '*' || (/^\d+$/.test(value.channel) && Number.isSafeInteger(index) && index < channelCount) ? value.channel : '*';
  return { category, channel, query: value.query };
}

/** Owned by the app shell, so closing a project or unmounting its list keeps its filters. */
export function useAnnotationListFilters(doc: ProjectDocument | undefined, authorId: string | null): ListFilterControl {
  const memory = useRef(new Map<string, ListFilters>());
  const [, refresh] = useState(0);
  const scope = doc ? JSON.stringify([doc.projectId, authorId]) : null;
  const current = useRef({ scope, doc });
  current.current = { scope, doc };
  const saved = scope ? memory.current.get(scope) : undefined;
  const defaults = { category: '*', channel: '*', query: '' };
  const value = doc ? normalize(saved ?? defaults, doc) : defaults;

  useEffect(() => {
    if (scope && current.current.scope === scope) memory.current.set(scope, value);
  }, [scope, value.category, value.channel, value.query]);

  return { value, onChange: next => {
    if (!scope || current.current.scope !== scope || !current.current.doc) return;
    memory.current.set(scope, normalize(next, current.current.doc));
    refresh(version => version + 1);
  } };
}
