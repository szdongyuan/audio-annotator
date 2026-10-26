# Task 3 implementation evidence: directory-preserving exchange and copy

TaskBase: `22c264779f75fa1199c2ae0d1010c9071c8d68f1`. Worktree: `D:/Work/annotator/.worktrees/media-folders`. Raw logs: `D:/Work/annotator/.test-output/media-folders/task3-*.log`.

Task 3 implementation checkpoint. Parent paired spec/code and quality review pending. No Task 4 folder/export preview UX, Task 5 version/build/release work, migration, NAS writes, raw audio commits, old-release changes, main integration, push or junction removal.

## Captured plan and exchange3

`annotator_core::exchange::{ExportPathPlan, PathChange, capture_organization, root_organization}` are the shared pure boundary. `ExportPathPlan::build(document, organization, bundle, preserve_folders)` validates both inputs and the 16 MiB logical head budget, binds the project, filters membership to exactly the adopted private document media (including hidden media), and retains every folder node. Missing adopted membership fails; pending remote media are excluded. The immutable plan contains the logical organization, bundle/preserve flags, declared directories, UUID-keyed physical media paths and deterministic adjustments.

`PathChange` serializes `{kind:'folder'|'media',id,originalPath,plannedPath}`. It includes changed empty folder paths and changes inherited from sanitized ancestors. Logical organization ordering, names and IDs remain exact; the physical path map and directory order are deterministic regardless of input ordering.

Manifest3 adds required `organization` and `preserveFolders`; every PortableMedia retains required nullable `mediaPath`. Annotation-only media paths are null. Bundle paths are the exact plan paths under `audio/`. All folders remain in metadata in both modes; preserved bundles include `audio/` and every declared directory, including empty folders. Flat bundles include only `audio/` plus original safe audio names. ProjectDocument remains version 2. Old exchange1/2 and future versions fail UnsupportedVersion before publication, without rewriting input. Deserialization rejects unknown, missing and duplicate JSON fields; native nullable fields remain required.

`Manifest::capture_with_plan`, `export_annotations_with_plan` and `export_bundle_with_plan` consume/validate the captured plan. Existing export wrappers create an ordinary root organization and default to preserved output. The import validator recomputes the same plan exactly and permits no undeclared/missing entries or caller-selected extraction paths. `ImportedProject` now also carries the independently rebound `organization`; bundled document source references point to the physical planned audio paths. JSON missing-source references remain internal UUID placeholders.

## Physical path rules and budgets

- Windows-invalid characters and controls become underscores, trailing dots/spaces are trimmed, and empty sanitized components become `_`. Reserved CON/PRN/AUX/NUL and COM/LPT1–9, COM/LPT¹²³ (including extension forms) receive a leading underscore.
- Components over 120 UTF-16 units shorten without splitting Unicode scalars and include the full stable folder/media UUID. Filename shortening and collision suffixes precede the extension; common WAV/FLAC/MP3 extensions remain usable.
- Folders and audio files reserve the same case-insensitive sibling namespace using Unicode lowercase. All colliding base names receive full UUID suffixes. A second check reserves naturally generated-looking names and equal cross-kind UUID cases, with deterministic kind/counter suffixes when needed. No audio is overwritten or deduplicated.
- Only physically emitted paths must fit 240 UTF-16 units, including directory suffixes. An actionable, path-specific error offers shortening directories or flat export. JSON and flat bundles retain valid deep logical trees without applying physical folder-path limits to paths they do not emit.
- Limits are aligned at 32 MiB manifest, 20002 raw ZIP entries (10000 audio + 10000 folders + manifest + audio root), 20 GiB total uncompressed bytes and 8 GiB/media. Organization retains the existing 16 MiB bound.
- Raw central-record preflight runs before ZipArchive allocates its index, including ZIP64. UTF-8 Chinese paths are accepted. Invalid/traversing/absolute/device paths, duplicates including Unicode case collisions and file-vs-directory names, links/special entries, wrong directory attributes/lengths, encryption and split archives remain refused. Directory trailing slash is stripped exactly once for component checks. The post-manifest allowlist verifies every declared directory is a real zero-byte directory and every audio is a regular file of the declared length.
- Existing streaming source stamps, raw SHA-256 checks, decoded metadata verification, cancellation, owned staging cleanup and no-clobber atomic output publication remain in use.

## Native preview and start contracts

New async command:

`export_path_preview({expected:{projectId,expectedRevision,runtimeNonce?},bundle:boolean,preserveFolders:boolean})`

Reply (all fields required):

`{token:UUID,runtimeNonce:UUID,projectId:UUID,documentRevision:safeInteger,organizationRevision:safeInteger|null,bundle:boolean,preserveFolders:boolean,directories:string[],mediaPaths:{[mediaUUID]:string},changes:PathChange[]}`.

The ordinary project organization revision is null. A single bounded native preview slot stores an Arc to the immutable document/root/organization/plan capture; generating another preview replaces that slot. Shared export uses only the captured current author's labels and adopted media, restores trusted private relinks for byte resolution, and excludes private DSP/playback/view settings as before.

`export_bundle` and `export_annotations` now require `previewToken` in addition to existing expected/path/channel arguments. Start accepts only the opaque native token for its command mode, checks expected document and current runtime identity, rereads organization revision outside private state, revalidates ownership/document authority and enters existing Service/ExchangeTasks admission before creating output. Caller-returned planned paths never authorize output. Stale organization/document/runtime or wrong token/mode fails before output. The worker uses the captured plan/document throughout, so later folder changes cannot modify an accepted export.

All new head reads, path planning, layer projection and writer work run in spawn_blocking outside the private state.0 mutex. Only immutable context capture and authority rechecks hold state.0. A native test hook confirms that private state can be acquired before head I/O/planning. The preview function's serde output is retained in `task3-native-preview-final.log` as `EXPORT_PREVIEW_IPC=...`; this is real command-function serialization, not WebView UI acceptance.

`src/bridge/exchange.ts` exports strict `ExportPreview`, `ExportPathChange`, `parseExportPreview`, and `exchangeClient.preview(expected,bundle,preserveFolders=true)`. The parser checks exact fields, UUIDs, bounds, nullable revision, directory/file kinds, safe Unicode paths, uniqueness, declared ancestors and adjustment references. Preview replies must match project/runtime/document/mode/options. `ExchangeRequest` adds optional `preserveFolders` and `previewToken`. Existing export start defaults request/accept native preserved preview automatically; Task 4 can request and display it explicitly. Only the opaque token is sent to export start. The existing import/cancel/channel and lifecycle UI remain functional; source requirements now support 10000 media.

## Copy, Save As and native import

New focused core APIs:

- `initialize_copy_layout(session, sourceOrganization) -> CollaborationRepository`: validates and seeds stable folder IDs into a newly created empty owned target, rebinding project ID; refuses targets with existing layout/media/revision. Native calls it only inside its owned `.create-UUID` staging directory.
- `prepare_media_copy_with_placement(source,cache,cancel,expectedDescriptor,sealedPlacement,progress)` independently verifies bytes/metadata, retains the source media UUID and consumes trusted placement.
- `prepare_media_copy_in_capture(source,cache,cancel,expectedDescriptor,&NativePlacementCapture,progress)` preserves the existing legacy ordinary-copy native filename fallback/verified extension detection after decoding, without rereading the target head per media.

`defaults::copy` captures shared organization outside private locks; `copy_with_organization` receives the validated exchange organization explicitly. Both filter to captured document media and retain all folder nodes. One folder-only target seed and one opaque root capture seal canonical relative folder segments plus trusted original filename for every verified copy. Shared/exchange names remain exact, including extensionless names; legacy ordinary invalid-name fallback remains `<full-media-UUID>.<verified-extension>`.

Existing target transfer inventories/publishes organization.json before final collaboration.json. Save As still captures live unsaved private document, preferences and hidden IDs, revalidates before adoption and retains same selected author identity. Failure/cancel cleanup removes only owned target/staging files. Pending remote audio is not silently adopted, and source bytes/tree are unchanged. Exchange import rebinds the incoming tree to its new format4 project while retaining stable folder/media IDs, native filenames and empty folders.

## RED/GREEN evidence

- `task3-path-red.log`: missing pure planner/plan-aware writers/imported organization APIs (exit101); `task3-path-green-final.log`: initial 15 exchange tests pass.
- `task3-folder-preview-red.log`: absent folder adjustment kind (exit101); `task3-folder-preview-green.log`: 16 pass, including changed empty folders and generated-looking/equal cross-kind collision namespace.
- `task3-copy-red.log`: actual shared copy produced no folders (exit101); `task3-copy-green.log`: folder IDs, empty dirs, native filename, exact captured media scope and source bytes retained.
- `task3-native-preview-valid-red.log`: missing native preview/accepted capability APIs (exit101). The first draft test used a nonexistent change variant; that test construction error is retained separately in `task3-native-preview-red.log`. `task3-native-preview-final.log`: stale organization/document/runtime and frozen writer output pass, with captured IPC and private-lock probe.
- `task3-bridge-red.log`: missing preview parser/default request (exit1); `task3-bridge-green.log`: all 18 focused frontend tests pass. `task3-preview-shape-red.log` reproduces accepted undeclared parent directory (exit1); strict ancestor validation fixes it in `task3-frontend-final.log` (18 pass).
- `task3-legacy-copy-red.log`: existing invalid legacy display-name fallback became bare UUID (exit101); `task3-legacy-copy-green.log`: verified `.wav` suffix restored through the one-capture copy API.
- `task3-head-budget-red-final.log`: a fully valid >16 MiB logical head was accepted with the check disabled (exit101); restored bounded validation passes. Earlier fixture-construction failures (duplicate IDs/missing per-media settings/insufficient generated size) remain honestly retained in the other head-budget logs; they are not claimed as behavior RED evidence.
- `task3-duplicate-json-red.log`: duplicate formatVersion accepted (exit101); direct strict DTO deserialization fixes it, with the 19-test core exchange suite green in `task3-duplicate-json-green.log`.

Additional focused coverage verifies preserve/flat Unicode folder and filename roundtrip, exact raw bytes, malformed directory records, raw duplicate names, 20003 raw-entry resource refusal, unknown fields/missing memberships/project mismatch, actual path budgets, cancelled/missing/changed sources and target no-clobber. Native exchange tests now roundtrip the complete tree through both annotation-source binding and flat bundle import; copied shared snapshots include hidden adopted media while excluding an unadopted pending remote item.

## Final verification

All planned final checks passed against frozen production code. Each log records the actual tool exit code.

- `cargo test --workspace` → exit **0**, **341 passed / 0 failed / 5 ignored**, 26 result groups including doc tests (`task3-workspace.log`). The existing 10000-record catalog capacity test ran in this complete workspace command.
- `cargo test -p annotator-desktop --features e2e --lib` → exit **0**, **83 passed / 0 failed** (`task3-native-e2e.log`). This is native library/e2e-feature coverage, not real WebView acceptance.
- `cargo test -p annotator-core --test exchange` → exit **0**, **19 passed** (`task3-duplicate-json-green.log`).
- `cargo test -p annotator-desktop --lib commands::collaboration` → exit **0**, **39 passed** (`task3-native-copy-exchange-final.log`).
- `cargo test -p annotator-desktop --lib native_export_preview -- --nocapture` → exit **0**, **1 passed**, with actual preview serde and private-lock probe (`task3-native-preview-final.log`).
- `npm.cmd test -- --run src/bridge/exchange.test.ts src/bridge/runtime.test.ts src/features/exchange/exchange.test.tsx --maxWorkers=2` → exit **0**, **18 passed in 3 files** (`task3-frontend-final.log`).
- `npm.cmd run typecheck` → exit **0** (`task3-typecheck-final.log`).
- `cargo fmt --all -- --check` → exit **0** (`task3-fmt.log`).
- `cargo clippy --workspace --all-targets -- -D warnings` → exit **0** (`task3-clippy.log`).
- `git diff --check` → exit **0** (`task3-diff-check.log`).

The five ignored workspace cases remain existing isolated subprocess entrypoints and explicitly owned SMB/NAS opt-in fixtures. No failure was hidden by a newly ignored test. No production source changed after the frozen broad run.

## Deviations and limits

- The existing integration file is `crates/annotator-core/tests/exchange.rs`, so the planned command was used directly.
- No spec behavior was weakened. Existing ordinary export wrapper signatures remain available while native IPC now requires preview acceptance; full visible preview/toggle UX belongs to Task 4.
- This slice verifies native command functions/serde and frontend units; real WebView/two-client/NAS/production delivery acceptance remains Task 5.
