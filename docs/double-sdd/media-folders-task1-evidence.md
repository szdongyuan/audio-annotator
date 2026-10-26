# Task 1 implementation evidence: shared organization head

TaskBase: `f05f0eb3256c870a99d52fe4b12f2060f570f244`. Main base: `49d016326cfa12cf498b82aff771f57e854c2c28`. Worktree: `D:/Work/annotator/.worktrees/media-folders`. Raw command logs: `D:/Work/annotator/.test-output/media-folders/task1-*.log`.

Task 1 implementation checkpoint only. Parent spec/code and quality reviews remain pending. No Task 2 native commands, discovery/parser changes, bridge or UI were implemented.

## Storage boundary and invariants

- New collaboration projects use collaboration format 4, catalog version 2, immutable media record version 1, and a required project-bound `organization.json` (kind `audio-annotator-organization`, format version 1). Ordinary ProjectDocument2 and exchange2 are unchanged in this slice. Old collaboration 1/2/3 is rejected without rewriting bytes.
- Organization contains revision/layoutRevision, stable folder IDs with nullable parent IDs and logical names, and exactly one membership/originalFilename per committed media UUID. Root is implicit. IDs are canonical/non-nil; required nullable fields cannot be omitted. Folder/member references, cycles, sibling lowercase collisions, counts, depth, names, controls, basename rules and safe-integer revisions are validated.
- Bounds: 10000 folders, 10000 media, 16 folder levels, 16 MiB serialized organization head. Folder names: 1–128 Unicode scalars/512 bytes and trimmed; original filenames: 1–255 scalars/1024 bytes. Both reject separators, controls and dot/dot-dot names.
- Catalog storage reads capture the head once through the existing bounded-handle reader before enumerating records. Only that immutable capture determines visible UUIDs. Referenced records/raw files must exist and validate. Canonical regular unreferenced record files are not opened, hashed, exposed or removed. Directory enumeration is capped at 100000 total entries; referenced record reads retain the 65536-byte/per-record and 16 MiB aggregate catalog budget. Unknown names, links/reparse entries and directory-shaped control/record files fail closed. Temporary names may disappear during concurrent publication.
- The catalog digest still hashes sorted `(media UUID, exact stored record hash)` pairs; byte length includes the immutable manifest and committed records only. Folder-only commits do not change catalog revision or cause catalog adoption.
- Under `catalog/.commit.lock`, append validates the current captured head/catalog and native sealed layout, resolves additive paths, places owned raw bytes, publishes/reuses the exact immutable media record, and atomically replaces the organization head last. Head replacement is the sole visibility commit. Precommit errors retain the old head bytes and visibility. A committed replacement remains final after a lost acknowledgement or late cancellation; UUID retry returns the current committed membership without replaying an old folder path.
- Existing source-stamp, staged fingerprint, Windows read-only identity-handle and lease checks remain. Known owned media can be returned to its owned staging name before record publication; a failed head write can retain an invisible immutable record/raw placement for the same capability's safe retry. No read or write performs broad orphan cleanup. Drop cleanup still verifies the exact owned staged-file identity.

## Core API for later tasks

Public types are under `annotator_core::collaboration::organization`:

- `Organization`, `Folder`, `MediaMembership`, `OrganizationOperation`, `NativePlacementPlan`, `MAX_ORGANIZATION_BYTES`, `MAX_FOLDERS`.
- `Organization::empty(project_id)`, `parse(bytes, project_id)`, `validate()`, and pure `apply(operation) -> Result<Organization>`.
- Operations: `CreateFolder { id, parent_id, name }`, `RenameFolder { id, name }`, `MoveFolder { id, parent_id }`, `RemoveFolder { id }` (empty only, all memberships count), `MoveMedia { media_id, folder_id }`. Wire discriminant `type` and fields use camelCase. Manual operations advance revision and layoutRevision together.
- `CollaborationRepository::organization() -> &Organization` is the repository's immutable captured head. `read_organization() -> Result<Organization>` reads/validates a fresh project-bound head without adopting a catalog or modifying personal state.
- `apply_organization(&AuthorSession, expected_revision, operation) -> Result<Organization>` takes the existing catalog commit lock and revalidates the author lease/current full catalog. A stale expected revision returns `RevisionConflict` with `details.currentRevision`; successful publication returns the next head and does not mutate the caller's captured repository.
- `seal_media_placement(layout_revision, target_folder_id, relative_folder_segments, original_filename) -> Result<NativePlacementPlan>` validates a fresh layout capture, destination and generated path. `NativePlacementPlan` has private fields, no serde/DTO constructor and no Clone. It binds project/layout/target/segments/native filename. The source task must retain this authority; frontend descriptors do not carry it.
- `PreparedCatalogMedia::with_placement(plan)` consumes/attaches the native authority before publication. Existing `prepare_media`, `prepare_media_with_progress` and `prepare_media_copy` remain compatible root-placement wrappers. They capture a current layout and native filename; copy uses the existing native display-name last component and verified-byte extension when missing, or a deterministic media UUID fallback for invalid legacy names.
- Existing `append_media*` APIs publish through the head. `append_media_with_catalog*` returns a repository containing the exact committed organization/catalog capture. A committed retry is recognized before source/cancel/layout checks and therefore retains the media's current placement after later manual movement.
- `PublishFault::BeforeRecord` and `AfterRecord` bracket record publication; the existing PartialWrite/Sync/Rename/CancelAfterWrite/AfterPublish fault points now exercise the head publication boundary for append. `AfterPublish` means the disk commit is already final even when the API simulates lost acknowledgement.

`catalog_storage.rs` owns bounded catalog reads and envelopes; organization model/validation/repository are focused submodules. `catalog.rs` is smaller than its TaskBase version despite publication integration.

## RED/GREEN evidence

1. `cargo test -p annotator-core --test organization`: initial missing organization API failed (`task1-organization-red.log`). After minimal initial wiring, head tests failed at runtime because membership was absent and orphan records were visible (`task1-head-red.log`). Organization/head implementation passed all initial four tests (`task1-organization-green.log`).
2. Directory-shaped ignored `.tmp` entry was incorrectly accepted; `cargo test -p annotator-core --test organization directory_entries_cannot_impersonate_ignored_control_files` failed (`task1-unsafe-red.log`). Regular-file validation fixed it; organization suite passed (`task1-unsafe-green.log`).
3. Stale native placement sealing returned InvalidInput instead of RevisionConflict; focused test failed (`task1-sealed-red.log`). Explicit conflict fixed it; organization suite passed (`task1-sealed-green.log`).
4. Legacy extensionless copy with an original `.wav` name became `.wav.wav`; focused native filename test failed (`task1-filename-red.log`). Verified extension is now appended only when the chosen basename lacks one; organization and catalog-workspace suites passed (`task1-filename-private-green.log`).
5. The full core run found the old current-format 4097-media limit fixture, which now reached duplicate-identity validation (`task1-core-current-fixture-red.log`). The fixture now tests 10001 media; its focused test passed (`task1-current-limit-fixture-green.log`). The new 10000-record catalog limit fixture also verifies successful final append and overflow refusal (`task1-catalog-limit-green.log`).

Additional integration coverage includes real Windows replacement denial with unchanged prior head/visibility; before-record/after-record/head-write faults; orphan invisibility; coherent captured reads; committed retry after manual move/source disappearance/cancellation; two-process stale CAS and no lost updates; additive sealed path reuse and manual-layout invalidation; strict wire/header/tree/count/depth/name limits; and preserved private draft/undo/catalog revision after folder-only commits. Existing catalog ownership/source-stamp/reparse/author/workspace regressions remain in the core suite.

## Verification

- Initial Task 1 checkpoint `cargo test -p annotator-core` → PASS, 241 passed / 0 failed / 5 ignored, 23 result groups including doc tests (`task1-core.log`). This includes organization 12 passed + 1 subprocess worker ignored, catalog 22 passed + 2 ignored, catalog workspace 13 passed, repository 18 passed + 1 ignored, workspace 23 passed, ordinary document 13 passed and exchange2 13 passed.
- `cargo check --workspace` → PASS (`task1-workspace-check.log`).
- `cargo fmt --all -- --check` → PASS (`task1-fmt.log`).
- `cargo clippy -p annotator-core --all-targets -- -D warnings` → PASS (`task1-clippy.log`).
- `git diff --check` → PASS.

Ignored tests are isolated subprocess entrypoints invoked by their parent tests, the existing explicitly owned SMB opt-in check, and the existing NAS archive opt-in scan reserved for Task 5. No ignored test was newly used to hide a failure. The 10000-record catalog capacity case took approximately 130 seconds in the final full run; it passed.

## Scope and deviations

- The old catalog collection fixture was updated to explicit head memberships, 10000 media and ignored unreferenced records. This preserves its record-version, aggregate-byte and collection-limit coverage under the new membership authority; old 4352-entry assumptions were removed because the specified enumeration cap is now 100000.
- Shared test fixture creation writes format4/catalog2 plus a complete root organization. Native fixtures reuse that helper; no native product behavior was changed.
- The parent clarified the approved spec's precommit/committed-ack wording and captured copy/export media scope during this slice; both documentation edits are included in this checkpoint.
- No migration mode, auth work, source parser, exchange3, native organization command or UI scope was added. No NAS inputs or release files were written; junctions were left intact.


## Task 1 paired-review correction pass

Original TaskBase remains `f05f0eb3256c870a99d52fe4b12f2060f570f244`; correction base is the initial implementation checkpoint `7a24e62f93df53fe0b6db7332ec01f37f9929e80`. Parent verified both findings and authorized this Task 1 correction only. A fresh paired review of the whole original range remains pending.

Confirmed fixes:

- Direct source basename capture now preserves every valid native basename verbatim, including extensionless `recording` and a 255-scalar extensionless basename. Direct names are never extended or silently replaced.
- Legacy-copy displayName last components are validated before extension synthesis. Empty, dot, dot-dot, control-containing or overlong components use `<media UUID>.<verified byte extension>`. A valid legacy extensionless component may gain the verified extension; if that result exceeds basename limits it also uses the deterministic UUID fallback.
- Fresh-head reading, filename validation and placement sealing now all finish before `media/.UUID.tmp` is created. The first staging file/identity handle is immediately followed by the existing `PreparedCatalogMedia` guard, retaining its exact-owned-file cleanup and Windows identity protections. Missing/corrupt head and invalid direct filename cannot leak a new media temporary; foreign staging artifacts remain untouched.

RED: `cargo test -p annotator-core --test organization` exited **101** (`task1-review-fixes-red.log`). The four new regressions independently failed: direct `recording` became `recording.wav`; direct 255-scalar basename was rejected after unwanted extension synthesis; empty legacy last component became `.wav`; and a missing head leaked a new owned `.tmp` beside the foreign sentinel.

GREEN: the same organization command exited **0**, with **16 passed / 1 ignored** (`task1-review-fixes-green.log`). The leak regression checks missing head, corrupt head and a real Windows filename containing a C1 control, preserving the head's prior missing/corrupt state and foreign sentinel bytes. The legacy regression covers empty/dot/dot-dot/control/256-scalar components and a valid 255-scalar component whose synthesized extension would overflow.

Fresh correction-pass verification:

- `cargo test -p annotator-core --lib --test organization --test collaboration_catalog --test collaboration_catalog_workspace -- --skip catalog_collection_limit_and_record_versions_are_enforced` → exit **0**, **57 passed / 0 failed / 3 ignored / 1 filtered** (`task1-review-focused.log`). The unchanged 10000-record capacity test was deliberately skipped per parent instruction; its earlier full-run PASS remains recorded above.
- `cargo check --workspace` → exit **0** (`task1-review-workspace-check.log`).
- `cargo fmt --all -- --check` → exit **0** (`task1-review-fmt.log`).
- `cargo clippy -p annotator-core --all-targets -- -D warnings` → exit **0** (`task1-review-clippy.log`).
- `git diff --check` → PASS.

No Task 2 implementation, delegation, main integration, push, junction cleanup, NAS mutation or release mutation occurred during this correction.
