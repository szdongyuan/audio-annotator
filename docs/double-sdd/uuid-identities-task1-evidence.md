# UUID identities — Task 1 evidence

Task base: `18d247c3644ee7f085a47f6b12bff1e8c6f3c5c3`.
Scope: additive core profile primitives only. Existing account/DPAPI, native and UI callers are unchanged; the old DPAPI file is neither read nor migrated by this module. Task 2 must replace the current callers and move/reuse `local_identity::short_lock` when retiring that module.

## API for Task 2

All exports are under `annotator_core::collaboration::profiles`.

- `Profile { author_id, display_name, created_at }`: camelCase serialized fields; `new(name)` generates v4 UUID/UTC timestamp, and deserialization strictly validates fields and normalizes the nickname. `validate()` also guards programmatically constructed values before persistence/export.
- `ProfileStore::load_or_create(existing_local_data_root)` verifies the safe directory and initializes one persisted default profile only when `profiles.json` does not exist. `snapshot()` reloads and validates the current disk state.
- `ProfileSnapshot { revision, last_selected_author_id, profiles }`: persisted launch preference only. The native service must retain a separate process-selected UUID; refreshing this snapshot must not rebind an active editor.
- `create(expected_revision, name)` and `rename(expected_revision, author_id, name)` return `ProfileMutation { snapshot, profile }`. Creation does not select; rename preserves UUID and creation timestamp.
- `select(expected_revision, author_id)` returns the saved snapshot. Same-selection is a byte-preserving no-op after checking the expected revision.
- `import(expected_revision, path)` returns `ImportResult { snapshot, profile, already_exists }`. The complete bounded portable file is validated before mutation. Duplicate UUID returns the local metadata and leaves revision, selection and bytes unchanged. A different UUID with the same nickname is a separate profile.
- `export(author_id, path)` writes one profile through the existing atomic create-new publisher. An existing target is never replaced. `parse_transfer(bytes)` / `encode_transfer(profile)` are the bounded portable codecs.

Local JSON: `{kind:"annotator.profile-store",formatVersion:1,revision,lastSelectedAuthorId,profiles:[{authorId,displayName,createdAt}]}`. Portable JSON: `{kind:"annotator.portable-profile",formatVersion:1,profile:{authorId,displayName,createdAt}}`. Shared kind/version/size constants are exported. UTC timestamps follow the existing core `Z` spelling convention. Store revisions are 1 through the existing JavaScript-safe maximum integer.

Every mutation holds the existing short OS file lock while re-reading and checking the revision, validating/encoding the next document, syncing its owned same-directory temporary file, and invoking `project::store::atomic_replace`. Stale mutations fail with `RevisionConflict`; resource bounds are enforced on both reads and writes. No new dependencies or cryptographic/authentication features were introduced.

## TDD and verification

Raw logs: `D:/Work/annotator/.test-output/uuid-identities/`.

| Phase | Actual result | Log |
| --- | --- | --- |
| Initial RED | Missing `profiles` module; focused test compilation failed | `core-profiles-red-initial.log` |
| Initial GREEN | 5 tests passed | `core-profiles-green-initial.log` |
| Mutation RED | Missing create/rename/select APIs; focused compilation failed | `core-profiles-red-mutations.log` |
| Mutation GREEN | 10 tests passed | `core-profiles-green-mutations.log` |
| Transfer RED | Missing transfer codecs/import/export APIs; focused compilation failed | `core-profiles-red-transfer.log` |
| Transfer GREEN | 15 tests passed | `core-profiles-green-transfer.log` |

Each phase used `cargo test -p annotator-core --test profiles` before and after implementation. Formatting is the only refactor.

Final verification on the formatted implementation:

- `cargo test -p annotator-core`: exit 0, 234 passed (including 15 profile tests and 2 doctests), 0 failed, 4 pre-existing ignored; `core-tests.log`.
- `cargo fmt --all -- --check`: exit 0; `core-fmt.log`.
- `cargo clippy -p annotator-core --all-targets -- -D warnings`: exit 0; `core-clippy.log`.
- `git diff --check`: exit 0. Git reports the repository's expected LF-to-CRLF normalization warning for the edited plan.

The focused tests exercise strict unknown/duplicate fields; canonical non-nil UUIDs; Unicode nickname normalization, scalar/byte/control limits; bad timestamps/kinds/versions; absent/duplicate selection; same-nickname distinct identities; exact byte boundaries; the 128-profile limit; revision exhaustion and stale operations; restart persistence; independent-process initialization; deterministic barrier-synchronized concurrent readers and retry without loss; and separate application-data directories for transfer.

Atomic replacement failure uses a real Windows file handle that allows read/write sharing but denies rename/delete sharing. `MoveFileExW` fails, old bytes/snapshot remain unchanged, the owned temporary file is removed, and retry after closing the handle succeeds. This Windows-specific test is gated with `cfg(windows)`; the rest are portable. Size tests include legal long fractional RFC3339 timestamps so actual serialized output—not merely padded input—is tested against the writer limits.

Paired spec and quality reviews passed at `acfedf08c8e324b7dec16b226a4f42d1393e55c2`. Root independently reran the 15 focused profile tests (exit 0, `root-profiles.log`). No Task 2/native/frontend implementation, integration or release publication is included in this checkpoint.
