# Task 7 — folder import workflow and batch lifecycle

Date: 2026-10-23. TaskBase: `7f20955aeb5a8541c305185e1211d059a963507b`.
Implementation and verification complete; independent specification/quality reviews pending.

## Delivered behavior

- File → Import Folder opens the subfolder option (unchecked by default), then the native directory picker. The existing Task 6 scanner remains the sole filesystem discovery implementation. Candidate pages of at most 256 are imported automatically and serially.
- One ActiveProject owns the folder controller and the shared media controller. A reservation covers options/picker/scan/import/paused states, preventing direct import and relink from starting another native media task. Replaced runtimes reject late picker, start, page, and media results, including same-ID Save As.
- `MediaImportController.completed()` waits for native terminal, start acknowledgement and all accepted publications. Ready messages register immediately with `lifecycle.enqueueEdit` and then CommandQueue; promise bookkeeping does not defer admission beyond lifecycle barriers. Cancellation resolves the completion waiter after accepted work even if the retired native owner sends no further event. Per-run callbacks retain their own item references.
- Beginning a lifecycle transition notifies media/folder controllers immediately, before draft/queue draining. Cancellation stops the owned scan and decoder separately, prevents subsequent pages/batches, retains accepted edits and releases unadmitted prepared PCM. It never discards a failed document edit.
- Any unresolved document failure pauses subsequent batches, including a failure appearing while a page response is pending. Folder Retry retries only its own failure IDs with their original prepared descriptors. Other owners remain in the global ledger and must be resolved through their own recovery controls before Continue. A successful retry updates aggregate success rather than permanently counting the item as failed.
- Explicit “结束并放弃失败项” abandons only this folder's failed imports. Cleanup is admitted through the lifecycle. Native PCM release must succeed before removing a failed ledger entry; a release failure leaves it recoverable for another explicit attempt.
- Results retain global batch indexes/paths, success/failure/existing/skipped totals, and at most 256 retained scan issues with honest truncation text. Expanded details project/render only the visible 50 rows; collapsed results do not project all rows. Internal batches do not create duplicate ImportProgress panels. Dismissing the folder result leaves zero feedback height.

## TDD and verification

The initial controller and UI runs failed because the new modules did not exist. Further observed RED runs reproduced early transition failing to cancel, failed PCM cleanup deleting its ledger too early, continuing batch 2 despite another owner's failure (`ledger-red.log`), and a failure arriving during page 2 (`page-ledger-red.log`). Each was followed by focused GREEN verification. Initial missing-module and transition/release RED outputs are in the implementation tool transcript, not claimed as retained log files.

All retained logs are under `.test-output/task7-folder-import/`.

| Command/check | Actual result | Evidence |
|---|---|---|
| `npm.cmd test -- src/features/media/folderImport.test.tsx` | 16 passed | focused.log |
| `npm.cmd test -- src/features/media src/features/project` | 48 passed, 5 files | media-project.log |
| `npm.cmd test` | 227 passed, 33 files | frontend.log |
| `npm.cmd run build` (includes typecheck) | Passed | build.log |
| `npm.cmd run tauri -- build --debug --no-bundle --features e2e --config src-tauri/tauri.e2e.conf.json` | Passed | native-build.log |
| `node tests/desktop/folder-flow.test.mjs` | All 10 groups passed | native.log; native-QILQmJ/report.json |
| `node tests/desktop/feedback-flow.test.mjs` | All 4 existing recovery/layout groups passed | feedback-regression.log; Task 4 feedback output |
| `git diff --check` | Passed | implementation command output |

Controller coverage includes 257 candidates, recursive/default options, scan result before start acknowledgement, native finished before media start acknowledgement, delayed publication, picker/page/decoder cancellation, reset without future terminal, accepted-publication drain, same-ID runtime replacement, late PCM release, scan overflow no import, corrupt-file continuation, folder-only results across subsequent direct jobs, picker/relink mutual exclusion, paginated DOM/issue truncation, scoped retry, unrelated failures, and release-failure retry during transition.

No Rust source or dependency changed; this task does not claim a new Rust workspace test run. Task 6's 117-test result remains its own evidence. Build's existing large third-party-notices chunk advisory remains unchanged.

## Actual native desktop checks

`tests/desktop/folder-flow.test.mjs` creates a unique owned evidence directory containing 257 generated short stereo WAV files with distinct paths and mixed-case extensions, a nested same-name file, unsupported text, and a corrupt WAV. It retains fixtures and screenshots. The existing harness refuses occupied ports 4445/4446/9235 and operates only on its spawned native PID. No user files, global DPI settings or release directories are changed.

The successful run was `native-QILQmJ`, native PID 17044. It verified:

1. Default nonrecursive import adds all 257 valid files across 256+2 candidates (one corrupt), with exactly one aggregate panel and 50 result rows per page.
2. Recursive import adds the nested same-name path; 257 existing paths are skipped, and corrupt audio fails independently.
3. Repeated recursive import reports 258 existing paths without duplicates.
4. One explicitly injected `apply_change` transport failure pauses before batch 2. Native decoding and prepared media are real. Folder Retry recovers that prepared result and continues the last candidate, producing 257 successes/0 failures for that run.
5. Cancel retains an injected publication failure; explicit End removes only that failed import and calls native PCM release.
6. Win32 outer 1280×800 → CSS viewport 1264×761: four plots each 236.5px; top 72px, transport 48px, per-file header/controls 54px, empty feedback height 0. Saved screenshot was visually inspected.
7. Explicitly delayed native ready/finished delivery makes cancellation/new-project isolation deterministic. Cancellation was visible in 92ms (WebDriver click through observed UI); one already accepted file remains in the old project, the replacement stays empty, and old unaccepted PCM releases.
8. An explicitly delayed scan terminal cannot start a decoder after cancellation.
9. Direct multi-select file import remains functional after folder cancellation.
10. Moving the owned fixture and using the real relink workflow preserves descriptor identity, classification and notes while updating its path.

Only native picker *return values* are supplied by the e2e feature; the production folder picker is wired through `@tauri-apps/plugin-dialog`. Physical OS picker interaction is not claimed. The earlier two native attempts are retained (`native-8SS8Oh`, `native-cDMc3A`): they exposed test-helper waiting mistakes (reading the previous project identity, then comparing a Windows canonical path without its extended prefix). The helper now waits for the expected project path suffix and saved state; the full successful run uses the final implementation.

The existing feedback regression verifies non-overlapping progress/failure controls at 1280×800 and 1000×680, native cancel/release, retry of the original prepared media, and no empty feedback strip. No Windows 125% system-DPI or long-audio performance claim is added here; release/performance/installer work remains Task 8.

## Handoff

Task 8 can use the real File → Import Folder menu and `folder-flow.test.mjs`. Keep the shared workspace-feedback stack and the lifecycle admission notification. Do not replace `completed()` with `start()` or a snapshot of `settled()`. Do not clear another owner's ledger or release a failed prepared descriptor before a successful retry/explicit abandonment. No migration, version change, installer, dependency or DSP change is part of this task.

## Review repair — serialize all visible recovery entries

The first quality review reproduced a concurrent recovery race: the generic “重试更改” button bypassed lifecycle edit admission, so Folder End could release its prepared PCM while `queue.retry` was in flight. Specification review passed that initial head; both reviews must run again against the repaired head.

All visible media recovery routes now share the existing lifecycle edit queue before inspecting a failure or touching PCM: generic single-failure Retry, project-wide Retry, folder Retry, and folder End. The generic route preserves the draft-aware submitter. The project-wide route captures the reviewed failure IDs. Every queued retry rechecks the ledger inside admission and becomes a no-op if an earlier retry or abandonment has resolved it. Folder Retry also reconciles its owned items inside admission. CommandQueue's behavior and unrelated-owner discard rules are unchanged.

New regressions render the actual AnnotationFailure and FolderImportProgress buttons together, use deferred native-boundary responses with an explicit prepared-PCM availability flag, and exercise both Retry→End and End→Retry. They additionally enqueue a stale duplicate Retry and begin a lifecycle transition while recovery is pending. Assertions prove no premature release/retry, no resurrected failure, preserved success counts, and transition waiting. Project-wide Retry is checked in both orders; a real generic Retry button preserves a newer annotation draft.

Observed RED: all three initial race regressions failed (`recovery-race-red.log`): release started during a pending retry, a retry started during release, and project-wide Retry bypassed release. Final GREEN and affected verification:

| Check | Actual result | Evidence |
|---|---|---|
| Focused folder/recovery suite | 21 passed | recovery-focused.log |
| Media + project + annotations + app | 108 passed, 14 files | recovery-affected.log |
| Full frontend | 232 passed, 33 files | recovery-frontend.log |
| E2E native debug build including production build/typecheck | Passed | recovery-native-build.log |
| Existing actual native feedback regression | 4 groups passed | recovery-feedback-native.log |
| Actual native folder workflow on repaired build | 10 groups passed | recovery-folder-native.log; native-fRnQwM/report.json |

The concurrency tests are deterministic controller/actual-component integration tests with injected boundaries. They are not claimed as physical concurrent OS input tests. This repair changes no native code, dependency, migration, version, or Task 8 deliverable.
