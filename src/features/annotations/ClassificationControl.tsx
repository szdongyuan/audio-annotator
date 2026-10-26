import { labelText, labelColor } from './labels';
import { annotationDisabled } from '../collaboration/capabilities';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Menu } from '../../components/menu/Menu';
import { classificationMenu, resolveClassification, type ClassificationTarget } from './classification';
import type { AnnotationUI } from './useAnnotations';
import { useSelectionContext } from '../selection/useSelection';

export function ClassificationControl({ ui, target, children }: { ui: AnnotationUI; target: ClassificationTarget; children?: ReactNode }) {
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const ref = useRef<HTMLButtonElement>(null), selection = useSelectionContext();
  const owner = ui.active, doc = owner?.store.snapshot.document, media = doc && resolveClassification(doc, target);
  useEffect(() => { setAnchor(null); }, [owner, target.mediaId, target.channelIndex]);
  useEffect(() => { if (annotationDisabled(owner) || !media) setAnchor(null); }, [annotationDisabled(owner), media]);
  if (!doc || !media) return null;
  const value = target.channelIndex === null ? media.categoryIds : media.channelCategoryIds[target.channelIndex];
  const label = `${media.displayName} ${target.channelIndex === null ? '文件' : `通道 ${target.channelIndex + 1}`} 类别`;
  const focus = () => { selection?.state.select(null); selection?.state.interact(target); };
  return <><div className="classification-title" data-pane-control onContextMenu={e => { e.preventDefault(); e.stopPropagation(); if (!annotationDisabled(owner)) { focus(); setAnchor({ x: e.clientX, y: e.clientY }); } }}>{children}<button ref={ref} className="classification-control" aria-label={label} title={`${label}：${labelText(doc.categories, value)}`} aria-haspopup="menu" disabled={annotationDisabled(owner)}
    onClick={() => { focus(); const box = ref.current!.getBoundingClientRect(); setAnchor({ x: box.left, y: box.bottom }); }}>
    <i style={{ background: labelColor(doc.categories, value) }} />{labelText(doc.categories, value)}<span aria-hidden="true">⌄</span>
  </button></div>{anchor && <Menu anchor={anchor} returnFocus={ref.current} onClose={() => setAnchor(null)} items={[classificationMenu(doc, target, ui.classify, target.channelIndex === null ? '文件类别' : '通道类别', annotationDisabled(owner))]} />}</>;
}
