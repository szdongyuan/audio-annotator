import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { start } from './harness.mjs';

const root = path.resolve('.test-output/native-responsiveness');
await fs.mkdir(root, { recursive: true });
const output = await fs.mkdtemp(path.join(root, 'desktop-'));
const executable = path.resolve(process.env.ANNOTATOR_WORKSPACE_EXE ?? 'target/debug/annotator-desktop.exe');
const report = {
  output,
  method: 'Actual Windows Tauri dispatch; independent native thread holds project mutex for 1500 ms; heartbeat runs on native main thread. Negative control reproduces former synchronous playback dispatch, not a historical freeze.',
  checks: [],
};
let h;
try {
  h = await start({}, output, executable);
  const preview = { runtimeNonce: 'retired', projectId: 'absent', previewId: 'absent' };
  const token = { runtimeNonce: 'retired', projectId: 'absent', taskId: 'absent' };
  const cases = [
    ['synchronous_playback_probe', {}, false, false],
    ['playback_status', {}, true, false],
    ['playback_control', { action: 'reset' }, true, false],
    ['playback_monitor_gain', { request: { projectId: 'absent', mediaId: 'absent', generation: 0, monitorGainDb: 0 } }, true, true],
    ['example_preview_cancel_open', { ...preview, requestId: 'absent' }, true, true],
    ['example_preview_register_view', preview, true, true],
    ['example_preview_retire_view', { ...preview, viewId: 'view' }, true, true],
    ['example_preview_cancel_generation', { ...preview, viewId: 'view', generation: 0 }, true, true],
    ['example_preview_playback_control', { ...preview, action: 'stop' }, true, true],
    ['example_preview_playback_status', preview, true, true],
    ['example_preview_close', preview, true, true],
    ['cancel_import_source_scan', { token }, true, true],
    ['release_import_source_scan', { token }, true, true],
  ];
  for (const [command, args, responsive, rejected] of cases) {
    const result = await h.driver.executeAsyncScript(`
      const [command, args, done] = arguments;
      (async () => {
        const invoke = window.__TAURI_INTERNALS__.invoke;
        await invoke('hold_project_lock');
        let settled = false;
        const start = performance.now();
        const work = invoke(command, args).then(
          value => { settled = true; return { value, rejected: false }; },
          error => { settled = true; return { error, rejected: true }; },
        );
        await new Promise(resolve => setTimeout(resolve, 80));
        const heartbeatWhileHeld = await invoke('native_heartbeat');
        const heartbeatMs = performance.now() - start;
        const pendingAtHeartbeat = !settled;
        const outcome = await work;
        return { heartbeatWhileHeld, heartbeatMs, pendingAtHeartbeat, commandMs: performance.now() - start, ...outcome };
      })().then(done, error => done({ harnessError: String(error) }));
    `, command, args);
    assert.equal(result.harnessError, undefined, `${command}: ${result.harnessError}`);
    assert.equal(result.heartbeatWhileHeld, responsive, `${command}: native heartbeat during lock contention`);
    if (responsive) assert.equal(result.pendingAtHeartbeat, true, `${command}: real native command must still be waiting`);
    assert.equal(result.rejected, rejected, `${command}: original result/authority rejection preserved`);
    assert.ok(result.commandMs >= 1000, `${command}: bounded contention actually occurred`);
    report.checks.push({ command, ...result });
  }
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error.stack;
  process.exitCode = 1;
} finally {
  await h?.quit();
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
