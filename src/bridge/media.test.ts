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
it('supplies the captured session for ordinary direct imports without a target', async () => {
  const nonce='22222222-2222-4222-8222-222222222222';
  await createMediaClient().start('project',['D:/a.wav'],()=>{},undefined,undefined,nonce);
  expect(invoke).toHaveBeenCalledWith('import_media',expect.objectContaining({projectId:'project',paths:['D:/a.wav'],runtimeNonce:nonce}));
  expect(invoke.mock.calls[0][1]).not.toHaveProperty('target');
  await expect(createMediaClient('11111111-1111-4111-8111-111111111111').start('project',['D:/a.wav'],()=>{},undefined,undefined,nonce)).rejects.toThrow();
});
