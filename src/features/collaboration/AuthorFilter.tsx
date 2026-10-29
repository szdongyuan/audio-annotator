import type { CollaborationController } from './controller';
export function AuthorFilter({ controller, compact = false }: { controller: CollaborationController; compact?: boolean }) {
 const filter = controller.filter;
 return <div className="author-filter"><label>显示<select aria-label="显示作者" value={filter.mode === 'custom' && !filter.authorIds.length ? 'none' : filter.mode} onChange={e => {
   const mode = e.target.value;
   controller.setFilter(mode === 'all' || mode === 'mine' ? { mode } : { mode: 'custom', authorIds: mode === 'none' ? [] : controller.authorIdentities.filter(a => controller.visible(a.authorId)).map(a => a.authorId) });
  }}><option value="all">全部作者</option><option value="mine">仅自己</option><option value="none">全部隐藏</option><option value="custom">自定义</option></select></label>
  {!compact && filter.mode === 'custom' && controller.authorIdentities.map(a => <label key={a.authorId}><input type="checkbox" checked={controller.visible(a.authorId)} onChange={e => controller.setAuthorVisible(a.authorId, e.target.checked)}/>{a.displayName}{a.authorId === controller.owner.collaboration?.actor?.authorId ? '（我）' : ''}</label>)}
 </div>;
}
