# NAS Collaboration 0.3.0 Implementation Plan

> **For agentic workers:** REQUIRED: Use the `subagent-driven-development` skill to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在同一 Windows/NAS 目录提供可选账号登录、按作者隔离的标注协作，保持个人音频操作私有，并交付可运行的 0.3.0。

**Architecture:** 新的严格 collaboration.json 固定共享媒体目录；各作者写独立、无覆盖发布的版本化标注图层。本机 private workspace 保存个人投影与原子同步检查点，远端图层通过独立只读协议显示，不进入个人撤销栈。

**Tech Stack:** React/TypeScript、Tauri 2、Rust 1.91、现有文件/音频/DSP基础设施，新增固定 RustCrypto argon2 0.5.3。

---

## Context and execution

Spec: `docs/double-sdd/specs/2026-10-23-nas-collaboration-design.md`（两轮 document review，最终 PASS）。用户明确授权自动完成，无需规格/计划再批准。遵守原文作者隔离、断线保护和私有边界，不扩展服务器、全员归并导出或动态媒体清单。

当前实现基线为 0.2.1；主目录有用户 untracked `.agents/`、`.codex/`、`.double-sdd/`，不得加入提交或清理。`releases/0.1.0`、`0.2.0`、`0.2.1` 及 `.test-output/spectral-fidelity-v021` 必须保留。

- [ ] 根代理记录计划提交后的 MAIN_BASE，创建 `.worktrees/nas-collaboration-v030` / `feature/nas-collaboration-v030`。迁移 owned `target/` 缓存到工作树复用，最后移回，不重复复制约20GiB缓存。复制现有 `.tools` 后运行 setup 更新绝对路径。
- [ ] 执行普通 npm ci（可用进程内 FFMPEG_BIN 指向已校验相同版本缓存，保持安装 hooks，复制匹配 ffmpeg.exe/LICENSE/README），fixtures、frontend tests/build 和 Rust workspace baseline；失败先诊断，不动用户数据。
- [ ] 每任务以任务前 SHA 为 TaskBase，单个 implementer 顺序实施，`tmp/sdd:` checkpoint，fresh spec+quality 双审查通过后再进入下一项。所有源代码/测试由 implementer 修改，根代理只组织/文档/整合。

## File responsibility map

- `crates/annotator-core/src/collaboration/{mod,model,validation,accounts,atomic,repository}.rs`: shared schemas, bounded auth, safe publication and per-author authority.
- `crates/annotator-core/src/collaboration/{workspace,sync}.rs`: private envelope/recovery, projection, pending generations and acknowledgements. Additional focused files allowed if needed, no monolithic service.
- `crates/annotator-core/src/project/local.rs`: explicit backend composition, personal session/revision/history delegation and mutation policy. Existing FileStore remains ordinary local backend.
- `src-tauri/src/commands/collaboration/{mod,runtime,creation}.rs`: commands, separate long-job state/generation, shared copy creation. Native project/media/exchange adapters enforce backend policy.
- `src/bridge/collaboration.ts`: strict types/parsing and native commands. `src/features/collaboration/{controller,useCollaboration,CollaborationMenu,IdentityDialog,CollaborationStatus,AuthorFilter,RemoteAnnotations,RemoteInspector}.ts[x]`: separate sync state, identity UX, read-only view. Use additional focused tests/styles as appropriate.
- `tests/desktop/collaboration-flow.test.mjs`, core collaboration tests and optional native helper: true multi-client/shared-directory evidence. Extend harness with explicit port overrides without weakening default refusal/owned PID checks.
- `docs/user-guide.md`, `docs/development.md`, `docs/verification-0.3.0.md`, `docs/evidence/<actual-date>-v0.3.0/`: concise operating and truthful release evidence. Ignored `releases/0.3.0/` frozen separately.

## Task 1: Shared schemas, accounts and safe author repository

**Create:** core collaboration module/model/validation/accounts/atomic/repository; `crates/annotator-core/tests/collaboration_repository.rs`. **Modify:** core lib/Cargo.toml, Cargo.lock, narrowly expose reusable validation/atomic helpers only when needed.

- [ ] Write RED real-filesystem tests for strict manifest/layer/account parsing and round-trip projection payload (regions/categories/file/channel labels+notes only), duplicate geometric regions from distinct actors surviving, unsupported versions and private-field injection rejected. Run `cargo test -p annotator-core --test collaboration_repository` to establish RED.
- [ ] Define structs for manifest, immutable public media, author identity/account credential, owned layer payload, revision/hash/parent checkpoint, independent read snapshot/error. Reuse existing v2 validation by reconstructing a clean document, never embed private edits/view/mix in a shared layer. Enforce spec size/count/path/reparse/identity and safe integer bounds before allocations or expensive hashing.
- [ ] Implement account normalization/deterministic safe path, atomic no-clobber registration, Argon2id exact fixed PHC validation and password verification with opaque native authenticated actor capability. Use uuid random bytes for salt, no plaintext/debug password output. RED/GREEN tests wrong password, duplicate canonical username, two concurrent registrations, hostile hash parameters and account size limits.
- [ ] Implement per-author lifetime OS lock and version publication: read verified current head, compare expected revision/hash, write+sync owned temp, no-replace publish, verify final authority and idempotent retry. No frontend supplied actor path. Keep 16 confirmed versions; highest corrupt revision is error rather than silent rollback. Poll can retain prior good layer outside repository.
- [ ] Test two actors simultaneous same-geometry publications, author spoof rejection, same-account lock contention/release, stale baseline, no-clobber competition, acknowledgement loss retry, partial write/rename fault, corrupt newest layer, media path traversal/reparse, file/count limit, and cleanup ownership. Use real independent processes for lock/no-clobber behavior where process-local locks would hide faults (small test/helper allowed).
- [ ] Run `cargo test -p annotator-core`, `cargo fmt --all -- --check`, `cargo clippy --workspace --all-targets -- -D warnings`; record RED/GREEN and observed results in `docs/double-sdd/nas-task1-evidence.md`, raw `.test-output/nas-task1/`. Commit `tmp/sdd: isolated author collaboration repository`.

## Task 2: Private workspace and race-safe local persistence

**Create:** core collaboration workspace/sync files; `crates/annotator-core/tests/collaboration_workspace.rs`. **Modify:** project/local.rs and small session/store interfaces; native project apply/undo/redo delegation only as required to use guarded LocalProject API and keep builds working.

- [ ] RED tests: independent guest/A/B private caches, ordinary v2 unchanged, private edits/settings never in payload, local-only settings produce no shared revision, only own annotations enter history, immutable media catalog policy and native author capability checks.
- [ ] Add explicit LocalProject storage backend for ordinary FileStore vs collaborative private envelope. Shared root resolves relative media but storage root is app-local; no `.project.lock`/recovery/view file on NAS. Keep ordinary FileStore fault tests working with a clear fallible backend accessor if needed; never panic for shared mode.
- [ ] Implement atomic private envelope/recovery containing latest personal document, per-identity playback preferences, base shared revision/hash, confirmed payload and pending payload/generation. Shared open/login projects only that author's three-level annotations onto base metadata with private settings; visitor has own local-only layer. Per-cache lifetime lock prevents same-machine concurrent cache writes.
- [ ] Implement pure prepare-publication / reconcile-ack state machine. Capture A generation/hash, advance confirmed baseline atomically after success, clear pending only if unchanged; preserve newer B and all current private document fields. On restart retain B and new base. Use controlled deferred publication RED/GREEN for A→B→ackA→restart→publishB, including private-only changes and lost confirmation.
- [ ] Implement personal saved-revision semantics independent from NAS status, conservative reopen reconciliation (no pending: adopt current own layer; pending same base: retry; divergent base: conflict), explicit load-remote/discard-pending confirmation backend, and guest publish merge (new annotation/category IDs; remap references; reject conflicting file/channel fields without partial changes). Keep identity transition prepare/commit separable so failure preserves prior session.
- [ ] Guard collaborative media import/remove/catalog mutation; local relink is private and fingerprint-checked. Save-as writes ordinary personal v2 copy and leaves shared data unchanged. Shared annotation export projection clears private edits, normalizes settings/view/mix, includes only own labels and safe relative/shared media references.
- [ ] Run targeted repository+workspace tests, full `cargo test --workspace`, fmt/clippy; record private disk inventories and hashes in `docs/double-sdd/nas-task2-evidence.md`. Commit `tmp/sdd: private collaborative workspaces and sync checkpoints`.

## Task 3: Native collaboration runtime and project creation

**Create:** native commands/collaboration module/runtime/creation; native tests or `tests/collaboration_runtime.rs` and owned helper as needed. **Modify:** AppState/lib/commands/project, media/folders/exchange adapters.

- [ ] RED native-boundary tests for creator copy, guest opening collaboration.json, registration/login/logout with wrong/stale identity, actor session lock, snapshot credentials not exposed, private app-data root, unsafe mutation rejection (including malicious ordinary apply_change), and local default compatibility.
- [ ] Native project open detects collaboration envelope explicitly; normal project.json flow preserved. Use AppHandle app_local_data_dir, test override only under e2e feature or explicit injected test constructor. Project runtime nonce changes on all adopted identity/project transitions even when projectId remains same.
- [ ] Create collaboration copy from saved ordinary current document into empty target: copy/hash validated media with existing cancellation/fingerprint patterns, sanitized immutable manifest, creator account and owned payload, original document/private operations retained only in creator's local workspace. Publish manifest last. Progress/cancel API, own staging cleanup, no overwrite. Failure leaves original session usable; creator/source hashes unchanged.
- [ ] Route local save to durable private envelope and schedule at most one shared worker; 2-second/manual refresh reads remote layers and attempts pending. NAS I/O/Argon2/copy outside global project/playback/analysis mutex; capture authority then reconcile under lock. Do not let remote changes mutate personal document/revision. Network errors retain last good layers plus explicit per-layer/offline/pending state.
- [ ] Commands cover status, refresh/sync, registration/login/logout, guest publication and conflict load-remote. Identity operations use lifecycle-compatible expected project/revision/runtime and refuse out-of-date requests; do not accept renderer owner identity as authority. Stale completions cannot mutate new actor or latest local B. Slow/cancelled worker remains bounded and does not block local edits/playing; lock lifetime remains valid through admitted publication.
- [ ] Ensure private relink mappings are honored by audio/analysis/export without mutating shared manifest. Shared export uses sanitized personal DTO; shared save-as uses explicit personal-copy path. Guards in async media import/commit and folder scan admission prevent bypassing disabled UI.
- [ ] Test two independent native sessions/data roots, fresh and stale callbacks, delayed I/O local edits, logout during pending, missing NAS recovery, highest corrupt author with other good layers, safe closing, and selected-channel processing unchanged. Run Rust full/fmt/clippy, frontend existing tests/build for interface compatibility; build debug native e2e and exercise commands through actual Tauri IPC. Record `nas-task3-evidence.md`. Commit `tmp/sdd: native NAS collaboration lifecycle and synchronization`.

## Task 4: Identity, synchronization and compact collaboration controls

**Create:** bridge/collaboration.ts; collaboration controller/hook/menu/dialog/status/filter plus tests and focused CSS. **Modify:** app shell/workspace menu, project lifecycle opened/adoption boundaries, SaveIndicator, playback settings identity initialization, export labels.

- [ ] RED strict bridge tests reject unknown fields/credentials/invalid remote region/invalid status versions and bounded malformed data; native API actual serialized shapes remain authoritative. Keep ProjectSnapshot ordinary protocol unchanged; collaboration metadata/state is separate.
- [ ] Add collaboration UI controller with single-flight 2-second polling, manual save→sync, last-good remote state, status and actor filters. Cancellation/active-runtime checks on every async completion; no ProjectStore.accept for other-author refresh. Test late results, draft/selection/playback preservation and repeated errors without request accumulation.
- [ ] Add “创建协作副本…” entry from ordinary project with empty-directory picker, identity form, copy progress/cancel. Project open filter accepts collaboration.json. Add menu/compact identity/status button: register/login/logout, refresh, all/mine/author toggles, pending/offline/conflict details. Normal state no teaching banner. Sign-in and identity changes go through lifecycle save/transition barrier; failure keeps prior current project and identity.
- [ ] Persist/reload volume/device and applicable playback options per local actor; reset ephemeral intents/cues/selection/history on identity adoption. Test no private state leaks across guest/A/B, while same actor reopen restores its private settings. Credentials never enter generic note drafts, snapshot, localStorage or logs.
- [ ] Add visitor publish explicit action and conflict recovery actions (“另存我的本机副本…”, confirm “加载共享版本”). Local-save vs shared-sync indicators truthful; exiting retains already durable pending for next login. Prevent edits against shared catalog in every UI path without disabling own annotations/personal processing.
- [ ] Label collaboration exports explicitly current-author only, normal local export unchanged; share dialog notes current scope concisely. Test forms/outside/Escape, errors, cancelled creation, no accidental double registration/publication, safe focus/keyboard and lifecycle barriers.
- [ ] Run `npm.cmd test -- src/features/collaboration src/features/project src/features/playback src/bridge src/app`, full frontend tests/build; fresh native build and actual UI guest/register/login/logout/copy workflow. Record `nas-task4-evidence.md`, screenshots 1280×800 and1920×1080. Commit `tmp/sdd: collaboration identity and sync controls`.

## Task 5: Read-only collaborator overlays and three-level inspection

**Create:** RemoteAnnotations/RemoteInspector and focused tests. **Modify:** ChannelPane, AnnotationOverlay hit routing as necessary, AppShell inspector/list author view, selection/region menu integration, styles. **Test:** actual UI collaboration flow beginning, native export boundary integration.

- [ ] RED: A and B same geometry both visible with author names; toggling filters only affects visibility; foreign frame has no handles/modify commands and cannot enter writable selection; current own active frame keeps grab priority. Foreign updates cannot reset own unsaved note, own undo or playback source.
- [ ] Render separate transparent readonly layer using existing coordinates and plot clipping; show author+category tooltip/short label, all/mine/specific filters. Distinguish no-author-data from error/stale. Avoid full-image tint and extra permanent rows.
- [ ] Foreign frame click/context opens readonly details (author, region, category, note) and explicit playback/locate only, using captured authoritative remote identity and current source rules. Re-resolve stale/deleted remote targets at execution. Selecting remote leaves own saved frames unchanged; new blank draw and own handles remain usable. No dragging/resizing/editing foreign frame. Overlaps selectable through author list.
- [ ] Show per-author file/channel categories/notes plus region list; locate respects pane independence/channel visibility, uses current user's settings. Keep current author's existing category/notes editor; do not make foreign ID eligible for ordinary action constructors. Test programmatic foreign update/delete rejected natively even if UI forged.
- [ ] Integrate two clients using explicit independent harness ports and local-data roots (or true native helper for collaborator). Both create same-region annotations, A modifies/deletes own and B remains; view A from B, display filters and readonly actions, simultaneous note drafts, separate masks/volume/view, restart/login owner, exact original hash preservation. Check collaborative exports exclude other authors/passwords/private edits and ordinary full bundles still retain existing semantics.
- [ ] Run full frontend tests/build, targeted Rust and fresh native build+collaboration flow. Record `nas-task5-evidence.md`, screenshot author overlaps and readonly inspector. Commit `tmp/sdd: read-only collaborator layers and author inspection`.

## Task 6: Full verification and Windows 0.3.0 release

**Modify:** desktop/performance runners only as required, version manifests/locks, HelpDialog, notices generator header, README/user-guide/development. **Create:** verification0.3.0/stable evidence, release freeze and source manifest.

- [ ] Complete real multi-process concurrency tests and desktop collaboration flow: accounts, guest copy, overlapping layers, owner-only update/delete/history, same-account second writer blocked, crash/lock release, refresh, pending reconnect, divergent own baseline conflict, A publish/B newer save restart reconciliation, corrupt foreign layer isolation, read-only share failures and cancellation. Fault tests only own fixture paths; restore after simulated disconnect. Add suite to sequential runner; preserve all18 previous suites and their effective assertions.
- [ ] Run `npm.cmd ci`, `npm.cmd run fixtures`, `npm.cmd run typecheck`, `npm.cmd test`, `npm.cmd run build`, `cargo fmt --all -- --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace`, `npm.cmd run test:desktop` and new concurrency/native suite. Record exit codes, counts, failures and fixes; do not silently delete assertions or rely on stale artifacts.
- [ ] Repeat existing HD/performance (`npm.cmd run perf`) at real1920/DPR density and processed playback; add representative two-author overlay/refresh check ensuring private audio/analysis authority stays unchanged. No lowering canvas resolution, weakening no-underrun or changing DSP to pass.
- [ ] Set all product versions0.3.0. `npm.cmd run notices` updates required new Rust dependency notices while reusing existing exact MPL archives; no unrelated version upgrades. Verify source inventory/resources and no secrets/private test credentials in delivery. Update Chinese help/guide with create/open/login/authorfilter, personal-only export, fixed media catalog, local/pending/conflict, trusted filesystem boundary and format support.
- [ ] Run normal `npm.cmd run tauri -- build --bundles nsis` without e2e/config override, wait completion, then verify same EXE with owned PID and actual native pickers: create shared copy/register, logout/guest view/login, author view and personal mask, close/reopen. Verify second native client if feasible; core/desktop multi-client evidence cannot be described as physical NAS testing. Do not alter system DPI/volume or operate user windows.
- [ ] Freeze ignored `releases/0.3.0/`: EXE, NSIS, guide, third-party notices/full licenses including sources, provenance/257-or-actual source file manifest, verification, file inventory/SHA. Preserve oldreleases/raw, disclose unsigned/manual-hearing/new-machine-install/exFAT/physicalNAS gaps exactly. Record `docs/verification-0.3.0.md` and stable evidence. Commit `tmp/sdd: verify and package NAS collaboration 0.3.0`.

## Root integration

- [ ] After all task pairs PASS, fresh full-range quality reviewer MAIN_BASE..finalHead; adjudicate findings against actual code, fix via implementer and re-review if material.
- [ ] Apply finishing-a-development-branch with already-authorized local squash, no extra user prompt. Verify main unchanged from MAIN_BASE, protect user untracked dirs. Move release/raw/tools and exact as-built inputs to main unique locations, verify hashes, restore owned target cache before cleanup. Record old→new evidence paths without modifying raw reports.
- [ ] Squash feature into main; compare staged reviewed tree. Run main frontend fulltests/build and workspace Rust tests plus collaboration focused checks. One permanent implementation commit; final docs-only completion amendment allowed.
- [ ] Confirm no owned process references feature, source clean, all ignored needed artifacts preserved; remove temporary worktree/branch safely. No push. Give program/installer/docs links and truthful verification/physicalNAS limitations. Keep executing until this entire checklist is complete.
