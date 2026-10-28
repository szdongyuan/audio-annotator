import { useState } from 'react';
import type { CollaborationController } from './controller';
export function AuthorFilter({ controller, compact = false }: { controller: CollaborationController; compact?: boolean }) {
 const filter = controller.filter;
 const [includeSelf, setIncludeSelf] = useState(false);
 return <fieldset className="author-filter"><legend>显示作者</legend>
  <div className="author-filter-modes">{(['all','mine','custom'] as const).map(mode => <label key={mode} title={mode === 'custom' ? '仅显示已选作者；新增作者保持隐藏' : undefined}><input type="radio" name={compact ? 'author-pane-filter' : 'author-filter'} checked={filter.mode === mode} onChange={() => controller.setFilter(mode === 'custom' ? { mode, authorIds: controller.authorIdentities.filter(a => controller.visible(a.authorId)).map(a => a.authorId) } : { mode })}/>{mode === 'all' ? '全部' : mode === 'mine' ? '仅我的' : '勾选作者'}</label>)}</div>
  <div className="visibility-bulk"><button type="button" onClick={() => controller.setAllAuthorsVisible(true, includeSelf)}>显示全部作者</button><button type="button" onClick={() => controller.setAllAuthorsVisible(false, includeSelf)}>隐藏全部作者</button><label><input type="checkbox" checked={includeSelf} onChange={e => setIncludeSelf(e.target.checked)}/>批量操作包括我</label></div>
  {!compact && filter.mode === 'custom' && controller.authorIdentities.map(a => <label key={a.authorId}><input type="checkbox" checked={controller.visible(a.authorId)} onChange={e => controller.setAuthorVisible(a.authorId, e.target.checked)}/>{a.displayName}{a.authorId === controller.owner.collaboration?.actor?.authorId ? '（我）' : ''}</label>)}
 </fieldset>;
}
