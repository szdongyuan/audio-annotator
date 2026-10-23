# NAS collaboration Task 1 evidence

Date: 2026-10-23. Worktree: `D:/Work/annotator/.worktrees/nas-collaboration-v030`.
TaskBase: `0261722407caa43c62b0a6175ea9647d4a218d4c`.
Immutable MAIN_BASE: `bb9ff6a5428fad531507738a99eb6a3f82f76fdd`.

## Implemented scope

Task 1 only: strict version-1 public manifest, immutable public media metadata, category/region/file/channel annotation payloads, author/account/checkpoint/snapshot models; bounded validation and whitelist projection through the existing v2 document validator; project-scoped accounts; authenticated native author capabilities; per-author OS locks; immutable no-clobber revisions and read isolation. No private workspace, native command, frontend, release, existing FileStore, audio or DSP behavior was changed.

Accounts use trim + Rust lowercase, SHA-256 filenames, atomic no-clobber registration and exact Argon2id 0.5.3 v19 parameters m=19456/t=2/p=1/output=32/salt=16. Salt bytes come from random UUID draws. External PHC parameters and decoded salt/output lengths are checked before password verification. Credential records have no Debug implementation, and snapshots contain identity only. Dependency changes add Argon2 and required transitive dependencies; no existing package versions changed.

A short accounts-only OS registration lock preserves normalized-name uniqueness and the 128-account cap under concurrent processes. The orchestrator clarified the spec to explicitly allow this protocol lock; it is never used by annotation publication. Author sessions hold their own OS lock and an opaque, non-serializable capability bound to root, project and account. The current lock path's OS file identity is checked against the held handle; Windows does not allow deletion sharing for this handle. No timeout/PID-based stealing exists.

Publication validates the current revision/hash checkpoint, writes and syncs its own UUID temporary file, publishes to a 20-digit immutable revision using Windows MoveFileExW without REPLACE_EXISTING, verifies current authority/head again, and prunes only validated history of its own author after confirmation, retaining 16 revisions. An identical retry at the expected target revision/hash confirms a lost acknowledgement. Other authors' matching geometry and IDs are independent. The non-Windows implementation uses no-clobber hard-link creation rather than overwrite rename.

Limits: 128 accounts, 4 KiB account records, 16 MiB per manifest/layer, 64 MiB read budget across loaded layers (including parent-checkpoint validation reads), 256 entries per enumerated account/author directory, 4096 media/categories and 100000 regions, and JavaScript-safe revision/metadata integers. Existing finite geometry, category/media references and model validation are reused. Media paths are restricted to `media/<canonical-uuid>.wav|flac|mp3`; existing path components reject symlink/reparse points. Oversized or corrupt author layers produce independent author errors; exhausting the aggregate read budget returns an explicit resource error rather than truncating the author list.

## RED → GREEN evidence

All raw logs are in ignored `.test-output/nas-task1/` within this worktree.

| Log | Command / observed result |
| --- | --- |
| `red-schema.log` | `cargo test -p annotator-core --test collaboration_repository`: valid public-manifest round-trip fails because the collaboration parser is not implemented; 1 failed, 1 passed. |
| `green-schema.log` | Same command after strict public-schema implementation: 2 passed. |
| `red-repository.log` | Same command with account/publication/filesystem tests and an unimplemented repository boundary: 3 failed with explicit missing repository behavior, 3 schema/projection tests passed. |
| `green-repository.log` | Same command after repository/account implementation and Windows lock-handle correction: 6 passed. |
| `red-projection-boundary.log` | Focused constructed-manifest test fails because payload projection accepted an unsafe media path. |
| `green-safety-process.log` | Full focused suite after boundary validation and process tests: 14 passed, 1 child-only helper ignored by the parent harness. |
| `red-strict-independent.log` | Full focused suite: duplicate JSON fields were silently collapsed, and an oversized author hid other authors; 2 failed, 14 passed. |
| `green-strict-independent.log` | Original-stream strict decoding and independent author error reporting: 16 passed, 1 child helper ignored. |
| `red-partial-cancel.log` | Focused partial-write cancellation test fails because the controlled cancellation boundary is not yet handled. |
| `green-complete.log` | Complete focused suite with cancellation, account/count and aggregate-byte limits: 19 passed, 1 child helper ignored; 0 failures. |

Tests use real temporary directories. The child-only ignored test is explicitly invoked in eight separate processes by the parent tests: lock holder/contender, two publication competitors, two normalized-name registrants, and two independent author writers. These exercise actual OS locks and filesystem publication; the lock holder is killed by its owned process handle before a fresh login proves release. No process-local lock substitute is used. A real Windows directory junction verifies reparse rejection. Fault tests cover partial write, sync, rename, cancellation before and after partial writing, and acknowledgement loss after publication; foreign temporary files survive.

Other focused checks cover wrong passwords without trimming, duplicate names, hostile PHC memory/time/parallelism/version/algorithm/salt-output values, account/private-field injection, current-head corruption, unsupported versions, mismatched author/hash/revision, oversized files, excessive directory entries, cross-root capability spoofing, stale baselines, immutable manifest mutation, whitelist payload round-trip, own-only retention, and simultaneous identical regions from different authors.

## Final verification

- `cargo test -p annotator-core --test collaboration_repository`: PASS, 19 tests plus the explicitly invoked child-process helper; `green-complete.log`.
- `cargo test -p annotator-core`: PASS, 131 tests total, 0 failed, 1 parent-harness ignored child helper; `core-tests.log`. This reruns all collaboration tests and the existing core regression suite.
- `cargo fmt --all -- --check`: PASS, exit 0; `fmt.log` is empty.
- `cargo clippy --workspace --all-targets -- -D warnings`: PASS, exit 0; `clippy.log`.
- `git diff --check`: PASS (Git reports only the existing Windows LF/CRLF normalization notice for Cargo.lock).

## Task 2 handoff and limits

Use `CollaborationRepository::open`, `manifest`, `root`, `register`, `login`, `read_author`, `snapshot` and `publish`; retain the returned `AuthorSession` for the entire writable native session. `publish` accepts only a session capability, optional prior `Checkpoint`, and `LayerPayload`; it has no caller-supplied author path. `LayerPayload::from_document`, `project` and `hash` support private-envelope projection and pending-generation comparison. The layer hash binds kind/version/project/author/revision/parent/payload, and `checkpoint()` produces its acknowledgement.

Repository snapshots are stateless: Task 2/3 must retain the last verified author layer on an author error and reject a missing/regressed head relative to its last checkpoint. Without a prior checkpoint, a never-published account and externally deleted entire history cannot be distinguished. `publish` always checks the supplied base and refuses divergent or corrupt current authority. Private pending-state reconciliation, local saves, guest merge, UI behavior and exported scope remain later tasks.

This evidence is Windows local-filesystem and same-directory multi-process verification. Physical SMB/NAS, non-Windows execution, UI and release packaging are not claimed by Task 1. The owned build cache and prior releases were not moved, deleted or modified as deliverables.
