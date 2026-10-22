import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AppShell } from './AppShell';

describe('workspace sidebars', () => {
  it('collapses and restores each sidebar independently with accessible state', () => {
    render(<AppShell />);
    const mediaToggle = screen.getByRole('button', { name: '收起音频列表' });
    fireEvent.click(mediaToggle);
    expect(screen.queryByRole('complementary', { name: '音频列表' })).not.toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: '属性' })).toBeVisible();
    const restoreMedia = screen.getByRole('button', { name: '展开音频列表' });
    expect(restoreMedia).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(restoreMedia);
    expect(screen.getByRole('complementary', { name: '音频列表' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '收起属性面板' }));
    expect(screen.queryByRole('complementary', { name: '属性' })).not.toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: '音频列表' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '展开属性面板' }));
    expect(screen.getByRole('complementary', { name: '属性' })).toBeVisible();
  });
});
