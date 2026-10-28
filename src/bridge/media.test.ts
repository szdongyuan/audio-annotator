import { beforeEach, expect, it, vi } from 'vitest';
const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke, Channel: class {} }));
import { createMediaClient } from './media';
beforeEach(() => invoke.mockReset().mockResolvedValue([]));
it('preserves full-project status calls and captures the runtime for scoped calls', async () => {
  const client = createMediaClient('runtime-a');
  await client.status('project');
  await client.status('project', ['selected']);
  await client.status('project', []);
  expect(invoke.mock.calls.map(([command, args]) => [command, args])).toEqual([
    ['media_status', {projectId: 'project', runtimeNonce: 'runtime-a'}],
    ['media_status', {projectId: 'project', mediaIds: ['selected'], runtimeNonce: 'runtime-a'}],
    ['media_status', {projectId: 'project', mediaIds: [], runtimeNonce: 'runtime-a'}],
  ]);
});
