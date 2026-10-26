import { useState, useSyncExternalStore } from 'react';
import type { SourceImportController } from './sourceImport';
const labels={idle:'',choosing:'配置音频导入',scanning:'扫描音频来源',preview:'音频预览',importing:'正在导入音频',paused:'导入已暂停',finished:'音频导入完成',cancelled:'音频导入已取消',failed:'音频导入失败'};
const itemLabels={waiting:'等待',extracting:'提取音频',hashing:'校验指纹',decoding:'解码',publishing:'写入项目',accepted:'已接收',success:'已导入',failed:'失败',cancelled:'已取消'};
export function SourceImportProgress({controller:c}:{controller:SourceImportController}){
 useSyncExternalStore(c.subscribe,c.getVersion);const [expanded,setExpanded]=useState(false),[page,setPage]=useState(0),[working,setWorking]=useState(false);
 if(c.state==='idle'||c.open)return null;
 const done=c.items.filter(i=>['success','accepted','failed','cancelled'].includes(i.state)).length,failures=c.failures.length,pages=Math.max(1,Math.ceil(c.items.length/50)),current=Math.min(page,pages-1);
 const recover=(end=false)=>{setWorking(true);void(end?c.end():c.retry()).finally(()=>setWorking(false));};
 return <section className="import-progress source-import-progress" aria-label="来源导入进度"><div><strong>{labels[c.state]}</strong><span>{done} / {c.counts.candidates}</span>{c.busy&&<button className="button button-quiet" onClick={()=>void c.cancel()}>取消导入</button>}<button className="button button-quiet" onClick={()=>setExpanded(!expanded)}>{expanded?'收起详情':'查看详情'}</button>{!c.busy&&!failures&&!c.pendingAcknowledgements.length&&<button className="button button-quiet" onClick={()=>c.dismiss()}>关闭结果</button>}</div><div>成功 {c.successCount} · 失败 {c.items.filter(i=>i.state==='failed').length} · 跳过 {c.counts.skipped} · 扫描问题 {c.counts.issues}</div>{c.state==='importing'&&<progress aria-label="来源导入完成文件数" max={Math.max(1,c.counts.candidates)} value={done}/>}
 {(failures>0||c.state==='paused'||c.pendingAcknowledgements.length>0)&&<div><button className="button" disabled={working} onClick={()=>recover()}>重试并继续导入</button><button className="button" disabled={working} onClick={()=>recover(true)}>结束并放弃失败项</button></div>}
 {c.state==='paused'&&!failures&&!c.pendingAcknowledgements.length&&<p>请先处理其他编辑失败，然后继续。</p>}
 {c.releasePending&&<button className="button" disabled={working} onClick={()=>void c.retryRelease()}>重试释放预览</button>}
 {c.state==='failed'&&!failures&&!c.pendingAcknowledgements.length&&<button className="button" onClick={()=>c.show()}>重新配置并扫描</button>}
 {c.error&&<p role="alert">{c.error.message}</p>}
 {expanded&&<><ul>{c.items.slice(current*50,current*50+50).map(item=><li key={item.index}><span title={item.path}>{item.index+1}. {item.path}</span><small>{itemLabels[item.state]}</small>{(item.error||item.ackError)&&<p>{item.error?.message??item.ackError?.message}</p>}</li>)}</ul><div><button className="button" disabled={!current} onClick={()=>setPage(current-1)}>上一页</button><span>{current+1} / {pages}</span><button className="button" disabled={current+1>=pages} onClick={()=>setPage(current+1)}>下一页</button></div></>}
 </section>;
}
