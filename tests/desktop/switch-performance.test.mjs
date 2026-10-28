// Usage: ANNOTATOR_WORKSPACE_EXE=... node tests/desktop/switch-performance.test.mjs --prepare
// Then set ANNOTATOR_SWITCH_MANIFEST to the printed manifest and --run (baseline/candidate).
// ANNOTATOR_SWITCH_NAS_ROOT optionally names a parent for a NEW, owned NAS fixture.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { start, Key } from './harness.mjs';
import { newProject, snapshot, saved, wav } from './workspace-helpers.mjs';

const exe = process.env.ANNOTATOR_WORKSPACE_EXE;
assert.ok(exe, 'Set ANNOTATOR_WORKSPACE_EXE');
const base = path.resolve(process.env.ANNOTATOR_SUITE_OUTPUT ?? '.test-output/switch-performance');
await fs.mkdir(base, { recursive: true });
const label = (process.env.ANNOTATOR_SWITCH_LABEL ?? 'baseline').replace(/[^a-z0-9_-]/gi, '_');
const output = await fs.mkdtemp(path.join(base, `${label}-`));
const report = { output, exe: path.resolve(exe), label, method: '876 real native direct imports; two 8.85s/48000Hz/mono WAVs, 874 0.01s/8000Hz/mono WAVs. Real Selenium clicks, full terminal canvas + two animation frames. Instrumentation observes calls and pixels without changing results.', projects: [] };
let h;
const options = localDataEnv => ({ localDataEnv, ports: { driver: 4465, native: 4466, debug: 9255 } });
const row = name => `.media-select[aria-label=${JSON.stringify(name)}]`;

async function prepare(kind, parent) {
  assert.ok(!path.resolve(parent).replaceAll('\\', '/').includes('/共享项目'), 'Refusing user shared project path');
  await fs.mkdir(parent, { recursive: true });
  const project = await fs.mkdtemp(path.join(parent, '.codex-switch-owned-'));
  const run = path.join(output, kind); await fs.mkdir(run);
  const sourceDir = path.join(run, 'sources'); await fs.mkdir(sourceDir);
  const sources = [];
  for (let i = 0; i < 876; i++) {
    const source = path.join(sourceDir, i < 2 ? `selected-${i + 1}.wav` : `tiny-${String(i).padStart(4, '0')}.wav`);
    const bytes = wav(i < 2 ? { seconds: 8.85, rate: 48000, channels: 1 } : { seconds: .01, rate: 8000, channels: 1 });
    // Different selected source, with identical analysis dimensions.
    if (i === 1) for (let frame = 0; frame < 8.85 * 48000; frame++) bytes.writeInt16LE(Math.round((.12 * Math.sin(2 * Math.PI * 2400 * frame / 48000) + .12 * Math.sin(2 * Math.PI * 8100 * frame / 48000)) * 32767), 44 + frame * 2);
    await fs.writeFile(source, bytes); sources.push(source);
  }
  const localData = path.join(run, 'local-data');
  const batches = Array.from({length: Math.ceil(sources.length / 128)}, (_, i) => sources.slice(i * 128, (i + 1) * 128));
  h = await start({ '新建项目 · 选择空文件夹': [project], '': batches }, run, exe, options(localData));
  await newProject(h);
  let imported = 0;
  for (const batch of batches) {
    await h.clickText('导入音频');
    await h.until("document.querySelector('.import-progress')?.textContent.includes('导入完成')", 'native import batch', 1200000);
    await fs.writeFile(path.join(run, `import-${imported}.txt`), await h.evaluate('return document.body.innerText'));
    imported += batch.length;
    await h.driver.wait(async () => (await snapshot(h)).media.length === imported, 180000, `accepted ${imported} media`, 100);
    await h.clickText('关闭导入结果');
  }
  const doc = await snapshot(h); assert.equal(doc.media.length, 876);
  const selected = ['selected-1.wav', 'selected-2.wav'].map(name => doc.media.find(m => m.displayName === name));
  assert.ok(selected.every(Boolean));
  await saved(h);
  await h.quit(); h = null;
  return { kind, project, localData, selected: selected.map(m => ({ id: m.id, name: m.displayName, sha256: m.sha256 })), mediaCount: doc.media.length };
}

// Runs in the actual WebView. Tauri's invoke property is immutable; observe its
// fetch transport, returning the original response without awaiting our clone.
function instrument() {
  const p = window.__switchPerf = { transport: 'fetch (response arrival; status body decoded from an independent clone)', fetches: [], longTasks: [], rafStalls: [], paints: [], samples: [], errors: [], current: null };
  window.addEventListener('error', event => p.errors.push({ at: performance.now(), type: 'error', message: event.message }));
  window.addEventListener('unhandledrejection', event => p.errors.push({ at: performance.now(), type: 'unhandledrejection', message: String(event.reason) }));
  const nativeFetch = window.fetch;
  window.fetch = function(input, init) {
    const url = typeof input === 'string' ? input : input.url ?? String(input);
    const command = decodeURIComponent(new URL(url, location.href).pathname.slice(1));
    const record = { url, command, start: performance.now() }; p.fetches.push(record);
    if (command === 'media_status') {
      try { record.args = typeof init?.body === 'string' ? JSON.parse(init.body) : null; }
      catch (error) { record.decodeError = String(error); }
    }
    return nativeFetch.call(this, input, init).then(response => {
      record.end = performance.now();
      if (command === 'media_status') {
        void response.clone().json().then(value => {
          record.decodedAt = performance.now();
          if (Array.isArray(value)) record.count = value.length;
          else record.decodeError = `Expected status array: ${JSON.stringify(value)}`;
        }, error => { record.decodeError = String(error); });
      }
      return response;
    }, error => { record.end = performance.now(); record.error = String(error); throw error; });
  };
  const put = CanvasRenderingContext2D.prototype.putImageData;
  CanvasRenderingContext2D.prototype.putImageData = function(...args) { const result = put.apply(this, args); if (this.canvas.matches?.('.spectrogram-surface canvas')) p.paints.push({ at: performance.now(), canvas: this.canvas }); return result; };
  try { new PerformanceObserver(list => p.longTasks.push(...list.getEntries().map(e => ({ start: e.startTime, duration: e.duration })))).observe({ type: 'longtask', buffered: false }); } catch { p.longTaskUnavailable = true; }
  let previous = performance.now();
  const frame = now => { if (now - previous > 50) p.rafStalls.push({ start: previous, duration: now - previous }); previous = now; requestAnimationFrame(frame); }; requestAnimationFrame(frame);
  document.addEventListener('pointerdown', event => {
    const button = event.target.closest('.media-select'); if (!button || !p.armed || button.dataset.mediaId !== p.armed.id) return;
    const sample = p.current = { ...p.armed, start: performance.now() }; p.armed = null;
    const check = () => {
      const canvases = [...document.querySelectorAll('.spectrogram-surface canvas')];
      const statuses = p.fetches.filter(r => r.command === 'media_status' && r.start >= sample.start && r.end && Number.isInteger(r.count));
      const verifiedAt = statuses.length ? Math.min(...statuses.map(r => r.end)) : Infinity;
      const ready = () => document.querySelector('.file-pane h2')?.textContent === sample.name && document.querySelector('.media-select[aria-pressed="true"]')?.dataset.mediaId === sample.id && !document.querySelector('.tile-status') && canvases.length > 0 && canvases.every(c => c.width && c.height && p.paints.some(r => r.canvas === c && r.at >= verifiedAt));
      if (!ready()) { requestAnimationFrame(check); return; }
      const lastPaint = p.paints.at(-1)?.at;
      requestAnimationFrame(() => requestAnimationFrame(async () => {
        if (!ready() || p.paints.at(-1)?.at !== lastPaint) { requestAnimationFrame(check); return; }
        sample.end = performance.now(); sample.duration = sample.end - sample.start;
        sample.canvas = await Promise.all(canvases.map(async c => {
          const pixels = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
          const digest = await crypto.subtle.digest('SHA-256', pixels);
          return { width: c.width, height: c.height, sha256: [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, '0')).join('') };
        }));
        sample.longTasks = p.longTasks.filter(r => r.start < sample.end && r.start + r.duration > sample.start);
        sample.rafStalls = p.rafStalls.filter(r => r.start < sample.end && r.start + r.duration > sample.start);
        p.samples.push(sample); p.current = null;
      }));
    }; requestAnimationFrame(check);
  }, true);
}

async function run(fixture) {
  assert.equal(fixture.mediaCount, 876);
  assert.ok(path.basename(fixture.project).startsWith('.codex-switch-owned-'), 'Only owned prepared fixtures allowed');
  const runOutput = path.join(output, fixture.kind); await fs.mkdir(runOutput);
  h = await start({ '打开项目': [path.join(fixture.project, 'collaboration.json')] }, runOutput, exe, options(fixture.localData));
  await h.evaluate(`(${instrument.toString()})()`);
  await h.menu('打开项目'); await h.until('document.querySelector(".file-pane")', 'project opens', 180000);
  await h.until('window.__switchPerf.fetches.some(r => r.command === "media_status" && r.args?.projectId && Number.isInteger(r.count))', 'fetch status instrumentation proves arguments and result count before measuring', 10000);
  const doc = await snapshot(h); assert.equal(doc.media.length, 876);
  const settings = { analysis: Object.fromEntries(fixture.selected.map(m => [m.id, doc.analysis[m.id]])), viewState: doc.viewState, viewport: await h.evaluate('return {width:innerWidth,height:innerHeight,dpr:devicePixelRatio}') };
  const initialId = await h.evaluate('return document.querySelector(".media-select[aria-pressed=true]")?.dataset.mediaId');
  const order = initialId === fixture.selected[0].id ? [...fixture.selected].reverse() : fixture.selected;
  // Keep the full 876-row list present: searching it away hides the original UI cost.
  for (let i = 0; i < 26; i++) {
    const media = order[i % 2];
    const element = await h.element(row(media.name));
    await h.evaluate('arguments[0].scrollIntoView({block:"nearest"})', element);
    await h.evaluate('window.__switchPerf.armed=arguments[0]', { ...media, phase: i < 2 ? 'first' : 'warm', index: i });
    await element.click();
    await h.until(`window.__switchPerf.samples.length===${i + 1}`, `terminal full canvas switch ${i}`, 180000);
    console.log(`${fixture.kind} ${label} switch ${i}: ${await h.evaluate('return window.__switchPerf.samples.at(-1).duration')} ms`);
  }
  const measured = await h.evaluate('const p=window.__switchPerf;return {samples:p.samples,transport:p.transport,fetches:p.fetches,longTasks:p.longTasks,rafStalls:p.rafStalls,errors:p.errors,longTaskUnavailable:p.longTaskUnavailable}');
  const warm = measured.samples.filter(s => s.phase === 'warm').map(s => s.duration).sort((a,b) => a-b);
  const result = { ...fixture, settings, ...measured, summary: { warmCount: warm.length, p50: warm[Math.ceil(warm.length*.5)-1], p95: warm[Math.ceil(warm.length*.95)-1], max: warm.at(-1) } };
  report.projects.push(result);
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  // Outside the measured switches, exercise the user's no-selection gain menu
  // case while the same 876-row tree is mounted. No gain is applied.
  const gainProbeStart = performance.now();
  await h.label('更多播放操作');
  assert.equal(await (await h.element('[role="menuitem"][aria-label="区域增益…"]')).getAttribute('aria-disabled'), 'true');
  await h.click('[role="menuitem"][aria-label="区域增益…"]');
  assert.equal(await h.evaluate('return !!document.querySelector("[role=dialog]") || !!document.querySelector(".app-root")?.inert'), false);
  await h.driver.actions().sendKeys(Key.ESCAPE).perform();
  await h.until('!document.querySelector("[role=menu]")', 'gain menu Escape closes', 10000);
  await h.label('更多播放操作');
  await h.driver.actions({async: true}).move({x: 5, y: 5, origin: 'viewport'}).click().perform();
  await h.until('!document.querySelector("[role=menu]") && !document.querySelector("[data-testid=menu-shield]")', 'outside click closes menu and shield', 10000);
  await h.click('[aria-label="搜索音频"]');
  await h.label('监听增益');
  await h.until('document.querySelector(".monitor-popover")', 'monitor popover remains responsive', 10000);
  await h.driver.actions().sendKeys(Key.ESCAPE).perform();
  await h.until('!document.querySelector(".monitor-popover")', 'monitor Escape closes', 10000);
  result.gainProbeMs = performance.now() - gainProbeStart;
  result.probeErrors = await h.evaluate('return window.__switchPerf.errors');
  assert.deepEqual(result.probeErrors, [], 'No JavaScript errors or unhandled rejection');
  for (const media of fixture.selected) {
    const values = measured.samples.filter(s => s.id === media.id);
    assert.ok(values.every(s => JSON.stringify(s.canvas) === JSON.stringify(values[0].canvas)), `Full pixel identity for ${media.name}`);
  }
  assert.notDeepEqual(measured.samples[0].canvas, measured.samples[1].canvas, 'Distinct source spectra must produce different full-canvas pixels');
  await h.screenshot('terminal'); await h.quit(); h = null;
}

try {
  if (process.argv.includes('--prepare')) {
    const fixtures = [await prepare('local', output)];
    if (process.env.ANNOTATOR_SWITCH_NAS_ROOT) fixtures.push(await prepare('nas', path.resolve(process.env.ANNOTATOR_SWITCH_NAS_ROOT)));
    const manifest = path.join(output, 'manifest.json'); await fs.writeFile(manifest, JSON.stringify({ fixtures }, null, 2));
    report.manifest = manifest; console.log(`Prepared manifest: ${manifest}`);
  } else {
    assert.ok(process.env.ANNOTATOR_SWITCH_MANIFEST, 'Set ANNOTATOR_SWITCH_MANIFEST from --prepare');
    const manifest = JSON.parse(await fs.readFile(process.env.ANNOTATOR_SWITCH_MANIFEST, 'utf8'));
    for (const fixture of manifest.fixtures) await run(fixture);
  }
  report.passed = true;
} catch (error) {
  report.error = error.stack;
  report.body = await h?.evaluate('return document.body.innerText').catch(() => null);
  report.partial = await h?.evaluate('const p=window.__switchPerf;return p ? {samples:p.samples,current:p.current,transport:p.transport,fetches:p.fetches,errors:p.errors,longTasks:p.longTasks,rafStalls:p.rafStalls} : null').catch(() => null);
  await h?.screenshot('failure').catch(() => {}); process.exitCode = 1; console.error(error);
}
finally { await h?.quit().catch(() => {}); await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ output, passed: report.passed, manifest: report.manifest, projects: report.projects.map(p => ({ kind: p.kind, summary: p.summary })) }, null, 2)); }
