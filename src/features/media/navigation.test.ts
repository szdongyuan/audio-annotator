import { afterEach, describe, expect, it } from 'vitest';
import { mediaNavigationDirection, mediaRandomShortcut } from './navigation';

afterEach(() => { document.body.replaceChildren(); });

function target(markup: string): Element {
  document.body.innerHTML = markup;
  return document.body.querySelector('[data-target]')!;
}

function keyEvent(key: string, target: EventTarget | null = document.body, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, cancelable: true, ...init });
  Object.defineProperty(event, 'target', { value: target });
  return event;
}

describe('mediaRandomShortcut', () => {
  it.each(['r', 'R'])('accepts unmodified %s from the body, including Caps Lock uppercase', key => {
    expect(mediaRandomShortcut(keyEvent(key))).toBe(true);
  });

  it.each([
    '<button class="media-select" data-target>audio.wav</button>',
    '<button class="media-select"><span data-target>audio.wav</span></button>',
    '<div contenteditable="false"><span data-target>workspace</span></div>',
  ])('accepts ordinary media/workspace targets: %s', markup => {
    expect(mediaRandomShortcut(keyEvent('r', target(markup)))).toBe(true);
  });

  it.each([
    '<input data-target>', '<textarea data-target></textarea>', '<select data-target></select>',
    '<input type="checkbox" data-target>', '<button role="checkbox" data-target>check</button>',
    '<div role="checkbox"><span data-target>check</span></div>',
    '<div contenteditable><span data-target>text</span></div>',
    '<div contenteditable="true"><span data-target>text</span></div>',
    '<div contenteditable="plaintext-only"><span data-target>text</span></div>',
    ...['dialog', 'alertdialog', 'menu', 'menubar', 'separator', 'tablist', 'slider'].map(role => `<div role="${role}"><span data-target>control</span></div>`),
  ])('ignores protected control targets: %s', markup => {
    expect(mediaRandomShortcut(keyEvent('r', target(markup)))).toBe(false);
  });

  it.each(['ctrlKey', 'metaKey', 'altKey', 'shiftKey', 'isComposing', 'repeat'] as const)('ignores %s', flag => {
    expect(mediaRandomShortcut(keyEvent('R', document.body, { [flag]: true }))).toBe(false);
  });

  it('ignores an already handled event', () => {
    const event = keyEvent('r');
    event.preventDefault();
    expect(mediaRandomShortcut(event)).toBe(false);
  });

  it.each(['ArrowUp', 'ArrowDown', ' ', 'Enter', 'rr'])('ignores unrelated key %s', key => {
    expect(mediaRandomShortcut(keyEvent(key))).toBe(false);
  });

  it.each(['<div data-app-menu></div>', '<details class="project-menu" open></details>'])('ignores shortcuts while a menu is open: %s', markup => {
    document.body.innerHTML = markup;
    expect(mediaRandomShortcut(keyEvent('r'))).toBe(false);
  });

  it('accepts non-element and absent event targets safely', () => {
    expect(mediaRandomShortcut(keyEvent('r', document))).toBe(true);
    expect(mediaRandomShortcut(keyEvent('r', null))).toBe(true);
  });
});

describe('mediaNavigationDirection compatibility', () => {
  it('preserves up/down directions and ignores unrelated keys', () => {
    expect(mediaNavigationDirection(keyEvent('ArrowUp'))).toBe(-1);
    expect(mediaNavigationDirection(keyEvent('ArrowDown'))).toBe(1);
    expect(mediaNavigationDirection(keyEvent('r'))).toBeNull();
  });

  it.each(['ctrlKey', 'metaKey', 'altKey', 'shiftKey', 'isComposing'] as const)('preserves the %s guard', flag => {
    expect(mediaNavigationDirection(keyEvent('ArrowDown', document.body, { [flag]: true }))).toBeNull();
  });

  it.each([
    '<input data-target>', '<input type="checkbox" data-target>', '<textarea data-target></textarea>', '<select data-target></select>',
    '<div contenteditable="true"><span data-target>text</span></div>',
    ...['dialog', 'alertdialog', 'menu', 'menubar', 'separator', 'tablist', 'slider'].map(role => `<div role="${role}"><span data-target>control</span></div>`),
  ])('preserves target protection: %s', markup => {
    expect(mediaNavigationDirection(keyEvent('ArrowDown', target(markup)))).toBeNull();
  });

  it.each(['<div data-app-menu></div>', '<details class="project-menu" open></details>'])('preserves open-menu protection: %s', markup => {
    document.body.innerHTML = markup;
    expect(mediaNavigationDirection(keyEvent('ArrowDown'))).toBeNull();
  });

  it('preserves existing handling of repeat, defaultPrevented, and custom checkbox targets', () => {
    const event = keyEvent('ArrowDown', target('<button role="checkbox" data-target>check</button>'), { repeat: true });
    event.preventDefault();
    expect(mediaNavigationDirection(event)).toBe(1);
  });

  it('allows media rows, nested text and explicitly non-editable content', () => {
    const element = target('<button class="media-select" contenteditable="false"><span data-target>audio.wav</span></button>');
    expect(mediaNavigationDirection(keyEvent('ArrowUp', element))).toBe(-1);
  });
});
