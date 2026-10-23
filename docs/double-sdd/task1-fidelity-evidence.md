# Task 1 — spectral fidelity evidence

TaskBase: `be1edfee3023416d1d0521f4186de1493bff5395`. Worktree: `.worktrees/spectral-fidelity-v021`, branch `feature/spectral-fidelity-v021`. Scope: approved design §4.1–4.2 only. No DSP, audio, model, default FFT, palette, processed-source or gesture changes.

## Result

Canvas backings now use rounded CSS × DPR. A workspace-wide 32 MiB allocator counts retained backings and one reusable 64-column RGBA strip; offscreen channels release their backing and numeric pins, and rebuild on reentry. The 64 MiB numeric LRU, 5 MiB/channel dependency allowance, leases, generations, cancellation and cache recovery remain in place. Resource excess produces an explicit local error, not a smaller bitmap.

Sampling precomputes physical seconds/Hz axes. Native dB values are converted to power for needed source bins, interpolated on real frame/bin/Mel centers, then mapped through the unchanged palette and −160 dB floor. Partial LOD groups use their actual counts. Only true global endpoints extend; gaps stay pending and audio-tail space stays blank. Required time/frequency neighbors are owned dependencies. Time LOD uses actual backing width, including changes within the old 64-pixel bucket. Cached finer time data is reused when it supplies a coherent row grid; incompatible mixed time grids request the planned grid before reporting completion.

## Executed verification

All raw logs are under `.test-output/fidelity-task1/`.

| Check | Observed result / log |
|---|---|
| Allocation RED | 800×600 produced 341×256, `allocation-red.log` |
| Interpolation RED | Midpoint gray value 204 instead of power-domain 196, `interpolation-red.log` |
| LOD/halo RED | 1920-width Mel selected LOD 1 instead of 0; required adjacent row absent, `halo-red.log` |
| Bounded-strip RED | Expanded 1800×850 CSS/DPR2 rejected with full-size scratch, `strip-red.log` |
| Width/cache RED | Missed 187→188 LOD boundary; mixed time grids accepted, `width-key-red.log`, `coherent-time-red.log` |
| Additional new-module / reuse RED | `budget-red.log`, `sampling-red.log`, `time-reuse-red.log` |
| `npm.cmd test -- src/features/spectrogram` | **62 passed**, 13 files, `spectrogram-final.log` |
| `npm.cmd test` | **248 passed**, 35 files, `ui-all.log` |
| `npm.cmd run build` | Typecheck + Vite exit 0, `build.log` |
| Full native debug/e2e build | Exit 0, `native-build.log` |
| `node tests/desktop/fidelity-flow.test.mjs` | **23 evidence checks, PASS**, `native.log`, `native/report.json` |

Native command: `npm.cmd run tauri -- build --debug --no-bundle --features e2e --config src-tauri/tauri.e2e.conf.json`. The final native run followed the completed build of the final product code. One earlier run timed out waiting for an inspector while the test had deliberately collapsed its sidebar; the harness was corrected to reopen that sidebar. Its diagnostic report/log remain as `native/attempt1-report.json` / `native-attempt1.log`.

## Native measurements

Owned Tauri/WebView2 processes only; ports 4445/4446/9235 checked before launch. Win32 `GetWindowRect` on the owned native PID verifies true outer 1280×800 and 1920×1080. Single-file two-channel and dual-file four-channel layouts passed at each outer size and simulated DPR 1, 1.25 and 2. CDP affected only the isolated WebView; this is **not** a Windows system-DPI test.

- Baseline at outer 1920×1080: CSS **1272×376.5**, backing **865×256**. New DPR1 backing: **1272×377**.
- Expanded single channel at outer 1920×1080/DPR2: CSS **1772×803**, backing **3544×1606**. Retained backing **22,766,656 bytes**, scratch **411,136 bytes**, total **23,177,792 bytes** (largest observed raster bound, below 33,554,432).
- Six plus six channels: top→bottom→top at both outer sizes/DPR2. All visible canvases were nonblack and full resolution; all offscreen backings were 0×0. At 1280, six visible/intersecting surfaces used ≤**4,878,720 bytes**; at 1920, eight used ≤**13,271,040 bytes**, including the scratch upper bound.
- Twenty displayed pixel samples at physical centers, including tones, pulse, both sides of the time tile seam and final audio frames, matched an independent interpolation of freshly requested Rust numeric tiles: **maximum RGBA error 0**.
- Real pointer-created annotation plus ruler tick alignment: maximum **0.000484585 CSS px**, below 0.5 px.
- Unit coverage includes partial time/frequency LOD groups, native Mel centers, missing neighbors versus global endpoints, blank short-file tail, release/reentry, 12-owner cache pressure and FFT 65536/DPR2-width budget bounds.

## Controlled appearance comparison

The baseline native EXE was rebuilt and captured **before renderer edits**. Old/new use the same generated 48 kHz, four-second, six-channel multitone/chirp/pulse WAV, Hann 2048, hop 512, FFT 2048, unchanged gain/range/palette. SHA-256 for both fixture files: `891e43e685e54e10806e73e8a58fb1e3eae6eb4d898551a1e431753422214848`.

Compare `baseline/outer1920x1080.png` with `native/outer1920x1080.png` under the raw evidence directory: the new tone/chirp edges follow the full-resolution grid without the old scaled blocks. Additional screenshots: `native/single-expanded-1920-dpr2.png`, `native/dual-1920-dpr2.png`, `native/six-plus-six-1920-bottom-dpr2.png`. This is synthetic controlled evidence, not the user's unavailable audio and not a claim to reproduce Audition.

The existing Vite large-chunk advisory remains. Task 8 owns the broader interaction performance/device/publishing matrix; no system DPI, volume or unrelated application settings were changed here.
Final paired specification/quality reviews: PASS at d4d68408fc2b31a0d32ac713d45b9f3b368a6cf2. Orchestrator independently reran 23 sampling/budget/coverage/useTiles/cache-pressure tests successfully and inspected raw native metrics and old/new screenshots.
