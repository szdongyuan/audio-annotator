# Task 4 — explicit active selection and interior dragging

Date: 2026-10-23 (Asia/Shanghai)

Task base: `cb94f8afccff9f014e8df2d9492c3ad8887a4d10` on `feature/spectral-fidelity-v021`.
Scope: approved spec §7.1 and implementation plan Task 4 only.

## Behavior and authority

- `SelectionState` separates its retained candidate from `getActiveSelection()`. `getSnapshot()` remains an active-only compatibility alias. `useSelection.selection` is active-only, so existing annotation/mask inspectors and AppShell's playback input receive no inactive candidate. `useSelection.candidate` supports the outline and pane invalidation.
- Completed draws activate. Active interiors and borders move; handles resize; Alt-left/middle retain pan priority. A blank gesture outside the global active target only deactivates, including when dragged or performed in the other pane. The next drag can draw a replacement.
- An inactive temporary outline stays visible with reduced opacity, without handles or Delete eligibility. Clicking it reactivates it, including overlap with saved annotations. Clicking a different saved object activates that object directly. Deactivation never deletes or disables a mask.
- Menu Escape remains first; gesture cancellation restores the prior activation and valid authoritative geometry/context; otherwise Escape deactivates. Nonplot clicks do not implicitly deactivate.
- Saved movement still submits through the existing lifecycle/queue once on release. Existing pending-update/removal, stale geometry, cancellation, channel invalidation, runtime replacement, and panel reconciliation coverage remains. Pointerdown also rejects a stale rendered frame whose authoritative object has disappeared.
- Late classification/mask completion cannot bind over a deactivated or changed target. No persistent document fields, DSP behavior, dependencies, source version defaults, or playback-intent features changed. Toolbar and new playback/cue behavior remain Tasks 5–6.

## RED → GREEN

Raw evidence is in `.test-output/fidelity-task4/` (ignored runtime artifacts retained locally).

| Command / evidence | Observed result |
|---|---|
| `npm.cmd test -- src/features/selection` → `red.log` | 6 failures / 43 passes: missing active/candidate API, active interior drag did not move, outside drag created a replacement rather than deactivating |
| Same command → `red-overlap.log` | 1 failure / 51 passes: inactive temporary click selected an overlapping saved object |
| Same command → `red-cancel-context.log` | 1 failure / 52 passes: cancellation did not restore prior channel context |
| Same command → `red-authority-context.log` | 1 failure / 53 passes: active context did not follow authoritative channel change |
| Same command → `red-stale-frame.log` | 1 failure / 54 passes: stale rendered target remained selected on pointerdown after authoritative deletion |
| Same command → final `green.log` | 4 files, 55 tests pass |
| `npm.cmd test` → final `full-test.log` | exit 0; 38 files, 277 tests pass |
| `npm.cmd run build` → final `build.log` | exit 0; TypeScript and production Vite build pass |
| `git diff --check` | clean |

The final small context/authority guards were followed by all final verification below; earlier native executables were not used as the final evidence.

## Fresh native verification

Exact build command, completed with exit 0 before launching either final suite:

```powershell
npm.cmd run tauri -- build --debug --no-bundle --features e2e --config src-tauri/tauri.e2e.conf.json
```

Final build log: `.test-output/fidelity-task4/native-build.log`. The executable was rebuilt at 16:17:40 local time, 32,591,360 bytes. SHA-256: `D71147D543E985A592A1F2C96E65EE8260047C1BC95BB1BDCD61AE9D8A17078E`.

- `node tests/desktop/interaction-flow.test.mjs` — exit 0. Final `interaction.log` and `interaction/report.json` record 18 checks, including real 1280×800 outer-window layout, independent pane changes, duplicate-target behavior, other-pane selection preservation, target invalidation, settings event shielding, native select and slider interactions, Escape focus, and save/reopen.
- `node tests/desktop/selection-flow.test.mjs` — exit 0 and `selection/report.json` has `passed: true`. Final `selection.log` retains the full report. Trusted WebDriver pointers verify active draw (8 handles), inactive outline (0 handles), inactive Delete no-op, click reactivation, interior temporary movement, second-gesture replacement, and first-gesture global deactivation in the other pane. Existing classification/note, deduplicated Delete mask, undo, transparent rectangles, nested-menu bounds, compare playback, overlap deletion, border movement, and handle resize assertions remain. Added saved-mask interior movement and Alt-pan after zoom prove that pan changes the viewport without changing persistent mask geometry.
- The selection report contains `activation` before/after styles, `pan` before/after view and mask geometry, and native playback status with consumed frames and zero underrun frames for both source variants and comparison playback.
- Screenshots: `selection/inactive-outline.png`, `selection/active-replacement.png`, `selection/selection-transparent.png`, `selection/selection-menu.png`, `selection/selection-compare-context.png`; interaction screenshots remain under `interaction/`.

One initial native assertion used the broad `.is-selected` selector and counted the sidebar's active file. Its screenshot showed correct rectangle deactivation. The assertion now targets `.annotation-rect.is-selected`; the failed run is retained as `selection-attempt1.{log,json,png}`, and the entire selection suite passed afterward and again against the final build. No product behavior was changed to satisfy that test failure.

Both suites used only their owned Tauri/WebView2/tauri-driver/EdgeDriver processes and ran sequentially on the harness ports. No user app/session, system DPI, system volume, source audio bytes, main checkout, or old release was modified. This task did not claim real system-DPI coverage. The pre-existing Vite large-chunk advisory remains non-fatal. Rust code was unchanged; no additional Rust unit run was required by Task 4.
