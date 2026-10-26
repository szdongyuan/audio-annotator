# Task 4 implementation evidence: folder tree and compact import/export UX

TaskBase: `4e7d44374515816fc48377ea819d2cca67ae41c5`. Worktree: `D:/Work/annotator/.worktrees/media-folders`. Raw logs: `D:/Work/annotator/.test-output/media-folders/task4-*.log`. Implementation checkpoint only; paired spec/code and quality reviews remain pending. No Task 5 desktop harness, version, native, release or delivery changes were made.

## Independent shared organization

- `OrganizationController` owns only Organization DTO state, selected folder ID, errors and native revision drafts. It has no reference to ProjectStore, catalog adoption, save, annotation history, playback, PCM or private DSP state. `useOrganization` creates one controller per ActiveProject object and runtime nonce, including StrictMode replay cleanup. It polls every 1500ms and on focus; a shared in-flight promise bounds overlapping slow reads. Conflict refresh can force a newer generation.
- Reads and mutations use `createOrganizationClient(runtimeNonce).get(projectId)` / `.apply(projectId, expectedRevision, operation)`. Project/runtime binding, generations, monotonic organization revisions and disposal reject stale/foreign replies. Errors retain the last valid snapshot. An acknowledged native mutation after disposal cannot install into a replacement owner, and no UI rollback attempts to retract a committed head.
- Edit drafts pin `expectedRevision` when the dialog opens. A RevisionConflict retains typed operation input, refreshes the tree and advances the draft revision for a separate explicit `核对并重试` action. No automatic overwrite or private-document transition occurs.
- `organizationIndex` indexes folders, ancestry paths, children, known media placement and native membership counts. Unknown unadopted media are never rendered as document media; full native membership counts include hidden/pending media for empty-folder context. Existing explicit 更新音频列表 remains unchanged.
- Selected folder IDs survive rename/move. Removal of the selected empty folder falls back to root. No organization update changes the active media selection or private snapshot.

## Folder tree and native actions

- The shared sidebar now has 全部音频, descendant counts, indexed expandable folders and media, folder-path/name search revealing matching ancestors, source-context accessible names, existing hide/restore and relink/status controls. Ordinary projects retain the root flat list. Read-only shared clients browse/select/play and receive synchronization, with mutation actions disabled.
- Folder disclosure and folder selection are separate buttons. Disclosure changes only expansion; selecting a folder scopes media/import target and reveals that folder/ancestors. Re-selecting an open folder keeps its media visible. Folder or media moves preserve active audio/private editor state.
- Existing `Menu` supplies keyboard navigation, Escape/outside dismissal and stable return-focus handoff. File menu actions also forward their stable trigger to source and exchange modals before root inert. Folder actions are create child, rename, move and remove empty; media actions include move to folder, hide and relink. Remove-empty is disabled for children or any native membership, including hidden media; native validation remains authoritative.
- `MediaDialog` portals outside the app root, captures the stable trigger before applying inert, traps focus, and removes inert before restoring focus. Real Menu tests cover Escape/outside dismissal with inert focus blocking. Open menu/draft state is bound to the controller owner and retired on owner replacement.
- `useMedia` retains its import-controller instance across folder selection. Direct import passes the selected `{folderId,layoutRevision}` through the existing native media start target, while relink retains the original path. Source import begins with the selected folder or root.

## Import plans and source dialog

- `ImportPlanStore` uses `annotator.import-plans.v2`; old `annotator.import-rules.v1` bytes are untouched. Storage is bounded to 2,000,000 characters, 32 custom plans and the existing strict discovery/organization budgets. Reader/writer validate the same reusable shape and unknown versions fall back with an error.
- Presets contain discovery plus reusable organization rules, excluding source paths and `targetFolderId`. Four immutable choices are 通用·保留来源目录 (generic/sourcePath/wrap), 通用·平铺 (generic/flat), 精成·按结果和故障分类 (jingcheng/template `{source}/{result}/{faultType}/{record}`), 精成·保留来源目录 (jingcheng/sourcePath/wrap/strip `audio`). Custom save/delete never overwrite built-ins.
- `SourceImportController.configurePlan` updates the combined configuration atomically and invalidates/releases the old preview. Applying a preset preserves the current project target. Parser changes to generic simultaneously replace dormant manifest templates with `{source}/{relativeDir}`, matching strict Task 2 validation. Scan validates both rules and organization before source I/O.
- The visible compact form contains source picker, 导入方案, target, layout, relevant logical second-route toggle, preview and explicit import. Advanced settings are closed initially and contain parser, patterns, recursion/extensions, wrapping, stripping, template/supported token picker and custom save/delete.
- Controls reflect the controller config across presets and reopening. Controller-owned raw pattern/strip editing text preserves trailing separators during typing and synchronizes whenever a plan changes; no stale per-component configuration copies survive reopening.
- Preview uses native complete `folderSummary`, including folders beyond the first 50 candidates. Indexed expandable directory rows and media rows are separately bounded to 50 per page. Resulting path/filename is visible; original source context and bounded missing-metadata issues are collapsed. Existing 256-item batch publication, <=50 native page requests, reservation, acknowledgement, retry/cancel/release and retained capability recovery remain intact.

## Accepted native export preview

- Bundle export defaults to preserving project folders. Annotation JSON has no preserve checkbox and continues to retain logical organization. One compact caption explains current-author/private export scope; no new toolbar or permanent explanatory banner was added.
- `prepareExport(kind,preserveFolders)` flushes the current queue/durable drafts, pins owner/project/runtime/document revision and calls `exchangeClient.preview(expected,bundle,preserveFolders)` without saving or entering a lifecycle transition. This is deliberately read-only and dismissible on Close/Escape/outside pointer; closing invalidates only its UI generation.
- A retained promise tail serializes native preview calls across rapid configuration changes and Close/reopen. Native stores one preview slot, so a late old call must finish before the next native call starts. Obsolete queued work is skipped and obsolete responses cannot install. The delayed Close/reopen regression proves the accepted latest token remains the native slot winner.
- The visible preview shows native readiness/counts and a collapsed original-to-planned adjustment list, bounded to 50 rows/page. Stale/error state exposes explicit refresh. Changing bundle/JSON/preservation invalidates acceptance.
- Actual export still uses `project.performExchange` for admitted edits, draft/save/transition and native start. It captures owner and accepted preview before the async picker, rechecks the post-save expected revision/runtime/project and sends exactly that `previewToken`. Changed revisions require an explicit refreshed preview; no unseen plan is substituted. Native completion from a replaced owner is rejected before it can return an OpenedProject for adoption.

## RED/GREEN and verification

- `task4-controller-plans-red.log`: missing new controller/preset modules failed (exit 1). `task4-controller-plans-green.log`: initial 6 focused cases passed (exit 0).
- `task4-tree-source-red.log`: missing atomic configurePlan/tree behavior failed (exit 1). `task4-ui-focused-green.log`: tree/source/export cases passed, 31 tests (exit 0).
- `task4-source-fields-red.log`: trailing pattern newline was lost (exit 1). Controller-owned editing text fixed it; source suite 21 passed in `task4-source-fields-green.log` (exit 0).
- `task4-export-red.log`: missing preservation/accepted preview controls failed (exit 1). `task4-export-dismiss-red.log`: initial preview incorrectly entered performExchange and could not dismiss (exit 1). The read-only serialized implementation passed 11 export cases in `task4-export-dismiss-green.log` (exit 0).
- `task4-tree-owner-red.log`: an open draft survived controller replacement (exit 1); owner-bound menu/draft state passed in `task4-tree-owner-green.log` (exit 0).
- `task4-export-owner-red.log`: a replaced owner's late completion returned an OpenedProject (exit 1); captured-owner event guard passed all 12 export cases in `task4-export-owner-green.log` (exit 0).
- `task4-folder-navigation-red.log`: reselecting an expanded folder collapsed its scoped audio (exit 1); separate disclosure/selection passed 5 tree cases in `task4-folder-navigation-green.log` (exit 0).
- `task4-slow-poll-red.log`: overlapping slow reads issued two native calls (exit 1); bounded read sharing and forced conflict generation passed 26 focused cases in `task4-slow-poll-green.log` (exit 0).
- `task4-preview-outside-red.log`: pending preview lacked outside-pointer dismissal (exit 1). `task4-file-menu-focus-red.log`: exchange/source omitted the stable File menu return trigger (exit 1). Outside dismissal and explicit pre-inert trigger forwarding passed 39 focused tests in `task4-preview-outside-menu-focus-green.log` (exit 0).
- `task4-controller-ui-regressions.log`, `task4-bounded-preview-selection.log` and `task4-target-token-regressions.log` cover real Menu/inert focus, StrictMode owner/poll/focus guards, unchanged private snapshot/drafts/history, complete folder summaries with 50-row pages, selected folder fallback, target retention and accepted native token propagation. All exit 0.
- Final `npm.cmd test -- --maxWorkers=2`: exit **0**, **491 passed / 0 failed in 62 files** (`task4-frontend-final.log`). Earlier frozen runs passed 487/488; the slow-read and explicit dismissal/focus regressions motivated the final rerun.
- Final `npm.cmd run typecheck`: exit **0** (`task4-typecheck-final.log`). Initial checks exposed only two newly added mock type annotations, corrected without production behavior changes; failure logs retained.
- Final `npm.cmd run build`: exit **0**, recorded in `task4-build-final.log`. Vite's existing large-chunk warning remains informational.
- `node --test tests/desktop/harness-menu.test.mjs tests/desktop/harness-lifecycle.test.mjs tests/desktop/harness-output-init.test.mjs tests/desktop/release-suite-registration.test.mjs`: exit **0**, **12 passed**, no skips (`task4-harness-units.log`). Frontend Menu/identity registration regressions also run in the full npm suite.
- `git diff --check`: exit **0**, recorded in `task4-diff-check.log`.

## Scope and deviations

The read-only, queued export preview is an explicit parent-authorized refinement: save/admission/transition remain at actual export start, while preview can be dismissed during a slow NAS read. Strict post-save matching still prevents use of a stale or unseen plan. No other plan behavior was weakened.

Task 5 will adapt old desktop labels/positional checkbox selectors, run actual WebView/two-client/NAS acceptance and verify physical output/compact-window behavior. Those real desktop checks were not claimed here. No NAS writes, raw audio commits, native changes, version metadata, production/release files, main integration, push, worktree removal or junction deletion occurred. Shared node_modules/target junctions and real .tools copy were preserved.

## Task 4 paired-review correction: stale menu targets

Original TaskBase remains `4e7d44374515816fc48377ea819d2cca67ae41c5`; correction base is `9eb1a0370bb5364549e61d8c10550b5550e444c7`. The original-range spec review passed. Parent confirmed the independent quality review's P2 stale-folder menu finding and authorized this focused correction. Fresh paired review of the corrected original range remains pending.

Root cause: `MediaList` kept menu state valid using controller ownership only. A remote organization refresh removed the folder and its trigger while the existing menu still exposed Rename/Move. Those callbacks dereferenced the now-missing indexed folder's `name` / `parentId`. Media callbacks similarly retained a removed local descriptor.

Correction, confined to `MediaList`:

- Menu target validity now checks the current indexed folder / visible local media. A missing target or detached trigger retires the menu. Invalid actions are disabled during that render.
- Folder actions resolve their target again from the controller's current snapshot when activated. Media actions resolve the current local descriptor and hidden state. Missing targets safely close the menu without opening a draft or invoking mutation/relink callbacks.
- Draft admission checks current target/destination membership before capturing the revision. This also covers a controller snapshot publication immediately before its React notification.
- A stable root-menu ref becomes the return-focus target before the stale Menu unmounts. Retirement and rejected actions focus the connected root control instead of a removed row. Existing valid-menu and modal focus behavior remains covered by the original tests.

RED: `npm.cmd test -- --run src/features/media/organizationTree.test.tsx --maxWorkers=2` exited **1**, **3 failed / 5 passed** (`task4-review-stale-menu-red.log`). Actual controller revision-2 publication while the menu stayed open reproduced both `Cannot read properties of undefined (reading 'name')` and `...('parentId')`; removed media still invoked its old relink callback.

GREEN: the same focused command exited **0**, **8 passed** (`task4-review-stale-menu-green.log`). Two additional action-time tests cover a changed controller snapshot before React notification.

Fresh correction verification, after the final product change:

- `npm.cmd test -- --run src/features/media/organizationTree.test.tsx src/features/media/organization.test.ts src/components/menu/menu.test.tsx src/features/media/import.test.tsx --maxWorkers=2` → exit **0**, **38 passed / 4 files** (`task4-review-focused.log`). Tree cases include both remote-delete actions, removed-media retirement, current-snapshot revalidation and connected root focus.
- `npm.cmd test -- --maxWorkers=2` → exit **0**, **496 passed / 62 files**, no failures (`task4-review-frontend.log`).
- `npm.cmd run typecheck` → exit **0** (`task4-review-typecheck.log`).
- `npm.cmd run build` → exit **0** (`task4-review-build.log`), with the existing informational Vite chunk-size warning.
- `git diff --check` and staged diff check → exit **0** (`task4-review-diff-check.log`).

No generic Menu, controller/native contract, Task 5 desktop harness, future multi-label/gain feature, version/release, NAS data, junction, main integration or push changes were made. The correction adds no new product scope or plan deviation.

## Task 4 paired-review correction: close-time dialog focus

Original TaskBase remains `4e7d44374515816fc48377ea819d2cca67ae41c5`; this correction base is `c24aa98a5882c42cf3df9462ad28cfa47532e3bf`. Parent confirmed the fresh spec review's second focus-lifetime finding; the quality PASS from that pass was held/discarded. A new paired review is required after this correction.

Root cause: the menu correction validated its trigger at menu lifetime boundaries, but `MediaDialog` retained the opening element in a ref and blindly focused it on cleanup. A remote deletion/move or successful local folder deletion could detach that element while the dialog remained open. During owner replacement, React can also run the portal cleanup before removing a previously connected old-owner row/root.

Narrow correction:

- `MediaDialog` still captures the initial trigger before applying inert. Cleanup removes inert first, invokes the latest optional close-time focus resolver, and focuses only a connected result.
- Folder dialogs resolve the captured row at actual close. They reuse it only for the current owner while it remains connected; otherwise they use the surviving root-menu control. If owner replacement removes that shared root, they use the stable search control. A current-owner ref prevents selecting an old root/row that React is about to remove during the same commit.
- No draft, native command, playback, annotation history, controller, modal dismissal or generic Menu behavior changed. The resolver covers the shared folder dialog's Escape, outside, cancel/success and owner-replacement cleanup path.

RED: `npm.cmd test -- --run src/features/media/organizationTree.test.tsx --maxWorkers=2` → exit **1**, **5 failed / 10 passed** (`task4-review-dialog-focus-red.log`). Actual controller refreshes reproduced remote delete/move × Escape/outside losing focus, and a successful native-style delete response lost its own return trigger.

GREEN: that same command → exit **0**, **15 passed** (`task4-review-dialog-focus-green.log`). An additional owner-to-ordinary replacement regression first failed (`task4-review-dialog-owner-red.log`); resolving owner plus connection state at close fixed it.

Fresh verification after the final product change:

- `npm.cmd test -- --run src/features/media/organizationTree.test.tsx src/features/media/sourceImport.test.tsx src/features/media/organization.test.ts src/components/menu/menu.test.tsx --maxWorkers=2` → exit **0**, **49 passed / 4 files**, including **16 tree tests** (`task4-review-dialog-focused.log`). The remote cases model inert focus blocking and verify inert is removed before focus restoration.
- `npm.cmd test -- --maxWorkers=2` → exit **0**, **502 passed / 62 files** (`task4-review-dialog-frontend.log`).
- `npm.cmd run typecheck` → exit **0** (`task4-review-dialog-typecheck.log`).
- `npm.cmd run build` → exit **0** (`task4-review-dialog-build.log`), existing informational Vite chunk-size warning only.
- Worktree and staged `git diff --check` → exit **0** (`task4-review-dialog-diff-check.log`).

Product changes are limited to `MediaDialog.tsx` and folder-dialog focus wiring in `MediaList.tsx`, with targeted tests and this evidence/plan checkpoint. Root-owned untracked editing-workspace spec/plan files were left untouched. No Task 5, new editing feature, native, release/version, NAS, junction, main or push changes occurred.
