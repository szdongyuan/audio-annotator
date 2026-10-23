import { useEffect, useState } from 'react';
import { useDismissibleLayer } from '../components/popover/DismissibleLayer';
import { createPortal } from 'react-dom';
import { version } from '../../package.json';
export type HelpTopic='shortcuts'|'guide'|'about';
export function HelpDialog({topic,onClose}:{topic:HelpTopic;onClose:()=>void}){
 const dialog=useDismissibleLayer<HTMLDialogElement>(onClose);const [showNotices,setShowNotices]=useState(false); const [notices,setNotices]=useState('加载第三方声明…');
 useEffect(()=>{if(!showNotices)return;let live=true;void import('../../licenses/THIRD-PARTY-NOTICES.txt?raw').then(module=>{if(live)setNotices(module.default);}).catch(()=>{if(live)setNotices('无法载入第三方声明，请关闭后重试。');});return()=>{live=false;};},[showNotices]);
 useEffect(()=>{const previous=document.activeElement as HTMLElement|null;dialog.current?.showModal();return()=>previous?.focus();},[]);
 return createPortal(<dialog ref={dialog} className="help-dialog" aria-label="帮助" onCancel={e=>{e.preventDefault();onClose();}} onKeyDown={e=>e.stopPropagation()}><header><h2>{topic==='shortcuts'?'快捷键':topic==='guide'?'使用说明':`音频标注 ${version}`}</h2><button className="button" autoFocus onClick={onClose}>关闭</button></header>
 {topic==='shortcuts'&&<ul><li>空白拖动框选；激活框内部抓取移动，外部首次操作取消激活；中键或 Alt + 拖动平移。</li><li>Delete 屏蔽选区；Escape 取消手势或清除选区。</li><li>Ctrl + Z 撤销；Ctrl + Y / Ctrl + Shift + Z 重做；Ctrl + S 保存。</li><li>空格播放 / 暂停；右键打开选区与坐标轴菜单。</li><li>滚轮缩放时间；Shift + 滚轮缩放频率；Ctrl + 滚轮调整 STFT 线性 / 对数比例。</li><li>沿刻度拖动局部放大；菜单使用方向键、Enter 和 Escape。</li></ul>}
 {topic==='guide'&&<><p>从“文件”新建项目，再导入 WAV、FLAC 或 MP3 音频。项目保存标注、屏蔽和显示设置，原始音频保持不变。</p><p>在频谱拖出选区，右键选择类别、填写备注、播放或屏蔽。激活框内部和边缘可移动，拖动控制点调整范围；外部首次操作取消激活，再次拖动新建。悬浮条可直接播放与分类；删除已保存对象使用明确的菜单入口。</p><p>“视图”选择双文件及左右 / 上下排列，拖动分隔线调整比例。各文件可独立滚动通道；分析和显示参数从文件标题或“视图”打开。</p><p>声音版本默认暂存编辑，同时控制频谱和普通播放；可切换原音以忽略屏蔽。空格自动播放激活选区。右键白色虚线定位，“从此处播放”和“播放整段”覆盖本次范围，停止后恢复自动选择。“音频”提供输出设备与混音。文件标题、通道标题或“标注”菜单可分别分类；文件、通道、区域类别和备注互不继承，列表可按类别查找三种对象。删除类别会统计三层引用，一次撤销可恢复。“另存项目副本…”在新目录创建工作副本并切换过去，仍引用原音频。跨电脑请选择“分享项目”中默认的“完整项目包（含音频）”；“仅标注（不含音频）”需要接收方另行关联同一批原始音频。</p><p>“文件 → 导入文件夹”默认只扫描当前目录，可勾选包含子文件夹。不跟随链接或 junction；重复路径跳过。同名不同路径独立导入。最多 10000 个候选音频、100000 个条目，超限需缩小目录。扫描后分批导入，取消保留已成功媒体；失败可从结果与错误提示恢复。</p><p>当前支持项目与分享格式 2；旧测试项目需要重新创建。缺失音频可从文件列表重新关联；保存失败时使用错误提示中的重试或另存。</p></>}
 {topic==='about'&&<><p>本地音频频谱观察、对比与标注。</p><button className="button" onClick={()=>setShowNotices(!showNotices)}>第三方声明</button>{showNotices&&<pre tabIndex={0}>{notices}</pre>}</>}
 </dialog>,document.body);
}
