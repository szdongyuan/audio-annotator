# Media folders and editing workspace · 0.7.0 completion

All original media-folders tasks 1–5 and editing-workspace tasks 5–8 are complete. Original Task 5 acceptance and delivery were consolidated into editing Task 8, rather than releasing an intermediate format. The detailed consolidated evidence is `editing-workspace-task8-evidence.md`; final public verification is `../verification-0.7.0.md`.

Every implementation task passed its paired spec and quality review. Final Task 8 range: `8204c23d6ac05265766cd824f6d789661316d6df..cbe4b0c09fb8e35916898f40953667e73b65ddb1`. Whole-range quality review: `49d016326cfa12cf498b82aff771f57e854c2c28..cbe4b0c09fb8e35916898f40953667e73b65ddb1`, PASS without required fixes.

## Delivered behavior

- Shared logical folders, four distinct discovery/placement plans with collapsed advanced settings, logical second-route selection, metadata grouping and safe fallback; preserved-directory and flat portable exports use one validated path plan.
- Ordered multiple labels at region, file and channel scope; independent notes and author ownership remain intact.
- One-click transient-selection retirement, plain-click playback cue and fresh-session start, selection dragging and playback; saved annotations remain independent of private DSP operations.
- Private undoable masks and regional gain, global monitoring default and absolute per-audio override/follow, no original-audio mutation and no monitoring-induced playback restart.
- Compact 28px media rows, contextual actions and central spectrum transport with gain and scoped reset controls; actual minimum-window and six-plus-six-channel layouts verified.

## Integration and fresh verification

Main base was unchanged `49d016326cfa12cf498b82aff771f57e854c2c28`. Local squash produced the exact reviewed tree `4e0edff6f66b1b3a2737cec7d34b7ef01e69cafc` before final completion-document edits. All 440 frozen build inputs retain their exact production bytes; 69 checkout-only CRLF/LF differences were reconciled from the verified backup. Only completion records changed after the code review and main tests.

Fresh main checks: frontend 569/65 files; Rust workspace 363 passed, 0 failed, 6 opt-in ignored; native e2e library 86; harness 19; typecheck/build/fmt/strict clippy all PASS. Actual desktop acceptance has 26 passing phases as an explicitly documented aggregate (`singleRunPassed:false`), with all failures, corrected attempts and the approved retained-project relink continuation preserved. The two-client editing and folder scenarios include numerical −6 dB processing, raw-byte hashes, new project UUIDs, public/private isolation and undo/reset behavior. Nine real NAS archives were read only: 3294 both-route and 1647 first-route identities.

Raw root evidence: `D:/Work/annotator/.test-output/media-folders/root-main-checks.json`, `root-squash-tree-equality.json`, `root-main-source-restore.json`, `root-desktop-authority-audit.json`, `root-independent-main-precommit-audit.log` and `root-cleanup.json`. No temporary feature commits are retained in permanent main history; no push was performed.

## Delivery and preservation

Release directory: `D:/Work/annotator/releases/0.7.0` (ignored/untracked). Both artifacts are normal production builds without e2e features or configuration overrides:

| Artifact | Bytes | SHA256 |
| --- | ---: | --- |
| annotator-desktop.exe | 18,156,032 | 5168e313c14d521d22601a60b5dec25cf4a5328f38de48c8ade1588b8f4d8082 |
| Audio Annotator_0.7.0_x64-setup.exe | 222,289,019 | a4eb24fa341f6a9ba9b9ff07ab71debbbe33daaf52176e0ee07da6b0b00fb6b9 |

The exact pre-build backup and 440-input source manifest remain under raw evidence. All 31 license files and both bundled guides match actual build resources and NSIS directives. All 292 prior delivery files retain their original size/hash. Release verification/provenance/inventory/checksums are updated after the final completion records.

Both verified dependency junctions were removed nonrecursively before the temporary directory was deleted; main dependency cache sentinel hashes remain unchanged. All 199 remaining worktree evidence files were copied and individually verified before cleanup. Git encountered Windows long paths after unregistering the worktree; the exact owned residual directory, with zero reparse points, was removed using native PowerShell 7 after path/backup checks. The temporary branch is removed. The owned C: production/main-check target is retained for audit; dependencies, existing releases, user files and evidence are preserved.

## Limits

Binaries are unsigned. Installer execution, independent-machine installation, subjective listening, physical Windows DPI, cross-host NAS concurrency and production identity-dialog invocation are not claimed. Actual workflow testing used isolated e2e profiles; the normal production readiness smoke preserved the real profile-store hash and used no debug arguments. Final formats explicitly reject retired versions without migration, as requested.
