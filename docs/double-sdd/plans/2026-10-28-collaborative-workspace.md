# Collaborative Workspace Implementation Plan

> **For agentic workers:** REQUIRED: Use the `subagent-driven-development` skill to implement this plan. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Resolve the requested workspace/collaboration issues and add personal flat display and unified read-only inspection while preserving deployed projects.

**Architecture:** Keep catalog adoption inside lifecycle/admission boundaries, preserve foreign author isolation and add local UI records. An owned transient preview session isolates read-only inspection analysis/playback. Evaluation/reannotation is deferred by the user. Diagnose playback with native counters and browser timing.

**Tech Stack:** React, TypeScript, Tauri/Rust, Vitest, native tests, isolated Windows WebDriver.

Spec: `docs/double-sdd/specs/2026-10-28-collaborative-workspace-design.md`.

Integration anchor: main branch `codex/project-examples-toolbar`, immutable base `47e2f0a2caa650a20e690b99b4cc7a3bdddb4e4f`. Execute sequentially in `D:/Work/annotator/.worktrees/collaborative-workspace-078`, branch `codex/collaborative-workspace-078`. Worktree checkpoint commits are temporary; final integration is one squash. Do not modify the running user app or actual NAS project. Do not change paused import/dedup code or category governance. Flat means the left list. Evaluation/reannotation is explicitly deferred by the latest user decision; this supersedes the earlier live-follow choice. Tasks 1–4 retain their independently reviewed scope.

Verified checkpoints: Task 1 at `97a7c4e84f1fe979514a460fa4d9295db98a5cc8`, paired reviews PASS and actual Windows tree geometry/navigation PASS. Task 2 at `deb2f2fe5438f29e3ce7504f8907b705eaea0488`, paired fresh reviews PASS; affected 400 tests and typecheck PASS, root independent 65 plus 69 tests PASS. The combined two-client append/trash/restore scenario remains Task 10.

Task 3 at `4bb6da74b496168381e26c9e1de630743e27eaf1`, paired reviews PASS, 90 project/app/cue tests plus 152 related regressions PASS; actual persisted-profile relaunch remains Task 10. Task 4 at `a80d66edc0a173b4214a35f0425da55ce73dffa5`, paired reviews PASS, 68 playback tests and root 105 focused regressions PASS. Real Windows baseline/candidate runs used 877 media, own Authors entries, mono/six-channel mask and gain workloads, matching numeric probes/settings and adequate playing-duration guards. Visual frame p95 improved to about 16.7 ms; no acoustic fix is claimed. See `docs/evidence/2026-10-28-collaborative-workspace/task4-playback.md` for measured limits.

Baseline verification: run `npm run typecheck` and affected existing collaboration/media tests before edits. Node dependencies are a junction to the main checkout. Use owned test output under `.test-output/collaborative-workspace/` and preserve RED/GREEN evidence. Native builds use an explicit external CARGO_TARGET_DIR, never overwrite the normal production executable with an E2E build.

## Task 1: Correct the tree disclosure gutter and include the current author

Latest scope decision: evaluation/reannotation is deferred. No linked replies, copied regions, review states or history UI are added. Continue the independently requested workspace, read-only inspection and local visibility improvements.

Ownership: `src/features/media/MediaList.tsx`, `src/styles/layout.css`, `src/features/collaboration/{RemoteInspector,remote}.tsx` (remote is `.ts`), related tests. Split a small presentation helper if needed; do not refactor unrelated inspector code.

- [x] Add failing geometry-independent structure tests for a consistent file disclosure gutter and a fixture geometry check in the existing desktop tree suite; add own-author tests covering no published layer, acknowledged local annotations and current notes/categories.
- [x] Run focused Vitest tests and preserve failures.
- [x] Add a compact reserved disclosure slot to nested file rows so their icons are unambiguously right of the containing folder label. Keep single indentation owner, 28px row height and truncation. Include the current actor using a synthesized snapshot of the current document, marked “我”; exclude stale published self layer and avoid duplicate self entries. Keep other-author layer validation unchanged. Own entry inspection resolves current own data safely.
- [x] Run affected tests, typecheck and `git diff --check`; checkpoint for paired reviews.

Commands: `npm test -- src/features/collaboration/remote.test.tsx src/features/media/organization.test.ts src/features/media/organizationTree.test.tsx --maxWorkers=1`; add newly created tests explicitly. Actual layout assertions run in Task 10 (Task 1 has also been checked independently in an actual Windows window).

## Task 2: Automatically adopt committed shared catalog additions

Ownership: `src/features/collaboration/{controller,useCollaboration}.ts`, project lifecycle, playback/selection idle guard registrations, AxisRulers/CompareSplitter and their callers/tests; native code only if an established limitation requires it.

- [x] Write failing tests demonstrating pending catalog changes appear automatically, pending notes/views survive, unchanged polls don't trigger transitions, busy operations defer, failure retries later while last verified data remains visible, and close/runtime replacement cancels old work. Explicitly defer active/preparing/paused-with-resumable-intent playback, permit adoption once truly idle, and retain pending/manual-update availability while deferred; terminal playback rejection must not leave a permanent guard. Defer modal interactions and recheck eligibility after draining drafts.
- [x] Run RED. Reuse `project.performCollaboration`/`api.adoptCatalog` and the existing `run` guarded transition. Schedule only for a fresh pending catalog and an eligible current runtime; use a single bounded operation per owner. Never adopt recursively from `accept` while the refresh flight is still holding native admission. Do not turn busy/deferred refresh into repeated error banners. Keep the manual action as explicit retry.
- [x] Verify no lost local drafts, no duplicate adopted media, unchanged own labels/settings/playback intent, stable selected media/compare views and read-only capability retention. Keep personal hiding separate from shared recycle.
- [x] Run collaboration/project suites, typecheck, checkpoint and paired reviews. Add simultaneous append/recycle two-client scenario for Task 10.

Commands: `npm test -- src/features/collaboration src/features/project --maxWorkers=1`; run targeted native tests if native code changes.

## Task 3: Prompt to restore the last project and local work state

Ownership: new focused session store/hook/dialog under `src/features/project/`, `src/features/project/useProjectLifecycle.ts`, `src/app/{App,AppShell}.tsx`, associated tests/styles.

- [x] Write RED tests for bounded valid local record, malformed/unavailable storage, successful-open-only persistence, accept/decline/forget, read-only open mode including null actor, recovery/failure and no autoplay. Include stale/hidden/deleted media fallback, project/actor identity mismatch ignoring transient state, newer durable/global settings winning, explicit close-project clearing reopen intent and application exit preserving it.
- [x] Introduce a separate local session key/version; retain path/project identity/actor UUID/open mode and inspector/panel/cue UI state. Reuse persisted project/private view and playback preferences as authority; never overwrite them from this record. Apply transient state only for matching project and actor identities. Persist acknowledged UI changes with bounded debounce; close/save barriers own actual edits.
- [x] Add lifecycle `openPath` (or equivalent) using the same operation/admission/finishCurrent/adopt/recovery handling as the existing picker. Expose the startup prompt only when idle on the welcome screen and there is a valid prior record. Record success after actual adoption, not picker acceptance. Distinguish explicit close-project from application close.
- [x] Restore transient UI only after owner/recovery is ready and IDs/coordinates validate. Initialize playback stopped. On failed path opening retain record and retry/start-empty/choose-another-project options. Test missing, locked and unavailable path handling and successful replacement by another chosen project. Never restore a local temporary draft or overwrite shared content.
- [x] Run project/app/playback focused tests plus typecheck; checkpoint for paired reviews.

Commands: `npm test -- src/features/project src/app/App.test.tsx src/app/AppShell.test.tsx src/features/playback/initialCue.test.tsx --maxWorkers=1`.

## Task 4: Measure and correct playback stutter

Ownership: `src/features/playback/{Playhead,usePlayback}.tsx` (hook `.ts`), focused new playback clock/store helper if justified, `src-tauri/src/commands/playback.rs` only on confirmed native defect, owned desktop diagnostic test, relevant tests.

- [x] Add a bounded owned Windows playback diagnostic suite, unique native/driver/debug ports and local/WebView data. Measure native event gaps, generation, consumed/underrun frames, RAF/long-task timings and cursor position; original/processed modes, seek/pause/resume/loop, representative mono and multichannel data. Run against preserved baseline E2E executable before fixes.
- [x] Write failing deterministic clock/scheduling regression tests based on confirmed observations. Preserve failure and diagnosis. No unverifiable assertion that audio is fixed.
- [x] Correct the smallest proven clock/update defect; use a monotonic presentation clock and bounded prediction while honoring native pause/end/generation. Avoid resetting interpolation backward on callback frame quantization and avoid React state per RAF across the entire app. Preserve linked view and zoom behavior.
- [x] If real starvation is measured, trace refill duration/source stat/PCM/DSP separately, prove any optimization output equivalent with sample-level checks, and retain source-change verification and callback lock-free guarantees. If starvation is not reproduced, don't change DSP or claim it was fixed.
- [x] Re-run diagnostics on candidate, affected frontend/native tests, typecheck; checkpoint and paired reviews.

Commands: `npm test -- src/features/playback --maxWorkers=1`; native changes require `cargo test --release --workspace --features annotator-desktop/e2e` or focused tests first then full appropriate native verification. Desktop suite invoked with explicit `ANNOTATOR_WORKSPACE_EXE` and isolated output.

## Task 5: Personal tree/flat display

Ownership: `src/features/media/MediaList.tsx`, a focused new `src/features/media/listDisplay.ts` store/helper plus tests, necessary app props and compact styles. Keep preferences separate from strict global-settings v1.

- [x] Write failing tests for local project/actor keyed mode/scope, tree expansion round trip, selected directory descendants/all scope, missing directory fallback, normal/hidden/recycle/search/multiselect, and global up/down revealing an outside-scope target without altering import destination.
- [x] Add compact display controls and flatten the existing filtered/indexed media sequence, preserving original filenames and context actions. Store local UI preferences only; no organization/native move/import layout calls. Keep tree counts independent from selected display scope.
- [x] Run media/navigation tests, typecheck and diff check. Add actual geometry/focus/tree-flat scenario for Task 10. Checkpoint for paired reviews.

## Task 6: Deferred by user — evaluation/reannotation

No implementation, sidecars, commands or output changes for this feature. Existing ordinary own annotation editing remains unchanged.

## Task 7: Independent native inspection preview sessions

Ownership: new `src-tauri/src/commands/inspection.rs` with small focused modules as necessary, reusable portions of `commands/examples/preview.rs`, native command registration/state and new `src/bridge/inspection.ts` contracts/tests. Preserve example library behavior and existing project analysis authority.

- [x] Write RED native tests for bound open/configure/tile/status/playback/control/gain/close, stale owner/session/generation, source verification, no project mutations and release after cancellation/error/owner replacement.
- [x] Reuse/extract the existing owned transient preview machinery to open project media from native-verified source descriptors/PCM without importing into the example library or copying source audio. Support original/processed and region audition, local monitor/volume, independent valid analysis/display requests, tile cache/generation cancellation and source identity checks.
- [x] Keep long I/O/analysis off app/native UI locks and retain callback safety. One explicit preview transport owns playback; opening hands off main playback, closing stops only the owned preview and does not auto-resume main. Add live gain control without reconfiguring the entire project.
- [x] Verify main document, settings, private preferences, history, author layers and media bytes unchanged for view/gain/analysis adjustments. Run native/bridge tests and existing example preview regressions. Checkpoint for paired reviews.

## Task 8A: Unified inspection viewer/session

Ownership: new focused `src/features/inspection/{targets,session,InspectionViewer}.ts(x)` and tests/styles, existing RemoteInspector/remote and AnnotationList/AppShell entry wiring. Use Task 7 bridge; annotation content is read-only in this viewer.

- [x] Write RED tests for author/list/self/foreign/file/channel targets opening one viewer without main navigation; independent analysis/view/gain, playback handoff, focus/cancel/error/owner cleanup, explicit jump validation and no autoplay after close.
- [x] Add accurate spectrum and independent channel/STFT/Mel/log/zoom/reset/display/analysis controls plus bottom playback/gain controls. Do not mount ordinary usePlayback twice. Register modal/background idle guard; release all session resources on cleanup. Source changes update metadata; source disappearance stops stale audition. Explicit jump closes and uses guarded reveal/locate.
- [x] Run `npm test -- src/features/inspection src/features/collaboration/remote.test.tsx src/app/listWorkflow.test.tsx src/features/examples --maxWorkers=1`, relevant AppShell tests/typecheck, checkpoint and paired reviews.

## Task 8B: Border-only foreign selection

Ownership: `src/features/annotations/AnnotationOverlay.tsx`, focused CSS/coordinate hit helper if needed, `src/features/selection/overlay.test.tsx` and new geometry tests. Reuse viewer target contract from 8A.

- [x] Write RED tests for 4 CSS pixel visible-border tolerance in linear/log/Mel/clipped views; own resize-handle/border priority; remote border winning over merely overlapping own interior; remote interior cue/draw behavior, context menu and cancellation.
- [x] Replace foreign interior hit routing with bounded visible-edge testing, preserve own gestures/cues and deterministic overlap handling. Open the same inspection viewer on accepted foreign edge; never expose foreign range handles or native update commands.
- [x] Run `npm test -- src/features/selection src/features/annotations/selection.test.ts --maxWorkers=1`, typecheck, checkpoint and paired reviews.

## Task 9: Personal author/category visibility

Ownership: collaboration controller/AuthorFilter/RemoteInspector list controls, CategoryManager display-only section, own/foreign overlay visibility helpers, local project/actor preference store from Task 5, related tests.

- [x] Write RED tests for hide/show one/all authors, explicit include-self, hidden authors remaining in control list, category-name filters with optional own labels, multi-label any-match, unclassified regions, own/foreign frame hiding, actor/project isolation and reload persistence.
- [x] Add compact reversible controls. Group matching trimmed category names solely for visibility without rewriting UUIDs/definitions. Hiding an author suppresses their frames. Apply applicable category any-match hiding consistently to plot/list results; keep control entries available for unhiding. No shared writes/export changes.
- [x] Run affected suites/typecheck and verify shared bytes/revisions unchanged by filters. Checkpoint for paired reviews.

## Task 10: Combined regression verification, integration and delivery

Ownership: `tests/desktop/` new combined suite, harness registration only if needed, verification/user/release documentation and version/package metadata after all features pass.

- [x] Run frontend suite, typecheck, appropriate Rust suites and desktop harness tests. Inspect every failure; don't weaken assertions just to pass.
- [x] Real Windows combined clicks: three-level folders/narrow geometry; tree/flat/filter/keyboard/scroll; author self; two clients append/trash/restore while one has pending note; startup restore/failure; source-border vs interior; read-only preview reflects source edits and handles source deletion; both entry pages open isolated preview, exercise gain/STFT/Mel/analysis/seek and explicit jump; hide/show authors/types including self; ordinary history/Save As/export preservation and playback responsiveness. Compare actual media/foreign author hashes except intentional fixture edits. Use new owned NAS and local fixtures; never mutate the real project.
- [x] Final paired full-range review. Record exact tests, limitations and unresolved reported causes honestly. Check protected formats and diff scope.
- [x] Squash final changes onto integration anchor without temporary commits; preserve user/untracked files. Update guide/release notes including unchanged repeat-import behavior and discussion-only category governance, accurate measured playback results and any limitations.
- [ ] Bump to the next compatible patch version, build separate E2E and production payloads, verify production contains no test hooks, build installer and direct complete update payloads from deployed 0.7.5/0.7.6/0.7.7 as supported. Verify archive structure/resources/hashes and copy to a new NAS software version directory. Update existing authorized PR with exact verification; no automatic install/merge/GitHub Release.
Task 5 at `11aac835b5fa30a0bcceb4e9cf0f41c641314457`, paired reviews PASS; 235 affected tests and root 104 focused tests PASS. Its extended actual Windows tree/flat scenario remains Task 10. Task 7 initial checkpoint `ba3e83c0a4055f1c0cbe6fca418d3e86bfcaaba3` passed spec review; quality identified destructive cleanup after rejected playback parameters. Follow-up `098ee44a6a4b8e77786a8ba3ec50c412b4373207` adds production-preflight regressions and preserves valid sessions on caller rejection. Final 117 native tests, 45 bridge/example tests and typecheck PASS; fresh paired spec and quality reviews PASS. Root independently ran all current frontend tests: 97 files / 874 tests PASS before the native-only follow-up. Tasks 8A, 8B, 9 and 10 remain outstanding; Task 6 stays deferred.

Task 8A at `59c495946efa48f974c08702f0f6eaefec9d4019`: final full frontend 101 files / 897 tests PASS, broader 308 tests and build/typecheck PASS; first paired spec review found the readonly adapter status-routing defect. Follow-up `0cf178c8e4a0910d90c7a48e0c1ee2b6aa8bf75c` adds real useTiles/binary tile regressions and fixes it; fresh paired reviews PASS, 153 affected tests and build/typecheck PASS. Task 5 extended actual Windows combination has now passed all 7 groups, including tree/flat scope, global keyboard focus/scroll, narrow geometry, multiselect and unchanged organization/audio hashes. Report: `.test-output/collaborative-workspace/task5-windows/desktop-NfBHX6/report.json`. Root independently reran the final Task 7 native workspace: 423 tests PASS, 9 existing ignores. Viewer/device, two-client and persisted-profile startup acceptance remain Task 10.

Task 8B at `f43cfaab6c5663fb34260262f704881b2e4edef7`: paired reviews PASS, both independently reran 138 focused tests; root 77 geometry/overlay tests and broader 196 tests PASS, build/typecheck PASS. The authorized integration-test fixture now clicks the actual remote border while retaining all navigation protections. Task 9 is in progress; Task 10 combined Windows/NAS acceptance and delivery remain outstanding.

Task 9 at `fe5200bf2aca543560a9505a689e80b396656afb`: paired reviews PASS; 499 affected tests, final 124 focused tests and root 84 focused tests PASS, build/typecheck PASS. Task 10A now owns combined actual Windows/NAS verification, appropriate legacy harness adaptation, version 0.7.8 and release-source documentation. Task 10B is root orchestration: local production build/artifact verification, final full-range paired review before NAS publication, squash integration onto the immutable anchor, main verification and existing PR update. All prior data-format and deferred-scope constraints remain unchanged.

Upstream integration refinement (2026-10-28): PR #6 was closed without merge while this work ran. Fetched main is `be32e1e7cd02d4536200bfdc364d9705b2e22785`; the incoming change since the original shared ancestor `b744140b5dbcdf2bdb4808ebcd457e153c93b716` is PR #8, random unclassified navigation. Preserve the immutable original `47e2f0a` source/audit anchor and original local branch. Task 10A incorporates pinned main into the temporary worktree, retaining all existing features and separately preserving R candidate scope and global arrow/flat reveal semantics. Rebuild and reverify the combined source. Final delivery uses a new clean release branch from recorded upstream `be32e1e`, squashing the verified merged tree to one permanent feature commit; open a new PR instead of reopening the closed PR. No upstream/user changes may be dropped. This is an integration-plan adjustment, not a change to the approved product scope or deferred work.

Final Task 10A at `eabcf8f49f356d819d25b6cfab0f3c0b4d485469`: product inputs frozen at `7b7c0c2`; frontend 109 files / 1078 tests PASS, Rust 423 PASS / 9 existing ignores, Node harness 21 PASS. Exact final E2E passed local/NAS 16 groups each, processing 3 and startup/recovery 3, plus all selected legacy suites and documented 0.7.5/0.7.7 compatibility continuations. Failed attempts and the unresolved original 0.7.7 WM_CLOSE cause remain explicit. No evaluation/reannotation or import/dedup changes were added. All owned test processes/listeners retired.

Task 10B local production build and complete updates PASS: 466 frozen inputs unchanged, 34 resources exact, normal 0.7.8 EXE excludes test markers, NSIS and direct complete 0.7.5/0.7.6/0.7.7 updates generated and archive hashes verified. See `docs/evidence/2026-10-28-collaborative-workspace/production.md`. Final full-range paired review, new NAS publication, clean integration from pinned upstream and new PR remain the only required work.

Final full-range paired review of `be32e1e..152a5f5` PASS: spec independently ran 99 focused tests; quality independently ran 152 frontend and 7 Node checks. No required fixes. NAS publication PASS: `N:/精成数据标注/软件/测试版-0.7.8`, seven files copied through unique temporary names and verified before/after rename; six prior 0.7.7 files remain byte/hash identical. Receipt: main `.test-output/collaborative-workspace-production-078/nas-publication.json`. Clean squash integration, main-directory verification and new PR remain pending.

Main-directory integration verification PASS: new release branch begins at pinned `be32e1e`; its staged tree matched the verified temporary tree exactly before documentation-only delivery updates. Fresh main checks passed 109 frontend files / 1078 tests, `npm run build` (including typecheck), and 21 Node harness checks. All 44 original untracked files are preserved in place or, for our two superseded draft documents, in the explicit backup. Original `codex/project-examples-toolbar` still points to immutable `47e2f0a`. The final permanent commit contains no temporary checkpoint history. Publishing the new branch/PR follows this pre-push record.

Audit cleanup: raw evidence moved on the same volume to main `.test-output/collaborative-workspace-evidence-078`; 23907 files / 1578527742 bytes preserved, with 214 critical report/screenshot/EXE hashes verified. Historical reports retain their original execution paths; this is their replacement root. Temporary checkpoint history is independently retained in verified `temporary-audit.bundle` under main `.test-output/collaborative-workspace-production-078`, outside the final branch history.
