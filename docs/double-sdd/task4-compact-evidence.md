# Task 4 — compact menus and comparison workspace evidence

Task base: `a5b69cba0aeefdcc3883d3913c1ba8b79f468471`.
Worktree: `D:/Work/annotator/.worktrees/compact-workspace-v2`, branch `feature/compact-workspace-v2`.
Status: implementation and verification complete; paired spec/quality review remains pending.

## Delivered scope

Six functional menus reuse project lifecycle, annotation history, shared selection actions, playback, and workspace view drafts. Captured menu targets retain their original selection; project transitions and context replacement close menus. Arrow navigation, disabled-item skipping, Escape, outside dismissal, and active-trigger focus restoration are covered. File/channel classification and folder-import entries are intentionally left for Tasks 5 and 7, with no placeholders.

The top region is 72 CSS px, transport 48 px, and each file heading/control region 54 px. Device choice, playback source and output counters live in the on-demand device panel; mix and analysis settings remain on demand. Removed persistent analysis/teaching/footer rows, redundant current-source text, successful-source verification rows, and empty-workspace teaching. Mono files hide channel selectors. Error/retry, import progress/cancel, missing-source association, and recovery remain accessible.

Comparison defaults to horizontal; vertical orientation and a draggable/keyboard separator use existing v2 view drafts. Split clamps at .25/.75 and saves/reopens without a content-undo entry. Each horizontal pane has a 300 px minimum and every pure `.spectrogram-surface` has a 180 px minimum. Per-file scrolling preserves its title. The physical-range-based `--frequency-ruler-width` logic in ChannelPane is untouched.

Help is rendered inside the application: current shortcuts, concise built-in guide, package version, and lazily loaded complete third-party notices. No external development paths are used. Package/release version remains unchanged for Task 8.

## RED / GREEN

- `npm.cmd test -- src/app/compactLayout.test.tsx`: initial RED on missing AppMenu/CompareSplitter; subsequent GREEN on menu disabled/focus/shortcut shielding, splitter limits, view-draft save/reopen and orientation retention.
- Added top-menu ArrowRight/Escape regression: RED restored focus to the old File trigger; GREEN keeps the Menu lifetime, remounts its panel, and restores the active trigger.
- Added linked short-file tail regression: RED zoom-out generated 2.5–0.1 seconds from a linked 5–10-second view; GREEN uses the shared bounded zoom function and displayed-pair duration, producing 2.5–12.5 seconds and a legal linked reset.
- Additional tests cover all six real menu groups, lifecycle save/new bindings, shared note creation, disabled barriers, and closing menus immediately on transition. Existing ProjectActions and playback tests now assert the compact UI while retaining their behavior coverage.
- Full `npm.cmd test`: 31 files / 193 tests passed.
- `npm.cmd run build`: TypeScript and Vite passed, also executed by each native build. Vite reports its size warning for the complete, lazily loaded third-party notices chunk (2.74 MB uncompressed); the main application chunk is about 392 kB.
- `npm.cmd run tauri -- build --debug --no-bundle --features e2e --config src-tauri/tauri.e2e.conf.json`: passed. One intermediate build was retried after an owned earlier executable briefly held the target file; final build completed before final native runs.

## Native outer-window evidence

`node tests/desktop/compact-layout.test.mjs` passed all 15 checks. Output, PNGs and JSON are in `.test-output/task4-compact/`; `report.json` records one-frame plot rectangles and ancestor clipping visibility, file/control rectangles, actual native PID/outer rect, driver rect, inner dimensions, DPR, and visual viewport scale. PNG hashes are in `screenshots-sha256.json`.

Important: attached EdgeDriver reports/sizes the WebView client area here. The harness now measures and resizes ONLY its spawned native PID with Win32 `GetWindowRect` / `SetWindowPos`; it records EdgeDriver's rect separately. It refuses occupied ports 4445, 4446, and 9235 and never attaches to or kills an unknown app.

| Native outer size | WebView inner size | DPR / scale | Pure plot heights | Result |
|---|---|---|---|---|
| 1280 × 800 | 1264 × 761 | 1 / 1 | 236.5 px × 4 | All four fully visible in the same frame |
| 1920 × 1080 | 1904 × 1041 | 1 / 1 | 376.5 px × 4 | All four fully visible in the same frame |
| 1000 × 680 | 984 × 641 | 1 / 1 | 180 px minimum | File-stack horizontal and channel vertical scroll remain reachable |
| 1000 × 680, vertical | 984 × 641 | 1 / 1 | 180 px minimum | Both file titles and complete channels reachable by stack scroll |
| 1280 × 800, isolated emulation | 1011 × 608 | 1.25 / 1 | 180 px minimum | CDP device-scale simulation only |
| 1000 × 680, six + six channels | 984 × 641 | 1 / 1 | 180 px × 12 | Independent scrolling, complete last channels, headers retained |

Actual Windows 125% system scaling was not changed or verified. The isolated simulation changes only this owned WebView's CDP device metrics, restores them afterward, and is explicitly not system-DPI evidence.

Inspected `stereo-outer1280x800.png` and `six-plus-six-last-channels.png` visually. The first six-channel inspection caught wrapping controls at the 300 px minimum; the redundant reset button was removed from the permanent row (View menu retains the real reset action), and a new per-control bounding check verifies that all controls stay inside the 54 px header. Final screenshots show the corrected row. `bundled-help-notices.png` and `edge-menu.png` cover bundled notice readability and menu boundaries.

Native checks also cover: sidebar selection preservation; top-menu note creation/focus; mask/undo/redo via native commands; devices/counters on demand; pointer separator adjustment, keyboard Home/End clamps, orientation retention and reopening; menu keyboard focus; help and notices; edge submenu bounds.

## Existing regression flows

- `node tests/desktop/selection-flow.test.mjs`: passed, including actual original/processed native output, annotation/mask operations, comparison targets, transparent overlays and mono selector hiding. Copied report: `.test-output/task4-compact/selection-report.json`.
- `node tests/desktop/rulers-flow.test.mjs`: all 11 checks passed, including physical coordinates, readable narrow frequency labels, unchanged warm FFT requests, wheel semantics and linked short-file tail. Copied report: `.test-output/task4-compact/rulers-report.json`.
- `node scripts/run-desktop-tests.mjs --skip-build`: all six phases passed — project import, 300 view switches / 450 mounted owners with fresh native analysis, spectral edits/native playback, restart, JSON/ZIP sharing, and recovery. Original report: `.test-output/desktop-vD6YVT/report.json`; copied report: `.test-output/task4-compact/desktop-report.json`. The first run reached an outdated prefix selector during sharing; corrected harness prefix matching and the full rerun passed.

No migration/compatibility layer, folder UI, whole-file/channel classification UI, dependency upgrades, release version changes, or release packaging are included. Manual listening and actual Windows 125% display scaling remain unverified.

## Spec-review fix — concurrent actionable feedback

The verified Task 4 review found that separate absolute-positioned import and command-failure panels occupied the same coordinates. Fixed by placing media errors, import progress, association controls and command failures in one bounded vertical `.workspace-feedback` stack. It overlays only active feedback, scrolls when necessary, and is `display: none` when empty. No command queue, import controller, native contract, cancellation or ledger code changed.

New regression: `node tests/desktop/feedback-flow.test.mjs` uses an owned native Tauri window and the actual bundled application CSS. It injects one failed `apply_change` response at the fetch transport boundary and delays later native ready/finished Channel deliveries to hold a deterministic concurrent failure/processing state. All import preparation, cancellation, prepared-media release and explicit retry otherwise execute the real native paths. This is controlled fault/timing injection, not a claim of naturally slow decoding.

- RED against the preceding implementation: `.annotation-failure` occupied y=78–148.5 while import progress occupied y=86–216. Cancel's center hit the covering failure panel (`reachable: false`). Saved as `.test-output/task4-compact/feedback-red.json` and `feedback-red-processing1280.png`.
- GREEN: at true outer 1280×800 and 1000×680, progress occupies y=78–208 and failure y=216–286.5. All Cancel and Retry button centers pass `document.elementFromPoint`, and the two panel rectangles do not intersect. Result controls are also checked after cancellation. Saved as `feedback.json`, `feedback-processing1280.png`, `feedback-processing1000.png`, and `feedback-cancelled1000.png`.
- WebDriver clicks Cancel; `cancel_media_import` and `release_media_import` execute. The remaining prepared item is not imported. Closing results leaves the failed command visible; clicking its retry imports the original failed item and clears the ledger. Saving succeeds, and the empty feedback container measures zero height.
- Visually inspected the corrected 1000×680 feedback screenshot.
- Focused checks: 30 tests passed (compact layout, AppShell, media imports, command queue).
- Full `npm.cmd test`: 31 files / 193 tests passed.
- Requested debug/e2e Tauri build (including TypeScript/Vite build) passed.
- Fresh `node tests/desktop/compact-layout.test.mjs`: all 15 checks passed; normal 72/48/54 px budgets and four complete stereo plots are unchanged.

Paired spec/quality review must be rerun on the full TaskBase..Head range.
