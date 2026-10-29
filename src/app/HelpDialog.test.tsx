import { render, screen } from '@testing-library/react';
import { beforeAll, expect, test, vi } from 'vitest';
import { HelpDialog } from './HelpDialog';
beforeAll(() => { HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); }; });
test('in-app guide explains the current source preview and logical-route workflow', () => {
  render(<HelpDialog topic="guide" onClose={vi.fn()} />);
  const text = screen.getByRole('dialog', { name: '帮助' }).textContent;
  for (const phrase of ['导入 ZIP 音频', '默认包含子文件夹', '扫描预览', '不会自动导入', '*/CH1', 'position 1', 'UUID 跨项目保持不变', '导入后需明确点击', '重复导入保留本机昵称', '项目3、协作5、作者层2、私人工作区2、交换4、DSP2', '旧格式拒绝且不迁移', '多个标签', '绝对覆盖', '重置屏蔽', '共享目录', '高级设置默认折叠', '私人工作区']) expect(text).toContain(phrase);
  expect(text).not.toContain('默认只扫描当前目录');
  expect(text).not.toContain('注册或登录项目账号');
});

test('in-app guide explains duplicate policy and resuming source imports precisely', () => {
  render(<HelpDialog topic="guide" onClose={vi.fn()} />);
  const text = screen.getByRole('dialog', { name: '帮助' }).textContent;
  for (const phrase of ['“跳过重复音频”默认勾选', '最终目标目录和完整文件名', '不区分大小写', '同名但内容不同也会跳过', '回收站中的音频不参与', '取消勾选', '中断后重新扫描', '直接“导入音频文件”保持原有行为']) expect(text).toContain(phrase);
  expect(text).not.toContain('同名或相同内容不会合并');
});
