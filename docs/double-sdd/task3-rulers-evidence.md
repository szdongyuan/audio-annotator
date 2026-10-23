# Task 3: wheel and interactive rulers evidence

Date: 2026-10-23. TaskBase: `65f92e3a724d24956ac369efa9a1d67f05442ada`.
Implementation and verification complete; fresh paired review remains with the orchestrator.

## Delivered scope

- Pixel/line/page wheel normalization uses 1/16/actual plot-height CSS pixels. Ctrl takes priority over Shift and changes STFT mixing by `-delta * 0.0005`, clamped to `[0,1]`; Mel consumes Ctrl without changing the view. Ordinary and Shift wheel preserve the corresponding physical anchor. Patches contain only changed fields.
- Actual ruler sizes come from ResizeObserver. Physical 1/2/5 candidate grids map through the shared coordinates; major labels have 60px/22px spacing and minor ticks 4px. Endpoints, decimals, scientific notation, DC and Nyquist are covered. Locally oversampled grids do not produce awkward major labels such as 0.089s just to fit near an endpoint.
- Ruler drags capture the starting mapping, accept at least 6px, support reverse/clipped ranges, and commit only the corresponding axis. Escape, cancellation, lost capture, disabled state and runtime replacement retire the gesture. Ruler context menus provide anchored zoom, axis reset and full linear/log controls, with a disabled Mel explanation.
- Frequency labels retain a 10px font. `frequencyRulerWidth` reserves space from physical bounds only, using `--frequency-ruler-width`; changing mixing cannot change the plot width or tile resolution. Task 4 should preserve this variable in its layout changes.
- Region zoom already used `withTarget` and `workspace.patch` from Task 2; those existing paths were retained and verified. `useWorkspace`, `viewport`, `coordinates` and the FFT cache key did not need changes. No tools/modes, Delete removal, migration, app menus, classification or folder work was added.

## TDD and automated checks

Observed REDs: missing ticks/wheel modules in the planned focused command; runtime replacement incorrectly committing a captured ruler drag; missing width reservation for readable narrow-range labels; fine candidate grids producing the awkward major value 0.089s. Each was followed by the corresponding GREEN run.

| Actual command | Result |
|---|---|
| `npm.cmd test -- src/features/spectrogram/ticks.test.ts src/features/spectrogram/rulers.test.tsx` | 2 files, 11 tests passed |
| `npm.cmd test -- src/features/spectrogram src/features/selection/regionMenu.test.tsx src/components/menu` | 13 files, 57 tests passed |
| `npm.cmd test` | 30 files, 186 tests passed; `.test-output/task3-rulers/frontend.log` |
| `npm.cmd run build` | TypeScript checks and production Vite build passed |
| `npm.cmd run tauri -- build --debug --no-bundle --features e2e --config src-tauri/tauri.e2e.conf.json` | Current UI rebuilt and debug native executable built successfully |
| `node tests/desktop/rulers-flow.test.mjs` | Passed all 11 reported checks |
| `git diff --check` | Passed |

Final tested debug executable SHA-256: `7F99F283381D3DD9660E8934E27BB83D732C876A43EA06D79714089F773D0068`.

## Owned native WebView evidence

Runner: `tests/desktop/rulers-flow.test.mjs`. Outputs: `.test-output/task3-rulers/report.json`, screenshots, per-process driver log and isolated test projects. The runner refuses occupied ports 4445, 4446 and 9235, starts its own Tauri/WebView profile, and closes only its owned processes. No user application or global DPI setting was changed. The e2e feature only supplies native picker paths.

The passing run uses actual WebDriver pointer, keyboard and wheel input (`isTrusted: true`) for Ctrl direction/clamps, Ctrl+Shift priority, ordinary/Shift anchored zoom, reverse time-axis drag, frequency-axis drag, menus, resets and repeated narrow-range drags. Three additional untrusted events explicitly supplement pixel fractional/line/page deltaMode coverage; they are not represented as hardware trackpad testing.

| Measurement | Observed result |
|---|---|
| Warm `request_tile` requests across Ctrl mixing | 2 before, 2 after; zero new native requests |
| WebView dimensions/DPR/visual scale before and after Ctrl | Identical |
| Shared coordinate round-trip maximum | `5.173e-12` CSS px |
| Actual annotation frame vs shared coordinate maximum | `0.014047` CSS px, below 0.5px |
| Saved annotation geometry and metadata after transforms | Deep equality preserved |
| Actual ticks vs shared coordinate positions | Within 0.5px |
| Actual major/minor spacing and bounds | No overlapping/cut-off labels; required spacing passed |
| Narrow nonzero frequency range | 11952.939464841944–11952.942901576622 Hz |
| Narrow labels | Fixed 10px font, 92px ruler, no horizontal clipping |
| Region zoom with linked short file | Exact physical region, linked seconds, independent Nyquist and empty short-file tail preserved |

The IPC evidence wraps and transparently forwards the native custom-protocol fetch boundary. Initial real requests validate the counter; no new request means the warmed mixing changes cannot schedule a new FFT. Tauri's immutable `invoke` property was not used for the final counter. The runner reads actual wheel event coordinates and fractional DOM geometry to avoid WebDriver rectangle rounding in anchor comparisons.

Screenshots inspected: `linear-near.png`, `full-log.png`, `mel-disabled-menu.png`, `narrow-nonzero-frequency.png`, `linked-region-zoom.png`. The narrow screenshot confirms legibility at the normal frequency font size; the frequency ruler grows only when the physical range requires more digits.

Limits: this is a debug/e2e Task 3 verification, not the final 0.2.0 release/installer, long-file performance or Task 4 layout acceptance. Physical trackpad hardware and the later 125% layout matrix were not exercised here. Rust DSP source was unchanged; the native build ran, but a new full Rust suite was not necessary for this UI slice.
