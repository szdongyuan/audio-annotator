import { expect, it } from 'vitest';
import { isResetViewShortcut } from './viewShortcut';
it('resets with Ctrl+0 or Command+0 without intercepting text entry or other commands', () => {
 expect(isResetViewShortcut({key:'0',ctrlKey:true,target:document.body})).toBe(true);
 expect(isResetViewShortcut({key:'0',metaKey:true,target:document.body})).toBe(true);
 for(const tag of ['input','select','textarea']) expect(isResetViewShortcut({key:'0',ctrlKey:true,target:document.createElement(tag)})).toBe(false);
 for(const patch of [{ctrlKey:false},{altKey:true},{shiftKey:true},{key:'r'}]) expect(isResetViewShortcut({key:'0',ctrlKey:true,target:document.body,...patch})).toBe(false);
});
