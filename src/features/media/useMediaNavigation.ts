import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { Annotation, MediaDescriptor } from '../../bridge/types';
import type { MediaStatus } from '../../bridge/media';
import { mediaNavigationDirection, mediaRandomShortcut } from './navigation';
import { pickUnclassifiedMedia } from './randomNavigation';

interface MediaNavigationOptions {
  scope: object | null;
  navigationIds: readonly string[];
  randomIds: readonly string[];
  selectedId: string | null;
  navigationDisabled: boolean;
  media: readonly MediaDescriptor[];
  annotations: readonly Annotation[];
  statuses: readonly MediaStatus[];
  onSelect: (id: string, intent?: 'random') => boolean | void;
  reveal: (id: string) => void;
  root: RefObject<HTMLDivElement | null>;
}

export function useMediaNavigation(options: MediaNavigationOptions): string | null {
  const latest = useRef(options);
  latest.current = options;
  const mounted = useRef(false), sequence = useRef(0), frame = useRef<number | null>(null);
  const [notice, setNotice] = useState<{ scope: object | null; message: string } | null>(null);
  const cancel = useCallback(() => {
    sequence.current++;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
  }, []);

  useEffect(() => {
    mounted.current = true;
    const move = (event: KeyboardEvent) => {
      const current = latest.current;
      if (current.navigationDisabled || event.defaultPrevented) return;
      let id: string;
      let intent: 'random' | undefined;
      if (mediaRandomShortcut(event)) {
        event.preventDefault();
        const result = pickUnclassifiedMedia(current.randomIds, current.media, current.annotations, current.statuses, current.selectedId);
        if (result.kind !== 'selected') {
          setNotice({ scope: current.scope, message: result.kind === 'empty' ? '当前范围内没有未分类音频' : '没有其他未分类音频' });
          return;
        }
        id = result.mediaId;
        intent = 'random';
      } else {
        const direction = mediaNavigationDirection(event);
        if (direction === null || !current.navigationIds.length) return;
        const before = current.navigationIds.indexOf(current.selectedId ?? '');
        const next = before < 0 ? direction === 1 ? 0 : current.navigationIds.length - 1
          : Math.max(0, Math.min(current.navigationIds.length - 1, before + direction));
        event.preventDefault();
        if (before === next) return;
        id = current.navigationIds[next];
      }
      const accepted = intent === 'random' ? current.onSelect(id, intent) : current.onSelect(id);
      if (accepted === false) return;
      setNotice(null);
      current.reveal(id);
      const request = sequence.current;
      frame.current = requestAnimationFrame(() => {
        const now = latest.current;
        if (!mounted.current || request !== sequence.current || now.scope !== current.scope
          || now.navigationDisabled || !now.navigationIds.includes(id)
          || now.selectedId !== current.selectedId && now.selectedId !== id) return;
        frame.current = null;
        const button = Array.from(now.root.current?.querySelectorAll<HTMLButtonElement>('.media-select') ?? [])
          .find(row => row.dataset.mediaId === id);
        if (!button?.isConnected) return;
        button.focus({ preventScroll: true });
        button.scrollIntoView?.({ block: 'nearest' });
      });
    };
    // Capture cancels even when a later control stops the event before bubble.
    window.addEventListener('keydown', cancel, true);
    window.addEventListener('pointerdown', cancel, true);
    window.addEventListener('keydown', move);
    return () => {
      mounted.current = false;
      cancel();
      window.removeEventListener('keydown', cancel, true);
      window.removeEventListener('pointerdown', cancel, true);
      window.removeEventListener('keydown', move);
    };
  }, [cancel]);
  useEffect(() => { cancel(); }, [options.scope, options.navigationDisabled, cancel]);
  useEffect(() => { setNotice(null); }, [options.scope]);
  return notice?.scope === options.scope ? notice.message : null;
}
