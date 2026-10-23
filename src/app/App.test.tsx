import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { App } from './App';

const { project } = vi.hoisted(() => ({ project: { error: { message: '保存失败' }, closePending: false, recovery: null, active: {}, busy: false, saveAs: vi.fn() } }));
vi.mock('../features/project/useProjectLifecycle', () => ({ useProjectLifecycle: () => project }));
vi.mock('../features/media/useMedia', () => ({ useMedia: () => ({ relink: null }) }));
vi.mock('../features/exchange/useExchange', () => ({ useExchange: () => ({ dialog: null }) }));
vi.mock('./AppShell', () => ({ AppShell: () => null }));
beforeEach(() => { project.saveAs.mockClear(); project.closePending = false; });

it.each([false, true])('uses the same local-copy label and action for save failure (closing: %s)', closing => {
  project.closePending = closing;
  render(<App />);
  fireEvent.click(screen.getByRole('button', { name: '另存项目副本…' }));
  expect(project.saveAs).toHaveBeenCalledOnce();
});
