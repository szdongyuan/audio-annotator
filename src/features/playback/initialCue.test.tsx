import { render } from '@testing-library/react';
import { expect, it } from 'vitest';
import { CueLine } from './CueLine';
import { PlaybackContext } from './usePlayback';
import { emptyPlayback } from '../../bridge/playback';
import { defaultView } from '../spectrogram/workspace';
import fixture from '../../../tests/fixtures/document-v3.json';
it('shows a first-play cue without requiring a prior click or right-click', () => {
  const m = fixture.media[0], ui = { cues: {}, status: emptyPlayback };
  const view = render(<PlaybackContext.Provider value={ui as never}><CueLine mediaId={m.id} view={defaultView(m)} /></PlaybackContext.Provider>);
  expect(document.querySelector('.audio-cue')).toHaveAttribute('data-seconds', '0');
  view.rerender(<PlaybackContext.Provider value={{ ...ui, status: { ...emptyPlayback, mediaId: m.id, startSeconds: .2, state: 'playing' } } as never}><CueLine mediaId={m.id} view={defaultView(m)} /></PlaybackContext.Provider>);
  expect(document.querySelector('.audio-cue')).toHaveAttribute('data-seconds', '0.2');
  view.rerender(<PlaybackContext.Provider value={{ ...ui, cues: { [m.id]: .4 } } as never}><CueLine mediaId={m.id} view={defaultView(m)} /></PlaybackContext.Provider>);
  expect(document.querySelector('.audio-cue')).toHaveAttribute('data-seconds', '0.4');
});
