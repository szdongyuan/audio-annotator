# Task 1 — local identity and append-only catalog

Scope: core APIs only, based on `ab4c885b072420636d012c6235087f2836c87be0`. Native commands, workspace reconciliation and UI remain subsequent tasks. Raw command output is retained under `.test-output/default-collaboration-v040/task1/` in this worktree.

## Identity contract

`LocalIdentity::load_or_create(local_root: &Path) -> Result<LocalIdentity>` accepts an existing private application-data directory. It serializes initialization with an OS file lock (bounded 10-second contention wait), then reads or atomically creates `local-identity.dpapi`. Windows CurrentUser DPAPI protects the entire versioned payload, including random `@local:<uuid>` login and a 64-character random secret. No machine-wide protection flag is set; cryptographic UI is forbidden. The encrypted file is bounded to 16 KiB, decrypted identity JSON to 1 KiB. Any malformed, oversized or undecryptable existing file returns an error without replacing it. Non-Windows production returns an explicit unsupported error.

The native-only type has no `Serialize`, `Deserialize`, `Debug`, `Clone` or public field/credential constructor. `login_name()` and `display_name()` expose only public identity metadata. Compile-fail doctests protect the Serialize/Debug boundary; unit tests inspect actual encrypted bytes and public snapshots against the private random secret. Display names are `本机作者 · <8 random UUID characters>` and never inspect the OS username.

`CollaborationRepository::login_local(&LocalIdentity) -> Result<AuthorSession>` registers the persisted identity when absent, verifies it using the existing Argon2 path, and acquires the existing author OS lease. Ordinary registration rejects the reserved namespace. Passwords entered through the existing login API are still session-only. Separate local roots create distinct project authors; reopening a root uses its existing author; duplicate writable sessions fail with `ProjectLocked`.

## On-disk and repository contracts

The v2 `collaboration.json` contains exactly `kind`, `formatVersion: 2`, `projectId`, `name`, `createdAt`, `catalogVersion: 1`. It has no embedded media array. `catalog/<uuid>.json` contains exactly `kind: "audio-annotator-media-record"`, `formatVersion: 1`, `projectId`, and typed `media: PublicMedia`. Media paths remain `media/<same uuid>.<wav|flac|mp3>`. Unknown versions/fields, duplicate JSON fields, malformed UUIDs/hashes/metadata, unsafe paths and reparse points fail closed. Only complete `.json` records are visible; bounded temporary entries and unreferenced media from a crash are invisible.

Limits: 4096 media, 64 KiB per record, 16 MiB total fixed manifest plus committed record bytes, at most 4096 + 256 catalog directory entries. Existing 1–6 channel and safe integer constraints apply. Sorting by UUID gives all readers a deterministic effective manifest. Independent imports retain distinct IDs even when fingerprints match, matching existing `ImportMedia` behavior. Only retrying the same sealed capability/UUID is idempotent. This corrects the initial spec's inaccurate assumption that old imports deduplicated fingerprints; the root updated the spec and plan before this checkpoint.

The original `parse_manifest` remains strictly format1-only. `open()` dispatches to the versioned reader, with original format1 accounts, publication and immutable-manifest authority checks retained. `manifest().format_version == 2` identifies an effective v2 view; this effective struct is not the serialized fixed manifest.

API handoff:

- `create_default(root, name, &LocalIdentity) -> Result<(CollaborationRepository, AuthorSession)>`: existing empty target required. Creates directories and fixed metadata, then logs in. The caller owns its target and failure cleanup; this function never recursively deletes it.
- `manifest_identity() -> &str`: exact fixed-manifest SHA-256; unchanged by catalog growth. `catalog_revision() -> Option<&CatalogRevision>` returns `{ media_count, byte_length, digest }` for v2 and `None` for v1. Digest binds sorted media IDs and record-byte hashes.
- `reload_catalog() -> Result<CollaborationRepository>`: returns a new view without mutating the original; rejects changed/deleted previously loaded descriptors and changed fixed metadata. Existing author leases remain valid for the new same-project view.
- `prepare_media(source, cache_root, cancel)` / `prepare_media_with_progress(source, cache_root, cancel, progress) -> Result<PreparedCatalogMedia>`: independently decodes and fingerprints real audio, streams a verified copy to caller-owned hidden staging, validates source identity, and retains its PCM. All copying/hashing occurs before the catalog commit lock. Progress forwards decoder phases and adds `copyMedia` byte counts. Cancellation/source changes clean only owned staging. No raw descriptor can construct this sealed capability.
- `PreparedCatalogMedia::media() -> &PublicMedia`, `decoded() -> Arc<DecodedMedia>`: prepare **before** the native Ready event, so Ready ID, pending item key and committed media UUID agree. The decoded source binding is still the original path. After commit native can construct its shared registry binding with returned `PublicMedia::descriptor()`, shared source path, its stamp, and the retained PCM; no second decode is required. Do not first decode through the old flow and then call preparation, which would intentionally create a different import identity.
- `append_media(&AuthorSession, &PreparedCatalogMedia, cancel) -> Result<PublicMedia>`: verifies matching repository/actor authority and source/staged bytes. A short catalog OS lock rechecks current count/byte budget and UUID identity, moves verified media without replacement, then atomically publishes the record. No application-state mutex is acquired by core. Before-record failures return precisely this invocation's media to its staging. After-record failures/lost acknowledgment preserve the committed media and record; retry with the same capability returns success even when cancellation subsequently arrives. Never drop and recreate the capability to retry a potentially committed item.
- `append_media_controlled(..., Option<PublishFault>)`: same production publication path with existing deterministic partial-write, sync, rename, cancellation and post-publication boundaries.
- `snapshot_with_catalog() -> Result<CatalogSnapshot>`: returns `snapshot`, `catalog_update_available`, current `revision`, and full `deferred_authors`. It validates author layers against the current verified catalog, then stages complete layers that need media outside the caller's loaded catalog. It does not filter/rewrite/re-publish payloads. Known-media layers continue to synchronize; actual unknown-media references remain corruption. Existing payload bytes/hashes remain unchanged because omitted labels already project to empty defaults.
- `snapshot()` compatibility consumers get an explicit `RevisionConflict` with `details.catalogUpdateRequired: true` for deferred authors. Existing `RememberedLayers` retains their last verified displayed layer. Catalog-aware callers must use the outer update flag/full deferred results and explicitly adopt later; core never mutates the live workspace during polling.

## Executed TDD and verification

Observed RED/GREEN pairs:

- `identity-red.log` / `identity-green.log`: absent LocalIdentity API failed compilation, then three real Windows identity tests passed.
- `catalog-red.log` / `catalog-green-initial.log`: absent catalog APIs failed compilation, then six initial behavior tests passed.
- `stale-snapshot-red.log` / subsequent `catalog-green.log`: legacy snapshot initially had no explicit deferred status; regression failed, then catalog suite passed with `catalogUpdateRequired` behavior.
- `native-capability-red.log` / `native-capability-green.log`: absent retained decoded-resource accessor failed compilation; same-UUID/Arc reuse passed after implementation.
- `copy-red.log` / `copy-green.log`: absent progress API failed compilation; real mid-copy source replacement and cancellation then passed with exact-owned cleanup.
- `duplicate-policy-red.log` / `duplicate-policy-green.log`: independent same-byte import incorrectly returned the first UUID; updated contract regression failed, then passed with distinct identities.
- `catalog-budget-red.log` / `catalog-budget-green.log`: oversized aggregate catalog was initially accepted; regression failed, then passed with bounded reads and commit budget checks.

`cargo test -p annotator-core` completed with 176 passed (including two compile-fail doctests), 0 failed, 2 ignored subprocess entry points. The ignored entry points were actually launched by parent tests. This broad run preceded only the final aggregate-catalog-budget addition; `core-final.log` records exit code 0. Current-code focused verification is recorded separately below.

The tests use actual Windows DPAPI, OS locks, separate subprocesses for concurrent independent catalog appends, forced termination of an owned lock-holder process, real NTFS junctions, filesystem partial publication faults, source modifications, and 4096 actual records/media files. They also test unknown layer media, changed old descriptors, malformed records and original format1 compatibility. Physical SMB/NAS and distinct Windows-account DPAPI isolation were not exercised here; they remain environment-specific delivery verification.

Final current-code commands:

| Command | Actual result | Raw output |
| --- | --- | --- |
| `cargo test -p annotator-core --test collaboration_defaults --test collaboration_catalog --test collaboration_repository` | 36 passed (3 identity + 14 catalog + 19 legacy repository), 0 failed, 2 worker entry points ignored; exit 0 | `focused-verified.log` |
| `cargo fmt --all -- --check` | Pass, exit 0 | `fmt-final.log` |
| `cargo clippy -p annotator-core --all-targets -- -D warnings` | Pass, exit 0 | `clippy-final.log` |
| `git diff --check` | Pass, exit 0 | terminal observation |

Implementation deviations: made the existing `atomic::no_replace` helper `pub(crate)` to reuse its write-through/no-overwrite media publication rather than duplicate it. No model/accounts DTO change was required; reserved-name enforcement and auto-registration live at repository authority boundaries. No dependency upgrade; only the pinned windows-sys DPAPI/Foundation feature flags changed. No user data migration or native/UI behavior was enabled.

## Task1 review fix pass

Read and followed `D:/Work/annotator/.agents/skills/systematic-debugging/SKILL.md`. Two deterministic reproductions confirmed the review findings before fixes:

1. A catalog was captured, then another writer appended media and published an author head before that head was read. The old code returned `catalog_update_available: false`, no deferred layer, and a normal unknown-media validation error. `snapshot-race-red.log` records the failure. A sustained-growth variant also failed (`snapshot-growth-red.log`). The reader now brackets author reads with catalog captures and retries if the catalog changed. A stable reread returns the complete verified deferred layer and update flag. Three continuously changing attempts return a top-level retryable `RevisionConflict` with `details.catalogUpdateRequired: true`, retaining the caller's previous snapshot rather than reporting a corrupt author. True unknown-media references still fail author validation when the catalog is stable. Both RED tests passed after this change (`snapshot-race-green.log`, `snapshot-growth-green.log`).
2. Media placement succeeded but catalog publication and rollback failed, or execution returned immediately after placement. A retry previously failed on missing/foreign staging (`orphan-retry-red.log`, two failures). The sealed prepared capability now keeps a handle to the original staged file. Recovery locates that exact OS file identity at staging or the final UUID path and validates its full fingerprint before committing; it never adopts a same-byte replacement file. It rechecks source stamp, cancellation and author/project authority, and preserves already committed lost-ack behavior. Failure to prove ownership returns retained recovery state via `details.mediaRecoveryRequired` and `mediaId`. Rollback and Drop also check ownership before moving/removing a path, so a foreign file occupying an old staging name is preserved. Both reproductions passed, including the same-byte substituted-target negative branch (`orphan-retry-green.log`). A separate guard test verifies cancellation, foreign project authority and changed source still block orphan publication.

The ownership handle is intentionally native and process-local. Retries must retain the same prepared capability; after process termination, unreferenced media remain invisible and are not silently adopted or deleted by a newly constructed capability. Native runtime nonce validation remains a Task3 caller obligation. Deterministic seams `snapshot_with_catalog_interleaved` (after each catalog capture) and `append_media_interleaved` (after placement, before record publication) exercise the same production paths without sleeps or random timing.

Final fix-pass validation:

- `cargo test -p annotator-core --test collaboration_defaults --test collaboration_catalog --test collaboration_repository`: **41 passed** (3 identity, 19 catalog, 19 legacy repository), 0 failed, 2 subprocess entry points ignored; exit 0. `review-fix-focused.log`.
- `cargo fmt --all -- --check`: pass, exit 0. `review-fix-fmt.log`.
- `cargo clippy -p annotator-core --all-targets -- -D warnings`: pass, exit 0. `review-fix-clippy.log`.
- `git diff --check`: pass, exit 0.

No Task2+ code was changed.

## Additional catalog boundary review

The root identified two further Task1 contract defects before the next paired review. Both were investigated through deterministic filesystem regressions:

- `transient-entry-red.log` reproduces a `.tmp` disappearing between `read_dir` yielding its entry and the reader inspecting its path. The reader previously failed with missing-file I/O. It now classifies temporary names before requiring their paths to exist, tolerates `NotFound` for those temporaries only, and still checks the catalog ancestors and rejects existing temporary reparse points. Committed record disappearance remains an error. The expanded test passes in `transient-entry-green.log`, including a real NTFS temporary junction and a deleted committed record. `open_catalog_interleaved(root, after_entry)` provides the deterministic enumeration boundary while `open()` uses the same implementation without a hook.
- `entry-capacity-red.log` reproduces 4095 real records + `.commit.lock` + 256 retained temporary files (4352 directory entries). The old writer returned success for another media record, creating an unreadable 4353-entry catalog. The writer now reserves one entry for the temporary/final catalog record under the commit lock, using the same limit as the reader, before media placement. It neither removes foreign temporaries nor changes source media. The test checks rejection at capacity, retained files/source, then removes only its own test fixtures and retries the same prepared capability to reach a readable 4096-media catalog.

This adjustment only exposes the existing atomic reparse-metadata predicate at crate visibility; it does not weaken committed-file path checks or modify later-task code.

Final boundary-fix validation, covering every current focused test:

- `cargo test -p annotator-core --test collaboration_catalog catalog_collection_limit_and_record_versions_are_enforced`: 1 passed, 0 failed, exit 0 (`entry-capacity-green.log`, 103.79 seconds).
- `cargo test -p annotator-core --test collaboration_defaults --test collaboration_catalog --test collaboration_repository -- --skip catalog_collection_limit_and_record_versions_are_enforced`: 41 passed (3 identity + 19 other catalog + 19 legacy repository), 0 failed, 2 subprocess entry points ignored and the one just-verified capacity test filtered, exit 0 (`catalog-boundaries-focused.log`). Together these runs cover **42 passing current focused tests**; the expensive exact-capacity case was not rerun unnecessarily.
- `cargo fmt --all -- --check`: pass, exit 0 (`catalog-boundaries-fmt.log`).
- `cargo clippy -p annotator-core --all-targets -- -D warnings`: pass, exit 0 (`catalog-boundaries-clippy.log`).
- `git diff --check`: pass, exit 0.
