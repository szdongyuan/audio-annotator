import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { DeviceDialog } from './DeviceDialog';
import { TransportBar } from './TransportBar';
import { MediaDialog } from '../media/MediaDialog';
import { emptyPlayback } from '../../bridge/playback';
import type { PlaybackUI } from './usePlayback';
const make=()=>({effectiveMonitorGainDb:0,active:{lifecycle:{subscribe:()=>()=>{},getVersion:()=>0},store:{drafts:new Map(),editingDisabled:false,snapshot:{document:{media:[]}}}},media:{id:'m',frameCount:48000,sampleRate:48000},status:{...emptyPlayback,consumedFrames:123,underrunFrames:456,deviceName:'USB'},options:{deviceId:null,volume:.5},monitor:{monitorGainDb:0,mediaMonitorGainDb:{}},devices:[{id:'usb',name:'USB',isDefault:true}],refreshDevices:vi.fn(),update:vi.fn(),stop:vi.fn()} as unknown as PlaybackUI);
it('selects private device preferences, refreshes, and omits public diagnostic counters',()=>{
 const ui=make();render(<DeviceDialog ui={ui} onClose={vi.fn()} />);expect(screen.getByRole('option',{name:'系统默认'})).toBeInTheDocument();fireEvent.change(screen.getByRole('combobox',{name:'输出设备'}),{target:{value:'usb'}});expect(ui.update).toHaveBeenCalledWith({deviceId:'usb'});fireEvent.click(screen.getByRole('button',{name:'刷新设备'}));expect(ui.refreshDevices).toHaveBeenCalled();expect(screen.queryByText(/已提交|欠载|123|456/)).not.toBeInTheDocument();expect(screen.getByText('当前设备：USB')).toBeInTheDocument();
});
it.each(['Escape','outside'])('dismisses by %s and restores its stable trigger',kind=>{
 const trigger=document.createElement('button');document.body.append(trigger);trigger.focus();const close=vi.fn();const result=render(<DeviceDialog ui={make()} returnFocus={trigger} onClose={close}/>);
 if(kind==='Escape')fireEvent.keyDown(screen.getByRole('dialog'),{key:'Escape'});else {const event=new Event('pointerdown',{bubbles:true,cancelable:true});fireEvent(screen.getByRole('dialog').parentElement!,event);expect(event.defaultPrevented).toBe(true);}expect(close).toHaveBeenCalledOnce();result.unmount();expect(trigger).toHaveFocus();trigger.remove();
});
it('exposes output devices through bottom playback menu using the stable menu trigger',()=>{
 const open=vi.fn();render(<TransportBar ui={make()} onDevices={open}/>);const trigger=screen.getByRole('button',{name:'更多播放操作'});fireEvent.click(trigger);fireEvent.click(screen.getByRole('menuitem',{name:'输出设备…'}));expect(open).toHaveBeenCalledWith(trigger);
});
it.each([false,true])('leaves child pointer defaults and busy backdrop actions alone (busy=%s)',busy=>{
 const close=vi.fn();render(<MediaDialog title="指针边界" busy={busy} onClose={close}><button>内容</button></MediaDialog>);
 const child=new Event('pointerdown',{bubbles:true,cancelable:true});fireEvent(screen.getByRole('button',{name:'内容'}),child);expect(child.defaultPrevented).toBe(false);expect(close).not.toHaveBeenCalled();
 if(busy){const outside=new Event('pointerdown',{bubbles:true,cancelable:true});fireEvent(screen.getByRole('dialog').parentElement!,outside);expect(outside.defaultPrevented).toBe(false);expect(close).not.toHaveBeenCalled();}
});
