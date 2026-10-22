import type { ProjectLifecycle } from './lifecycle';
export function SaveIndicator({ lifecycle }: { lifecycle: ProjectLifecycle }) {
  const labels = { saved: '已保存', unsaved: '未保存', saving: '保存中…', failed: '保存失败' };
  return <span className={`status-label save-${lifecycle.status}`} role="status" title={lifecycle.savedAt ? `最近保存 ${lifecycle.savedAt.toLocaleTimeString('zh-CN')}` : '项目内容保存在本地'}><i />{labels[lifecycle.status]}</span>;
}
