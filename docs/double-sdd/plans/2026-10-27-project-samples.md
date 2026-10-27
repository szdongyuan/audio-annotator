# Project example audio implementation plan

> **For agentic workers:** REQUIRED: Use the `subagent-driven-development` skill to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add project-scoped private/shared named reference audio and move device settings into a dialog.

**Architecture:** Keep the ordinary document/catalog unchanged. An optional sidecar repository owns copied example audio and author-specific records; native commands bind it to the current project/identity and open an isolated read-only preview using existing media/analysis/playback machinery. React renders a compact inspector tab and modal viewer through typed clients.

**Tech Stack:** Rust, Tauri 2, React 19, TypeScript, Vitest, Windows WebDriver.

**Workspace:** `C:/Users/DY/AppData/Local/Temp/annotator-project-samples-20261027`, branch `codex/project-samples`, base `196fdd3993a04e4357f2a6d62bd02510ece85ac9`. Shared node_modules is a junction. Do not edit the user's original workspace or real NAS project. Existing test source/build data are in `D:/Work/annotator/.test-output/recycle-busy-fix/`. Use the cached Cargo target `C:/Users/DY/AppData/Local/Temp/annotator-071-production-20261027` with `CARGO_INCREMENTAL=0`; disk space is limited, avoid copying binaries/dependencies.

## File responsibilities

- `crates/annotator-core/src/examples/{mod.rs,repository.rs}` and `tests/examples.rs`: DTOs and safe durable repository; small modules for distinct persistence responsibilities if needed.
- `src-tauri/src/commands/examples/{mod.rs,preview.rs}`: current runtime capture, import/list/mutate and transient preview commands; register from commands/mod.rs and lib.rs. Extend state with a reference-runtime manager only if needed.
- Existing native analysis/playback modules: expose small reusable owned helpers; preserve their original command behavior and checks.
- `src/bridge/examples.ts`: strict typed runtime-scoped native boundary.
- `src/features/examples/{controller.ts,ExampleLibrary.tsx,ExamplePreview.tsx,examples.css}`: owner-bound controller, compact list and read-only preview. Reuse spectrogram tile renderer and modal.
- `src/features/playback/DeviceDialog.tsx`, TransportBar.tsx, `src/app/{AppShell.tsx,WorkspaceActions.ts}`: replace device tab with examples and wire both device-menu entries.
- Dedicated core/native/frontend/desktop tests and `docs/examples.md`: meaningful behavior tests and usage/compatibility limits.

## Task 1: Repository and native example authority

- [x] Write core regression tests for project/actor/scope isolation, byte copies, same names/different IDs, reader access, ownership, conflict and failed import cleanup; run failing tests. Also test malformed paths/junctions (reject before access), absent store (empty without creating files), missing/corrupt records (explicit isolated item/library error with no main project writes), changed source hash (preview rejected), and entry/batch limits (bounded error without partial metadata corruption).
- [x] Implement separately versioned optional storage with safe owned paths and bounded validation, atomic commits, project/identity binding. Do not change existing file versions or catalogs.
- [x] Add native list/import/from-project/rename/remove/copy commands with runtime capture/revalidation and copied original bytes. Return DTOs useful to the UI (entries, scopes, creator, durable revision).
- [x] Complete isolated read-only preview authority in this task, reusing existing FFT/playback. Contract: all library commands bind `{runtimeNonce, projectId}`; scope is `private|shared`, records have sample UUID and creator UUID. Opening a preview returns `{previewId, snapshot}` where snapshot is a transient ProjectSnapshot containing only the example descriptor and supplied valid local analysis settings. Preview calls bind `{runtimeNonce, projectId, previewId}`. Expose register/request/cancel/retire methods matching TileTransport, a ready/missing media-status adapter, original-only playback configure/seek and pause/stop, and close. Preview playback uses the singleton output, while document/media authority remains isolated. Use a small reusable owned helper in existing native commands instead of duplicating DSP/FFT logic. Stale/closed preview invalidates work; ordinary document never changes. Write exact IPC names/DTOs in a short contract note for Task 2.
- [x] Native regression tests explicitly cover project, actor and nonce changes during copy/commit, superseded preview rejection, generation/view invalidation on close and safe playback cleanup. Verify the transient snapshot never enters the main catalog or annotations; checking the parent document before/after returns identical state.
- [x] Verify `cargo test -p annotator-core --release` and relevant desktop `--lib` tests using shared target. Record commands/results, create a temporary checkpoint `tmp/sdd: example repository and native authority`.

## Task 2: Compact example UI, spectrum preview and device dialog

- [x] Write failing behavior tests for owner-bound async results, scope import/rename/copy/remove, creator restrictions, search, project switch, preview lifecycle, Device dialog/menu focus/dismiss and missing public counters. Test empty and overlong names retain input with validation feedback, guests can read shared but cannot mutate or use private scope, and all tabs remain accessible at a 1000px window. Preserve the established responsive inspector widths (220px at narrow windows); a 280px unit-test container is an additional capacity check, not a required production width.
- [x] Implement strict bridge client and controller with automatic polling only for the currently visible library and explicit refresh, busy/error states and original friendly names. Import dialog chooses mine/shared and optional custom name; multiple selected files retain per-row editable names. Add current audio as example via compact panel action/context menu.
- [x] Implement compact 示例 inspector tab with 我的示例/共享示例, play controls and context actions. Never inject examples into ordinary MediaList or its document; keep tab/header layout contained.
- [x] Implement required read-only spectrum preview with channel selection, original tiles, zoom/pan and native audition using current private monitor/volume/device options. Use isolated frontend store/transport adapter if reusing SpectrogramCanvas. Closing/switching owner stops preview and retires view, and main source can be played again.
- [x] Replace Device tab with DeviceDialog. Wire 音频→输出设备… and bottom menu entry to it. Remove diagnostic text, preserve system default/refresh/private preference updates, click outside/Escape and return focus.
- [x] Run targeted Vitest + `npm.cmd run typecheck`, fix real failures, checkpoint `tmp/sdd: example library and device dialog`.

## Task 3: Integration and real desktop combination verification

- [x] Add `tests/desktop/examples.test.mjs` using existing isolated Tauri harness. Cover two identities/projects, original source removal after successful import, mine/shared naming/reopen, preview spectrum/play/seek/stop, project switching and devices modal; ensure no main media/annotation changes.
- [x] Document library persistence, original-byte copying, per-project/private/shared meaning, ownership, and project exchange limit in `docs/examples.md`; update relevant help text.
- [x] Bump application version to 0.7.5 in package.json/package-lock.json/Cargo.toml/Cargo.lock/src-tauri/tauri.conf.json for this test candidate; keep all existing data formats unchanged. Write concise release notes. Check 0.7.4-to-0.7.5 project/identity/settings compatibility using the preserved actual 0.7.4 E2E executable `D:/Work/annotator/.test-output/recycle-busy-fix/final-e2e/annotator-desktop.exe` and isolated test profiles/projects.
- [x] Run full frontend and core/native tests, production typecheck/build, then build an owned E2E executable with `--features e2e` and run the desktop scenario. Preserve the prior final 0.7.4 binary/evidence if build cache overwrites it. Fix errors in the owning implementation, no user data changes.
- [x] Record final evidence and limitations. Check `git diff --check`; checkpoint `tmp/sdd: verify project example audio`. Reviews cover full `196fdd3..HEAD` range. Do not push/merge/create releases until explicitly requested for this increment.
- [x] After acceptance checks and review fixes, produce a normal executable/NSIS installer and full file update package using the shared release cache and `scripts/package-update.mjs` with previous version 0.7.4. Validate no E2E markers, resource hashes and update ZIP entries; smoke-start the normal app with an owned process and without opening a user project. Preserve all older deliveries. Copy the verified new files under `N:/精成数据标注/软件/测试版-0.7.5`, with SHA256 and concise instructions. This is a local test delivery, no GitHub Release or PR #3 modification. Parent may execute packaging/delivery after implementation reviews; do not package unfinished code.

### Task 3 layout metric correction

Actual desktop source and measurement confirm the existing inspector is 268px normally, 240px at widths up to 1280px, and 220px up to 1100px. The earlier 280px desktop expectation was a planning assumption, not a user requirement. Keep the compact responsive layout and verify all eight tabs remain fully visible, contained and clickable at a 1000px native window; retain the existing 280px component test as a separate capacity check. No product width change is required.
