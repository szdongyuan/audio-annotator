import { useEffect, useLayoutEffect, useRef } from 'react';
import type { PlaybackStatus } from '../../bridge/playback';
import type { MediaView } from '../../bridge/types';
import { PresentationClock } from './presentationClock';

/** Animation updates only this line, without scheduling a React commit per frame. */
export function ProgressLine({ status, view, looping, className, label }: { status: PlaybackStatus; view: MediaView; looping: boolean; className: string; label?: string }) {
 const line = useRef<HTMLDivElement>(null), clock = useRef(new PresentationClock()), width = useRef(100);
 const mapping = useRef(view); mapping.current = view;
 const paint = () => {
  const seconds = clock.current.position(performance.now()), node = line.current, v = mapping.current;
  if (node) {
   node.hidden = seconds < v.startSeconds || seconds > v.endSeconds;
   node.style.transform = `translate3d(${width.current * (seconds-v.startSeconds)/(v.endSeconds-v.startSeconds)}px,0,0)`;
  }
 };
 useLayoutEffect(() => {
  const parent = line.current?.parentElement;
  if (!parent) return;
  width.current = parent.getBoundingClientRect().width || 100;
  const observer = new ResizeObserver(entries => { width.current = entries[0].contentRect.width || 100; paint(); });
  observer.observe(parent); return () => observer.disconnect();
 }, []);
 useLayoutEffect(() => {
  clock.current.accept(status, performance.now(), looping);
  paint();
 }, [status, looping]);
 useLayoutEffect(paint, [view.startSeconds, view.endSeconds]);
 useEffect(() => {
  if (status.state !== 'playing') return;
  let frame = 0;
  const draw = () => {
   paint(); frame = requestAnimationFrame(draw);
  };
  frame = requestAnimationFrame(draw); return () => cancelAnimationFrame(frame);
 }, [status.state]);
 return <div ref={line} className={className} aria-label={label} style={{ left: 0, willChange: 'transform' }}/>;
}
