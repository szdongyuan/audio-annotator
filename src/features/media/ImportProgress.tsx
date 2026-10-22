import type { MediaImportController } from './imports';
import { useState } from 'react';
const labels = { waiting: '等待导入', hashing: '校验指纹', decoding: '解码音频', publishing: '写入项目', success: '已导入', failed: '失败', cancelled: '已取消' };
export function ImportProgress({ controller }: { controller: MediaImportController }) {
  const [dismissed, setDismissed] = useState<unknown>(null);
  const [expanded, setExpanded] = useState(false);
  if (!controller.items.length) return null;
  if (!controller.busy && dismissed === controller.items) return null;
  const done = controller.items.filter(i => ['success', 'failed', 'cancelled'].includes(i.state)).length;
  return <section className="import-progress" aria-label="导入进度">
    <div><strong>{controller.busy ? controller.cancelling ? '正在取消…' : '正在导入音频' : `导入完成 · ${controller.items.filter(i => i.state === 'success').length} 成功，${controller.items.filter(i => i.state === 'failed').length} 失败`}</strong><span>{done} / {controller.items.length}</span>{controller.busy ? <button className="button button-quiet" disabled={controller.cancelling} onClick={() => controller.cancel()}>取消导入</button> : <><button className="button button-quiet" onClick={() => setExpanded(!expanded)}>{expanded ? '收起详情' : '查看详情'}</button><button className="button button-quiet" onClick={() => setDismissed(controller.items)}>关闭导入结果</button></>}</div>
    {controller.busy && <progress max={controller.items.length} value={done} aria-label="完成文件数" />}
    {(controller.busy || expanded || controller.items.some(i => i.state === 'failed')) && <ul>{controller.items.map((item, i) => <li key={i}><span title={item.path}>{item.path.split(/[\\/]/).pop()}</span><small>{labels[item.state]}{item.state === 'hashing' ? ` · ${(item.completed / 1048576).toFixed(1)} MiB` : item.state === 'decoding' ? ` · ${item.completed.toLocaleString()} 帧` : ''}</small>{item.error && <p role="alert">{item.error.message}</p>}</li>)}</ul>}
    {controller.error && <p role="alert">{controller.error.message}</p>}
  </section>;
}
