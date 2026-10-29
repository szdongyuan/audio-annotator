import { MediaDialog } from '../media/MediaDialog';
import type { PlaybackUI } from './usePlayback';

export function DeviceDialog({ui,onClose,returnFocus}:{ui:PlaybackUI;onClose:()=>void;returnFocus?:HTMLElement|null}){
 const disabled=!ui.active||ui.active.store.editingDisabled;
 return <MediaDialog title="输出设备" returnFocus={returnFocus} onClose={onClose}>
  <header><h2>输出设备</h2></header>
  <div className="source-import-body transport-detail">
   <label>输出设备<select autoFocus aria-label="输出设备" disabled={disabled} value={ui.options.deviceId??''} onChange={e=>ui.update({deviceId:e.target.value||null})}>
    <option value="">系统默认</option>{ui.options.deviceId&&!ui.devices.some(d=>d.id===ui.options.deviceId)&&<option value={ui.options.deviceId}>所选设备（当前不可用）</option>}{ui.devices.map(d=><option key={d.id} value={d.id}>{d.name}{d.isDefault?'（系统默认）':''}</option>)}
   </select></label>
   <span>当前设备：{ui.status.deviceName??'系统默认'}</span>
   <button className="button" disabled={disabled} onClick={ui.refreshDevices}>刷新设备</button>
   {ui.error&&<p role="alert">{ui.error.message}</p>}
  </div>
  <footer className="dialog-actions"><button className="button" onClick={onClose}>关闭</button></footer>
 </MediaDialog>;
}
