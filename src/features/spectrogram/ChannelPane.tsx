import { SelectionToolbar } from '../selection/SelectionToolbar';
import { ClassificationControl } from '../annotations/ClassificationControl';
import { useAnnotationContext } from '../annotations/useAnnotations';
import { useSelectionContext } from '../selection/useSelection';
import { CueLine } from '../playback/CueLine';
import { Playhead } from '../playback/Playhead';
import type { ComponentProps, CSSProperties } from 'react';
import { SpectrogramCanvas } from './SpectrogramCanvas';
import { AxisRulers } from './AxisRulers';
import { ColorScale } from './ColorScale';
import { frequencyRulerWidth } from './ticks';
import { AnnotationOverlay } from '../annotations/AnnotationOverlay';
const layoutLabels: Record<string, string> = { left: '左', right: '右', frontLeft: '左前', frontRight: '右前', frontCenter: '中置', lfe: '低频', rearLeft: '左后', rearRight: '右后' };
export function ChannelPane(props: ComponentProps<typeof SpectrogramCanvas>) {
  const annotations = useAnnotationContext(), selection = useSelectionContext();
  const interact = () => selection?.state.interact({ mediaId: props.media.id, channelIndex: props.channel });
  const layout = props.media.channelLayout?.[props.channel], label = layout && layoutLabels[layout];
  const title = <strong tabIndex={0} onClick={() => { selection?.state.select(null); interact(); }} onFocus={() => { selection?.state.select(null); interact(); }}>通道 {props.channel + 1}{label ? ` · ${label}` : ''}</strong>;
  return <section onPointerDownCapture={e=>{if(e.button===0)interact();}} onFocusCapture={interact} style={{ '--frequency-ruler-width': `${frequencyRulerWidth(props.view)}px` } as CSSProperties} className="channel-pane" aria-label={`通道 ${props.channel + 1}`}><div className="channel-caption">{annotations ? <ClassificationControl ui={annotations} target={{ mediaId: props.media.id, channelIndex: props.channel }}>{title}</ClassificationControl> : title}<span>{props.view.spectrumKind === 'mel' ? '梅尔带功率' : 'STFT 幅度'}</span></div><div className="channel-graph"><AxisRulers owner={props.active} view={props.view} nyquist={props.media.sampleRate / 2} timeLimit={props.timeLimit} onView={props.onView} disabled={props.active.store.editingDisabled} /><SpectrogramCanvas {...props}><CueLine mediaId={props.media.id} view={props.view}/><Playhead mediaId={props.media.id} view={props.view} /><AnnotationOverlay media={props.media} channel={props.channel} view={props.view} /><SelectionToolbar media={props.media} channel={props.channel} view={props.view} status={props.status} /></SpectrogramCanvas><ColorScale view={props.view} /></div></section>;
}
