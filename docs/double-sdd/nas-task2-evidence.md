# NAS collaboration Task 2 evidence

Date: 2026-10-23. Worktree: `D:/Work/annotator/.worktrees/nas-collaboration-v030`.
TaskBase: `33db0e0ca0ec51595f3e978acfb72e869208f96f`.
Immutable MAIN_BASE: `bb9ff6a5428fad531507738a99eb6a3f82f76fdd`.

## Scope and storage contract

Task 2 only. `LocalProject` now explicitly selects ordinary `FileStore` or an app-local `PrivateWorkspace`. `root()` remains the shared media resolution root; `storage_root()` is the private cache root. The ordinary v2 store algorithm and fault points are unchanged. Its test accessor is now fallible; calling it or the unguarded session accessor in shared mode returns an error. Native apply/undo/redo delegate through guarded `LocalProject` methods. No collaboration native commands, worker scheduler, UI, release changes, DSP changes, or shared project creation were added.

The private path is `collaboration/<SHA256(canonical shared root)>/<project UUID>/<author UUID or guest>/` beneath the injected app-local directory. Every ancestor is checked before creating the next directory, including Windows reparse rejection. The local OS lock lives at `.workspace.lock`; each actor has `workspace.json` and `workspace.recovery.json`. No personal project lock, recovery, preference or cache file goes onto the share. Each atomic envelope contains the current own-only v2 projection, preferences, monotonically increasing save generation and checkpoint sequence, shared base, confirmed payload, latest pending payload/generation/hash, and an admitted in-flight payload. Cache decoding is strict and bounded, validates immutable media metadata and payload/checkpoint coherence, and offers an explicit recovery choice when the recovery envelope is newer than the accepted primary, when same-sequence envelopes disagree, or when only recovery is valid. Both malformed copies fail closed. No edits or publication are admitted until that choice is durably committed. Local writes use same-directory atomic replace and never delete-before-rename.

Preferences include volume (default 0.75), device (default null), looping (default false), and workspace source (default processed). Actor/guest caches restore their own settings. Credentials and password hashes never enter a private envelope or frontend snapshot. Foreign layers remain in `RememberedLayers`, separate from `ProjectSession` and its history. Missing authors, missing/regressed layers and author read errors preserve the previously verified layer with an error, while malformed/cross-project snapshots cannot silently replace it.

Shared catalog import/removal is rejected. Relink follows the existing fingerprint/metadata identity check and changes only the private source reference. Shared exports are reconstructed through the public payload and immutable manifest: only own labels, default view/mix/analysis, no private masks or local paths. Save-as creates an ordinary v2 personal project, retaining own private state and rebasing relative sources; it rejects the canonical shared root and all its descendants before creating even a destination lock, and leaves collaboration only after destination publication succeeds. Guest copying builds the complete proposed document before applying one history entry; category and annotation IDs are new, references remap, masks are excluded, and conflicting file/channel values reject the entire copy.

## Publication and Task 3 handoff

- Prepare identity/project transitions by constructing `LocalProject::open_shared(repo Arc, optional AuthorSession Arc, app_local)` outside the app mutex; adopt only after success. Failure leaves the previously installed project untouched. Do not expose an author-ID-based writable constructor or deserialize an author capability.
- `save()` writes local storage only. `persisted_revision()` reports local durability, independently of pending NAS work.
- `workspace_mut().prepare_publication()` captures the durable payload/generation/hash/base and durably records an admitted in-flight checkpoint using **local I/O only**. A captured job owns an `Arc<AuthorSession>` so the author OS lease survives identity exit until that admitted job ends. Keeping this extra in-flight payload is necessary to recover lost acknowledgement of A after B was saved.
- Run `PublicationCapture::publish()` outside the global application/playback/analysis mutex. Task 3 must enforce one network job per runtime and skip overlaps. The Task 2 capture itself does not start threads or schedule retries.
- Deliver the opaque returned `PublicationAck` to `workspace_mut().acknowledge()`. It checks runtime nonce, old base and admitted generation/hash, atomically advances the baseline/confirmed payload, and clears pending only when it still matches A. It never replaces the current personal document or preferences with A. B and its generation remain pending. A private-only B with the same payload is subsequently recognized as already confirmed without an extra revision.
- Reopen recognizes an in-flight A already published on the share by its exact expected immutable layer hash. It confirms A and keeps B, including after an acknowledgement failure. Unrelated newer own layers with pending local work become a conflict, never automatic overwrite. `reconcile_shared_version()` protects unsaved personal changes before considering an incoming own layer. `load_shared_version()` is the explicit discard-pending/history route, retaining latest private operations. Fetch the remote layer outside the mutex and validate runtime/project/actor freshness in Task 3 before applying either result.
- Task 3 must wire `export_document()` into collaborative exchange and honor private relinks when resolving audio/export bytes, implement the scheduler/status commands and lifecycle/runtime stale-response checks, and load the guest payload from the native guest workspace for the explicit copy operation. Existing ordinary export/native paths intentionally remain unchanged until that task.

## RED / GREEN evidence

All raw logs are in ignored `.test-output/nas-task2/` in this worktree.

| Logs | Executed command and result |
| --- | --- |
| `red-private.log` → `green-private.log` | `cargo test -p annotator-core --test collaboration_workspace`: initial private-workspace boundary explicitly returns not-implemented (1 failed), then actor/cache isolation passes (1 passed). A fixture category-reference mistake encountered during green development was corrected before recording the passing run. |
| `red-race.log` → `green-race.log` | Focused delayed-worker A/B test fails because capture returns no pending job; after capture/atomic acknowledgement implementation, both tests pass. |
| `red-guest-remote.log` → `green-guest-remote.log` | Whole workspace suite: explicit guest copy missing and regressed remote layers replace newer ones (2 failed / 2 passed); atomic merge and remembered remote state produce 4 passed. |
| `red-cache-boundaries.log` → `green-cache-boundaries.log` | Whole workspace suite: missing pending accepted, reparse parent creates private directories on the share before rejection, and omitted empty remote labels cause a spurious publication (3 failed / 14 passed). Coherence validation, ancestor-before-create and canonical empty-label projection produce 17 passed. |
| `red-unsaved-private-load.log` → `green-workspace.log` | Focused conflict-load regression loses an unsaved private mask (1 failed). Persist latest personal projection before replacing own annotations; final suite passes all 20. |

Additional real-filesystem coverage exercises six local write/sync/replace interruptions, retained foreign temp files, complete recovery envelopes, malformed/foreign/versioned caches, local-only changes, delayed A → B → ack → restart → B, same-payload private B, lost acknowledgement while B is newer, lease lifetime after project exit, stale ack rejection, divergent baseline and explicit load, native foreign update/delete/history guards, immutable catalog and relink mismatch, failed identity preparation, guest channel conflicts, shared export/save-as privacy, and local save while the owned fixture manifest is temporarily unavailable. Existing ordinary-v2 persistence/fault tests remain in the full workspace run.

## Disk evidence

`private-inventory.log` records the actual relative paths and SHA256 digests from an owned temporary fixture, before and after local annotation/mask/preference changes. The shared account, manifest and media bytes and file inventory remain equal. OS lock files are inventoried but excluded from byte hashing because Windows enforces the held lock. The only three local files are `.workspace.lock`, `workspace.json`, and `workspace.recovery.json`.

Representative recorded hashes:

- Immutable shared manifest: `1e974ca49cc39f53a79973d243ad7ce3c305818cffe9d7c2f8d6d76194231505`.
- Immutable shared media: `f16d05ec6b29248d2c61adb1e9263f78e4f7bace1b955014a2d17872cfe4064d`.
- Both matching private envelopes after save: `89580997380bc71afbb1a71968212ca0384690109360f22c095472fc0fa788ca`.

The inventory run separately asserts no plaintext test password or `passwordHash` in private files. Test fixture media supplies model metadata for persistence tests; media decoding/copy validation remains existing media tests and later Task 3 creation tests.

## Verification

- `cargo test -p annotator-core --test collaboration_workspace`: PASS, 20 passed / 0 failed; `green-workspace.log` (includes final per-actor preference assertions).
- `cargo test --workspace`: PASS, 160 passed / 0 failed: 151 core and 9 native. The repository's child-only helper remains 1 ignored in the parent runner and is explicitly run by its process tests; `workspace-tests.log`. Includes 19 repository tests and the 20 new workspace tests.
- `cargo test -p annotator-core --test collaboration_workspace disk_inventory_proves_private_save_does_not_touch_share -- --nocapture`: PASS, 1 passed; `private-inventory.log`.
- `cargo fmt --all -- --check`: PASS, exit 0; `fmt.log`.
- `cargo clippy --workspace --all-targets -- -D warnings`: PASS, exit 0; `clippy.log`.
- `git diff --check`: PASS, exit 0; `diff-check.log` (only Git LF/CRLF normalization notices).

Minor implementation detail beyond the minimum envelope fields: durable in-flight payload plus an envelope sequence distinguishes acknowledgement checkpoints from document generations and makes lost-ack A/newer-B restart safe. `FileStore::atomic_replace` is reused with crate-only visibility; its implementation is unchanged. No dependencies changed.

This evidence covers Windows local-filesystem faults and the Task 1 same-directory multi-process repository checks. Physical SMB/NAS, collaboration desktop UI, frontend worker integration and release packaging are not claimed by Task 2. MAIN_BASE, old releases, user configuration and the owned target cache were not moved or modified as deliverables.

## Review corrections (supersedes initial Task 2 acceptance claims)

The first review pair did not accept `061b14267deb966457dc9f031b7df027444035a9`. Root inspection confirmed two material boundaries, both repaired within Task 2:

1. Collaborative save-as previously allowed the active shared root to receive `.project.lock`, or an empty descendant to receive the personal v2 files. It now canonicalizes the destination and rejects the shared root or descendants **before** any `FileStore::create`, lock creation, or write. Tests compare shared inventories and byte hashes and retain the current private workspace/session for root, empty descendant and Windows junction-alias destinations.
2. A failed main write could leave recovery B newer than accepted A; explicit discard previously left B available for automatic recovery and publication. Discard now atomically suppresses recovery using the complete last accepted envelope, retaining accepted pending A and its publication metadata. It remains available when storage cannot persist suppression. On reopen, unaccepted newer/different recovery or missing primary requires an explicit choice through the existing `LoadReport`/`RecoverySource`/`LocalProject::resolve_recovery` protocol. There is no active `ProjectSession`, and direct private-workspace save/capture/ack/reconcile/load APIs also reject work until resolution succeeds. Failed resolution retains the gate. The selected **full envelope**, including base, confirmed payload, pending generation, in-flight payload and preferences, is restored and atomically checkpointed; no reconstruction from the projected v2 document occurs. Recovery resolution is local-only, leaving later remote reconciliation to the worker outside the app mutex.

`red-review-boundaries.log`: `cargo test -p annotator-core --test collaboration_workspace` reproduced four failures (root save-as write, junction save-as write, discarded B resurrection after main failure, and absent explicit-choice gate under persistent failure), with 20 existing tests passing. `green-review-boundaries.log`: same suite now passes **25 tests**. Existing fault/malformed-primary tests retain their content assertions but now explicitly select the valid recovery envelope; automatic acceptance of unconfirmed recovery was intentionally removed.

New/expanded tests cover all three main write/sync/replace faults followed by discard and reopen, accepted pending A retention, failure of discard suppression, inability to edit/publish before choice, failure of choice persistence, complete accepted-checkpoint restoration, and explicit recovery of in-flight A plus newer B after lost acknowledgement without duplicate revisions. Successfully committed A/B restart behavior remains unchanged.

Review-fix final checks: `review-workspace-tests.log`, `review-clippy.log`, `review-fmt.log`, and `review-diff-check.log` contain the fresh full-workspace, strict Clippy, formatting, and whitespace results. The earlier logs and inventory evidence remain preserved as historical evidence rather than replacement acceptance evidence.

Fresh review-fix results: full `cargo test --workspace` PASS (**165 passed / 0 failed**, comprising 156 core and 9 native; 1 intentional child-only helper ignored in the parent runner); focused workspace tests PASS (**25 passed / 0 failed**); `cargo clippy --workspace --all-targets -- -D warnings`, `cargo fmt --all -- --check`, and `git diff --check` all PASS (exit 0). Root confirmed that its earlier independent privacy run was the same collaboration workspace suite, so no additional external test source was omitted. Fresh paired review is still required for the full original TaskBase-to-fix range.
