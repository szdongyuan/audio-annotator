import { labelText, labelColor } from '../annotations/labels';
import type { CSSProperties } from 'react';
import type { AuthorSnapshot } from '../../bridge/collaboration';
import type { MediaDescriptor, MediaView } from '../../bridge/types';
import { coordinates } from '../spectrogram/coordinates';
import { remoteKey } from './remote';

export function RemoteAnnotations({ authors, media, channel, view, visible = () => true }: { authors: AuthorSnapshot[]; media: MediaDescriptor; channel: number; view: MediaView; visible?: (author: AuthorSnapshot, ids: string[]) => boolean }) {
  const c = coordinates(view, media.sampleRate / 2, 100, 100);
  return <div className="remote-annotations" aria-label={`通道 ${channel + 1} 共享标注图层`}>{authors.flatMap(author => (author.layer?.payload.annotations ?? []).filter(a => a.region.mediaId === media.id && a.region.channelIndex === channel && visible(author, a.categoryIds)).map(a => {
    const r = a.region, categories = author.layer!.payload.categories, label = `${author.identity.displayName} · ${labelText(categories, a.categoryIds)}`;
    return <div key={remoteKey(author.identity.authorId, a.id)} data-remote-key={remoteKey(author.identity.authorId, a.id)} title={label} className="remote-annotation" style={{ left: `${c.secondsToX(r.startSeconds)}%`, top: `${c.hzToY(r.highHz)}%`, width: `${c.secondsToX(r.endSeconds) - c.secondsToX(r.startSeconds)}%`, height: `${c.hzToY(r.lowHz) - c.hzToY(r.highHz)}%`, '--region-color': labelColor(categories, a.categoryIds, '#93b6db') } as CSSProperties}><span>{label}</span></div>;
  }))}</div>;
}
