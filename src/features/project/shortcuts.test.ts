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
it('maps history, delete, cancel and tool keys outside text editing', () => {
  const target = document.createElement('div');
  for (const [key, expected] of [['Delete', 'delete'], ['Escape', 'cancel'], ['v', 'select'], ['a', 'annotate'], ['m', 'mask']]) expect(shortcutAction({ key, target })).toBe(expected);
  expect(shortcutAction({ key: 'z', ctrlKey: true, target })).toBe('undo');
  expect(shortcutAction({ key: 'y', ctrlKey: true, target })).toBe('redo');
});
