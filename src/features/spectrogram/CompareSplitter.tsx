import { useEffect, useRef } from 'react';
import type { ViewState } from '../../bridge/types';
import type { ProjectLifecycle } from '../project/lifecycle';
export const clampSplit=(value:number)=>Math.max(.25,Math.min(.75,Number.isFinite(value)?value:.5));
export function CompareSplitter({layout,value,disabled,onChange,lifecycle}:{layout:ViewState['compareLayout'];value:number;disabled:boolean;onChange:(value:number)=>void;lifecycle?:ProjectLifecycle}){
 const drag=useRef<{pointer:number;start:number;length:number;value:number}|null>(null);
 useEffect(()=>{const unregister=lifecycle?.registerBackgroundGuard(()=>!drag.current);return()=>{unregister?.();drag.current=null;};},[lifecycle]);
 return <div className="compare-splitter" role="separator" aria-label="调整对比比例" aria-orientation={layout==='horizontal'?'vertical':'horizontal'} aria-valuemin={25} aria-valuemax={75} aria-valuenow={Math.round(value*100)} aria-disabled={disabled} tabIndex={disabled?-1:0}
 onPointerDown={e=>{if(disabled||e.button!==0)return;e.preventDefault(); const rect=e.currentTarget.parentElement!.getBoundingClientRect();drag.current={pointer:e.pointerId,start:layout==='horizontal'?e.clientX:e.clientY,length:(layout==='horizontal'?rect.width:rect.height)-8,value};e.currentTarget.setPointerCapture(e.pointerId);}}
 onPointerMove={e=>{const d=drag.current;if(!d||disabled||e.pointerId!==d.pointer)return;onChange(clampSplit(d.value+((layout==='horizontal'?e.clientX:e.clientY)-d.start)/d.length));}}
 onPointerUp={e=>{drag.current=null;if(e.currentTarget.hasPointerCapture(e.pointerId))e.currentTarget.releasePointerCapture(e.pointerId);}} onPointerCancel={()=>{drag.current=null;}} onLostPointerCapture={()=>{drag.current=null;}}
 onKeyDown={e=>{if(disabled)return;const minus=layout==='horizontal'?'ArrowLeft':'ArrowUp',plus=layout==='horizontal'?'ArrowRight':'ArrowDown';if([minus,plus,'Home','End'].includes(e.key)){e.preventDefault();onChange(clampSplit(e.key==='Home'?.25:e.key==='End'?.75:value+(e.key===plus?.05:-.05)));}}}/>;
}
