# Configurable import Task 3 frontend evidence

Task base: `f67ca29647a867fb0194bff6d7b31281745d65b3`.

## Implemented

- Strict source-import IPC validators and runtime-bound client match Task 2 camelCase token, event, page, candidate, issue and batch payloads. Media progress accepts the native `extract` phase. Scan callbacks are installed before invoke, and both early events and acknowledgements carry checked project/runtime identity.
- Shared folder/ZIP dialog offers source selection, local presets, recursion, supported extensions, collapsible newline/comma/semicolon path rules and the Jingcheng second-route option. Scans stop at a 50-row paginated preview. Import requires the explicit count-labelled action. Preview issues are bounded by the native 256-detail limit.
- Source controller owns the existing media reservation through configuration, preview and import. It uses a narrow per-run start adapter on `MediaImportController`; descriptors, queue publication, retry/discard and native acknowledgements stay in the existing controller. Indices are mapped from each batch's local event index to original preview indices. Batches are at most 256 and wait for native start/terminal plus accepted publication barriers. Publication or acknowledgement failures pause the next batch, including failures arriving during page retrieval.
- Rules and source choices survive recoverable scan errors. Editing rules retires the previous generation and releases its preview. Failed preview releases retain their exact tokens, including late acknowledgements from an older generation while a newer preview exists. Retry never substitutes the new token. Closing cancels the admitted media run and releases discovery, while pending publication/acknowledgement controls remain accessible.
- The existing media release ledger now also retains unused late Ready results whose cancellation cleanup release fails, and releases rejected-before-admission Ready results through the same acknowledgement path. These have a release-only flag; retry does not publish them. The shared confirmation panel describes release confirmation without claiming these unused results were imported.
- Presets are validated local-only rules, at most 32 custom entries and 64-character names. Builtin IDs cannot be overwritten or deleted; returned preset values are copies. Corrupt/unavailable storage retains usable defaults and a visible error. No source paths are serialized.
- File menu uses the new folder and ZIP flow. Existing direct/relink, old folder bridge/controller and legacy `useMedia.chooseFolder` remain for protected callers/tests; the visible menu uses `chooseSourceFolder`. Configurable entries are disabled for unsupported project flavors.
- Structured media names show record identity plus a nonshrinking filename. Full names remain in search, button `aria-label` and `title`; ordinary filenames retain their prior visible text/ellipsis presentation.

## Verification

Logs: `D:/Work/annotator/.test-output/configurable-import/ui-*.log` (outside checkout).

Observed RED/GREEN cycles:

- `ui-red.log` / `ui-bridge-green.log`: source bridge and preset modules absent, then strict native shape/rule and local-store tests passed.
- `ui-controller-red.log` / `ui-controller-green2.log`: controller absent, then early preview/no automatic import, 257 sequential imports, rule invalidation, failed preview release, acknowledgement pause/retry and disposal passed. Initial GREEN attempt exposed a test deadlock because retry waited for the newly resumed import to finish; retry now returns after dispatching continuation.
- `ui-view-red.log` / `ui-view-green.log`: dialog absent, then rule/second-route controls, multiple paths, explicit preview action and structured media identity tests passed.
- `ui-lifecycle-red.log` / `ui-lifecycle-green.log`: late start rejection incorrectly changed cancellation to failure, and late progress overwrote final counts. Both reproduced and fixed with generation/state guards.
- `ui-late-release-red.log` / `ui-late-release-green.log`: cancelled late Ready cleanup failure had no retained retry capability. The shared release-only ledger fix passed along with direct and legacy folder tests (63 focused tests).
- `ui-retired-red.log` / `ui-retired-green.log`: retry substituted a newer preview token after an old acknowledgement's release failed. Exact retired-token retention now passes.
- `ui-storage-red.log` / `ui-storage-green.log`: unavailable localStorage accessor error was cleared by a later no-op persist. Persist now preserves an explicit storage failure.
- `ui-page-barrier-red.log` / `ui-page-barrier-green.log`: an unrelated publication failure arising during the next page fetch allowed the batch to start. Rechecking barriers after the await now pauses it.

Additional tests cover source-change failure without publication, ResourceLimit retry retaining config, bounded preview paging and stale pages, custom preset save/delete, invalid/corrupt persisted values, the 32-preset bound, native extract payload and runtime-bound bridge arguments. Expanded cases were added after foundational implementation; not every expanded case has an individual RED implementation cycle.

Final frontend suite: `npm.cmd test` — 51 files, 415 tests passed (`ui-tests-final.log`). Standalone `npm.cmd run typecheck` passed (`ui-typecheck-final.log`). Production frontend `npm.cmd run build` passed, including another typecheck and 2,072 transformed modules (`ui-build.log`); the main bundle is 505.20 kB before gzip. `git diff --check` passed (only the existing Windows LF-to-CRLF advisory for the edited CSS file).

## Task 4 handoff

- Desktop selector for structured imported audio: use `.media-select[aria-label="<full native displayName>"]` or its `title`; `.media-select strong` intentionally contains compact record/filename text. Ordinary direct filename text remains unchanged.
- Dialog role/title is `导入文件夹` or `导入 ZIP 音频`. Picker controls: `选择文件夹…` / `选择 ZIP…`; scan: `扫描预览`; final action: `导入 N 个音频`. Existing folder desktop tests must add the scan/explicit-import steps. Native legacy folder API tests remain valid.
- No Rust, release version, desktop suite, NAS data, installer or production executable changes were made by Task 3. Native desktop/compact visual acceptance and actual ZIP/folder fixture flows remain Task 4. The frontend production build emits its bundle-size advisory; no code splitting or dependency changes were added to this scoped task.
- Paired spec/quality review is pending with the parent orchestrator.

## Spec review correction: shared recovery reservation reconciliation

Spec review found that a source batch paused on a native acknowledgement failure could be cancelled, recovered through the shared `重试导入确认` button, and dismissed while leaving the media reservation occupied. The source subscription only rerendered, so recovery outside its own retry method never returned the reservation.

Added three regression cases before the correction. `ui-reservation-red.log` confirms failures for the exact shared-button/dismiss/new-import path, project-wide publication retry, and dismissal during an accepted publication still pending after preview release. The source controller now reconciles reservations on media-controller notifications and before terminal dismissal. Reconciliation requires terminal state, no media batch activity, no preview or failed/retired release capability, and no publication/acknowledgement recovery outstanding. It clears its local ownership flag before notifying the media controller, preventing reentrant ownership checks from releasing twice. Active configuration/preview/import states retain their reservation.

Post-correction verification:

- Focused source/direct/legacy-folder tests: 65 passed (`ui-reservation-green.log`).
- Full `npm.cmd test`: 51 files, 418 tests passed (`ui-reservation-full.log`).
- `npm.cmd run typecheck`: passed (`ui-reservation-typecheck.log`).
- `npm.cmd run build`: passed, with the same bundle-size advisory; main bundle 505.29 kB (`ui-reservation-build.log`).
- `git diff --check`: passed. No native or adjacent feature changes.

Paired review must be rerun from the original Task 3 base after this checkpoint.
