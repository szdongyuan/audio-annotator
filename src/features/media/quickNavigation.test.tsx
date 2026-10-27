import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useState } from 'react';
import fixture from '../../../tests/fixtures/document-v3.json';
import { MediaList } from './MediaList';
import { OrganizationController } from './organization';
import { AppShell } from '../../app/AppShell';

afterEach(() => { localStorage.clear(); vi.unstubAllGlobals(); });
it('navigates collapsed directory contents, skipping hidden and other-pane audio without hijacking inputs', () => {
  const files = Array.from({ length: 4 }, (_, i) => ({ ...fixture.media[0], id: crypto.randomUUID(), displayName: `音频${i}.wav` }));
  const folder = crypto.randomUUID(), controller = new OrganizationController(fixture.projectId, 'test', true, {} as never);
  controller.snapshot = { kind: 'audio-annotator-organization', formatVersion: 1, projectId: fixture.projectId, revision: 0, layoutRevision: 0, folders: [{ id: folder, parentId: null, name: '收音' }], media: files.map(m => ({ mediaId: m.id, folderId: folder, originalFilename: m.displayName })) };
  const select = vi.fn();
  function App() { const [id, setId] = useState<string>(files[0].id); return <MediaList organization={controller} media={files} annotations={[]} statuses={[]} selectedId={id} disabled={false} hiddenMediaIds={[files[2].id]} navigationExcludedId={files[1].id} onSelect={next => { select(next); setId(next); }} onImport={vi.fn()} onRelink={vi.fn()} />; }
  render(<App />); expect(screen.queryByRole('button', { name: '音频3.wav' })).toBeNull();
  fireEvent.keyDown(document.body, { key: 'ArrowDown' }); expect(select).toHaveBeenLastCalledWith(files[3].id); expect(screen.getByRole('button', { name: '音频3.wav' })).toHaveAttribute('aria-pressed', 'true');
  fireEvent.keyDown(screen.getByLabelText('搜索音频'), { key: 'ArrowUp' }); expect(select).toHaveBeenCalledTimes(1);
  fireEvent.keyDown(document.body, { key: 'ArrowUp', ctrlKey: true }); expect(select).toHaveBeenCalledTimes(1);
  fireEvent.keyDown(document.body, { key: 'ArrowUp' }); expect(select).toHaveBeenLastCalledWith(files[0].id);
});
it.each([false, true])('copies the original basename without changing selection; clipboard rejection=%s', async rejected => {
  const file = { ...fixture.media[0], displayName: '记录/audio/CH2.wav' }, select = vi.fn(), writeText = rejected ? vi.fn().mockRejectedValue(new Error('denied')) : vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  render(<MediaList media={[file]} annotations={[]} statuses={[]} selectedId={file.id} disabled={false} onSelect={select} onImport={vi.fn()} onRelink={vi.fn()} />);
  fireEvent.contextMenu(screen.getByRole('button', { name: file.displayName }), { clientX: 20, clientY: 20 }); fireEvent.click(screen.getByRole('menuitem', { name: '复制文件名' }));
  await waitFor(() => expect(writeText).toHaveBeenCalledExactlyOnceWith('CH2.wav')); expect(select).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.getByRole(rejected ? 'alert' : 'status')).toHaveTextContent(rejected ? '复制失败' : '已复制'));
});
it('persists explicit sidebar width, restores it after collapse, and resets on double-click', () => {
  const view=render(<AppShell />); let panel = screen.getByRole('complementary', { name: '音频列表' });
  vi.spyOn(panel, 'getBoundingClientRect').mockReturnValue({ width: 232 } as DOMRect);
  fireEvent.keyDown(screen.getByRole('separator', { name: '调整音频列表宽度' }), { key: 'ArrowRight' }); expect(panel).toHaveStyle({ width: '242px' });
  fireEvent.click(screen.getByRole('button', { name: '收起音频列表' })); fireEvent.click(screen.getByRole('button', { name: '展开音频列表' })); expect(panel).toHaveStyle({ width: '242px' });
  expect(localStorage.getItem('audio-annotator.media-panel-width')).toBe('242'); view.unmount(); render(<AppShell/>); panel=screen.getByRole('complementary',{name:'音频列表'}); expect(panel).toHaveStyle({width:'242px'}); fireEvent.doubleClick(screen.getByRole('separator')); expect(panel.style.width).toBe(''); expect(localStorage.getItem('audio-annotator.media-panel-width')).toBeNull();
});
it('cancels a sidebar drag without writing the preview to local storage', () => {
  vi.stubGlobal('PointerEvent', MouseEvent); render(<AppShell />);
  const panel = screen.getByRole('complementary', { name: '音频列表' }), separator = screen.getByRole('separator');
  vi.spyOn(panel, 'getBoundingClientRect').mockReturnValue({ width: 232 } as DOMRect);
  fireEvent.pointerDown(separator, { button: 0, clientX: 232 }); fireEvent.pointerMove(separator, { clientX: 310 }); expect(panel).toHaveStyle({ width: '310px' });
  act(() => { fireEvent.keyDown(window, { key: 'Escape' }); }); expect(panel.style.width).toBe(''); expect(localStorage.getItem('audio-annotator.media-panel-width')).toBeNull();
});
