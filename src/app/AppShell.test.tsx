import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import fixture from '../../tests/fixtures/document-v3.json';
import { parseProjectDocument } from '../bridge/types';
import { ProjectStore } from './store';
import { CommandQueue, type ProjectCommands } from './commands';
import { ProjectLifecycle } from '../features/project/lifecycle';
import type { ProjectLifecycleUI } from '../features/project/useProjectLifecycle';
import { AppShell } from './AppShell';

describe('workspace sidebars', () => {
  it('restores transient inspector/panels after owner reset without changing durable workspace or creating drafts', () => {
    const doc=parseProjectDocument(structuredClone(fixture));
    const store=new ProjectStore({document:doc,canUndo:false,canRedo:false}),queue=new CommandQueue(store,{} as ProjectCommands),lifecycle=new ProjectLifecycle(store,queue,{save:vi.fn(),close:vi.fn()});
    const ui={inspectorTab:'list',mediaOpen:false,propertiesOpen:true,cues:{[doc.media[0].id]:.4}};
    const owner={store,queue,lifecycle,path:'test',restoredUI:ui};
    const acknowledgeSessionUI=vi.fn();
    const project={active:owner,acknowledgeSessionUI} as unknown as ProjectLifecycleUI;
    const before=structuredClone(store.snapshot.document);
    const view=render(<AppShell project={project}/>);
    expect(screen.getByRole('tab',{name:'列表'})).toHaveAttribute('aria-selected','true');
    expect(screen.getByRole('button',{name:'展开音频列表'})).toHaveAttribute('aria-expanded','false');
    expect(acknowledgeSessionUI).toHaveBeenLastCalledWith(owner,ui,[]);
    expect(store.snapshot.document).toEqual(before); expect(store.drafts.size).toBe(0); expect(store.snapshot.canUndo).toBe(false);
    fireEvent.click(screen.getByRole('tab',{name:'类别'}));
    expect(acknowledgeSessionUI).toHaveBeenLastCalledWith(owner,{...ui,inspectorTab:'categories'},[]);
    view.unmount(); lifecycle.dispose();
  });
  it('opens the same output dialog from audio and playback menus and restores each stable trigger',()=>{
    const store=new ProjectStore({document:parseProjectDocument(fixture),canUndo:false,canRedo:false}),queue=new CommandQueue(store,{} as ProjectCommands),lifecycle=new ProjectLifecycle(store,queue,{save:vi.fn(),close:vi.fn()});
    const project={active:{store,queue,lifecycle,path:'test'}} as ProjectLifecycleUI;
    const view=render(<AppShell project={project}/>);const audio=screen.getByRole('menuitem',{name:'音频'});fireEvent.click(audio);fireEvent.click(screen.getByRole('menuitem',{name:'输出设备…'}));expect(screen.getByRole('dialog',{name:'输出设备'})).toBeInTheDocument();fireEvent.keyDown(screen.getByRole('dialog'),{key:'Escape'});expect(audio).toHaveFocus();
    const bottom=screen.getByRole('button',{name:'更多播放操作'});fireEvent.click(bottom);fireEvent.click(screen.getByRole('menuitem',{name:'输出设备…'}));expect(screen.getByRole('dialog',{name:'输出设备'})).toBeInTheDocument();fireEvent.pointerDown(screen.getByRole('dialog').parentElement!);expect(bottom).toHaveFocus();expect(screen.queryByText(/已提交|欠载/)).not.toBeInTheDocument();view.unmount();lifecycle.dispose();
  });
  it('replaces the device tab with compact example access at narrow width', () => {
    Object.defineProperty(window, 'innerWidth', {configurable:true,value:1000});
    render(<AppShell />);
    expect(screen.getByRole('tab',{name:'示例'})).toBeVisible();
    expect(screen.queryByRole('tab',{name:'设备'})).not.toBeInTheDocument();
    expect(screen.getAllByRole('tab')).toHaveLength(7);
    fireEvent.click(screen.getByRole('tab',{name:'示例'}));
    expect(screen.getByText('打开项目后查看示例')).toBeVisible();
  });
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
