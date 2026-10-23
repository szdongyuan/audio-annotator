import { expect, it } from 'vitest';
import { shortcutAction } from './shortcuts';
it('protects text controls and contenteditable from all project shortcuts', () => {
  for (const tag of ['input', 'textarea', 'select']) {
    const target = document.createElement(tag);
    for (const key of ['Delete', ' ', 'Escape', 'z', 'y', 'a']) expect(shortcutAction({ key, ctrlKey: true, target })).toBeNull();
  }
  const target = document.createElement('div'); target.setAttribute('contenteditable', 'true');
  expect(shortcutAction({ key: 'Delete', target })).toBeNull();
});
it('maps history, delete and cancel without obsolete tool modes', () => {
  const target = document.createElement('div');
  for (const [key, expected] of [['Delete', 'delete'], ['Escape', 'cancel'], ['v', null], ['a', null], ['m', null]] as const) expect(shortcutAction({ key, target })).toBe(expected);
  expect(shortcutAction({ key: 'z', ctrlKey: true, target })).toBe('undo');
  expect(shortcutAction({ key: 'y', ctrlKey: true, target })).toBe('redo');
});
it('does not trigger editing while either menu implementation or a dialog is active', () => {
  const menu = document.createElement('details'); menu.className = 'project-menu'; menu.open = true; document.body.append(menu);
  expect(shortcutAction({ key: 'Delete', target: document.body })).toBeNull(); menu.remove();
  const dialog = document.createElement('div'); dialog.setAttribute('role', 'dialog'); const button = document.createElement('button'); dialog.append(button);
  expect(shortcutAction({ key: 'Delete', target: button })).toBeNull();
});
