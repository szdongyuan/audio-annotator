# 0.6.0 Windows verification

Date: 2026-10-26. This release replaces project accounts with global UUID identities and local nicknames. Collaboration format is 3; ordinary ProjectDocument and exchange formats remain 2. Old collaboration formats 1/2 are deliberately rejected without migration.

## Verification

| Check | Actual result | Raw evidence under `.test-output/uuid-identities` |
| --- | --- | --- |
| Frontend | 56 files, 459 tests passed | `final-frontend.log` |
| Typecheck / frontend build | Passed; existing chunk-size advisory | `final-typecheck.log`, `final-build.log` |
| Rust workspace | 298 passed, 0 failed, 4 existing ignored | `final-workspace.log` |
| Native with e2e feature | 71 passed | `final-native-e2e.log` |
| Rust formatting / strict workspace clippy | Passed | `final-fmt.log`, `final-clippy.log` |
| Desktop | All 24 registered phases have passing evidence | `desktop-aggregate.json` |

Desktop results are an aggregate of the registered run and diagnosed continuations, **not one uninterrupted passing run**. The first run's debug/source version mismatch, folder helper's disabled-button readiness race, and native fixture's retired fixed-catalog expectation were corrected without weakening assertions or timeouts. Actual UI acceptance found an inert/focus handoff bug; an integrated AppMenu-to-identity-dialog regression reproduced it, and explicit trigger capture fixed it. The final rebuilt app passed compact-layout, interaction-flow and the complete UUID suite. All failed logs remain available; details are in `docs/double-sdd/uuid-identities-task4-evidence.md`.

Actual native UI workflows cover empty-workspace profile creation/use/export; the same UUID across projects; export/import between independent app-data directories without automatic selection; duplicate import retaining the local nickname; rename preserving UUID/creation time; same-UUID writer contention and explicit read-only opening; overlapping Alice/Bob regions and own categories/notes; private masks, volume and hidden-list restoration; shared audio/labels without source-PC private edits; same-profile no-op; and a 100-profile list at 1000×680 with footer/focus/keyboard/outside dismissal. Existing media, playback, classification, Save As rescue after real source persistence obstruction, exchange, configurable folder/ZIP import and corruption recovery checks remain.

Native IPC-only suites and transport/Channel failure injections are labeled separately from UI acceptance. No frontend-store mutation replaces UI workflows. Test data is generated in owned local directories; no user NAS projects or recordings are written. The former DPAPI corruption scenario now corrupts an owned profile store in a fresh process, verifies refusal without a replacement author, restores exact bytes and reopens the original UUID.

## Build provenance

The normal production command is `npm.cmd run tauri -- build --bundles nsis`, without e2e or an extra Tauri configuration. Before that build, 350 source/build inputs were frozen with relative paths, sizes and SHA256 at `D:/Work/annotator/.test-output/uuid-identities/release-product-source-manifest.json`; exact bytes are retained in `release-asbuilt-inputs` beside it. Manifest SHA256: `c335dbefff154c03e8ce16ed54e439090b74da215d6dcb698b20f2b04204e182`. Post-build rehashing must match the frozen source and backup.

The command exited 0 (`release-production-build.log`). All 350 input hashes and exact-byte backup hashes match after the build (`release-source-rehash.log`). Delivery is untracked at `D:/Work/annotator/releases/0.6.0`, including licenses/resources, the source manifest, build provenance, a sorted inventory and SHA256SUMS. Both EXE and NSIS report actual file/product version 0.6.0 and Authenticode `NotSigned`.

| Artifact | Bytes | SHA256 |
| --- | ---: | --- |
| `annotator-desktop.exe` | 17,104,896 | `406fd8f3c4748a1df913d443b7d447d821369be3dc9dcf8a0d919144f6528b40` |
| `Audio Annotator_0.6.0_x64-setup.exe` | 221,995,871 | `2670c90a3e16a1e708556e878fc1019b779f45803668e1ce13c65dc032889348` |

The staged normal executable contains none of the checked e2e marker strings. All 250 protected prior release files were independently rehashed unchanged. Current third-party inventory has 293 entries and no missing notices; all 31 license/resource files (including 13 MPL source archives) are delivered and matched to the Tauri resource declarations.

## Normal-program smoke

Two bounded owned-process launches used the delivered production executable, no e2e/debug flags and the real Windows application-data location. The first observed the native window before frontend readiness; the second waited on the owned accessibility tree and observed the actual menu/UI. Its WebView command line had zero debug arguments. The first legitimate default UUID profile initialized; no test profile was created, selected or renamed. Both owned processes were retired. Evidence: `production-smoke` and `production-smoke-ready` under the raw root.

The collaboration menu could not be invoked through the available native accessibility pattern. Production identity-dialog interaction and native picker interaction therefore remain unverified; no blind restore/click loop or production test backdoor was used. Actual identity/menu workflows are covered by the separate e2e WebView acceptance above.

## Limits

Automated playback output counters are verified; subjective listening is not. Device-scale emulation is verified, not physical Windows DPI settings. Installer execution, installation/uninstallation on a new/offline machine, separate physical computers/Windows users and NAS failure behavior are not claimed by this run. Identity transfer uses separate owned application-data directories on this Windows host.

## Final main integration

All four paired task reviews and the final whole-range quality review passed. The completed work was squash-integrated onto main base `2833ae35907f37ae1511f4665dd3f7ff15d83839` as one permanent commit; no push was performed. Before completion documentation, the staged Git tree exactly matched the reviewed tree `e3728addd618f9201f636ff225e72169d76e9aeb`.

Independent verification from `D:/Work/annotator` passed: 459 frontend tests, typecheck and frontend build, 298 workspace tests with 4 existing ignored, 71 native e2e tests, formatting and strict clippy. Raw logs are `root-main-*.log` and `root-main-command-status.log` under the evidence directory. All 350 main source inputs match the exact as-built manifest; 52 checkout differences were proven to be line-ending-only and restored from the verified byte backup before these checks. The normal release binaries were not rebuilt or replaced during integration.

Independent delivery audit verified all 42 files, 41 checksum entries, 350 source inputs/backups and all 250 protected prior release files. The temporary worktree and branch were removed after commit, unlinking only the two verified junctions without traversing them. Main node_modules, target, tools, raw evidence, as-built backups, prior releases and the 0.6.0 delivery remain available. Original untracked workflow directories were left untouched. See `root-delivery-audit.json`, `root-main-source-reconciliation.json` and `root-cleanup.json`. The limits above remain unchanged.
