# Configurable import Task 2 native contract and evidence

Task base: `73d5048017309e4a2b9c02837016c4f392c585b6`.

## IPC for Task 3

All JSON property names below are camelCase. Commands are registered in the Tauri handler.

- `scan_import_sources({ runtimeNonce, projectId, config, onEvent }) -> Token`.
  `config` is the core Config: `{ kind: "folder" | "zip", paths: string[], rules: { mode: "generic" | "jingcheng", recursive: boolean, extensions: string[], include: string[], exclude: string[], includeSecond: boolean } }`.
- `import_source_page({ token, offset, limit }) -> { candidates, issues, counts }`. Limit 1–256; offset 0 through candidate count inclusive. Issues contains the same bounded first 256 issue details on each page, not an unbounded archive log.
- `cancel_import_source_scan({ token }) -> null`. Cancels discovery or invalidates further preview use; retain token until release. Cancellation terminal event is `failed` with `error.code: "Cancelled"`.
- `release_import_source_scan({ token }) -> null`. Drops preview and cancels scan; idempotent within the same runtime, including an old release retry after a newer preview has started. A stale runtime/project still returns RevisionConflict. Release does not delete accepted/prepared media and does not cancel an already admitted media batch.
- `import_source_batch({ token, indices, onEvent }) -> taskId`. Indices must be unique, 1–256 items, each inside the immutable preview. No caller path or name is accepted. Native MediaEvent protocol and existing cancel_media_import/release_media_import are unchanged.

`Token = { runtimeNonce: string, projectId: string, taskId: string }`. Scan task ID is a native random UUID, distinct from every media batch task ID. Carry the whole opaque token; verify token runtime/project before accepting an early event. Start acknowledgement and events can race. The event token is sufficient to fetch the page before start acknowledgement arrives; delayed events must still respect the frontend run generation.

Scan events:

```ts
{ type: "progress", token, counts }
{ type: "result", token, counts }
{ type: "failed", token, error: AppError }
```

`Counts = { checked, candidates, skipped, issues, selectedBytes }` (nonnegative bounded integer numbers). Progress is throttled to 100 ms. Final result counts are authoritative: folder exclusion can lower final candidates/selectedBytes compared with progress. Scanning does not publish media.

`Candidate = { index, sourceIndex, sourceName, relativePath, displayName, byteLength, logicalPosition }`, where `logicalPosition` is a number or null (the field is present). All paths/display names in candidates are native derived; no local staging paths are present. `Issue = { sourceIndex, relativePath, message }`.

Batch MediaEvent.index is batch-local, so map via `submittedIndices[event.index]` to original preview index. Ready.descriptor and catalog record have the same native displayName. Progress/failed.path uses that displayName. Additional phase `extract` precedes existing decode/hash/copy phases. Never construct or modify a Ready descriptor in the UI. Publish it through the existing importMedia change and acknowledge with release_media_import; keep the existing retry/discard/failure ledger and wait for publication/release barriers before advancing batches.

Closing/rescanning releases the old preview. Closing during import must also invoke existing cancel_media_import for the admitted batch and retain pending publication/retry/release affordances. The native preview release intentionally cannot destroy a prepared lease. Reset/actor/project replacement retires previews, cancels workers and invalidates prepared results. New direct import/relink is rejected while a preview exists; media admission also prevents overlapping source batches/direct workers. Frontend should reserve its import controller for the full choosing/scanning/preview/import workflow.

Only writable default format-2 projects support this configurable workflow. Legacy ordinary and legacy shared/read-only projects are rejected before source I/O; existing ordinary direct import still works. For folders, exact canonical current catalog source paths are skipped before publishing preview and candidate indices are rebuilt. Source copies at other paths and ZIP repeated exports are never deduplicated by content or record ID.

## Ownership and implementation

Runtime Service owns one bounded Registry; install/retire reset it. The host snapshots project/runtime authority, traverses/stages without authority locks, and rechecks before exposing results. Immutable ScanResult remains pinned for admitted batches even when preview is released. Pending catalog media holds an Arc bundle containing both PreparedCatalogMedia and optional StagedAudio. Publication clones the bundle, so even concurrent release cannot drop the extraction source before final catalog checks. Existing deferred disposal releases both leases after publication/retry/acknowledgement. Native registry adopts the final durable media path. No staging path is persisted in project/catalog files.

Small core additions: validated PreparedCatalogMedia.with_display_name updates both pending descriptor and catalog identity before Ready; ScanResult.exclude_folder_paths excludes validated exact folder paths and reindexes entries and candidates atomically.

## Verification record

Logs are outside the checkout at `D:/Work/annotator/.test-output/configurable-import/host-*.log`.

- RED `host-red.log`: first native test could not compile because the source-import API was absent. GREEN `host-green.log`: ownership, bounded pagination, stale runtime and direct exclusion test passed.
- `host-integration.log`: two initial test-harness failures attempted to reopen while the current project was still open; corrected the test to close/retire first. The production open contract was unchanged.
- `host-integration2.log`: eight native integration tests passed, including 257 ZIP candidates in two batches.
- RED `host-exclusion-red.log`: exact already-used folder source appeared in preview. GREEN `host-exclusion-green.log`: skip exact project media path, preserve same bytes at original path and two independent ZIP entries.
- RED `host-release-red.log`: repeated release acknowledgement returned RevisionConflict. Final library tests exercise its fix and prove an old release cannot retire a newer preview.
- Acceptance tests cover real generated ZIP -> Ready -> catalog import backend (the backend used by apply_change; this task does not exercise its wrapper) -> retryable publication admission failure -> retry -> release -> save/reopen, source archive removal, staging removal, durable registry source and original-byte comparison/decode. Other tests cover no preview publication, early event correlation without held project/registry locks, cancelled scan, disconnected scan/media channels, source-change rescan errors, invalid/duplicate/oversized indices, legacy/read-only rejection with preserved legacy direct import, in-flight preview release, and stale worker/accepted Ready results.
- Expanded acceptance tests were added after the foundational implementation; the initial missing-API test, exact-path exclusion, and idempotent release fixes have observed RED/GREEN evidence. No claim is made that each expanded acceptance case was individually implemented test-first.

Final checks:

- `cargo test -p annotator-desktop --lib`: 58 passed (`host-lib.log`).
- `cargo test -p annotator-desktop --features e2e --lib`: 59 passed (`host-e2e-lib.log`).
- `cargo test -p annotator-core --test import_source`: 14 passed, 1 ignored real-NAS test (`host-core-regression.log`).
- After adding explicit durable-registry/save assertions, `cargo test -p annotator-desktop --lib source_import`: 12 passed (`host-final-source.log`).
- `cargo fmt --all -- --check`: exit 0 (`host-fmt.log`).
- `cargo clippy --workspace --all-targets -- -D warnings`: exit 0 (`host-clippy.log`).

One interim test build overlapped the already-running Windows library test executable and failed to replace its locked EXE (LNK1104); rerunning after that test process exited produced the expected RED assertion. No unknown process was stopped. One intermediate fmt check caught the newly added save/registry assertions; formatting was applied and the final check passed.

A released/cancelled scan may still be draining its filesystem worker. Until that worker exits, shared MediaTasks admission can return ResourceLimit to an immediate new scan; preserve rules/source choice and allow rescan. Normal preview rescan occurs after the scan worker finished. Source-change failures use IdentityMismatch and the native rescan message.

Paired task review is pending with the parent orchestrator. No UI, production build, installer, or real NAS native-import verification belongs to this task; Task 4 covers those checks.

## Paired-review preparation admission correction

Spec review passed. Quality review identified that media preparation admission remained held until the worker closure returned, although Finished had already been emitted. A synchronous Finished callback beginning the next source batch deterministically returned ResourceLimit even when every previous item had failed and no publication was pending.

Added `finished_callback_can_immediately_start_next_source_batch`: invalid audio yields two all-failed batches, and the first terminal callback synchronously admits the second. There are no sleeps or disposal waits. RED `host-terminal-red.log` captured ResourceLimit with operationKind=mediaPreparation. The worker now explicitly drops its preparation permit after MediaTasks.finish and before sending Finished.

Post-fix checks:
- `cargo test -p annotator-desktop --lib source_import`: 13 passed (`host-terminal-green.log`).
- `cargo test -p annotator-desktop --features e2e --lib source_import`: 13 passed (`host-terminal-e2e.log`).
- `cargo fmt --all -- --check`: exit 0 (`host-terminal-fmt.log`).
- `cargo clippy --workspace --all-targets -- -D warnings`: exit 0 (`host-terminal-clippy.log`).

The IPC contract is unchanged; Finished now correctly releases worker admission before the consumer can observe it. Earlier cancelled-scan draining behavior is separate and unchanged.
