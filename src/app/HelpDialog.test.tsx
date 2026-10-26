import { render, screen } from '@testing-library/react';
import { beforeAll, expect, test, vi } from 'vitest';
import { HelpDialog } from './HelpDialog';
beforeAll(() => { HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); }; });
test('in-app guide explains the current source preview and logical-route workflow', () => {
  render(<HelpDialog topic="guide" onClose={vi.fn()} />);
  const text = screen.getByRole('dialog', { name: '帮助' }).textContent;
  for (const phrase of ['导入 ZIP 音频', '默认包含子文件夹', '扫描预览', '不会自动导入', '*/CH1', 'position 1']) expect(text).toContain(phrase);
  expect(text).not.toContain('默认只扫描当前目录');
});
