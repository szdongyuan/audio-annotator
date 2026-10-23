# Task 3 — independent panes and dismissible settings

Date: 2026-10-23. Task base: `0518653bd82782690a3ccf3499a8082a3a8e6089`.

Worktree: `D:/Work/annotator/.worktrees/spectral-fidelity-v021`.
Scope: approved design §§5–6 and plan Task 3. Tasks 1–2 sampling, raster budgets, and original/processed cache identity are unchanged. The UI still uses the original analysis source until Task 5.

## Implemented contract

- `useWorkspace.selectPane(primary|compare, id)` is the single identity entry point. Sidebar and list locate choose primary; each compact title chooser chooses its own pane; the comparison menu uses the same guard. No auto-swap and no independent `mediaUI.selected` rendering path remain. Retained callbacks read the current draft/accepted document and validate the current runtime before acting.
- Duplicate options stay visible and enabled. A duplicate leaves view drafts, content history, playback source and selection untouched, and highlights the existing pane with a live-region explanation for 1200ms. The border is static, including reduced-motion mode; spectrum colors do not change.
- Visible-pane reconciliation preserves valid selection/context in the other pane, clearing only a replaced/hidden target. Saved per-file views, linked seconds, reopen, media removal and stale-owner guards remain covered.
- Analysis settings close on outside pointerdown or Escape. The closing pointer release/click is consumed after unmount, so it cannot draw or start playback. Internal drags ending outside and native selects remain open. Escape restores the header/toolbar/menu trigger. Same-trigger toggling and direct other-file switching work.
- Closing discards unapplied compute settings while retaining immediate display changes. Target removal/replacement and runtime replacement close settings without later revival. Blocking decision dialogs keep their own handlers. Help supports outside dismissal.
- Native evidence exposed the old global popover covering the other file's settings button. The popover now stays within its own pane below the header, with an internal scroll area. Both triggers remain reachable in horizontal and vertical layouts. The title chooser uses a compact arrow beside the existing filename and category control, avoiding duplicate filenames or a new row.

## RED → GREEN evidence

All logs below are under [`.test-output/fidelity-task3`](../../.test-output/fidelity-task3/).

| Command / regression | Observed RED | Observed GREEN |
| --- | --- | --- |
| `npm.cmd test -- src/features/spectrogram/paneSelection.test.tsx` | `panes-red.log`: 4 failures: missing shared selection API and comparison selection incorrectly cleared after primary replacement | `panes-green.log`: 7 tests pass, including actual AppShell sidebar/title/menu controls, hidden settings target/runtime, stale callbacks and save/reopen/removal |
| `npm.cmd test -- src/components/popover/DismissibleLayer.test.tsx` | `popover-red.log`: 2 failures; outside pointer and Escape leave settings open | Initial `popover-green.log`: all 3 tests pass; the final six-test suite passes in `draft-sync-green.log` and `targeted.log` |
| Blocking recovery decision regression, same popover command | `decisions-red.log`: recovery button handler was incorrectly consumed | Added modal/alertdialog exclusion; final targeted suite passes |
| Accepted authority before effects settle, pane-selection command | `authority-red.log`: stale callback incorrectly accepted primary C while authority already showed comparison C | Fresh draft/authority read rejects it; `panes-green.log` passes |
| `node tests/desktop/interaction-flow.test.mjs` | `native-overlap-red.log` and `native-overlap-red.png`: genuine WebDriver click intercepted because settings covered the comparison settings trigger | Pane-local popover; final `native-interaction.log`: 18 checks pass |

During initial test construction, fixture cloning/UUIDs and test-only prop/type updates were corrected before treating those runs as behavioral evidence. Existing classification context coverage now clicks the spectrum-type control; chooser/settings controls deliberately avoid changing playback/selection during their capture phase. Existing stale-owner, geometry, recovery and undo tests were retained.

## Final command results

All commands ran in the worktree and returned exit 0:

1. `npm.cmd test -- src/features/spectrogram src/components src/app` — 20 files, 104 tests (`targeted.log`).
2. `npm.cmd test -- src/features/selection src/features/annotations` — 10 files, 77 tests (`selection-regression.log`).
3. `npm.cmd test` — 38 files, 265 tests (`all-tests.log`).
4. `npm.cmd run build` — typechecks and production bundle succeed (`build.log`). The existing large third-party-notices chunk warning remains.
5. `npm.cmd run tauri -- build --debug --no-bundle --features e2e --config src-tauri/tauri.e2e.conf.json` — complete fresh native build succeeds (`native-build.log`).
6. **After that build exited 0:** `node tests/desktop/interaction-flow.test.mjs` — 18 checks pass (`native-interaction.log`, `report.json`).
7. `git diff --check` — clean.

Native binary used: `target/debug/annotator-desktop.exe`, SHA-256 `DE1811A8A4C93A58E964BA0963381D9E770AD5194763D9F9696A71E40026E228`.

## Native observations

The suite creates its own project and launches its own debug/e2e application/WebView2/driver processes. Trusted WebDriver pointer and keyboard actions import three independent fixtures: `stereo24.wav`, `stereo.mp3`, `float32.wav`. It refuses occupied ports 4445/4446/9235 and cleans up only its owned processes. No user audio, user application, Windows display scaling or system volume was changed.

- Real Win32 outer window: **1280×800**; WebView viewport **1264×761**; actual reported DPR **1**.
- Horizontal comparison: four fully visible plots, each **236.5 CSS px** high; both header-plus-controls totals **54 CSS px**. Backing sizes are **277×237** for 277×236.5 CSS plots, preserving Task 1's rounding contract.
- A/B→C/B through sidebar retains comparison selection. A/B→A/C through comparison title clears the replaced target only. Primary title and top comparison menu independently switch the intended side.
- Both duplicate directions are exercised through the title selectors, sidebar and top menu. Native snapshots show unchanged revision, pair, source and selected rectangle; explanation disappears after the 1200ms interval.
- Real native dropdown selection, internal slider drag/release outside, Escape focus restoration (header and View menu), direct settings switching, same-trigger close, closing-drag no drawing and closing-play-button no playback pass.
- Linked time and identities survive native save/close/reopen. Help backdrop dismissal and vertical-layout settings switching pass. Target removal/runtime invalidation are exercised in component tests with real store updates.

Screenshots: [four plots](../../.test-output/fidelity-task3/four-plots-1280.png), [sidebar duplicate](../../.test-output/fidelity-task3/sidebar-duplicate-compare-highlight.png), [reverse title duplicate](../../.test-output/fidelity-task3/header-duplicate-primary-highlight.png), [menu duplicate](../../.test-output/fidelity-task3/menu-duplicate-primary-highlight.png), [vertical settings](../../.test-output/fidelity-task3/vertical-settings-switch.png), [final panes](../../.test-output/fidelity-task3/final-independent-panes.png).

## Review repair — preserve compute drafts during display saves

Quality review reproduced a regression in commit `0bdcb2585b130ee9906c79d064bc179646bb305a`: synchronizing the compute draft on the `settings` object reference reset a pending hop of 777 to the applied 512 when a display-only save returned an equivalent, newly parsed settings object. The prior 263-test / 17-native-check result did not cover the still-open draft after that save. Its raw top-level logs, reports and screenshots are preserved in [before-draft-repair](../../.test-output/fidelity-task3/before-draft-repair/); the prior committed evidence remains in that commit.

- Component RED: `npm.cmd test -- src/components/popover/DismissibleLayer.test.tsx` returned exit 1, with one of six tests failing (`draft-sync-red.log`): after a real gain change and equal cloned authority, expected hop 777, observed 512. The changed-authority characterization also verifies draft replacement without remounting the dialog.
- Native RED: the extended `node tests/desktop/interaction-flow.test.mjs` ran against the previously built pre-repair executable and returned exit 1 (`native-draft-sync-red.log`, `native-draft-sync-red-report.json`, `native-draft-sync-red.png`). It waits for an increased native revision and the accepted gain value before checking the open hop field; observed 512 instead of 777.
- Fix: synchronize against the five scalar analysis values (`window`, `windowSize`, `hopSize`, `fftSize`, `melBands`). Equivalent snapshots preserve pending compute edits; actual authority changes reset them. No key remount or focus/placement change was introduced.
- Component GREEN: the same command returned exit 0, six tests pass (`draft-sync-green.log`). Then targeted 104 and complete 265 frontend tests, production build, and the exact full debug/e2e native build all returned exit 0.
- Native GREEN: only after the fresh native build exited 0, the same extended interaction command returned exit 0 with 18 checks. Hop 777 survives the accepted display save while open; Escape still discards it and reopening shows applied hop 512. All prior focus, placement, pointer, pane and layout checks remain green.

Original Task 3 review base remains `0518653bd82782690a3ccf3499a8082a3a8e6089`. Repair scope is only this reviewed draft lifecycle regression and its evidence.

## Limits

This is Task 3 evidence, not release validation. No new real Windows 125%/200% DPI, alternate machine, long-audio performance, native output listening or final signed-release tests were performed. Those remain in the later approved tasks. No Rust source or dependency versions changed.
