import { Playhead } from '../playback/Playhead';
import type { ComponentProps } from 'react';
import { SpectrogramCanvas } from './SpectrogramCanvas';
import { AxisRulers } from './AxisRulers';
import { ColorScale } from './ColorScale';
import { AnnotationOverlay } from '../annotations/AnnotationOverlay';
const layoutLabels: Record<string, string> = { left: '左', right: '右', frontLeft: '左前', frontRight: '右前', frontCenter: '中置', lfe: '低频', rearLeft: '左后', rearRight: '右后' };
export function ChannelPane(props: ComponentProps<typeof SpectrogramCanvas>) {
  const layout = props.media.channelLayout?.[props.channel], label = layout && layoutLabels[layout];
  return <section className="channel-pane" aria-label={`通道 ${props.channel + 1}`}><div className="channel-caption"><strong>通道 {props.channel + 1}{label ? ` · ${label}` : ''}</strong><span>{props.view.spectrumKind === 'mel' ? '梅尔带功率' : 'STFT 幅度'}</span></div><div className="channel-graph"><AxisRulers view={props.view} nyquist={props.media.sampleRate / 2} /><SpectrogramCanvas {...props}><Playhead mediaId={props.media.id} view={props.view} /><AnnotationOverlay media={props.media} channel={props.channel} view={props.view} /></SpectrogramCanvas><ColorScale view={props.view} /></div></section>;
}
