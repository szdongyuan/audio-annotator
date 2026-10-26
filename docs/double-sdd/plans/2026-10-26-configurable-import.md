# Configurable Folder and ZIP Import Implementation Plan

> **For agentic workers:** REQUIRED: Use the `subagent-driven-development` skill to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Import selected audio from folders or multiple ZIPs with reusable wildcard rules and accurate optional second-route selection for Jingcheng recordings.

**Architecture:** Native discovery produces runtime-owned immutable previews; bounded extraction feeds the existing prepared-media/catalog pipeline. React presents local rule presets, previews and import progress through a single workflow; project schemas and collaboration semantics stay unchanged.

**Tech Stack:** React/TypeScript, Tauri 2, Rust, existing zip 6/serde/Symphonia, Vitest and desktop WebDriver.

---

Spec: `docs/double-sdd/specs/2026-10-26-configurable-import-design.md`.
Working directory: `D:/Work/annotator/.worktrees/configurable-import`.
Main base: `fe346a3676cce4953d72d6facf20905eb9dcfbeb`; temporary branch `configurable-import`. All task commits are temporary; final squash into main. No user approval pauses: existing user authorization requests autonomous delivery. Source archives on N: are read-only. Node_modules/target are junctions to main dependencies/cache; do not recursively delete either. Logs go to `D:/Work/annotator/.test-output/configurable-import`.

## Responsibilities / file map
- `crates/annotator-core/src/media/import_source/{mod,rules,discovery,jingcheng,archive,staging}.rs`: bounded serializable configuration, path matching, folder/ZIP enumeration, record routing, source fingerprints and lazy owned extraction. Split further only for focused responsibilities.
- `crates/annotator-core/tests/import_source.rs` (split integration tests if useful): synthetic fixtures and opt-in read-only real source validation.
- `src-tauri/src/commands/source_import.rs`: project/runtime-bound scan registry, pagination, extraction-to-existing-media adapter and release.
- `src-tauri/src/commands/media.rs`: minimal reusable worker input adapter to consume trusted prepared scan candidates, with native-selected display names. Avoid duplicate publish/decode logic.
- `src-tauri/src/{state,lib}.rs`, `src-tauri/src/commands/{mod,project}.rs` and collaboration runtime lifecycle hooks as needed: registry registration/reset and nonce handling.
- `src/bridge/sourceImport.ts`, `src/bridge/runtimeInvoke.ts`, project runtime API binding: strict IPC validators and typed runtime client.
- `src/features/media/{sourceImport,importRules}.ts`, `SourceImportDialog.tsx`, `SourceImportProgress.tsx`: shared configurable workflow, validated local preferences, paginated preview and recovery.
- `src/features/media/{imports,useMedia}.ts`, `src/app/AppShell.tsx`, File menu module and existing styles: reuse queue/media controller; add compact entrypoints, replace visible folder dialog without removing protected direct/relink paths.
- `tests/desktop/source-import.test.mjs`, `scripts/run-desktop-tests.mjs`: real UI flow and registration. Existing folder-flow tests adapt to explicit preview or keep legacy native folder contract tests.
- `docs/user-guide.md`, `docs/verification-0.5.0.md`, release version files: explain syntax, preview, route selection and verified artifacts.

## Contract intent
Native configuration serializes camelCase: `kind: folder|zip`, `paths: string[]`, `rules: { mode: generic|jingcheng, recursive: boolean, extensions: string[], include: string[], exclude: string[], includeSecond: boolean }`. Built-ins/defaults and exact limits are in spec. Presets store rules only. Candidate preview has stable index, source display name, relative path, displayName, byteLength and optional logicalPosition. Frontend cannot substitute extraction paths or names for native candidate handles. Tokens contain unpredictable owner/task IDs; project/runtime binding is enforced by host. Scan events follow existing folder event/channel conventions. Page size <=256. Import batches reference the token and candidate indices/range; they return existing MediaEvent protocol so MediaImportController's publication/release/failure ledger stays authoritative. Runtime registry may be new instead of overloading old folder scanner. Direct import API remains usable.

## Task 1: Core source discovery, rules and safe staged audio

- [x] Read spec, existing `media/folder_scan.rs`, `media/identity.rs`, `exchange/import.rs` and existing ZIP/path checks; record task base.
- [x] Add failing rules tests first: `*/CH1` matches root/deep CH1.wav/FLAC case-insensitively, not CH10; comma/semicolon input normalization belongs UI; native arrays have bounded individual patterns; `**/audio/*.wav`, extension selection, include OR/exclude precedence, recursion and invalid input. Run `cargo test -p annotator-core --test import_source` and retain RED.
- [x] Implement bounded wildcard matcher without exponential backtracking, native Rules validation/defaults and serializable preview types.
- [x] Add folder/ZIP fixture tests for position 1 CH2 vs position 2 CH4, CH1/CH3, original and relocated cleaned record paths, duplicate/missing/malformed manifests and records. Create small ZIPs programmatically using existing zip crate. Assert route2 off returns exact intended paths, generic mode does not require manifest. Run failing tests, implement discovery, rerun GREEN.
- [x] Add hostile/limit/error tests: traversal/absolute/reparse/symlink paths, duplicate normalized entry paths, unsupported/encrypted archives, large declared/actual sizes, corrupt CRC, cancellation, source changed after scan, manifest cap, candidate/entry cap. Implement bounded ZIP streaming extraction into uniquely owned generated files and scoped cleanup. Validate original-byte hashes and failed-item cleanup. Native extraction APIs must let caller hold a lease until original bytes have been independently copied by catalog preparation; never persist temporary source references for legacy projects.
- [x] Add opt-in test using `ANNOTATOR_IMPORT_SOURCE_FIXTURES=N:/精成采集数据` to scan exactly the nine named archives read-only and assert totals 3294 with second on /1647 off. Investigate actual totals if manifests exclude entries, report evidence; no blanket relaxed counts. This test must be ignored by normal CI and explicitly executed locally. No bulk extraction required; extract representative first/second route files, verify bytes and decode metadata into local owned temp only.
- [x] Run focused tests, `cargo fmt --all -- --check`, `cargo clippy -p annotator-core --all-targets -- -D warnings`; save core evidence and temporary checkpoint. Report public API for task 2. Paired spec/quality review before continuing.

## Task 2: Native runtime ownership and media publication integration

- [x] Read task1 APIs, existing host folder/media commands, catalog preparation, lifecycle reset, and MediaTasks release semantics. Record task base.
- [x] Add failing native tests for scan event before start acknowledgement, pagination ownership, stale runtime/reset, read-only rejection, scan cancellation, preview without publication, and source-change rescan error. Introduce source_import command registry with testable internal command functions.
- [x] Register commands `scan_import_sources`, preview paging/cancel/release, and `import_source_batch` (names may adapt consistently to existing naming). Apply runtime nonce binding in all stateful operations. Avoid holding project/registry locks during NAS I/O or extraction; snapshot authority, do work, recheck authority.
- [x] Preserve the old folder scan's exact canonical already-used project-source exclusion before publishing preview; reindex retained candidates atomically. Cover this with a host regression. Do not add content/run-ID deduplication to ZIP or other independently selected media.
- [x] Integrate trusted candidate inputs into existing media worker, using identical MediaEvent shape and existing release_media_import acknowledgement path. Native displayName derives from source plus relative path before ready descriptor is retained. Batch index maps to original preview index in UI. Staging lease outlives required preparation/copy but is never left as final source. For legacy ordinary projects, either copy into durable project audio storage with existing ownership protection or reject configurable import explicitly before work while retaining direct legacy import; default format2 must work fully.
- [x] Test native end-to-end selected ZIP entries -> Ready -> apply_change/importMedia -> release -> save/reopen/source registry. Verify copied bytes after source ZIP and all staging are removed. Include cancelled/disconnected Channel, retryable publication, stale accepted results, scan release during in-flight batch, invalid candidate index/count, >256 candidates split across batches, global direct-import exclusion. Test folder input through same native workflow.
- [x] Run `cargo test -p annotator-desktop --lib`, `cargo test -p annotator-desktop --features e2e --lib`, fmt and strict workspace clippy. Save native evidence, temporary checkpoint and IPC details. Paired review before UI work.


Task 2 final paired spec/quality review: PASS at `1a06e219` (confirmed by root).

## Task 3: Compact configurable UI, presets and preview/import controller

Implementation, verification and paired review complete (PASS at `9e412d2c539c617147bb254774fe52d9bf3e2988`). Evidence: `docs/double-sdd/configurable-import-task3-evidence.md`.

- [x] Record task base; add failing strict bridge validation and UI/controller tests before implementation.
- [x] Implement `sourceImport` bridge to native task2 contract and runtime ownership. Reuse MediaImportController by a narrowly scoped per-run start callback/input adapter; retain original release/retry/failure ledger. Never publish guessed descriptors on frontend.
- [x] Implement local preset store with schema validation, 32 custom presets, bounded names/rules, built-ins immutable, graceful corrupt/unavailable-storage error (usable defaults). Remember rules only, no source paths. Support pattern text separated by newline/comma/semicolon, including user examples `*/CH1`, `*/CH2`.
- [x] Implement controller states choosing/scanning/preview/importing/paused/finished/cancelled/failed. Reserve media controller for the full workflow; do not import upon scan completion. Preview pagination and issue details remain bounded. Rescan releases old generation, delayed responses cannot replace new UI. Explicit Import runs <=256 batches via existing publication barrier. Preserve retry/discard/ack visibility on partial failure. Close/project-switch cancels but respects pending publication lifetimes.
- [x] Build one compact dialog: choose folder or ZIPs, preset chooser/save/delete controls, recursion checkbox, extensions, collapsible rule fields, optional second-route checkbox for Jingcheng, scan button; after scan show count/list plus explicit import. Keep actions fixed and details scrollable at 1000x680. Avoid permanent explanatory banners; placeholders/tooltips or brief syntax help inside rules section only. User can edit rules then rescan; never import obsolete preview under new rules.
- [x] Wire File menu `导入文件夹…` and `导入 ZIP 音频…`; preserve project-package ZIP import. Add source import progress integrated into existing library layout without duplicate stale folder/direct result panels. Existing direct/relink/menu tests remain.
- [x] Make long structured import names useful in the compact media list: retain the complete displayName for search and hover/accessibility, but show record identity and filename so a long identical archive prefix does not hide every distinguishing name. Ordinary direct-import filenames retain their existing presentation. Keep the filename visible and ellipsize the record portion rather than expanding card height.
- [x] Verify React behavior for preset persistence/deletion/corrupt values, wildcard examples, route2 toggle, file picker cancellation, preview selection counts, rescan stale results, no auto-import, >256 batching, partial failure, release failure and project replacement. Test native contracts against task2 serde payloads. Run `npm.cmd test`, `npm.cmd run typecheck`, `npm.cmd run build`; checkpoint and paired review.

## Task 4: Desktop acceptance, documentation and production 0.5.0

Task base `9e412d2c539c617147bb254774fe52d9bf3e2988`. Evidence: `docs/double-sdd/configurable-import-task4-evidence.md`. Implementation and verification complete: 23 desktop phases covered across recorded runs, final compact/help and bounded production smoke documented. Task 4 paired review and final whole-range quality review passed at `7229033e5c3c8c736bee0cee2888d772e59d1d81`. The reviewed changes were squash-integrated on main, independently verified there, and the temporary worktree/branch removed; shared dependencies, build cache, delivery and raw evidence were preserved.

- [x] Record task base. Add actual desktop UI fixture flow and register it in full suite; update existing folder workflow assertions for new preview where needed without dropping old coverage. Use generated fixture archives, real native pipeline, UI selectors and native-picker hooks; no frontend store mutation as substitute.
- [x] Run real folder+ZIP preview/import with both routes and first-only, wildcard examples, multiple archives with duplicate basenames, rescan/cancel and preview display at compact viewport. Verify persisted display names and source bytes after original source removal; capture screenshot/report. Run relevant previous folder/direct/collaboration/share desktop flows, then complete full desktop suite if available.
- [x] Execute read-only real nine-archive scan from Task1 and native representative imports. Preserve concise counts/timings/failure evidence without committing raw user recordings or complete sensitive manifests. Source NAS paths are input only; all test writes in unique local directories.
- [x] Bump package/Cargo/Tauri and lockfile versions consistently to 0.5.0. Update user guide and verification notes with glob shorthand, route-vs-CH distinction, source format scope, ownership, limits, failures and actual verified/unverified checks.
- [x] Run complete `npm.cmd test`, typecheck/build, `cargo test --workspace`, `cargo test -p annotator-desktop --features e2e --lib`, fmt and strict workspace clippy. Record actual outcomes, fix any task-attributable regression through RED/GREEN.
- [x] Build production Windows EXE and NSIS with normal config/no e2e. Preserve required resources/licenses in new `releases/0.5.0`, hash binaries and build inputs. Smoke production executable through owned UI process if environment permits; report any untested installer behavior precisely. Never overwrite previous releases or terminate unknown processes. Keep artifacts out of temporary worktree cleanup hazards.
- [x] Save verification evidence, update task checkboxes and temporary checkpoint. Paired spec/quality task review and final full-range quality review. Root independently verifies tests/artifacts, squash-integrates onto recorded main base, preserves relevant evidence/dependencies and cleans only owned worktree links. No push or separate approval question.
