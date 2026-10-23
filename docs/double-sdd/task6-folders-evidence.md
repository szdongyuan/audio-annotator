# Task 6 — bounded native folder discovery

Date: 2026-10-23. TaskBase: `1bcb152263266f46edbeb86bd08489c466f8cedf`.
Implementation complete; independent specification/quality reviews pending.
No UI/controller work, dependency changes, migration, decoding, or document import is included.

## Contract and Task 7 handoff

- `folderClient.start(projectId, absolutePath, receive, recursive = false)` invokes `scan_folder` and returns `{ taskId, ownerId }`. Both are UUIDs; `ownerId` is an opaque runtime generation, regenerated on project create/open/save-as/close and successful exchange replacement. Events can arrive before the start promise resolves.
- Events are `progress` (counts only, at most once per 100 ms), `result` (root, counts, retainedIssues), `cancelled`, or `failed` (AppError). Every event carries the complete token. Reset/release suppresses late worker publication. Failed exchange import leaves the previous scan valid.
- `folderClient.page(token, 'candidates' | 'issues', offset, limit = 256)` returns the exact requested token, kind, offset, total, candidates, and issues. Only the requested array contains items. Limits are 1–256. Candidates are available only after successful completion, sorted by ordinal relative path, with canonical absolute paths. Issues retain at most 256 items; total counts are not truncated.
- Counts: checked filesystem entries, accepted candidates, existing paths, skipped unsupported/reparse items, failed access/unresolved-source items, and total issues. Existing unresolvable source references are explicitly reported and their lexical absolute paths reserved; they are never relinked or replaced. Relative source references resolve against the project root.
- `cancel(token)` immediately signals only that scan and discards its stored candidates. `release(token)` also frees the single active slot. Release on accepted completion, discarded results, failures, and cancellation; keep the slot while reading pages. Old tokens are rejected, including old cancellation requests. Reset cancels and releases the slot. Failed delivery of the terminal event releases it as well.
- Task 7 must capture ActiveProject, reconcile early events/start acknowledgement, and ignore obsolete owners. Page candidates sequentially and pass each page to the existing native import path. Await native finished, start acknowledgement, and accepted document queue work before the next batch. Release the scan after all pages/results needed by the controller have been consumed. Folder cancellation does not cancel media decoding; cancel the owned decoder separately once import starts. Preserve the failed-edit ledger and release unpublished PCM through existing media APIs.
- Discovery uses spawn_blocking. Only capture and publication touch task/project state; directory walking never holds project authority. Root is canonicalized. Children are checked with symlink_metadata and the Windows reparse attribute before canonicalization/traversal. Hard links and equal content at distinct paths remain separate candidates.
- Hard caps are 10,000 accepted audio candidates and 100,000 checked directory entries. Going over either returns ResourceLimit without publishing any candidate page. Configurable smaller core limits exercise the exact boundary/over-boundary paths; callers cannot raise either hard cap. No 100,001-file disk stress fixture is claimed.

## Verification

Logs are retained in `.test-output/task6-folders/` in the implementation worktree.

| Check | Observed result | Evidence |
|---|---|---|
| Core RED | Missing folder_scan module | core-red.log |
| Bridge RED | Missing folders bridge module | bridge-red.log |
| Failed-count RED | Counts had no failed field | counts-red.log |
| Core focused GREEN | 7 passed | core-green.log |
| Rust workspace | 117 passed, 0 failed | workspace.log |
| Strict workspace/all-target clippy | Passed, no warnings | clippy.log |
| cargo fmt --all -- --check | Passed | fmt.log |
| Bridge contracts | 7 passed | bridge-green.log |
| TypeScript typecheck | Passed | typecheck.log |
| Full frontend suite | 211 passed across 32 files | frontend.log |
| E2E debug native build | Passed (existing large notices bundle advisory) | native-build.log |
| Real native IPC | All 5 groups passed | native.log; native-khWrRJ/report.json |

Core coverage includes nonrecursive/recursive scans, mixed-case extensions, same names in separate directories, stable ordering, relative/absolute existing paths, distinct hard links, unresolved sources, exact/over limits, pre/mid-scan cancellation, inaccessible root, injected child permission failure with continuation, bounded issues, 256+4 paging, stale owner completion/read/cancel, cancellation independent from MediaTasks, and 300 result release cycles. The native host unit test checks the actual Channel JSON and verifies project authority is available during progress/terminal publication.

The real NTFS junction test creates a UUID-owned temporary tree and a junction via native PowerShell, verifies no traversal into its target, removes only the owned junction, and verifies the target file survives. Recursive temporary cleanup verifies the canonical absolute target is under OS temp and has the expected owned prefix. The permission branch is deterministic injected PermissionDenied; no user ACLs are changed.

Reproduce native IPC checks after the recorded e2e build with `node tests/desktop/folder-scan.test.mjs`. The test uses the existing harness's owned ports 4445/4446/9235, refuses occupied ports, and touches only its new evidence directory. It verifies 260 candidates as 256+4 pages, recursive 261 candidates, no implicit imports, malformed owner/page limit rejection, release, save-as reset, close/open/create isolation, cancellation, missing-root failure, failed exchange preservation, and successful exchange invalidation. It exercises native commands, not the Task 7 UI.

No production installer rebuild, folder-import decoding/controller acceptance, physical directory-picker interaction, or large-directory performance conclusion is claimed in this task; those belong to Tasks 7–8.
