# UUID identities — Task 2 backend evidence

Task base: `8039384c76f44c7db53f3019d7c6afe10fbd26a7`. Scope is the coupled backend slice only. Frontend compatibility, actual desktop UI acceptance, version bump and delivery remain Tasks 3/4. All raw logs are under `D:/Work/annotator/.test-output/uuid-identities`.

## Core contract

`CURRENT_COLLABORATION_FORMAT = 3`. The persisted manifest retains `catalogVersion: 1`; media catalog records, author layers and private envelopes retain their existing versions. Ordinary `ProjectDocument` and exchange documents remain version 2. Repository open rejects collaboration versions 1/2 with `UnsupportedVersion` before creating directories, locks or identities in that project. No migration is performed.

Public author JSON is `authors/<canonical UUID>.json`: `{kind:"audio-annotator-author",formatVersion:1,projectId,identity:{authorId,displayName,createdAt}}`. Maximum 128 records, 8 KiB per record, bounded directory enumeration. The 8 KiB budget intentionally accommodates a valid 4 KiB portable profile plus project/header fields. `CollaborationRepository::adopt(&Profile)` uses the exact global UUID, refreshes its metadata and obtains the existing author writer lease. `refresh_author(&AuthorSession,&Profile)` changes metadata using atomic replacement. Session authority checks project/root/UUID, valid associated record and the held lease; nickname equality is not authority.

The obsolete account/password/DPAPI implementation and commands are removed, including Argon2 and its now-unused lockfile dependencies. `atomic::short_lock` replaces the retired module's lock helper. Existing DPAPI bytes are neither read nor modified. Shared file publication, catalog append, private root/project/author layout, payload revisions, masks, playback preferences and hidden media behavior are retained.

Profile timestamps deliberately keep Task 1's contract: a string ending in `Z` accepted by `chrono::DateTime::parse_from_rfc3339`. This includes long fractional seconds and accepted leap-second spellings. Task 3 must not reuse the old 64-character / JavaScript date-roundtrip restriction. A new core test uses an exactly 4096-byte portable profile, whose valid author record exceeds 4096 bytes. Nicknames keep 1–64 Unicode scalar values, 256 UTF-8 bytes, trimmed and without control characters.

## Native IPC for Task 3

Registered commands:

- `profile_list()` → `ProfileSnapshot`.
- `profile_create({expected,operationId,displayName})` → `ProfileResponse`.
- `profile_rename({expected,operationId,authorId,displayName})` → `ProfileResponse`.
- `profile_select({expected,operationId,authorId})` → `ProfileResponse`.
- `profile_import({expected,operationId,path: string|null})` → `ProfileResponse`.
- `profile_export({expected,operationId,authorId,path: string|null})` → `ProfileResponse`.

Pickers belong to the frontend; null path represents picker cancellation and has no persistence/file effect. `operationId` is nonempty and at most 128 bytes. Existing `collaboration_cancel({operationId})` cancels the admitted native operation. Author selection accepts an existing store UUID only. All commands work without an open project.

```ts
type Profile = { authorId: string; displayName: string; createdAt: string };
type ProjectExpectation = { projectId: string; expectedRevision: number };
type ProfileExpected = {
  storeRevision: number;
  runtimeNonce: string;
  project: ProjectExpectation | null; // required, including explicit null
};
type ProfileSnapshot = {
  storeRevision: number;
  selectedAuthorId: string; // this process; never substitute persisted last-selected
  profiles: Profile[];
  runtimeNonce: string;
  project: ProjectExpectation | null;
};
type ProfileResponse = {
  profiles: ProfileSnapshot;
  transition: { opened: OpenProject; status: CollaborationStatus } | null;
  status: CollaborationStatus | null;
  warning: AppError | null;
  profile: Profile | null;
  alreadyExists: boolean;
};
```

`profile` identifies the created/imported/renamed entry. Creation/import do not select. Duplicate import returns the retained local entry and `alreadyExists: true`, without overwriting metadata. Export uses a revision-checked immutable metadata capture and create-new publication; it never overwrites a destination. Import reads/validates completely outside the live project mutex, then commits only local metadata. Export destination I/O also runs outside that mutex, with the existing cancellation-aware atomic publisher.

`transition` is present only when selecting a different profile in a writable collaboration project. `status` supplies an immediate active-project display refresh after rename, without replacing the editor/history. Same UUID selection returns neither and is a true no-op. Selection in an ordinary/view-only project updates only the global selection; project runtime, actor and document remain unchanged. A real process selection always advances store revision, even if another process has already saved the same launch preference; otherwise stale projectless/view-only requests could survive a selection change. The original core `select()` remains byte-preserving when its persisted preference is unchanged.

Collaboration `identityMode` is now `ordinary | profile | viewOnly`; `projectFlavor` is `ordinary | default`. The collaboration status envelope's own `formatVersion` remains 1. `AuthorIdentity` contains exactly the three profile fields, with no `normalizedLogin`. The actor remains nullable and distinct from global selection. `collaboration_identity`, `collaboration_publish_guest`, credential DTOs and guest-copy code are removed. `collaboration_create` no longer accepts credentials; it uses the process-selected profile. Load-shared, preferences, sync, cancellation and project-copy commands remain.

## Commit and failure semantics

The service captures its active UUID separately from persisted `lastSelectedAuthorId`. List refresh and other-process selections never rebind it. Writable collaboration new/open, ordinary-project collaboration copy, Save As and exchange import obtain the service-selected profile. Ordinary and explicit view-only opens also initialize/load global profile state before installing a project; view-only never adopts a writer profile. A corrupt profile store is reported instead of inventing an identity.

Selection acquires the existing lifetime-bound collaboration permit. It checks store revision, runtime nonce, nullable project identity/revision, unsaved state and publication/recovery barriers. Target author lease and workspace are prepared while retaining the old editor. It then rechecks runtime/cancellation and acquires live project/runtime/selected/source/prepared/media/folder locks. Retained source previews, prepared media, active/pending media tasks, retained folder previews and the separate preparation slot block selection. Response DTOs and replacement runtime are prepared before durable selection. After `select_for_process` succeeds, only infallible assignment/reset operations remain; it does not call fallible `Service::install` or `info_shared` after persistence.

Failed target lease, corrupt target workspace, profile-file replacement, cancellation, stale store/runtime/project or current unsaved/unpublished state retain the old UUID and project. Preparing a target may leave an unused empty author record, as allowed. No categories, annotations, notes, masks, preferences or history are copied between UUIDs.

Rename commits the local metadata first. A writable current project refresh is best effort. Failure returns `warning.message = "昵称已保存在本机，项目显示名称未更新"` and `warning.details.cause` with the original error, while the committed profile and editor remain usable. Local actor display updates without reacquiring the author lease. Subsequent writable open/use retries public metadata refresh. No other projects are scanned or written.

## Tests and sequencing

Core RED: `cargo test -p annotator-core --test uuid_authors` failed on missing profile adoption/metadata-refresh APIs and old constructor type (`native-core-authors-red.log`); implementation then passed (`native-core-authors-green.log`). Old account/DPAPI fixtures were adapted to explicit profiles and format-3 catalog fixtures. Removed assertions cover only retired password/DPAPI contracts, legacy catalog order and guest-copy semantics; corruption/recovery, private state, source copy, author isolation, bounded enumeration, real-process writer contention, catalog immutability and publication retry assertions remain.

Native compile wiring and command scaffolding preceded compilation of the complete new native test suite because retirement of concrete credential DTOs temporarily broke existing tests. This is a procedural deviation from strict test-first sequencing for every new command; no claim is made that every individual command had an initial RED. The suite did expose and preserve genuine behavioral RED/GREEN cycles:

- Stale store revisions during same-UUID no-op/export: `native-profiles-red.log` (6 passed, 1 failed), fixed by revision-checked captures/checks.
- Retained folder preview admission: `native-profile-folder-red.log` (1 failed), fixed by checking retained folder work before selection.
- Ordinary/view-only initialization: `native-profile-open-red.log` (1 failed), fixed by loading global profile state for every project open before installation.
- Process selection when the persisted launch preference already matches: `native-profile-process-red.log` (1 failed), fixed by recording the actual process selection with a fresh store revision.

Focused profile suite before the final open-initialization regression: 9 passed (`native-profiles-final.log`); the final full native run covers all 10 profile tests. It covers no-project management/portable transfer/cancelled paths, duplicate import, independent running processes, stale guards/corruption, same-UUID history retention, unsaved/unpublished refusal, writer and corrupt-workspace preparation failures, retained work, cancellation/old runtime, real Windows profile replacement failure, partial rename warning, and ordinary/view-only preservation. Fault injection uses actual deny-delete Windows file handles and bounded existing hooks; no production mock success path was added.

Verification at the initial Task 2 checkpoint `ea5fd703ae2a3ecacc73f1c7479600eca7f8bc50`:

| Command | Observed result | Log |
| --- | --- | --- |
| `cargo test --workspace` | Exit 0; 297 passed, 0 failed, 4 existing ignored | `native-workspace.log` |
| `cargo test -p annotator-desktop --features e2e --lib` | Exit 0; 70 passed | `native-e2e.log` |
| `cargo fmt --all -- --check` | Exit 0 | `native-fmt.log` |
| `cargo clippy --workspace --all-targets -- -D warnings` | Exit 0 | `native-clippy.log` |
| `git diff --check` | Exit 0; expected repository LF/CRLF warnings only | `native-diff-check.log` |

The final workspace suite includes three `uuid_authors` tests and the 15 retained profile-store tests. Earlier regression logs retain obsolete-fixture failures and their corrections; `native-workspace-before-final-guards.log` is an intermediate passing run before the final process-selection guard. No frontend/UI usability or delivery claim is made by this checkpoint.

Strict clippy initially reported two redundant `ErrorCode::clone()` calls (`native-clippy-initial.log`); they were removed without changing behavior and strict clippy then passed.

## Spec-review repair: coherent list snapshots

The spec review found that `profile_list` could read selected UUID A, allow an A→B selection commit, and then read B's store revision/runtime/project. That mixed response could mislabel the active author while carrying valid mutation expectations. The original review base remains `8039384c76f44c7db53f3019d7c6afe10fbd26a7`; this repair starts from the initial Task 2 checkpoint above.

List now initializes the process identity before authority locking, discards that initial metadata read, and captures its actual selected UUID, store snapshot, runtime and project under `current → runtime → selected` guards—the same order as selection commit. The guards remain held through DTO construction. `selected_profile()` is never called while holding its internally acquired `selected` mutex. The captured selected UUID is also checked against the captured profile list. Another process changing persisted last-selected still does not rebind this process.

A deterministic test-only hook pauses list after initial identity access. Selection completes while list is paused, then list resumes and must return the complete B tuple. This exercises empty, ordinary, view-only and writable projects; the first three retain their runtime nonce, so nonce-only coherence would not pass. Channel waits are bounded to 10 seconds, without timing sleeps or polling.

Repair verification:

- RED: `cargo test -p annotator-desktop --features e2e --lib profiles_list_snapshot_is_coherent_with_concurrent_selection` reproduced the wrong selected UUID on the empty-workspace case; `native-profile-list-coherence-red.log`.
- GREEN: the same focused regression passed all four project-mode cases; `native-profile-list-coherence-green.log`.
- `cargo test -p annotator-desktop --features e2e --lib profiles`: 11 passed, including process independence; `native-profile-list-fix-focused.log`.
- `cargo test -p annotator-desktop --features e2e --lib`: 71 passed; `native-profile-list-fix-e2e.log`.
- `cargo fmt --all -- --check`: exit 0; `native-profile-list-fix-fmt.log`.
- `cargo clippy --workspace --all-targets -- -D warnings`: exit 0; `native-profile-list-fix-clippy.log`.

This repair changes only native list capture, its test hook/regression and documentation. Core implementation is unchanged, so the prior full workspace/core result remains recorded above; the affected complete native suite was rerun. This repair followed RED/GREEN sequencing without an additional deviation.

Fresh paired spec and quality reviews passed over the full original Task 2 range ending at `394b7b9476f9d322be5166a9275af596bcc998f1`. Root independently reran all 11 native profile tests (exit 0, `root-native-profiles-final.log`). No main integration, push, release write, NAS write, dependency-junction removal, or Task 3/4 work is claimed by this checkpoint.
