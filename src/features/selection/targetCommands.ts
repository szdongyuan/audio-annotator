import type { MediaStatus } from '../../bridge/media';
import type { PlaybackUI } from '../playback/usePlayback';
import { sameRegion, type Selection } from './state';
import type { SelectionUI } from './useSelection';

/** Both menus resolve captured identities at execution time and use the same edit barrier. */
export function targetCommands(ui: SelectionUI, target: Selection | null, playback: PlaybackUI | null,
  statuses: () => MediaStatus[], isCurrent: () => boolean = () => true) {
  return {
    audition: (source?: 'original' | 'processed') => {
      if (!isCurrent()) return;
      ui.withTarget(target, region => {
        if (statuses().some(s => s.mediaId === region.mediaId && s.status === 'ready')) playback?.playSelection(region, source);
      });
    },
    edit: (action: (selected: Selection) => void) => {
      if (!isCurrent()) return;
      ui.withTarget(target, region => {
        const selected = sameRegion(target!.region, region) ? target! : { ...target!, region };
        ui.state.select(selected); action(selected);
      });
    },
  };
}
