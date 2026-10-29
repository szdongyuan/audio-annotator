import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { useState, type ComponentProps } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fixture from '../../../tests/fixtures/document-v3.json';
import type { Annotation, MediaDescriptor } from '../../bridge/types';
import { MediaList } from './MediaList';
import { OrganizationController } from './organization';
import { RecycleController } from './recycle';

type Props = Partial<ComponentProps<typeof MediaList>>;
let frames: FrameRequestCallback[];
beforeEach(() => {
  frames = [];
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => frames.push(callback)));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.spyOn(Math, 'random').mockReturnValue(0);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function files(count = 3): MediaDescriptor[] {
  return Array.from({ length: count }, (_, i) => ({ ...structuredClone(fixture.media[0]), id: crypto.randomUUID(), displayName: `random-${i}.wav`, categoryIds: [], channelCategoryIds: [[], []] }));
}
function region(mediaId: string, categoryIds: string[] = []): Annotation {
  return { ...structuredClone(fixture.annotations[0]), region: { ...fixture.annotations[0].region, mediaId }, categoryIds };
}
function setup(media = files(), initial: Props = {}) {
  const select = vi.fn<NonNullable<Props['onSelect']>>();
  function Container(props: Props) {
    const [selected, setSelected] = useState(media[0]?.id ?? null);
    return <MediaList media={media} annotations={[]} statuses={[]} disabled={false} onImport={vi.fn()} onRelink={vi.fn()} {...props}
      selectedId={props.selectedId === undefined ? selected : props.selectedId}
      onSelect={(...args) => { const accepted = select(...args); if (accepted !== false) setSelected(args[0]); return accepted; }} />;
  }
  const view = render(<Container {...initial} />);
  return { ...view, media, select, update: (props: Props) => view.rerender(<Container {...initial} {...props} />) };
}
function press(key = 'r', target: Element | Window = document.body) { fireEvent.keyDown(target, { key }); }
// Execute even cancelled callbacks, as if a browser had already dequeued them.
function flush() { const pending = frames.splice(0); act(() => pending.forEach(callback => callback(0))); }
function selected(file: MediaDescriptor) { expect(screen.getByRole('button', { name: file.displayName })).toHaveAttribute('aria-pressed', 'true'); }

it('randomly opens a different audio, focuses it, and permits history repeats', () => {
  const ui = setup();
  press(); selected(ui.media[1]); flush();
  expect(screen.getByRole('button', { name: ui.media[1].displayName })).toHaveFocus();
  press(); selected(ui.media[0]);
  vi.mocked(Math.random).mockReturnValue(0.999);
  press('R'); selected(ui.media[2]);
  expect(ui.select.mock.calls).toEqual([[ui.media[1].id, 'random'], [ui.media[0].id, 'random'], [ui.media[2].id, 'random']]);
});

it('passes random intent only for R while clicks and arrows retain single-argument selection', () => {
  const ui = setup();
  press();
  press('ArrowDown');
  press('ArrowUp');
  fireEvent.click(screen.getByRole('button', { name: ui.media[0].displayName }));
  expect(ui.select.mock.calls).toEqual([
    [ui.media[1].id, 'random'], [ui.media[2].id], [ui.media[1].id], [ui.media[0].id],
  ]);
});

it.each(['empty', 'current-only'] as const)('announces %s without changing selection, focus or batch checks', kind => {
  const media = files(2);
  media[1].categoryIds = ['tag'];
  if (kind === 'empty') media[0].categoryIds = ['tag'];
  const ui = setup(media);
  fireEvent.click(screen.getByLabelText('多选音频'));
  fireEvent.click(screen.getByLabelText(`选择音频 · ${media[0].displayName}`));
  const row = screen.getByRole('button', { name: media[0].displayName }); row.focus();
  press('r', row); flush();
  expect(screen.getByRole('status')).toHaveTextContent(kind === 'empty' ? '当前范围内没有未分类音频' : '没有其他未分类音频');
  expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');
  expect(ui.select).not.toHaveBeenCalled(); selected(media[0]); expect(row).toHaveFocus();
  expect(screen.getByLabelText(`选择音频 · ${media[0].displayName}`)).toBeChecked();
});

it('preserves batch checks while previewing during import', () => {
  const ui = setup();
  fireEvent.click(screen.getByLabelText('多选音频'));
  fireEvent.click(screen.getByLabelText(`选择音频 · ${ui.media[0].displayName}`));
  ui.update({ disabled: true, navigationDisabled: false }); press();
  selected(ui.media[1]); expect(screen.getByText('已选 1')).toBeVisible();
  expect(screen.getByLabelText(`选择音频 · ${ui.media[0].displayName}`)).toBeChecked();
});

it.each(['file', 'channel', 'region'] as const)('uses newly added, cleared and restored %s labels on every key', layer => {
  const media = files(2), ui = setup(media, { selectedId: media[0].id });
  const tagged = structuredClone(media);
  if (layer === 'file') tagged[1].categoryIds = ['tag'];
  if (layer === 'channel') tagged[1].channelCategoryIds[1] = ['tag'];
  const labeled = { media: tagged, annotations: layer === 'region' ? [region(media[1].id, ['tag'])] : [] };
  ui.update(labeled); press(); expect(ui.select).not.toHaveBeenCalled();
  expect(screen.getByRole('status')).toHaveTextContent('没有其他未分类音频');
  ui.update({ media, annotations: [region(media[1].id)] }); press();
  expect(ui.select).toHaveBeenLastCalledWith(media[1].id, 'random'); expect(screen.queryByRole('status')).toBeNull();
  ui.select.mockClear(); ui.update(labeled); press(); expect(ui.select).not.toHaveBeenCalled();
});

it('uses the latest statuses and media without requiring ready status', () => {
  const media = files(3), ui = setup(media, { selectedId: media[0].id });
  ui.update({ statuses: [{ mediaId: media[1].id, status: 'missing' }, { mediaId: media[2].id, status: 'changed' }] });
  press(); expect(ui.select).not.toHaveBeenCalled();
  ui.update({ statuses: [{ mediaId: media[1].id, status: 'unverified' }, { mediaId: media[2].id, status: 'ready' }] });
  press(); expect(ui.select).toHaveBeenLastCalledWith(media[1].id, 'random');
  ui.update({ media: [media[0], media[2]], statuses: [] });
  press(); expect(ui.select).toHaveBeenLastCalledWith(media[2].id, 'random');
});

it('excludes hidden, trashed, and comparison audio from the actual list results', () => {
  const media = files(5), recycle = new RecycleController(fixture.projectId, crypto.randomUUID(), true, {} as never);
  recycle.snapshot = { kind: 'audio-annotator-recycle', formatVersion: 1, projectId: fixture.projectId, revision: 0, trashed: [{ mediaId: media[2].id, deletedBy: 'author' }], recentOperations: [] };
  const ui = setup(media, { recycle, hiddenMediaIds: [media[1].id], navigationExcludedId: media[3].id });
  press(); expect(ui.select).toHaveBeenLastCalledWith(media[4].id, 'random');
});

function organization(media: MediaDescriptor[]) {
  const controller = new OrganizationController(fixture.projectId, 'runtime', true, {} as never);
  const parent = crypto.randomUUID(), child = crypto.randomUUID(), outside = crypto.randomUUID();
  controller.snapshot = { kind: 'audio-annotator-organization', formatVersion: 1, projectId: fixture.projectId, revision: 0, layoutRevision: 0,
    folders: [{ id: parent, parentId: null, name: '父目录' }, { id: child, parentId: parent, name: '子目录' }, { id: outside, parentId: null, name: '范围外' }],
    media: media.map((m, i) => ({ mediaId: m.id, folderId: i === 1 ? child : i === 2 ? outside : parent, originalFilename: m.displayName })) };
  return { controller, parent, child };
}

it('draws from the selected folder and collapsed descendants, then expands and focuses the target', () => {
  const media = files(), { controller } = organization(media), ui = setup(media, { organization: controller });
  fireEvent.click(screen.getByTitle('父目录'));
  expect(screen.queryByRole('button', { name: media[1].displayName })).toBeNull();
  press(); expect(ui.select).toHaveBeenLastCalledWith(media[1].id, 'random');
  expect(screen.getByRole('button', { name: '折叠文件夹 · 子目录' })).toBeVisible();
  flush(); expect(screen.getByRole('button', { name: media[1].displayName })).toHaveFocus();
});

it('intersects search, selected folder, whole-project search and tag filters', () => {
  const media = files(), { controller } = organization(media), ui = setup(media, { organization: controller, categories: fixture.categories });
  fireEvent.click(screen.getByTitle('父目录'));
  fireEvent.change(screen.getByLabelText('搜索音频'), { target: { value: media[2].displayName } });
  press(); expect(ui.select).not.toHaveBeenCalled();
  fireEvent.click(screen.getByLabelText('筛选音频'));
  fireEvent.click(screen.getByLabelText('搜索整个项目'));
  press(); expect(ui.select).toHaveBeenLastCalledWith(media[2].id, 'random');
  ui.select.mockClear();
  fireEvent.change(screen.getByLabelText('标签筛选'), { target: { value: fixture.categories[0].id } });
  press(); expect(ui.select).not.toHaveBeenCalled(); expect(screen.getByRole('status')).toHaveTextContent('当前范围内没有未分类音频');
});

it('keeps the existing unannotated filter meaning for an untagged region box', () => {
  const media = files(2), ui = setup(media, { selectedId: media[0].id, annotations: [region(media[1].id)] });
  press(); expect(ui.select).toHaveBeenLastCalledWith(media[1].id, 'random');
  ui.select.mockClear(); fireEvent.click(screen.getByLabelText('筛选音频'));
  fireEvent.change(screen.getByLabelText('标注状态筛选'), { target: { value: 'unannotated' } });
  press(); expect(ui.select).not.toHaveBeenCalled(); expect(screen.getByRole('status')).toHaveTextContent('没有其他未分类音频');
});

it.each(['hidden', 'trash', 'disabled'])('does not navigate in %s context', context => {
  const ui = setup();
  if (context === 'disabled') ui.update({ navigationDisabled: true });
  else fireEvent.change(screen.getByLabelText('音频列表视图'), { target: { value: context } });
  press(); flush(); expect(ui.select).not.toHaveBeenCalled(); expect(screen.queryByRole('status')).toBeNull();
});

it('does not reveal or focus when selection explicitly rejects the target', () => {
  const media = files(), { controller } = organization(media), ui = setup(media, { organization: controller });
  ui.select.mockReturnValue(false); press(); flush();
  expect(ui.select).toHaveBeenCalled(); expect(requestAnimationFrame).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: '展开文件夹 · 父目录' })).toBeVisible();
  expect(screen.queryByRole('button', { name: media[1].displayName })).toBeNull();
});

it.each(['unmount', 'scope', 'disabled', 'removed', 'changed-selection', 'pointer', 'stopped-key', 'handled-key'])('cancels pending focus after %s', change => {
  const scope = {}, ui = setup(undefined, { navigationScope: scope });
  const input = screen.getByLabelText('搜索音频'); input.focus();
  press(); expect(frames).toHaveLength(1);
  if (change === 'unmount') ui.unmount();
  else if (change === 'scope') ui.update({ navigationScope: {} });
  else if (change === 'disabled') ui.update({ navigationDisabled: true });
  else if (change === 'removed') ui.update({ media: [ui.media[0], ui.media[2]] });
  else if (change === 'changed-selection') ui.update({ selectedId: ui.media[2].id });
  else if (change === 'pointer') { fireEvent.pointerDown(input); fireEvent.click(screen.getByRole('button', { name: ui.media[2].displayName })); }
  else {
    input.addEventListener('keydown', event => change === 'stopped-key' ? event.stopPropagation() : event.preventDefault(), { once: true });
    press('x', input);
  }
  const focus = vi.spyOn(HTMLElement.prototype, 'focus'); flush(); expect(focus).not.toHaveBeenCalled();
  if (change !== 'removed' && change !== 'changed-selection') expect(cancelAnimationFrame).toHaveBeenCalled();
});

it.each(['r', 'ArrowDown', 'ArrowUp'])('only the latest %s request can move focus', key => {
  const ui = setup(files(4)); press(); press(key);
  const focus = vi.spyOn(HTMLElement.prototype, 'focus'); flush();
  expect(focus).toHaveBeenCalledTimes(1);
  const lastId = ui.select.mock.calls.at(-1)![0];
  expect(document.activeElement).toHaveAttribute('data-media-id', lastId);
});

it('scopes notices to the current runtime or author and clears them on successful arrows', () => {
  const media = files(2), ui = setup([media[0]], { navigationScope: {} });
  press(); expect(screen.getByRole('status')).toHaveTextContent('没有其他未分类音频');
  ui.update({ navigationScope: {} }); expect(screen.queryByRole('status')).toBeNull();
  press(); ui.update({ media }); press('ArrowDown');
  expect(ui.select).toHaveBeenLastCalledWith(media[1].id); expect(screen.queryByRole('status')).toBeNull();
});

it('finds the focus target within its own list root', () => {
  const media = files(2);
  const foreign = document.createElement('button'); foreign.className = 'media-select'; foreign.dataset.mediaId = media[1].id; document.body.prepend(foreign);
  try {
    const ui = setup(media); press(); flush();
    expect(within(ui.container).getByRole('button', { name: media[1].displayName })).toHaveFocus(); expect(foreign).not.toHaveFocus();
  } finally { foreign.remove(); }
});

it('preserves void consumer focus behavior before controlled selection rerenders', () => {
  const media = files(2), select = vi.fn();
  render(<MediaList media={media} annotations={[]} statuses={[]} selectedId={media[0].id} disabled={false} onSelect={select} onImport={vi.fn()} onRelink={vi.fn()} />);
  press(); flush();
  expect(select).toHaveBeenCalledExactlyOnceWith(media[1].id, 'random');
  expect(screen.getByRole('button', { name: media[1].displayName })).toHaveFocus();
});

it('removes its keyboard listener on unmount', () => {
  const ui = setup(); press(); ui.unmount(); press(); flush();
  expect(ui.select).toHaveBeenCalledTimes(1);
});

it('keeps copy feedback alongside the random navigation notice', async () => {
  const ui = setup(files(1));
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  press();
  fireEvent.contextMenu(screen.getByRole('button', { name: ui.media[0].displayName }));
  await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: '复制文件名' })); });
  expect(screen.getByText('没有其他未分类音频')).toHaveAttribute('role', 'status');
  expect(screen.getByText(`已复制：${ui.media[0].displayName}`)).toHaveAttribute('role', 'status');
  expect(ui.select).not.toHaveBeenCalled();
});
