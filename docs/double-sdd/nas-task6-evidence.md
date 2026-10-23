# Task 6 release handoff

2026-10-23. TaskBase `796acbc91158b6ec1fe9c35737ae396b7c9e6bd1`; worktree `feature/nas-collaboration-v030`. Task 6 completed through normal production UI acceptance and ignored release freeze. Root review/integration remains separate. Full details: [0.3.0 verification](../verification-0.3.0.md).

## Changes and regression evidence

- Preserved all 18 previous desktop phases and added native/controls/two-client collaboration suites. Registration RED missing collaboration-native, then GREEN. Output-isolation regressions failed four cases before implementing per-run destinations and unique standalone defaults; final harness 11/11 passed.
- Full desktop exposed a Task 5 cross-pane selection regression: pane-local `current` replaced global active selection for blank-gesture deactivation. Added ordinary/shared tests (RED 2 failures / 31 passes), restored global active selection with the author-visibility guard, then 100 focused and 355 full frontend tests passed. Fresh complete desktop 21/21 passed.
- Added real Windows DACL rejection/recovery in native IPC and same-account rejection, UI offline pending/reconnect, and unchanged two-author refresh instrumentation in the two-client UI suite. Final native 8 groups, controls 9, layers 16. Existing real core subprocess, crash lease, in-flight A/B, divergence, corrupt-head and cancellation tests reran in workspace 182/182.
- Product/manifests/locks/help/docs are 0.3.0. Notices header uses the lock version (old-header check RED, generated 0.3.0 GREEN); inventory 299 packages, no missing notice, no dependency upgrade. Exact 31 license resource files including 13 MPL archives were checked against staging and NSIS inclusion.

Final commands, counts and performance method are in the linked verification. After versioning, typecheck, frontend 355, build, fmt, strict workspace clippy, workspace 182, e2e test 1 and e2e clippy passed; fresh 0.3.0 debug compact UI 15/15 passed. Normal `npm.cmd run tauri -- build --bundles nsis` exited 0 after all e2e/performance builds. Production UI used real native pickers, owned Win32 controls and scoped native UIAutomation text entry; no test IPC/store mutation. Six formal groups passed, including independent production PIDs 24972/37088, foreign updates, private mask/reopen/Save As and version. Both processes closed normally.

Performance: real 1920×1080/DPR1, 600s 6+2 channels; zoom/pan/mix P95 90.5/84.0/74.6ms, combined 84.0ms. Original/processed native output 30,595.74/30,553.40ms, zero underruns. No DSP/resolution/budget reductions. Two-author unchanged manual sync/poll IPC 2.2–13.6ms, zero spectral pixel writes/analysis requests/playback reconfiguration with a positive transport probe. Physical SMB/NAS, manual hearing, physical DPI changes, new-machine offline install/uninstall and exFAT remain unverified.

## Frozen delivery and preservation

`releases/0.3.0/` has 42 files, including 41 entries in SHA256SUMS. EXE 15,840,768 bytes / `ac4b4d84a46360af7c43a49774969160418ac89310e763ffc7fafdd7fd881f24`; NSIS 221,767,821 bytes / `aac18ad0667a00906147f6c06a4c234222698abe528b0256f6090f3c51608cd1`. Both file/product versions 0.3.0, NotSigned. All production test-marker scans, resource comparisons and credential exclusion checks passed.

292 exact production input files were copied before the normal build to `.test-output/nas-release/as-built-inputs/`. Manifest SHA256 `a142be00f89337068cdc9293cb1537bb8d42850e855741cbaf2162dbe9a29052`. Freeze rechecked current bytes and archived bytes; future Git/CRLF normalization cannot be substituted for this as-built evidence. Root also independently verified all frozen sums and both input sets (`root-artifact-verification.json`).

Preserve **all** worktree `.test-output/`, frozen release, `.tools/` and owned `target/`; only the root may restore/move the shared target and integrate/remove the worktree. Do not overwrite old releases. Main/user configuration and protected untracked directories were not changed, and no push occurred.

The final plain `git diff --check` reports one original upstream trailing space in the newly included subtle 2.6.1 BSD license, `licenses/THIRD-PARTY-NOTICES.txt:34484`. It is intentionally preserved with the exact licensed/as-built bytes. `git diff --check -- . ':(exclude)licenses/THIRD-PARTY-NOTICES.txt'` passes. Logs: `diff-check.log` and `source-diff-check.log`. This is a documented generated-license exception, not an application lint/test failure.

Raw failures and repairs remain documented in verification: first cross-pane failure (fully archived), inherited fixed-output overwrites before isolation, Windows PowerShell/Core ACL module mismatch, selecting the overlapping mask in the added note test, ineffective readonly invoke instrumentation, and formal input-method/accessibility/float precision test adaptations. Early repeated formal phases reused one screenshot basename; unique failure logs remain, and later captures use unique names. No claim is made that every early screenshot survived. No product changes occurred after normal build/input capture.
