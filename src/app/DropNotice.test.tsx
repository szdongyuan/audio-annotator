import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { HelpDialog } from './HelpDialog';
import { DropNotice } from './DropNotice';

let original: typeof HTMLDialogElement.prototype.showModal, originalMatches: typeof HTMLDialogElement.prototype.matches;
beforeEach(() => { original = HTMLDialogElement.prototype.showModal; originalMatches = HTMLDialogElement.prototype.matches; HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); this.dataset.testModal='true'; }; HTMLDialogElement.prototype.matches = function (selector) { return selector === ':modal' ? this.dataset.testModal === 'true' : originalMatches.call(this,selector); }; });
afterEach(() => { HTMLDialogElement.prototype.showModal = original; HTMLDialogElement.prototype.matches = originalMatches; });
it('places the passive drop status inside the open HelpDialog and preserves its focus', async () => {
  const help=render(<HelpDialog topic="shortcuts" onClose={vi.fn()}/>), dialog=screen.getByRole('dialog',{name:'帮助'}), close=within(dialog).getByRole('button',{name:'关闭'});
  close.focus();render(<DropNotice message="请先关闭当前窗口，再拖入音频。"/>);
  const status=within(dialog).getByRole('status');expect(status).toHaveTextContent('请先关闭当前窗口');expect(status).toHaveAttribute('aria-live','polite');
  expect(status.querySelector('button, a, [tabindex]')).toBeNull();expect(close).toHaveFocus();
  help.unmount();await waitFor(()=>expect(screen.getByRole('status')).toBeInTheDocument());expect(screen.getByRole('status').closest('dialog')).toBeNull();
});
it('does not move the status into a nonmodal dialog popover',()=>{
  render(<><div role="dialog" aria-label="监听增益"/><DropNotice message="拖入提示"/></>);
  expect(screen.getByRole('status').closest('[role="dialog"]')).toBeNull();
});
it('does not move the status into a nonmodal native dialog',()=>{
  render(<><dialog open aria-label="非模态面板"/><DropNotice message="拖入提示"/></>);
  expect(screen.getByRole('status').closest('dialog')).toBeNull();
});
