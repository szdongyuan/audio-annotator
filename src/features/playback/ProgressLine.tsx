import { useLayoutEffect, useRef } from 'react';
import type { PlaybackStatus } from '../../bridge/playback';
import type { MediaView } from '../../bridge/types';
import { PresentationClock } from './presentationClock';

/** Animation updates only this line, without scheduling a React commit per frame. */
export function ProgressLine({ status, view, looping, className, label }: { status: PlaybackStatus; view: MediaView; looping: boolean; className: string; label?: string }) {
 const line = useRef<HTMLDivElement>(null), clock = useRef(new PresentationClock());
 useLayoutEffect(() => {
  clock.current.accept(status, performance.now(), looping);
  let frame = 0;
  const draw = () => {
   const seconds = clock.current.position(performance.now()), node = line.current;
   if (node) { node.hidden = seconds < view.startSeconds || seconds > view.endSeconds; node.style.left = `${100 * (seconds-view.startSeconds)/(view.endSeconds-view.startSeconds)}%`; }
   if (status.state === 'playing') frame = requestAnimationFrame(draw);
  };
  draw(); return () => cancelAnimationFrame(frame);
 }, [status, looping, view.startSeconds, view.endSeconds]);
 return <div ref={line} className={className} aria-label={label}/>;
}
