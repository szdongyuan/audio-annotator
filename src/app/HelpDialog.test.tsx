import { render, screen } from '@testing-library/react';
import { beforeAll, expect, test, vi } from 'vitest';
import { HelpDialog } from './HelpDialog';
beforeAll(() => { HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); }; });
test('in-app guide explains the current source preview and logical-route workflow', () => {
  render(<HelpDialog topic="guide" onClose={vi.fn()} />);
  const text = screen.getByRole('dialog', { name: '帮助' }).textContent;
  for (const phrase of ['导入 ZIP 音频', '默认包含子文件夹', '扫描预览', '不会自动导入', '*/CH1', 'position 1', 'UUID 跨项目保持不变', '导入后需明确点击', '重复导入保留本机昵称', '旧协作格式 1/2 不受支持', '私人工作区']) expect(text).toContain(phrase);
  expect(text).not.toContain('默认只扫描当前目录');
  expect(text).not.toContain('注册或登录项目账号');
});
