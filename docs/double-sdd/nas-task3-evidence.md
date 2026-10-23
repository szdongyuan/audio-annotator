# NAS collaboration Task 3 evidence

Date: 2026-10-23. Worktree: `D:/Work/annotator/.worktrees/nas-collaboration-v030`.
TaskBase: `652f0dde2d1bc4666ce34f978c7a88460aab90c0`.
Immutable MAIN_BASE: `bb9ff6a5428fad531507738a99eb6a3f82f76fdd`.

## Implemented boundary

Task 3 implements the native runtime, project opening/creation, author lifecycle, synchronization, preferences, guest-copy and explicit conflict loading. It does not implement the Task 4/5 collaboration UI, overlays, a two-second frontend timer, version changes, or release packaging. The complete Task 4 handoff is [nas-task3-protocol.md](nas-task3-protocol.md).

Production setup obtains `app_local_data_dir` from Tauri AppHandle. Only an e2e build can read `ANNOTATOR_E2E_LOCAL_DATA`; unit tests inject their own root. Shared project opening detects the strict collaboration entry and starts guest. Read-only ordinary preflight prevents an unknown account JSON or shared subdirectory from creating a `.project.lock`, while preserving ordinary missing-primary recovery. Shared `OpenProject` includes an atomically captured nonce/actor/preferences context; ordinary OpenProject and ProjectSnapshot shapes remain unchanged.

Native identity capabilities remain opaque `Arc<AuthorSession>` values held inside the private workspace/captured publication, never renderer author IDs. Native nonce checks cover shared project mutations and reads, media import/relink/status/scan admission, playback configure/control/status, analysis request/view admission, and exchange operations. They reject delayed work even when actor A and actor B have equal project IDs and revisions. Identity adoption, recovery, and explicit conflict load return snapshot plus the matching new nonce; callers must retain it in an immutable per-ActiveProject adapter.

A service-wide collaboration permit bounds sync/identity/copy/layer jobs across retired runtimes. Retirement cancels adoption but does not free the permit while the actual blocking worker is alive. Argon2, repository reads/publication, creator audio decoding/copying and guest-cache opening run outside `AppState.0`. Local save persists only the private envelope, then schedules one attempt. A refresh captures durable pending, publishes before reading a fresh snapshot, and reconciles only after checking nonce/cancellation. An old prepare sync error cannot prevent a read that clears it; actual local capture/write errors remain visible. Guests are local-only, not network-pending. Own divergence requires explicit load, and foreign errors/missing/regressed layers retain prior verified content.

Acknowledgements update the envelope checkpoint without assigning its saved document back into the live session. A delayed A publication can complete after saved B and unsaved C: the document remains C, the envelope remains B, baseline becomes A, and B stays pending. Own refreshes never replace personal history. Existing private-workspace recovery gates retain their complete envelope and deny edits/publication until choice.

Creation reads a saved ordinary project, verifies and copies original WAV/FLAC/MP3 bytes to UUID names, registers/publishes the creator in owned staging, transfers only to no-clobber destinations, verifies final copied fingerprints, and publishes the final collaboration.json last. The author reauthenticates against the final canonical root. Original personal operations initialize only the creator's private cache; public payloads contain only annotations. Copy progress is throttled, cancellation checks run through decoding/copy/publication, and unadopted copies retain an ownership guard until successful adoption. Rollback releases the author lease first and removes exact owned files/directories without recursively deleting a target or deleting unknown foreign files.

Shared catalog import/scan is rejected before starting asynchronous work; commit still uses guarded LocalProject. Relinks retain the fingerprint/metadata checks, with source verification outside the global mutex. Shared exchange snapshots are sanitized. A private relink can be used as the native bundle byte source, but PortableMedia never serializes sourceRef. Ordinary full export behavior remains intact. Archive import now captures authority, performs long I/O outside the global mutex, and rechecks project/revision/runtime before adoption. Shared save-as continues to use the Task 2 personal-copy boundary and exits collaboration only after success.

## RED / GREEN evidence

Raw logs are ignored under `.test-output/nas-task3/`.

| Logs | Observed result |
| --- | --- |
| `red-runtime.log` → `green-runtime.log` | The single-flight lifetime test initially cannot compile because the new Service does not exist; after adding the runtime, the retired-worker permit test passes. This is an absent-API RED, not a runtime assertion failure. |
| `red-creation.log` → `green-creation.log` / `creation-final.log` | Creator-copy test invokes an explicit not-implemented boundary and fails; completed creation passes. The final focused suite also passes real WAV/FLAC/MP3 copies, fingerprints, cancellation, source mismatch, private masks/export sanitization, existing-target refusal and exact ownership rollback. |
| `red-native-boundaries.log` → `green-native-boundaries.log` | Two real regressions fail: an unknown shared account JSON creates `.project.lock`, and own remote divergence replaces the live document. Read-only preflight and observation-only reconciliation make all seven initial native tests pass. |
| `red-missing-entry.log` → final native/full suite | Missing project.json path fails even with valid recovery; known entry resolution now preserves that ordinary recovery path. |
| `red-status-errors.log`, `red-capture-error.log` → `green-status-errors.log` | Guest data incorrectly appears network-pending, then a local capture failure is incorrectly cleared by a successful repository read. Actor-aware pending and distinguishing prior sync errors from local capture errors fix both assertions. |

Broader native checks were added as integration/characterization coverage alongside the foundational implementation; an individual RED run is not claimed for every adapter. One real-media test initially used a region longer than the short fixture; its bounds were corrected to half the actual media duration before the passing run. This is test-fixture correction, not a product regression.

## Final verification

- `cargo test --workspace`: PASS, **182 passed / 0 failed** (156 core + 26 native). The 26 native tests include **17 new collaboration tests**. One core child-only helper remains ignored in the parent harness and is explicitly invoked by process tests. Raw: `workspace-tests.log`.
- Root independently reran `cargo test -p annotator-desktop commands::collaboration`: PASS, **17 passed / 0 failed**; `root-native-verification.log` (reported by root after reviewing the final IPC report).
- `cargo test -p annotator-desktop commands::collaboration::creation`: PASS, 3 tests. This focused follow-up expanded the already-passing creator test to WAV, FLAC and MP3 without changing production code; `creation-final.log`.
- `cargo clippy --workspace --all-targets -- -D warnings`: PASS; `clippy.log`.
- `cargo fmt --all -- --check` and `git diff --check`: PASS; `fmt.log`, `diff-check.log` (Git emits only LF/CRLF normalization notices).
- `npm.cmd test`: PASS, **309 tests / 40 files**; `frontend-tests.log`.
- `npm.cmd run build`: PASS (typechecks plus Vite production build); `frontend-build.log`. Existing large notices-chunk warning remains unchanged.
- `npm.cmd run tauri -- build --debug --no-bundle --features e2e --config src-tauri/tauri.e2e.conf.json`: PASS, fresh binary; `debug-build.log`.
- `node tests/desktop/collaboration-native.test.mjs`: PASS through the actual freshly built Tauri binary and owned Selenium/WebView2 session; `native-ipc.log`, final fixture `ipc-MfDa08/report.json` and driver log. Harness retained its unknown-port refusal and owned-PID teardown. Edge/WebView2 version is 155.0.4283.62; only one GUI ran at a time, and all owned processes/ports were released.

Native tests use independent AppState sessions and private data roots over one actual filesystem repository. They cover A/B isolation, wrong credentials and same-author lock denial, private/default preferences, native guest copy/undo, catalog admission, stale capability input, delayed A/B/C, permit retention across retirement, published old callbacks after new adoption, cancelled identity, explicit own conflicts, offline/reconnect, corrupt foreign snapshots and last-good retention. Existing full-workspace tests retain private recovery, multi-process locks/no-clobber, selected-channel DSP and ordinary-v2 fault coverage.

The final real IPC run executes saved-source WAV creation/progress/hash validation; Alice logout; guest editing; wrong-password preservation; Bob registration and native guest copy; own publication and independent author visibility; stale project/playback/analysis rejection; preferences; owned-manifest offline simulation and finally restoration; reconnect publication; close/reopen/login; validated private relink; JSON/full ZIP export with the shared original temporarily unavailable; ordinary ZIP import; owned private-primary corruption and full-envelope recovery with a new nonce; and unknown account JSON rejection before any shared lock file appears. It does not claim collaboration UI acceptance.

## Recorded bytes and limits

`inventory.json` records final shared/private relative inventories and hashes. Shared output contains only the manifest, immutable original media, accounts, author versions and protocol locks; guest/Alice/Bob private caches are beneath the injected local root.

- Final fixture manifest SHA256: `863f297538d86a1b4bbaeee96c719e02dc8c1bd5f592d9a8b31c1deafc156ee9`.
- Copied WAV and original expected SHA256: `192d1008c5d0f6d58a9f917d27eee6dcebe3992501f2c994750f4601ba79d34e` (equal after offline/relink/export/recovery operations).
- Fresh e2e debug EXE SHA256: `f1d0ba880561c87871f96c6d3f04b8ff015a65deb419683ead64b4d51b8214ed`.

This verifies Windows same-directory native sessions, existing core multi-process repository tests, deterministic native worker delays and owned filesystem fault simulation. Physical SMB/NAS hardware, simultaneous multi-window collaboration UI, and the 0.3.0 release are later acceptance work and are not claimed here. No main checkout, old release, user configuration, or target-cache relocation was performed.
