import { useCollaborationContext } from './useCollaboration';
import { useInspectionDocument } from './remote';
import type { ActiveProject } from '../project/useProjectLifecycle';
import { Eye, EyeOff } from 'lucide-react';

export function CategoryVisibility({ owner, name }: { owner: ActiveProject; name?: string }) {
 const ui = useCollaborationContext();
 useInspectionDocument(owner);
 if (ui?.active !== owner || ui.controller?.owner !== owner) return null;
 const controller = ui.controller;
 if (name === undefined) return <label className="category-visibility-scope">隐藏范围<select aria-label="类别隐藏范围" value={controller.includeOwnCategories ? 'all' : 'others'} onChange={e => controller.setIncludeOwnCategories(e.target.value === 'all')}><option value="all">所有人的标注</option><option value="others">仅其他人的标注</option></select></label>;
 const shown = !controller.hiddenCategoryNames.includes(name.trim());
 return <button type="button" className="visibility-toggle" title={`${shown ? '隐藏' : '显示'}此类别的标注`} aria-label={`${shown ? '隐藏' : '显示'}类别 ${name.trim()}`} aria-pressed={shown} onClick={() => controller.setCategoryVisible(name, !shown)}>{shown ? <Eye size={14} aria-hidden="true"/> : <EyeOff size={14} aria-hidden="true"/>}</button>;
}
