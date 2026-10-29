import type {MediaView} from '../../bridge/types';
import {usePlaybackContext} from './usePlayback';
import {usePlaybackStatus} from './statusStore';
import {ProgressLine} from './ProgressLine';
export function Playhead({mediaId,view}:{mediaId:string;view:MediaView}) {
 const ui=usePlaybackContext(),status=usePlaybackStatus(ui);
 if(!status.mediaId||(status.mediaId!==mediaId&&!ui?.active?.store.snapshot.document.viewState.linkedTime))return null;
 return <ProgressLine status={status} view={view} looping={!!ui?.options.looping} className="audio-playhead" label="音频播放指针"/>;
}
