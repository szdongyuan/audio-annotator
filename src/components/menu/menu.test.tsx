import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { Menu } from './Menu';
import { menuPosition } from './menuModel';
it('clamps root menus and flips submenus at the window edge', () => {
  expect(menuPosition({ x: 790, y: 590 }, { width: 200, height: 300 }, { width: 800, height: 600 })).toEqual({ left: 596, top: 296 });
  expect(menuPosition({ x: 790, y: 20 }, { width: 200, height: 300 }, { width: 800, height: 600 }, 590)).toEqual({ left: 390, top: 20 });
});
it('skips disabled entries, enters submenus, consumes Escape and restores focus', () => {
  const trigger = document.createElement('button'); document.body.append(trigger); trigger.focus();
  const action = vi.fn(), close = vi.fn();
  const view = render(<Menu anchor={{ x: 5, y: 5 }} onClose={close} items={[{ id: 'disabled', label: 'Disabled', disabled: true }, { id: 'group', label: 'Group', children: [{ id: 'action', label: 'Action', action }] }]} />);
  expect(screen.getByRole('menuitem', { name: 'Group' })).toHaveFocus();
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
  expect(screen.getByRole('menuitem', { name: 'Action' })).toHaveFocus();
  fireEvent.keyDown(document.activeElement!, { key: 'Enter' }); expect(action).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
  view.unmount(); expect(trigger).toHaveFocus(); trigger.remove();
});
it('outside pointer closes without reaching the underlying canvas', () => {
  const close = vi.fn(), canvas = vi.fn();
  render(<div onPointerDown={canvas}><Menu anchor={{ x: 5, y: 5 }} onClose={close} items={[{ id: 'one', label: 'One' }]} /></div>);
  fireEvent.pointerDown(screen.getByTestId('menu-shield')); expect(close).toHaveBeenCalledOnce(); expect(canvas).not.toHaveBeenCalled();
});
it('an entirely disabled menu keeps keyboard focus and still closes with Escape', () => {
  const close = vi.fn(); render(<Menu anchor={{ x: 5, y: 5 }} onClose={close} items={[{ id: 'one', label: 'Unavailable', disabled: true }]} />);
  expect(screen.getByRole('menu')).toHaveFocus();
  fireEvent.keyDown(document.activeElement!, { key: 'Home' }); fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' }); expect(close).toHaveBeenCalledOnce();
});
it('checkbox actions stay open and expose checked state for mouse, Space and Enter',()=>{
 const action=vi.fn(),close=vi.fn();const view=render(<Menu anchor={{x:5,y:5}} onClose={close} items={[{id:'a',label:'A',checked:false,keepOpen:true,action} as never]}/>);
 const item=screen.getByRole('menuitemcheckbox',{name:'A'});expect(item).toHaveAttribute('aria-checked','false');fireEvent.click(item);fireEvent.keyDown(item,{key:' '});fireEvent.keyDown(item,{key:'Enter'});expect(action).toHaveBeenCalledTimes(3);expect(close).not.toHaveBeenCalled();view.unmount();
});
it('keyboard toggle after a checkbox click acts on the clicked checkbox',()=>{
 const a=vi.fn(),b=vi.fn();render(<Menu anchor={{x:5,y:5}} onClose={vi.fn()} items={[{id:'a',label:'A',keepOpen:true,checked:false,action:a},{id:'b',label:'B',keepOpen:true,checked:false,action:b}]}/>);
 const second=screen.getByRole('menuitemcheckbox',{name:'B'});fireEvent.click(second);fireEvent.keyDown(second,{key:' '});expect(b).toHaveBeenCalledTimes(2);expect(a).not.toHaveBeenCalled();
});
