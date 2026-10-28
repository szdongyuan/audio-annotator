import { useCollaborationContext } from './useCollaboration';
import { authorsForInspector, useInspectionDocument } from './remote';
import type { ActiveProject } from '../project/useProjectLifecycle';
import { Eye, EyeOff } from 'lucide-react';

export function CategoryVisibility({ owner }: { owner: ActiveProject }) {
 const ui = useCollaborationContext();
 useInspectionDocument(owner);
 if (ui?.active !== owner || ui.controller?.owner !== owner) return null;
 const controller = ui.controller;
 // Definitions come from every verified author, including hidden authors, never the filtered results.
 const names = [...new Set(authorsForInspector(ui).flatMap(author => author.layer?.payload.categories.map(c => c.name.trim()) ?? []))].filter(Boolean).sort((a, b) => a.localeCompare(b));
 return <fieldset className="category-visibility"><legend>类别显示</legend>
  <label><input type="checkbox" checked={controller.includeOwnCategories} onChange={e => controller.setIncludeOwnCategories(e.target.checked)}/>类别过滤包括我的标注</label>
  <div className="category-visibility-rows">{names.map(name => {
   const shown = !controller.hiddenCategoryNames.includes(name);
   return <div key={name}><span title={name}>{name}</span><button type="button" className="visibility-toggle" aria-label={`${shown ? '隐藏' : '显示'}类别 ${name}`} aria-pressed={shown} onClick={() => controller.setCategoryVisible(name, !shown)}>{shown ? <Eye size={14} aria-hidden="true"/> : <EyeOff size={14} aria-hidden="true"/>}</button></div>;
  })}</div>
 </fieldset>;
}
