import {afterEach,expect,it} from 'vitest';
import {seekKeyDelta} from './keyboardSeek';

afterEach(()=>document.body.replaceChildren());
it('maps only eligible unmodified arrow keys, including repeats',()=>{
 const event={key:'ArrowRight',target:document.body};
 expect(seekKeyDelta({...event,key:'ArrowLeft'})).toBe(-2);
 expect(seekKeyDelta({...event,repeat:true})).toBe(2);
 expect(seekKeyDelta({...event,key:'Home'})).toBeNull();
 for(const flag of ['ctrlKey','metaKey','altKey','shiftKey','isComposing','defaultPrevented'])expect(seekKeyDelta({...event,[flag]:true})).toBeNull();
 expect(seekKeyDelta({...event,nativeEvent:{isComposing:true}})).toBeNull();
});
it('preserves controls and their descendants while allowing ordinary buttons and audio rows',()=>{
 for(const tag of ['input','textarea','select','dialog'])expect(seekKeyDelta({key:'ArrowRight',target:document.createElement(tag)})).toBeNull();
 for(const role of ['dialog','alertdialog','menu','menubar','tablist','slider','separator']){
  const control=document.createElement('div'),child=document.createElement('span');control.setAttribute('role',role);control.append(child);
  expect(seekKeyDelta({key:'ArrowRight',target:child})).toBeNull();
 }
 const editable=document.createElement('div'),child=document.createElement('span');editable.setAttribute('contenteditable','true');editable.append(child);
 expect(seekKeyDelta({key:'ArrowRight',target:child})).toBeNull();
 editable.setAttribute('contenteditable','false');expect(seekKeyDelta({key:'ArrowRight',target:child})).toBe(2);
 for(const className of ['', 'media-select']){const button=document.createElement('button');button.className=className;expect(seekKeyDelta({key:'ArrowRight',target:button})).toBe(2);}
});
it('rejects shortcuts while either application menu is open',()=>{
 for(const markup of ['<div data-app-menu></div>','<dialog class="project-menu" open></dialog>']){
  document.body.innerHTML=markup;expect(seekKeyDelta({key:'ArrowRight',target:document.body})).toBeNull();
 }
});
