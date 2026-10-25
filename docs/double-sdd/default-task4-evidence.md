# Task 4 — compact default-project frontend

Task base: `37201602dceaaf34bc4d1f4075ecf1bf93a76f12`. This checkpoint changes the frontend and its focused tests only, plus this evidence and the root's pre-existing Task3 plan checkboxes. Native code, versions, protected configuration, desktop suites and release files are unchanged. Raw command output is retained in `.test-output/default-collaboration-v040/task4/`.

## Frontend behavior and protocol

- Shared context/status strictly require the six native capability/catalog fields, reject extra fields and credentials, correlate flavor/identity/write capabilities, and validate hidden UUID uniqueness/count. Context allows a bounded 256 KiB so all 4096 hidden UUIDs fit. Status/open results also validate hidden membership when a document is available. Legacy fixtures explicitly carry legacy capabilities.
- Create/open/Save As/exchange accept the native default project and automatic local author. The file picker says “打开项目”; the file menu includes explicit “只读打开项目…”. Default projects enable direct/folder import from the file menu, toolbar, sidebar and empty state. Only old ordinary projects offer conversion. Conversion starts without an account form; project registration/login remain optional. Default menus omit guest publication, and logout means return to the local author.
- Normal Save As always calls `save_project_as_controlled` with a fresh caller operation UUID and a required Channel. Its compact dialog shows phase-appropriate progress and cancellation. Target-copy cancellation/errors remain outside the source lifecycle's save-failure ledger; already-existing source failures remain owned by that lifecycle. Source owner/snapshot remain active on cancelled copies.
- `sourcesRequired` is a terminal exchange event. The import dialog retains the source digest/requirements and per-media file bindings without adopting a project. Continuation submits fresh task/Channel/current expected-owner data; wrong media and changed exchange source stay correctable. Choosing another exchange restarts preflight. Cancel clears association, and only native completed results adopt the new default project.
- Catalog update uses the existing draft/save transition barrier. Background refresh is suspended, and the returned status is accepted only after its new snapshot is installed. Same-nonce transitions retain the `ActiveProject`, its adapters, selections and playback ownership; unchanged revision/history also retains the snapshot reference. Background polling never installs a document.
- Hidden IDs come from the latest controller status, separately from the project document. Sidebar, both pane selectors, comparison menu and fallback selection filter them. Hiding a selected medium clears its region/context selection. Compact per-item restore stays in the sidebar. Annotation/mask/foreign Locate first unhides its target through native status and then selects it. Public document/annotation/export data are never filtered.
- View-only disables public annotation/category/file/channel controls and their underlying renderer actions, including region menus and the floating toolbar. Private masks, playback, settings and private history remain available; native remains the final authority. Help text describes automatic authors, account portability, catalog update, private hiding and copied media.

## Admission and Ready ownership

`src/bridge/admission.ts` retries only `ResourceLimit` with `details.operationBusy === true`. It never retries hard capacity/byte limits. Factory retries are bounded to 100 attempts with 100 ms spacing; matching-owner status waits share a 10-second deadline. Cancellation/stale ownership is checked before each attempt. Channel-producing operations rerun the outer bridge factory, constructing a fresh Channel every time. This includes media preparation, controlled Save As, legacy conversion and exchange start. Media preparation uses the separate native busy signal without assuming `Status.busy` covers its lifetime.

Controller suspension is registered by lifecycle identity in a WeakMap, never by mutable global nonce. Accepted media publications, including global queue Retry, suspend refresh and wait for the current owner's publication permit. Suspension does not wait on a manual sync that may itself be waiting for the accepted edit, avoiding a save/import dependency cycle. Identity/catalog/exchange/copy paths wait for already scheduled publishers; create/open retries accommodate retiring workers.

Ready publication retains the original queue command/descriptor/UUID. A native error with `catalogCommitted`, `catalogAdoptionRequired` and the matching media ID becomes **accepted, adoption pending**, counts as accepted, and retains its retry ledger. Retry and End retry adoption of that same Ready instead of decoding again or discarding a durable item. Confirmed success calls `release_media_import(taskId,mediaId)`; global Retry success is reconciled against the snapshot and acknowledged too. A release service error leaves the item successful with a visible acknowledgement retry, never a failed audio import. Uncommitted abandonment still requires successful release before discarding the ledger.

## Executed RED / GREEN

- `defaults-red.log`: the new native context was rejected and default media imports were disabled (2 failures). Strict capability parsing/menu changes passed in the later focused and full runs.
- `admission-red.log`: missing retry helper import. `ready-green.log` and later runs verify structured busy-only retries, cancellation and a bounded retry count. One intermediate test exposed an unnecessary microtask before first preparation invocation; the helper now preserves synchronous first admission.
- `ready-red.log`: durable acceptance was incorrectly shown as failed, and global Retry never acknowledged Ready. `exchange-green.log`: media/exchange suites passed after retaining accepted state and releasing confirmed capabilities.
- `exchange-red.log`: sources-required metadata was absent from the import UI. `exchange-green.log`: 19 tests passed across media/exchange. Added tests also cover wrong association, changed-source preflight restart, successful default adoption, task acknowledgement ordering and cancellation.
- `private-red.log`: view-only note controls remained editable and hidden media remained selected. `capability-regressions.log`: 59 tests passed across default capabilities, folder import, region menu and floating toolbar; the additional hidden primary/comparison selection test passes in `exchange-hidden-regressions.log`.
- `release-red.log`: failed acknowledgement lacked a retained visible retry. `release-green.log`: 34 media/folder tests passed, including global Retry/End ordering, accepted adoption failures and service-release failure recovery. Added folder coverage confirms release errors do not classify successful files as failed.
- `copy-ledger-red.log`: cancelling a target copy polluted the saved source lifecycle's error ledger. `copy-ledger-green.log`: all 27 project lifecycle/shared lifecycle tests passed after isolating target-copy failures.
- `transport-regressions.log`: 17 tests passed, including distinct Channel objects on busy media/copy/exchange retry and successful progress/terminal delivery, controlled copy cancellation and same-nonce owner preservation.
- `catalog-barrier.log`: 13 tests passed, including explicit catalog draft/save ordering, suspended polling, same-owner adoption, hard ResourceLimit refusal, identity cancellation and legacy conversion.

Earlier full-suite output is retained: `frontend-first.log` exposed seven outdated fixture/label/acknowledgement assertions; `frontend-second.log` passed 373 tests before the additional regressions. An intermediate typecheck found test-only generic/optional-argument/Testing Library typing errors; they were corrected before final verification. Final counts exclude accidentally re-executed imported test helpers from an early focused run.

## Final verification

- `npm.cmd run typecheck`: passed, exit 0 (`typecheck-verified.log`); the final build reruns the same check after the last copy-ledger change.
- `npm.cmd test`: **381 passed, 48 files passed**, exit 0 (`frontend-verified.log`).
- `npm.cmd run build`: passed, exit 0 (`build-verified.log`), including TypeScript checks and production Vite compilation. Vite retains the existing large generated third-party-notices chunk warning; no dependency/release changes were made to suppress it.
- `git diff --check`: passed, exit 0.

No Task4 native code changed, so native verification remains the Task3 evidence rather than a claimed rerun. Real Windows dialogs, two-process desktop acceptance, production binary smoke, NAS and release/version work belong to Task5. No push or main merge was performed. This implementation checkpoint is ready for the root's paired review.

## Task4 review fix — retained acknowledgement recovery

Following checkpoint `abd284cd94a7b4b6a9478ac7b4a2354d1ddfb5ab`, the paired spec review passed and quality review reported a confirmed acknowledgement leak. Original TaskBase remains `37201602dceaaf34bc4d1f4075ecf1bf93a76f12`. Applied the systematic-debugging skill and the code-review feedback evaluation guidance; the root owns the fresh paired review dispatch.

Root cause: a failed `release_media_import` correctly retained a successful item's original task/media pair in the controller's `retained` set. Starting another import replaced `items`, while `retry(items)` visited only that displayed/scoped array. Earlier successful capabilities could therefore remain unreleased even when the recovery action was clicked. Folder result replacement and direct-to-folder switching had the same mismatch. Result dismissal also hid the only acknowledgement control.

The fix adds a controller-wide successful-acknowledgement sweep. Normal `retry(items)` runs it before handling the caller's scoped failed edits; its failure replay remains scoped. A separate acknowledgement-only action performs no queue refresh, apply, decode, or failure discard. Existing End/abandonment remains scoped. A compact transient `ImportAcknowledgements` control now mounts independently of direct/folder result panels, uses the retained entries rather than the latest result array, and disappears when they are acknowledged. Dismissing or replacing result panels cannot hide recovery. The control does not display during normal successful acknowledgement and is disabled while import/recovery is active.

Observed verification:

- `review-ack-red.log`: **4 failed, 37 passed**. Reproduced the missing original-pair release after a second direct import, second folder import, and direct-to-folder switch; the independent acknowledgement control was also absent. The folder-to-direct scoped path already passed and is retained as a regression.
- `review-ack-green.log`: **41 passed** after the controller-wide sweep and independent control.
- `review-ack-scoped.log`: **44 passed**, including eight new regressions across both media suites. They verify original task/media release without another apply/decode; direct/folder switching; 257-file folder batches; dismissal/replacement/End visibility; and acknowledgement-only Retry preserving another failed edit and scoped End ownership.
- `npm.cmd run typecheck`: passed, exit 0 (`review-typecheck.log`).
- `npm.cmd test`: **389 passed, 48 files passed**, exit 0 (`review-frontend.log`).
- `npm.cmd run build`: passed, exit 0 (`review-build.log`), including repeated TypeScript verification. The same existing notices-chunk warning remains.
- `git diff --check`: passed, exit 0.

This fix changes only the media acknowledgement controller/control, its AppShell placement, focused tests and this evidence. No native, Task5, version, release or protected files changed.
