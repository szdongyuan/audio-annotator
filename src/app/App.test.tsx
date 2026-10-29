import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { App } from './App';

const { project } = vi.hoisted(() => ({ project: { error: { message: '保存失败' } as {message:string}|null, closePending: false, recovery: null, active: {} as object|null, busy: false, saveAs: vi.fn(), restorePrompt:null as unknown, restoreLast:vi.fn(),startEmpty:vi.fn(),forgetSession:vi.fn(),open:vi.fn() } }));
vi.mock('../features/project/useProjectLifecycle', () => ({ useProjectLifecycle: () => project }));
vi.mock('../features/media/useMedia', () => ({ useMedia: () => ({ relink: null }) }));
vi.mock('../features/exchange/useExchange', () => ({ useExchange: () => ({ dialog: null }) }));
vi.mock('./AppShell', () => ({ AppShell: () => null }));
beforeEach(() => { vi.clearAllMocks(); project.busy=false; project.closePending = false; project.restorePrompt=null; project.active={}; project.error={message:'保存失败'}; });

it.each([false, true])('uses the same local-copy label and action for save failure (closing: %s)', closing => {
  project.closePending = closing;
  render(<App />);
  fireEvent.click(screen.getByRole('button', { name: '另存我的项目副本…' }));
  expect(project.saveAs).toHaveBeenCalledOnce();
});
it('waits for an idle welcome screen before first presenting restore, then retains its modal during opening', () => {
  project.active=null; project.error=null; project.restorePrompt={path:'C:/project/project.json'}; project.busy=true;
  const view=render(<App/>); expect(screen.queryByRole('dialog',{name:'继续上次的项目？'})).not.toBeInTheDocument();
  project.busy=false; view.rerender(<App/>); expect(screen.getByRole('dialog',{name:'继续上次的项目？'})).toHaveFocus();
  project.busy=true; view.rerender(<App/>); expect(screen.getByRole('button',{name:'恢复项目与工作状态'})).toBeDisabled();
});
it('keeps the welcome screen inert, traps modal focus and suppresses global shortcuts until restore is decided', () => {
  project.active=null; project.error=null; project.restorePrompt={path:'C:/project/project.json'};
  const view=render(<App/>), dialog=screen.getByRole('dialog',{name:'继续上次的项目？'});
  expect(view.container.querySelector('.app-root')).toHaveAttribute('inert'); expect(dialog).toHaveFocus();
  const restore=screen.getByRole('button',{name:'恢复项目与工作状态'}), forget=screen.getByRole('button',{name:'忘记此记录'});
  forget.focus(); fireEvent.keyDown(forget,{key:'Tab'}); expect(restore).toHaveFocus();
  fireEvent.keyDown(restore,{key:'Tab',shiftKey:true}); expect(forget).toHaveFocus();
  const global=vi.fn(); window.addEventListener('keydown',global);
  fireEvent.keyDown(dialog,{key:'s',ctrlKey:true}); fireEvent.keyDown(dialog,{key:' '}); expect(global).not.toHaveBeenCalled();
  fireEvent.click(restore); expect(project.restoreLast).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button',{name:'选择其他项目…'})); expect(project.open).toHaveBeenCalledWith('open');
  fireEvent.click(screen.getByRole('button',{name:'暂不打开'})); expect(project.startEmpty).toHaveBeenCalledOnce();
  fireEvent.click(forget); expect(project.forgetSession).toHaveBeenCalledOnce();
  window.removeEventListener('keydown',global);
});
