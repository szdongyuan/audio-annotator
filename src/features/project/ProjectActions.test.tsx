import { fireEvent, render, screen } from '@testing-library/react';
import { it, expect, vi } from 'vitest';
import { ProjectActions } from './ProjectActions';
import type { ProjectLifecycleUI } from './useProjectLifecycle';
it('dismisses project menu after an action, outside pointer and Escape', () => {
  const project = { busy: false, recovery: null, active: {}, open: vi.fn(), close: vi.fn(), save: vi.fn(), saveAs: vi.fn() } as unknown as ProjectLifecycleUI;
  const { container } = render(<ProjectActions project={project} />);
  const menu = container.querySelector('details')!;
  menu.open = true; fireEvent.click(screen.getByText('新建项目'));
  expect(project.open).toHaveBeenCalledWith('create'); expect(menu.open).toBe(false);
  menu.open = true; fireEvent.pointerDown(document.body); expect(menu.open).toBe(false);
  menu.open = true; fireEvent.keyDown(document, { key: 'Escape' }); expect(menu.open).toBe(false);
  expect(container.querySelector('summary')).toHaveFocus();
});
