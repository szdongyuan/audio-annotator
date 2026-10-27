# Project examples — Task 3 evidence

Task base: `704ffd1dcfbf192d1577f1c7b01399f1127d9ef1`. Workspace: `C:/Users/DY/AppData/Local/Temp/annotator-project-samples-20261027`. This task owns desktop verification, user help/docs, application version 0.7.5 and evidence. Existing data format versions remain unchanged. Parent owns normal executable/installer/update packaging after review.

## Test design and RED

`tests/desktop/examples.test.mjs` drives the real Windows app using existing Selenium / official tauri-driver / EdgeDriver harness. All normal mutations use clicks/keys; native IPC is read-only assertion. Picker selections are injected by the E2E feature, not physical picker testing. Each invocation creates its own local profile, WebView directory, two-second six-channel fixture and two new projects; project A is an owned `.codex-example-verification-<timestamp>` NAS directory. Nothing writes the user's original workspace, running app or existing NAS project.

RED command: set `ANNOTATOR_WORKSPACE_EXE=D:/Work/annotator/.test-output/recycle-busy-fix/final-e2e/annotator-desktop.exe`; `node tests/desktop/examples.test.mjs` → exit 1. Actual preserved 0.7.4 successfully created the ordinary project with one audio, category/label, note, temporary mask and +20 dB monitor, then failed specifically because the inspector has no 示例 tab. Evidence: `.test-output/examples-red.log`, `.test-output/examples/task3/desktop-xdHozl/report.json` and failure screenshot. This is the feature-negative control; product implementation was already completed in Tasks 1/2.

Aggregate registration RED: `node --test tests/desktop/release-suite-registration.test.mjs` → exit 1, missing examples phase. Added the isolated examples phase while preserving historical phases. Re-run → exit 0, 1 test passed. Logs: `task3/registration-red.log` and `task3/registration-green.log`. The historical aggregate itself is not rerun for this increment.

## Completed commands

All paths below are relative to `.test-output/examples/` unless stated. Shared `CARGO_TARGET_DIR=C:/Users/DY/AppData/Local/Temp/annotator-071-production-20261027`, `CARGO_INCREMENTAL=0`; release profile only.

- `npm.cmd test -- --maxWorkers=2` → exit 0; 83 files / 666 tests passed (`task3/frontend.log`).
- `npm.cmd run build` → exit 0; TypeScript and Vite production frontend build passed (`task3/frontend-build.log`). Vite reports its existing large-chunk advisory.
- `cargo test -p annotator-core --release` → exit 0; 302 passed, 9 explicit external-fixture/subprocess-helper tests ignored (`task3/core.log`).
- `cargo test -p annotator-desktop --release --lib` → exit 0; 95 passed (`task3/native.log`). No native source changed during the later UI fix.
- After the integration fix, `npm.cmd test -- --maxWorkers=2` → exit 0; 83 files / 671 tests passed (`task3/frontend-final.log`).
- `npm.cmd run typecheck` → exit 0 (`task3/typecheck-final.log`).
- `node --check tests/desktop/examples.test.mjs` → exit 0.

## Integration bug and strict TDD fix

The initial E2E build passed (`task3/e2e-build.log`) and was preserved with SHA256 `dddfb187c6d3d14ee03d038651572fb474518f2c0ab2a88814280ca2d24fa6d3`. Desktop attempts were retained rather than represented as a clean run:

| Report folder | Observed result |
| --- | --- |
| `desktop-hYzXUS` | Script incorrectly waited for every button enabled after success, including the intentionally disabled completed-import action; corrected to wait for per-row terminal results. |
| `desktop-jR1FiR` | Script required more than eight colors after zooming a stationary two-tone fixture. Actual screenshot showed valid spectrum. Nonblack/multicolor assertion now checks at least three colors and more than 100 lit pixels; each channel has distinct tones and pixel fingerprints. |
| `desktop-Wn4zci`, `desktop-KaXo5r` | Paused seeking failed with both keyboard and pointer; treated as potential product bug. |
| `desktop-6jaWRW`, `desktop-T4HZ3J` | Baseline script raced annotation acknowledgement or mounted menu. Added native commit acknowledgement + explicit row selection and local mounted-menu wait. |
| `desktop-p1UR16` | Reproduced pointer seek failure; initial attempt to observe read-only Tauri function properties yielded an empty trace. |
| `desktop-aIpZnl` | Transparent fetch/callback observation captured 56 wire records, proving the paused-seek bug. |

In the final diagnostic trace, pause returned `paused`, generation 7, position 0.152 s. The first pointer seek sent `seekSeconds:1.605, play:false`; native returned `buffering`, generation 8, position 1.605 s. A second slider input then sent `seekSeconds:1.67, play:true`, because the UI inferred Play from the temporary buffering state. Native correctly played that request to completion. No IPC response/event was substituted, delayed or held; observation forwarded original calls unchanged.

Parent authorized a minimal integration fix in `preview.ts` / `ExamplePreview.tsx`: preserve explicit play intent independently from presentation state. Seek preserves the current intent, pause/stop/release clear it, and only accepted current ended/error status clears it; pending older events cannot clear a newer intent. Controls use that intent, including during buffering.

- RED: `npm.cmd test -- src/features/examples/ExamplePreview.test.tsx --maxWorkers=2` → exit 1; the focused UI regression observed `[false,true]` rather than the required `[false,false]` across two paused seeks (`task3/seek-intent-red.log`).
- GREEN: same command → exit 0, two UI tests passed (`task3/seek-intent-green.log`).
- Boundary verification: `npm.cmd test -- src/features/examples src/bridge/examples.test.ts --maxWorkers=2` → exit 0, eight files / 45 tests. Added playing seeks, stop/close, pause during configure and stale end/error event boundaries (`task3/seek-intent-affected.log`).
- The full 671 frontend tests and final typecheck above passed after the fix.

Actual preserved 0.7.4 created an isolated annotated project, then the initial candidate opened it with identity, original audio hash, label/note/mask and +20 dB preserved, without creating recycle or example files on read (`task3/compatibility-x7qXK1/report.json`, `task3/compatibility-run-1.log`, exit 0). Final compatibility is repeated below against the rebuilt final candidate.

## Native outside-click focus discovery

The first rebuilt candidate (`e11311e5242755a67395e703987f92dfb18c2ec165e3cfbcfef02e926d002006`) passed the full preview flow in `task3/desktop-5tpIG5/report.json`: six distinct channel FFTs, zoom/pan/reset, original playback progression, pause, seek, stop, close, unchanged main document/selection/counts/preferences and playable main audio. Both pointer seek requests now used `play:false` (1.605 and 1.656 s). The next actual browser outside-click closed DeviceDialog but lost trigger focus; Audio-menu Escape focus restoration passed.

The shared backdrop called `onClose` during pointerdown, restoring focus, then the browser's default pointer action moved focus again. Parent authorized the minimal shared MediaDialog fix: prevent default only when the pointer target is the nonbusy backdrop immediately before dismissing. Child pointer events and busy backdrop behavior are unchanged.

- RED: `npm.cmd test -- src/features/playback/DeviceDialog.test.tsx --maxWorkers=2` → exit 1; cancelable backdrop event remained uncancelled (`task3/backdrop-focus-red.log`).
- GREEN: same command → exit 0; four existing device tests passed (`task3/backdrop-focus-green.log`).
- Added two child/busy guard cases; `npm.cmd test -- src/features/playback/DeviceDialog.test.tsx src/features/media src/features/identity/IdentityDialog.test.tsx src/features/examples src/components/popover src/components/menu src/app/HelpDialog.test.tsx --maxWorkers=2` → exit 0; 24 files / 214 tests (`task3/backdrop-focus-affected.log`).

## Offline documentation resources

The bundled user guide links `examples.md`, so both Tauri resource mapping and complete-file update payload now include that document. Resource count becomes 34. A focused Node test checks local guide links resolve to the same existing source in both resource lists: `node --test tests/desktop/release-suite-registration.test.mjs` failed before adding the mapping (`task3/resources-red.log`), then passed both registration/resource tests (`task3/resources-green.log`, `task3/registration-final.log`). This checks delivery declarations; parent performs actual normal installer/update payload audits after review.

## Layout metric correction and retained-results discovery

After the focus fix, actual `task3/desktop-lrogCY/report.json` passed both device routes and real outside/Escape focus restoration. The script then expected a 280 px inspector at 1000 px outer window width, whereas the established production CSS uses 268 px normally, 240 px below 1280 and 220 px below 1100. Measured inner width was 984, inspector 220; all eight tabs were visible and no horizontal overflow/counters existed. Parent corrected the test metric assumption, preserving production CSS. Final acceptance checks 220 px at 1000 outer width, each tab within the panel/window, text fitting and clickable. No forced DOM sizing or production widening substitutes for the real layout.

With that correction, `task3/desktop-PShmVF/report.json` revealed a separate product issue: returning to 示例 reopened previously closed completed import results, blocking the next tab action. ExampleLibraryPanel is remounted when revisiting the tab, and its local initial state/effect interpreted retained rows as a new dialog request. Parent authorized retaining presentation state in the owner controller instead. Closing stays closed across tab switches, explicit 查看导入结果 reopens retained success/error rows, a new batch opens, and disposal clears presentation state and ignores late file selections.

- RED: `npm.cmd test -- src/features/examples/ExampleLibrary.test.tsx --maxWorkers=2` → exit 1; the remounted panel unexpectedly contained the closed import dialog (`task3/import-dialog-red.log`).
- GREEN: same command → exit 0, nine tests (`task3/import-dialog-green.log`).
- Disposed-owner boundary RED/GREEN: same command first failed because a late file selection reopened presentation after disposal, then passed with the lifetime guard (`task3/import-dialog-dispose-red.log`, `task3/import-dialog-dispose-green.log`).
- Affected examples/bridge verification → exit 0, eight files / 46 tests (`task3/import-dialog-affected.log`).

## Identity save/publication admission boundary

After the example-specific fixes, `desktop-RVd6Hn` failed creating B in the active NAS project with `Collaboration job already running`. `desktop-2pEjCC` first observed `collaboration_status.busy=false` but still failed. `desktop-Zx91yv` performed three explicit UI create retries only after read-only verification that no profile had committed; all failed without changing profile IDs or store revision. Precreating B outside the project succeeded, but `desktop-xwLtsy` still failed three actual in-project selects. Those attempts were preserved rather than classified as a passing or merely transient flow.

`desktop-y3ayM5` transparently observed profile/collaboration/save traffic. `save_project` completed revision 5, a fresh `profile_list` returned store revision 6, then `profile_select` itself rejected with `ResourceLimit` and `details.operationBusy=true`; the same pattern repeated. The parent traced `save_project`'s existing `collaboration::schedule()` after local save: the identity save barrier starts a new background publication immediately before identity mutation. An external idle check or retrying the whole UI operation repeats Save and can recreate this contention. No native scheduling change was made.

Parent authorized a narrow IdentityController fix, now required for actual actor-isolation acceptance: use the existing bounded `retryAdmission` around each native mutation, calling `fresh()` and rechecking the existing owner/cancel guard for every attempt. Create and subsequent Select have independent retries, so a committed profile UUID is retained. Pickers run once; I/O/conflict/hard resource errors are not retried. Cancellation, disposal or replaced owner stops waiting.

- RED: `npm.cmd test -- src/features/identity/controller.test.ts --maxWorkers=2` → exit 1, six failing / 17 passing tests (`task3/identity-admission-red.log`).
- GREEN: same command → exit 0, 23 passing tests (`task3/identity-admission-green.log`). Added busy-before-create, fresh revisions/stable operation IDs, busy after committed creation without a second Create, each native metadata mutation, picker-once, cancel/retired-owner/disposal and no I/O/conflict retries.
- Affected identity/project/profile/admission suites → exit 0, six files / 64 tests (`task3/identity-admission-affected.log`).
- Full frontend → exit 0, 83 files / 685 tests (`task3/frontend-final-4.log`).
- Typecheck first exposed zero-argument fake inference in the new call-argument assertions (`task3/typecheck-final-4.log`, exit 2); typed Create/Select mocks against ProfileCommands, then typecheck passed (`task3/typecheck-final-4-retry.log`, exit 0) and all 23 focused tests passed again (`task3/identity-admission-typed-fixture.log`). This typing repair does not change runtime behavior.

The final scenario restores creating B in the active NAS project and switching back to A, so the repaired boundary is exercised directly instead of retaining the precreation workaround. Native/Rust sources and all existing data versions remain unchanged by these integration fixes.

## Final candidate and acceptance

Final release-profile E2E build: `npm.cmd run tauri -- build --no-bundle --features e2e --config src-tauri/tauri.e2e.conf.json` → exit 0 (`task3/e2e-build-final-identity-admission.log`). This includes the production TypeScript/Vite frontend build. Candidate preserved at `.test-output/examples/e2e-executable/annotator-desktop.exe`, SHA256 `02ac3c22181dde8c5fcfa456a34962a6bfe42f6495ac67639ecd972b79e0d694`. Earlier tested candidates are retained with `before-seek-fix`, `before-focus-fix`, `before-import-dialog-fix` and `before-identity-admission-fix` filenames; the actual previous 0.7.4 executable remains untouched in the original workspace.

`node tests/desktop/examples.test.mjs` with `ANNOTATOR_WORKSPACE_EXE` pointing to that candidate → exit 0 (`task3/desktop-final-run-11.log`, `task3/desktop-aLqjkw/report.json`). All seven checkpoints passed. A prior full passing run is `desktop-Rv3Rde` / final-run-10; the final report also preserves 166 transparent wire observations from before process restart. `desktop-YfC1qa` had already passed live identity switching before exposing the test helper's old-project Save-status wait; native project ID + actual UI adoption waits corrected that test timing issue, without product changes.

Observed final acceptance:

- Owned NAS project A: `N:/精成数据标注/.codex-example-verification-1793103684782`; isolated local project B, profiles and WebViews beneath `task3/desktop-aLqjkw`. No existing user project or running process was attached or modified.
- Ordinary main audio retained its single media/directory count, labelled annotation, Chinese note, private mask and +20 dB monitor; the full native document, organization and local preferences matched after preview. Main audio played again after close. Original main bytes retained SHA256 fidelity.
- Private/shared custom names, filtering, rename, scope copy, add-current, removal and per-row success/missing-file error results passed. Shared original-byte hashes matched the owned fixture; deleting only that external fixture did not prevent preview.
- Six original channel canvases were nonblack and had six different fingerprints. Time zoom, Alt-pan and reset passed. Native output position advanced 0.062 → 0.082 s with 3936 consumed frames. Paused seek reached 1.656 s; both slider requests used `play:false`, then stop/close succeeded.
- Audio and bottom-menu output-device routes, default/refresh, Escape/outside dismissal and stable focus passed. At 1000 px outer width / 984 px inner width, the established 220 px inspector exposed all eight fully fitting, clickable tabs; no horizontal overflow or public frame counters.
- B was created inside A's active NAS project, saw A's shared entries but not private entries, had no rename/remove actions for A and copied an entry into B's own private record. Switching back restored A's private list. B project was empty; reopening A and restarting the owned process preserved both scopes and the full ordinary document/organization.
- Identity admission was exercised without manual UI retries: Create first received busy then succeeded with the same operation ID; the reverse Select also received busy then succeeded with the same ID. No extra UUID was created.

Final actual old-client compatibility: set `ANNOTATOR_PREVIOUS_EXE=D:/Work/annotator/.test-output/recycle-busy-fix/final-e2e/annotator-desktop.exe`, `ANNOTATOR_WORKSPACE_EXE` to the final candidate and `ANNOTATOR_COMPAT_OUTPUT` to the owned Task 3 output; `node tests/desktop/recycle-compatibility.test.mjs` → exit 0 (`task3/compatibility-final.log`, `task3/compatibility-mjrG86/report.json`). Actual 0.7.4 created/saved the project; final 0.7.5 preserved original audio bytes, UUID identity, labels, notes, temporary mask and +20 dB monitor. Reading the empty optional library created neither shared nor private example directories, and no recycle migration file.

Final `node --test tests/desktop/release-suite-registration.test.mjs` → exit 0, two tests (`task3/registration-final-2.log`). Version consistency and `git diff --check` → exit 0 (`task3/version-check.log`, `task3/diff-check.log`). Full 26 historical desktop phases and prior 10k/920 import stress suites were not rerun; the dedicated scenario and full frontend/core/native suites above cover this increment. Normal executable/NSIS/update payload production and delivery are deliberately left to the parent after reviews.

## Limits

No subjective listening, physical native picker, multi-workstation session, installer execution or actual user-data update is represented by automated desktop checks. Normal-build resource/package checks and NAS delivery are the parent's subsequent reviewed packaging task. Existing annotation/project exchange packages intentionally do not carry the optional example library; share the whole project folder for shared examples, while private examples remain local to project and identity.

## Parent completion

Task 3 paired reviews and the full implementation quality review passed. Normal NSIS and update builds, 34-resource/38-entry audits, production startup smoke, and verified NAS test delivery are complete; see ../verification-0.7.5.md and .test-output/examples/delivery/. Failed-run browser caches were retired after preserving reports, screenshots, native profiles and final successful profiles.
