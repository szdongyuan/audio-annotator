import {menuIsOpen} from '../../components/menu/menuModel';

export interface SeekKeyEvent {
 key:string;
 target:EventTarget|null;
 ctrlKey?:boolean;
 metaKey?:boolean;
 altKey?:boolean;
 shiftKey?:boolean;
 isComposing?:boolean;
 nativeEvent?:{isComposing?:boolean};
 defaultPrevented?:boolean;
 repeat?:boolean;
}

export function seekKeyDelta(event:SeekKeyEvent):-2|2|null {
 if(event.defaultPrevented||event.isComposing||event.nativeEvent?.isComposing||event.ctrlKey||event.metaKey||event.altKey||event.shiftKey||menuIsOpen())return null;
 if(event.target instanceof Element&&event.target.closest('input,textarea,select,dialog,[role="dialog"],[role="alertdialog"],[role="menu"],[role="menubar"],[role="tablist"],[role="slider"],[role="separator"],[contenteditable]:not([contenteditable="false"])'))return null;
 return event.key==='ArrowLeft'?-2:event.key==='ArrowRight'?2:null;
}
