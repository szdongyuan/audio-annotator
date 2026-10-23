import { fireEvent, render, screen } from '@testing-library/react';
import { it, expect, vi } from 'vitest';
import { AppMenu } from '../../app/AppMenu';
import { projectMenuItems } from './ProjectActions';
import type { ProjectLifecycleUI } from './useProjectLifecycle';
it('binds project menu actions and dismisses after action, outside pointer and Escape', () => {
 const project={busy:false,recovery:null,active:null,open:vi.fn(),close:vi.fn(),save:vi.fn(),saveAs:vi.fn()} as unknown as ProjectLifecycleUI;
 render(<AppMenu owner={null} menus={[{id:'file',label:'文件',items:projectMenuItems({project})}]}/>);
 const trigger=screen.getByRole('menuitem',{name:'文件'});
 fireEvent.click(trigger);fireEvent.click(screen.getByRole('menuitem',{name:'新建项目'})); expect(project.open).toHaveBeenCalledWith('create');expect(screen.queryByRole('menu')).not.toBeInTheDocument();
 fireEvent.click(trigger);fireEvent.pointerDown(screen.getByTestId('menu-shield'));expect(screen.queryByRole('menu')).not.toBeInTheDocument();
 fireEvent.click(trigger);fireEvent.keyDown(document.activeElement!,{key:'Escape'});expect(screen.queryByRole('menu')).not.toBeInTheDocument();expect(trigger).toHaveFocus();
 fireEvent.click(trigger);expect(screen.getByRole('menuitem',{name:'保存'})).toHaveAttribute('aria-disabled','true');
});

it('names the local project copy accurately and calls the existing saveAs action', () => {
 const project={busy:false,recovery:null,active:{store:{editingDisabled:false}},saveAs:vi.fn()} as unknown as ProjectLifecycleUI;
 render(<AppMenu owner={null} menus={[{id:'file',label:'文件',items:projectMenuItems({project})}]}/>);
 fireEvent.click(screen.getByRole('menuitem',{name:'文件'}));
 fireEvent.click(screen.getByRole('menuitem',{name:'另存项目副本…'}));
 expect(project.saveAs).toHaveBeenCalledOnce();
});
