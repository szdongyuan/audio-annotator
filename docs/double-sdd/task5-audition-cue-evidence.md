# Task 5 — coherent audition source and cue evidence

Scope: spec §4.3 and §7.2–7.4; plan Task 5. Task base: `98e7ad00ea1769ea44408e7770ba807246bcdcb7`.

## Behavior implemented

- Runtime `workspaceSource` defaults to `processed`, drives both file panes and ordinary playback, and is not serialized. A single compact 原音 / 暂存编辑 control replaces mode/bypass controls.
- `automatic`, `explicit-file`, `explicit-cue`, and `explicit-selection` intents resolve the source and range. Opposite source auditions keep the workspace and graph identity unchanged. Pause/resume retains the intent; stop/end, selection changes, source changes and runtime transitions release it.
- New explicit intents stop the prior session and seek their own beginning. Resume uses a null seek. An inactive selection is excluded. Ordinary stopped playback uses a valid current-file cue or its current file position.
- Right-click captures owner/media/real seconds without selecting a playback source, seeking, stopping, or activating a different region. The captured menu always exposes 从此处播放; out-of-file positions and stale/not-ready sources cannot execute. The command uses full-file channel mixing from the cue to EOF and preserves the active selection.
- Each file retains its own ephemeral cue. Visible channels render the same fixed 1 CSS px white dashed, pointer-transparent marker; zoom/pan projects its seconds, and out-of-view markers hide.
- Choosing note/classification/mask explicitly activates the guarded, current captured target. Merely opening its menu remains nonmutating. Existing owner and latest geometry guards remain.

## RED / GREEN

Executed `npm.cmd test -- src/features/playback` before implementation: 17 passed, 2 failed. Ordinary active playback incorrectly submitted original full-file/null seek, and explicit `playFile` was absent. After the intent implementation: 19 passed.

Executed `npm.cmd test -- src/features/playback src/features/selection/regionMenu.test.tsx` after changing expectations and before UI implementation: 25 passed, 3 failed (missing 声音版本, new audition label, and 从此处播放). After wiring controls/menus: 28 passed.

Additional focused RED / GREEN cycles:

- Inactive captured-object note action: menu remained inert but note failed to activate/focus its target. The focused menu suite passed after guarded activation; classification and mask actions are also covered.
- Blank-tail ordinary cue: native request incorrectly sought 99 seconds; fixed by revalidating cue time before ordinary playback.
- Ordinary stopped position: request incorrectly sought 0 instead of the stopped 0.5-second position; fixed by retaining the current-file stopped position when no valid cue exists.
- Native interaction initially showed a new explicit cue inherited the prior session's stop origin. New explicit intents now queue stop before their deliberate seek; pause/resume retains the same origin and current position. No Rust DSP changes.

Final focused playback coverage: 24 tests, including actual hook/fake native request boundaries, Space, selection activation/deactivation, explicit range/source overrides, paused seek, source/runtime replacement, latest-generation errors and pending acknowledgements. Spectrum hook tests additionally prove both opposite overrides preserve both files' request sources/keys and issue no new tile requests.

## Verification commands and artifacts

Working directory: `D:/Work/annotator/.worktrees/spectral-fidelity-v021`.

1. `npm.cmd test` — 38 files / 290 tests passed. Log: `.test-output/fidelity-task5/frontend-tests.log`.
2. `npm.cmd run build` — typecheck and Vite production build passed. Log: `.test-output/fidelity-task5/frontend-build.log`. Existing large-chunk warning remains.
3. `npm.cmd run tauri -- build --debug --no-bundle --features e2e --config src-tauri/tauri.e2e.conf.json` — fresh native executable built, exit 0 observed before final desktop runs. Log: `.test-output/fidelity-task5/native-build.log`.
4. `node tests/desktop/processed-flow.test.mjs` — exit 0; 7 report checks, `passed: true`. Log/report/screenshots: `.test-output/fidelity-task5/processed.log`, `.test-output/fidelity-task5/processed/`.
5. `node tests/desktop/interaction-flow.test.mjs` — exit 0; 19 report checks, no error. Log/report/screenshots: `.test-output/fidelity-task5/interaction.log`, `.test-output/fidelity-task5/interaction/`.

A supplementary race test initially had an overly narrow inferred fake return type. Typecheck caught it; the test fake was annotated `Promise<PlaybackStatus>`. The final native build and desktop evidence are from after that correction. Intermediate desktop runs against a preceding build are not used as final evidence.

## Native evidence

`processed-flow` now exercises actual UI actions before retaining all earlier native IPC identity/authority checks. It imports owned synthetic 48 kHz dual-tone (1500/6000 Hz) stereo WAVs, draws a real selection and presses Delete, checks the accepted mask, observes the actual binary tile callback without changing its payload, and hashes actual Canvas RGBA pixels.

- The 1500 Hz sample within the masked interval falls to -160 dB in the displayed processed tile. The selected channel's bitmap changes; the other channel and second file are byte-for-byte unchanged.
- Real UI undo/redo, raw switch, disable/enable, move, delete/undo recover their exact corresponding canvas hashes. The mask stays in normal v2 saved project data; close/reopen reconstructs its pixels and defaults to processed.
- Each opposite audition preserves all four canvas hashes, the workspace selector and tile callback count, while native consumed output frames advance. Pause/resume is checked against actual native status.
- The existing independent IPC stage additionally verifies >30 dB rejection at the masked tone and <1 dB change at the retained tone, unchanged original results, independent channels, forged/stale source rejection, disabled/moved/undo/redo/delete signatures, unrelated notes/files, save/reopen, retired view rejection and unchanged source SHA256.

`interaction-flow` retains Task 3/4 pane/popover regressions and adds an owned four-second stereo fixture alongside a short file. It verifies automatic selection playback, full-file/cue overrides, pause/resume, stop/end restoration, preserved active selection, a disabled linked short-file tail command, and increasing native output frames while menus open on a different file.

The white dashed cue is measured on both same-file channels to ≤0.5 CSS px, including isolated WebView DPR 1 / 1.25 / 2 emulation; zoom-to-selection hides an outside cue and resetting the view restores it. Actual statuses and output counts are in the JSON report. The test does not use global Windows DPI, system volume or device-setting changes.

## Limits / handoff

- No manual listening claim; output is evidenced by native device frame consumption, status/range assertions and DSP/tile numbers.
- DPR emulation is not physical Windows 125%/200% display scaling. No new-machine or release installer validation here.
- No Task 6 toolbar, Task 7 sharing changes, Task 8 release/performance work or dependency changes.
- Legacy `tests/desktop/selection-flow.test.mjs` and `tests/desktop/playback-smoke.mjs` still contain the removed mode/submenu selectors. Their broader orchestration/selector migration belongs to the planned Task 8 pass; no stale/race/recovery coverage was deleted. The two required Task 5 native suites use the new semantics.

## Final observed measurements

- Processed native IPC tone rejection: -149.542057 dB; retained tone change: 0 dB.
- Opposite explicit auditions consumed 3456 frames (raw) and 4416 frames (processed); their resumed streams consumed 3456 and 7776 frames at the recorded observation.
- Automatic selection: 0.7942291667–2.0072291667 seconds; 3456 frames observed during playback and 58224 frames at natural end.
- Explicit cue: 2.5992708333 seconds into the full 0–4 second file; 4416 output frames observed, and resume retained that session origin.
- Explicit whole-file: 0–4 seconds, start 0; 4896 frames observed. After stop/end, ordinary playback returned to the active selection. After deactivation, ordinary playback used the current-file cue.
- Both cue lines measured 0 CSS px horizontal error at DPR 1, 1.25 and 2; border width remained 1 CSS px.

These are observations from the final sequential desktop runs after the final successful native build, not synthetic audio-counter stubs. JSON reports retain the complete generations, device status, frame counters, coordinates, hashes and ranges.
