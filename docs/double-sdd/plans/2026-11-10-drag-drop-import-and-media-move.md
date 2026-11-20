# Drag-and-drop import and media move Implementation Plan

> **For agentic workers:** REQUIRED: Use the `subagent-driven-development` skill to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Import audio, archives, and folders dropped from Windows Explorer, and move one or multiple project audio records by dragging them in the directory tree.

**Architecture:** Preserve the existing import controllers and catalog format. Native Tauri file events are classified and session-bound before reuse of direct or previewed import; pointer gestures handle internal tree movement through one atomic shared-organization operation. Project session, folder layout, authorization, and recycle status are checked at the existing native commit boundaries.

**Tech Stack:** React, TypeScript, Tauri 2, Rust, Vitest, Cargo, Windows desktop integration tests.

---

## Shared requirements and implementation boundaries

Read `docs/double-sdd/specs/2026-11-09-drag-drop-import-and-media-move-design.md` before every task. Preserve all existing source changes from the captured workspace baseline; use only an isolated worktree and a dedicated test project. Never mutate an actual NAS project during tests. Do not change organization/catalog disk formats, existing IPC requirements, single-item menu behavior, audio IDs, labels or notes. Existing UI copy, import limits, presets, cancellation, progress and errors remain authoritative unless the specification says otherwise.

File map:

- `crates/annotator-core/src/collaboration/organization/{model,validation,repository}.rs`: new batch operation, atomic validation/publication and recycle checks.
- `crates/annotator-core/tests/organization.rs`, `src-tauri/src/commands/organization/tests.rs`: transaction, race and compatibility regression coverage.
- `src/bridge/organization.ts` and `src/bridge/organization.test.ts`: validated batch operation wire contract.
- `src-tauri/src/commands/drag_drop.rs`, `src-tauri/src/commands/{mod,media,source_import}.rs`, `src-tauri/src/{state,lib}.rs`: native source classification, session binding and optional initial layout capture.
- `src/bridge/{media,sourceImport}.ts`, `src/features/media/{imports,sourceImport}.ts`: reuse existing jobs while propagating a captured native session and initial scan layout.
- `src/features/media/{MediaList,MediaRow,MediaBatch}.tsx`, `src/features/media/organization.ts`, `src/app/{App,AppShell}.tsx`, `src/styles/layout.css`: external event handling, target feedback, pointer interaction and conflict/retry UI.
- Relevant adjacent Vitest files and `tests/desktop/media-folders.test.mjs` / `tests/desktop/source-import.test.mjs`: interactions and integration regression coverage.

## Task 1: Atomic batch organization move

**Files:** `crates/annotator-core/src/collaboration/organization/{model,validation,repository}.rs`, `crates/annotator-core/tests/organization.rs`, `src-tauri/src/commands/organization/tests.rs`, `src/bridge/organization.ts`, `src/bridge/organization.test.ts`.

- [ ] Write transaction tests for a batch crossing folders, a mix already at target, all already at target, invalid/duplicate/missing IDs, missing target, stale revision, latest recycle state without a revision change, and definite pre-publication failure. Assert no partial updates or version changes on rejection/no-op; both revisions increase once for a real move. An uncertain post-publication response requires client reconciliation, not an assumption that publication failed. Test existing single-move/recycle behavior separately.
- [ ] Run `cargo test -p annotator-core --test organization` and verify the new tests fail before implementation.
- [ ] Add a distinct operation with the exact wire shape `{ type: 'moveMediaBatch', mediaIds: string[], folderId: string | null }`; reject empty, duplicate or more than 10,000 IDs. Under the existing catalog lock, validate authority, revision, target, every membership and fresh recycle head before any write; publish exactly one new head or return the validated existing head for a no-op. The no-op path must also perform the final native session/authority check before returning; cover a session replacement while that request waits. Preserve old `moveMedia` semantics.
- [ ] Extend the strict frontend operation parser and its tests for accepted/rejected shapes.
- [ ] Run `cargo test -p annotator-core --test organization`, `cargo test -p annotator-desktop organization`, and `npx vitest run src/bridge/organization.test.ts src/features/media/organization.test.ts`; expect success. Checkpoint only this task for paired spec/quality review.

## Task 2: Safe native drop classification and import session capture

**Files:** `src-tauri/src/commands/drag_drop.rs`, `src-tauri/src/commands/{mod,media,source_import}.rs`, `src-tauri/src/{state,lib}.rs`, `src/bridge/{media,sourceImport}.ts`, `src/features/media/{imports,sourceImport}.ts`, adjacent native and frontend tests.

- [ ] Add failing native tests for audio groups, ZIP groups, one directory, share bundles, mixed/unsupported/missing/unreadable/over-limit paths, and old session rejection after close and reopening the same project UUID. Cover both normal and shared projects, expected target revision, readonly and import contention.
- [ ] Provide a native runtime session token for the current open project and classify submitted paths on a blocking worker, checking the project ID, token, capability and session again before returning. Use existing path policies and limits, reject malformed mixtures as a whole, and return a typed source kind. Keep the UI responsive during filesystem I/O.
- [ ] Reuse the existing direct-import request with its optional runtime token for backwards compatibility, but supply the captured token on every drop-initiated import, including ordinary projects. Test a session replacement after preflight and before task admission. A normal non-shared project must omit `DirectTarget` (its importer has no shared organization); a writable shared project supplies the frozen folder and layout revision. Extend source-scan admission with an optional expected layout revision, checked against the placement captured for the first scan without saving it to presets or changing the existing callers. Explicit user rescans use the refreshed layout. Retain existing reservation, progress, error and cancellation behavior.
- [ ] Test stale target/layout between drop and first scan, explicit rescan, and cancellation without project writes. Run `cargo test -p annotator-desktop drag_drop`, `cargo test -p annotator-desktop source_import`, `npx vitest run src/bridge/sourceImport.test.ts src/features/media/sourceImport.test.tsx src/features/media/import.test.tsx`, and `npm run typecheck`; expect success. Checkpoint for paired review.

## Task 3: Desktop drag interactions and integration

**Files:** `src/features/media/{MediaList,MediaRow,MediaBatch}.tsx`, `src/features/media/organization.ts`, `src/app/{App,AppShell}.tsx`, `src/styles/layout.css`, adjacent Vitest and desktop tests, plus small focused modules if needed.

- [ ] Write failing interaction tests for ordinary clicks versus pointer threshold; dragging checked versus unchecked rows; root/folder target, no-op, Escape, lost capture, blur, readonly/recycle view, selection and focus. Capture project session and organization revision at drag start: test a remote revision change before release rejects the original attempt and requires explicit retry, including when the other session already moved all IDs to target. Test reconciliation when publication succeeded but its response was lost, and when refresh itself fails. Test external enter/over/leave/drop, physical-to-CSS coordinate conversion, the actual folder under release after crossing targets, the workspace fallback to the selected folder or root, project switch including close/reopen of the same UUID during delayed preflight, modal/busy admission and the three source kinds. Verify direct audio drop succeeds in a normal project.
- [ ] Handle Tauri WebView native file events; bind the active project/session at enter and freeze the hit-tested target plus layout revision on drop. On owner changes invalidate the gesture and reject remaining over/drop events until a new native enter. Pass validated audio to the existing direct importer, omitting the target in normal projects; pass ZIP/folder to the existing preview with auto-scan and confirmation. Verify actionable rejection messages for no project, switching projects, modal/busy/readonly states, and ZIP/folder on an ordinary project requiring a writable shared project. Do not enable HTML5 file drag-and-drop in place of native Tauri events.
- [ ] Implement tree pointer gestures separately from OS drag, using capture and coordinate hit testing. A checked row snapshots all checked IDs; an unchecked row snapshots only itself. Record the current organization revision and project session at drag start. Highlight valid target and count. Submit the batch once with that revision. On conflict or uncertain result, retain IDs and target, refresh, and verify the same session, target existence, all source IDs, current target memberships, and fresh recycle state before any explicit retry. Require explicit per-request success for both organization and recycle reads, rejecting errors, superseded reads and foreign-session results; current refresh methods swallow errors and retained snapshots must not qualify as fresh. If either refresh fails, block retry. For an uncertain outcome only, if all IDs are already at target treat the move as completed; a definite revision conflict always remains for user review and explicit retry. On success expand destination ancestors and focus its row; retain audio selection and existing sorting.
- [ ] Run `npx vitest run src/features/media/organizationTree.test.tsx src/features/media/organization.test.ts src/features/media/sourceImport.test.tsx src/app/listWorkflow.test.tsx`, the new interaction tests, `npm run typecheck`, and relevant desktop folder/source import tests. Verify ordinary menu import, single-item move and multi-export regressions. Checkpoint for paired review.

## Task 4: Integrated acceptance and handoff

- [ ] Run the full applicable Rust and frontend suites plus Windows desktop tests on isolated, disposable fixtures. Exercise real Explorer audio/ZIP/folder drags at normal and high DPI where Windows test access permits; if unavailable, state the exact unverified acceptance rather than claiming it passed.
- [ ] Run a two-session test covering organization conflict, deleted destination, recycle-only change and a failed atomic publish. Confirm no migration and intact labels/IDs.
- [ ] Request full-range quality review. Integrate only the feature delta onto the original recorded workspace while preserving its pre-existing tracked and untracked changes and staged state. Run focused checks again after integration. Do not retain temporary checkpoint commits in the user's branch history.
