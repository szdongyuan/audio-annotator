# NAS collaboration Task 5 evidence

Date: 2026-10-23. Worktree: `D:/Work/annotator/.worktrees/nas-collaboration-v030`.
TaskBase: `32556e692456222866ba87aa512eb65d91d2bd9b`.

## Implemented scope

`RemoteAnnotations` renders transparent, clipped foreign frames through the existing plot coordinates. Labels contain the author and that author's category. Own live annotations remain the editable source, with their author label in shared projects; the older published own layer is excluded. Foreign React keys and inspection targets include the author ID. No geometric/text deduplication or foreign insertion into ProjectStore, writable SelectionState, category tables, command queues or undo history occurs.

The existing AnnotationOverlay remains the pointer host. Own active interior/border/handles and unselected own objects have priority. A stationary foreign click or right-click opens read-only inspection. Dragging through foreign geometry still creates a private temporary region. The author filter changes display only; hiding own annotations also hides their floating toolbar while retaining the underlying selection and document. Private masks remain separate.

The compact 作者 property tab lists each foreign author's regions and file/channel categories/notes. Inspection shows author, media/channel, category, note and physical region; its only content actions are playback and locate. These callbacks capture an ActiveProject plus author-qualified identity and re-resolve the current verified layer at execution. Deleted targets become unavailable, and callbacks from retired runtimes do nothing. Playback uses the current private playback hook/source and its captured native adapter. Locate uses the current workspace pane/visibility rules. It leaves the inspector open so the user can continue reading or close it explicitly.

Read errors distinguish unavailable layers, no published layer and retained last-good layers. A refresh changes neither the own document nor the mounted note editor, playback preferences or history. Dialog Tab/ShiftTab wraps inside its actions, keyboard events cannot reach underlying edit shortcuts, dismissal restores focus, and deletion of a focused remote action moves focus back inside the dialog. Shared property tabs use one horizontally scrollable row to avoid wrapped labels at the compact width.

## Harness changes and investigated failures

`start(paths, output, executable, options)` now accepts `ports: {driver,native,debug}` and `localDataEnv`. Defaults remain **4445 / 4446 / 9235**. All three ports must be distinct integers in 1024–65535; localDataEnv must be an absolute path. Every configured port receives the existing unknown-listener refusal before launch, and teardown waits only for those ports after stopping only its own spawned PIDs. The two clients use separate app-local-data and WebView roots.

The first real two-client attempt (`two-ui-A5DoZf`) showed the e2e window config's fixed `--remote-debugging-port=9235` prevented B from exposing port 9245. Removing that fixed argument alone (`two-ui-zO5TBi`) showed this installed WebView runtime did not apply the environment-only argument: its owned browser command line contained no remote-debugging flag. The tested correction configures the window before construction from numeric `ANNOTATOR_E2E_DEBUG_PORT`, only under the e2e feature, defaulting to 9235 and rejecting arbitrary flags/out-of-range values. The ordinary production config remains unchanged.

Further UI runs found test sequencing issues: the first ordinary annotation-list row was a file classification, so the deletion test now explicitly selects the region row; the asynchronous create-copy picker required waiting for the credentials form before typing. Neither correction changes product behavior or weakens assertions. Screenshot inspection also found the new eighth property tab caused wrapping; the final shared tab row overrides the existing flex-wrap rule. The initial compact-height assertion failed before this correction. Failed runs and screenshots remain in the owned fixture directories.

## RED / GREEN evidence

Logs are under ignored `.test-output/nas-task5/`.

| Logs | Observed behavior |
| --- | --- |
| `red-remote.log` → `green-remote.log` | Missing remote API/component import initially failed. Three initial tests then pass author-qualified duplicate geometry/category resolution, display-only filters, current-target/retired-owner guards and three-level read-only inspection. |
| `red-routing.log` → `green-routing.log` | Three failures reproduce missing foreign inspection/rendering/filter handling; 34 focused tests pass after routing/render integration, including the existing own move/resize/draw regressions. |
| `red-dialog-focus.log` → `green-dialog-focus.log` | Tab from the dialog root fails to move to the first action; focus wrapping, destructive-key isolation and focus restoration pass after the fix. |
| `red-deleted-focus.log` → `green-deleted-focus.log` | A removed focused playback button leaves focus outside the dialog; the final six remote tests pass with focus retained inside. |
| `red-toolbar-filter.log` → `green-toolbar-filter.log` | Hidden own frame incorrectly retains a floating toolbar; 17 toolbar tests pass after display eligibility follows the author filter. |
| `red-harness.log` → `green-harness.log` | Two new independent-port/refusal tests initially fail on absent APIs; all four lifecycle tests pass with validated per-instance options. |
| `red-native-port.log` → `green-native-port.log` | Missing native e2e port configurator initially fails compilation; the focused Rust test passes default/override/range/flag-rejection behavior. Actual two-client startup passes with the rebuilt binary. |

`remote-draft.log` additionally characterizes a mounted real NoteField with an unsubmitted draft: remote rerender preserves the same textarea node, draft value, snapshot identity/undo state and private original-source choice. This is a characterization test, not a separately claimed RED failure. The later full suite includes it and all other final tests.

## Final verification

- `npm.cmd test`: **353 passed / 46 files**, `frontend-tests-final.log`.
- `npm.cmd run build`: PASS, including both TypeScript checks and Vite build, `frontend-build-final.log`. Existing third-party-notices chunk-size warning remains.
- `npm.cmd run tauri -- build --debug --no-bundle --features e2e --config src-tauri/tauri.e2e.conf.json`: PASS before the final UI runs, `debug-build.log`.
- `cargo test -p annotator-core --test collaboration_workspace --test exchange`: **25 + 13 passed**, `core-tests.log`. These cover private workspace/retained layers/shared export sanitization and ordinary complete exchange semantics.
- `cargo test -p annotator-core --test collaboration_workspace native_guards_keep_foreign_entities_out_of_personal_history_and_catalog_immutable -- --exact`: **1 passed**, `forged-foreign-guard.log`. The native LocalProject authority rejects both forged foreign-UUID remove and update, keeps the foreign payload unchanged through own undo/redo, and rejects shared catalog mutation. This is a native Rust boundary test, not a claim that write IPC was used inside the UI acceptance suite.
- `cargo test -p annotator-desktop commands::collaboration`: **17 passed**, `native-tests-final.log`.
- `cargo test -p annotator-desktop --features e2e e2e::tests`: **1 passed**, `green-native-port.log`.
- `cargo clippy -p annotator-desktop --features e2e --all-targets -- -D warnings`: PASS, `clippy-e2e.log`.
- `node --test tests/desktop/harness-lifecycle.test.mjs tests/desktop/harness-output-init.test.mjs`: **6 passed**, `harness-final.log`.
- `cargo fmt --all -- --check` and `git diff --check`: PASS.
- Parent independently ran the final remote/overlay/toolbar set: **54 passed / 3 files**, `root-focused-verification.log`.

## Actual two-client UI acceptance

`node tests/desktop/collaboration-layers.test.mjs`: **13 checks passed**, `two-ui-final.log`, final fixture `two-ui-TlqY0I/report.json`. Earlier complete 10-check fixture `two-ui-XBteh6` is retained. All acceptance mutations use actual WebDriver pointer/keyboard controls and native picker queues; IPC in this suite is read-only assertion. No shared JSON was directly written to simulate a collaborator.

The final flow starts independent Alice and Bob native processes (initial owned PIDs 46148 and 47292), distinct driver/debug ports and distinct local roots. Both create exactly the same time/frequency/channel region through UI; their UUIDs remain distinct and each sees the other's separate frame. It exercises per-author file/channel categories/notes, transparent interiors/no foreign handles, readonly detail keyboard isolation and regional playback consuming real device frames without underruns, filters, own active drag/undo, and a focused own note/selection/playback generation/source surviving a foreign update. The UI note check allows normal autosave; the separate frontend test proves an actually unsubmitted draft is preserved.

Alice update/delete/undo leaves Bob's annotation intact, and Bob's already-open Alice inspector becomes unavailable after Alice deletes it. Foreign click/right-click routing is exercised with own display hidden. File/channel Locate reveals the inspecting client's hidden channel without changing the other client. Both clients create distinct private masks/volume/view settings, and both independently close/restart/login to restore their own annotations, masks, categories, views and volume/source while the other remains running.

Actual UI JSON and ZIP exports contain Alice's annotation and no Bob annotation/category, password/hash/nonce/local-root data or private mask. The parsed manifests explicitly have empty edits/default view state, default mix and no sourceRef. The source fixture and shared copied WAV both retain SHA256 `25a6a386be6423ee3958eae4897bcb682248fcf92f128652bd928fdf7e51f9c2`.

Screenshots under each successful fixture's `client-a/`: `author-overlap.png`, `readonly-inspector.png`, `readonly-playback.png`. The 1280×800 WebView screenshots were visually inspected: own/foreign labels remain distinct and the plot interiors remain transparent; no permanent instruction banner was added. No claim of measured native outer dimensions is made for these screenshots.

Fresh debug EXE SHA256: `c24dc291b2ec1cb740e34d1db02ca383f3ce6141b4443554b57372b6a2c076db`.

## Ordinary regression and Task 6 handoff

`node tests/desktop/classification-flow.test.mjs`: **17 checks passed** on the same fresh binary with default harness ports, `ordinary-classification.log`. Original report/screenshots are under `.test-output/task5-classification/` (project `project-AaTSdu`); a report copy is `ordinary-classification-report.json`. This existing suite verifies ordinary file/channel/region editing, own history, independently located comparison panes, measured native outer 1280×800 / 1920×1080 / compact layout, native restart and full ordinary JSON/ZIP semantic round trips including masks, analysis, mix, view and notes. Its assertions were unchanged.

Task 6 should add the new layers suite to the sequential desktop runner and preserve all existing 18 suites. Use its per-instance options when adding concurrency/failure scenarios; always freshly build the e2e binary before GUI checks. Production binaries do not read ANNOTATOR_E2E_DEBUG_PORT or use the picker plugin. The final two-client suite leaves all its owned ports/processes stopped; the unrelated pre-existing releases/0.2.0 app was observed and left untouched.

This task did not change the product version, create a release, move target caches, change the main checkout/user configuration, or push. Full 18-stage regression, release/performance packaging, additional Task 6 fault flows and physical SMB/NAS devices remain Task 6. The evidence here is local shared-directory multi-process/native UI testing; **physical SMB/NAS has not been tested**.
