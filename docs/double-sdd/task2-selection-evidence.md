# Task 2 verification — 2026-10-23

Task base: `f97678c39f801319d25f1c976bc179ecbd7fe0cc`.
Scope: unified temporary selection, region actions and menu primitive. Tasks 3–8 remain separate.

## Automated checks

- `npm.cmd test -- src/features/selection src/components/menu src/features/annotations src/features/playback src/features/project/shortcuts.test.ts`: 12 files, 85 tests passed.
- `npm.cmd test`: 28 files, 175 tests passed.
- `npm.cmd run build`: TypeScript and Vite passed. The final native build also reran this command successfully.
- `npm.cmd run tauri -- build --debug --no-bundle --features e2e --config src-tauri/tauri.e2e.conf.json`: passed; built the owned debug executable used below.
- `git diff --check`: passed. Modified desktop modules also passed `node --check`.

RED/GREEN cycles observed: absent selection/gesture/actions/menu modules, absent stable `playSelection`, stale menu rendered after same-project runtime replacement, missing blank-menu reset action, old project-menu shortcut leakage, list locate resetting the selected channel to zero, all-disabled menu focus, and absent reactive pointer-channel context. Each failing check was rerun successfully after its implementation. Overlay interaction and lifecycle regression tests additionally cover threshold, reverse draw, interior/new selection, border/handle mutations, Alt/middle priority, Escape/cancel/lost capture, overlapping target priority, stable action completion, draft draining, close barriers and failure ownership.

Existing mode-specific tests were replaced by unified-selection tests in `src/features/selection/overlay.test.tsx`. Existing playback generation, delayed terminal-event, source intent, and draft/queue tests remain passing.

## Actual Windows desktop runs

`node tests/desktop/selection-flow.test.mjs` passed against an owned real Tauri process using official tauri-driver 2.1 and Microsoft EdgeDriver 155.0.4283.62. Only picker return paths use the e2e feature. All editing, classification, note entry, menu navigation, selection gestures, undo and transport actions use WebDriver pointer/keyboard input. Document/playback snapshots are read-only verification.

Verified:

- Dragging creates no durable annotation; right-click classification creates one, subsequent classification updates the same ID and preserves the note.
- Delete creates one exact-range mask and deduplicates repeats; undo removes the mask without removing the annotation.
- Temporary selection plays without another annotation. The runner waits for a **new native generation** with `state=playing`, nonzero device channels and more than 4800 consumed frames, rather than trusting stale UI counters.
- Original selection: generation 5, 5376 consumed frames, 2 device channels, 48000 Hz, 0 underrun frames.
- Processed selection: generation 7, 4896 consumed frames, 2 device channels, 48000 Hz, 0 underrun frames.
- Comparison-pane processed selection: generation 10, 7296 consumed frames, 2 device channels, 48000 Hz, 0 underrun frames; media ID is the second file, while the sidebar still selects the first.
- Context note creates the second-file annotation and focuses its note field. Overlap chooser selects the underlying annotation. Explicit annotation deletion leaves the overlapping mask intact. Border move and handle resize persist the mask's new physical coordinates.
- Computed annotation and temporary-frame styles have transparent backgrounds, no background image, and no box shadow. Screenshot inspection also confirms the retained mask has transparent fill.
- Context menu is within the WebView bounds; arrow/Escape navigation and focus restoration work.

The affected existing `projectFlow` and `spectralFlow` also passed sequentially on a separate owned process after updating their former tool-button workflow. This includes six-channel import, annotation/note/category edits, undo/redo, comparison, native transport and save/close.

Evidence remains under `.test-output/task2-selection/`:

- `affected-tests.log`, `ui-tests.log`, `build.log`, `native-build.log`
- `report.json`, `native-run.log`, `selection-transparent.png`, `selection-menu.png`, `selection-compare-context.png`
- `legacy-run.log`, `legacy-FBJfH2/report.json` and that run's screenshots
- Per-process driver logs; all launched test processes were shut down by the harness.

These are short fixture audio/output checks, not the later 30-second performance or listening assessment. Task 4 still owns compact layout and four-plot height budgets; Task 8 owns the complete desktop/performance/release matrix. No Rust/DSP implementation changed in Task 2.

## Task 2 spec-review correction

The review of `e3607a3078b6157c849e22bd979a08e9fac9d35b` found that nonpersistent menu actions still used the originally captured object region after an accepted native move/delete completed. A shared `resolveRegion` now resolves both persistent actions and synchronous menu callbacks against current authority. `withTarget` rejects stale runtime owners, invalid objects and disabled editing before invoking playback, zoom or overlap selection. The store subscriber closes a menu when its target or context media disappears; render-time checks also disable invalid targets. Temporary selections retain their captured physical region.

RED: `npm.cmd test -- src/features/selection/regionMenu.test.tsx` observed four failures: playback and zoom received the old bounds, the deleted-object menu stayed open, and no owner-guarded callback dispatcher existed. GREEN: the same seven tests passed after the correction. The tests release an accepted lifecycle-enrolled move/delete while the menu is open and also verify retained callbacks cannot act on removed objects or a replaced runtime.

Fresh checks after this correction: affected suite 68/68, full frontend suite 158/158, typecheck and production build, native debug/e2e build, and the complete actual native selection flow all passed. The current `report.json` and frame counts above are from this rerun. The existing legacy project/spectral run remains the earlier Task 2 evidence; its entry points were unchanged by this correction.

Correction logs: `review-fix-red.log`, `review-fix-green.log`, `review-fix-affected.log`, `review-fix-ui.log`, `review-fix-build.log`, and `review-fix-native.log` under `.test-output/task2-selection/`.

## Task 2 cancellation-race correction

After spec02b passed, quality02b identified that `SelectionState.prior` could remain stale while an accepted native edit or history command completed during a gesture. Reconciliation now resolves both current and prior selection against authority, using the same identity-preserving resolver as menu and durable actions. Updated saved annotation/mask geometry is retained on cancellation; a removed object or invalid temporary channel cannot be restored. An unchanged valid temporary prior retains its exact snapshot identity and physical region.

RED: the focused selection suite observed four failures for annotation geometry, mask geometry, deleted prior restoration, and invalid temporary-channel restoration. The valid-temporary-identity characterization passed before and after. GREEN: all eight focused tests passed. Fresh verification: affected suite 73/73, full frontend suite 163/163, and `npm.cmd run build` (TypeScript + Vite) passed; `git diff --check` passed.

This correction changes pure selection reconciliation only. Per the review dispatch, the native desktop flow was not rerun; the last native evidence above remains the verified `4f69512d16e03b081fdf340fc6aa304e108a338b` implementation. Logs: `cancel-fix-red.log`, `cancel-fix-green.log`, `cancel-fix-affected.log`, `cancel-fix-ui.log`, and `cancel-fix-build.log` under `.test-output/task2-selection/`.

## Task 2 pointer-release correction and bounded terminal audit

Spec02c passed; quality02c found that stationary pointer-up selected `Drag.target` directly after a pending native update/delete had reconciled the actual selection. Pointer release now reconciles against the latest document and resolves the captured identity before selecting it. Valid temporary targets preserve identity; new or moved temporary ranges are validated against the latest media/channel bounds. Pointer-down and right-click target selection use the same resolver.

The bounded audit reproduced another instance of the same stale-snapshot problem: a move/resize proposal based on lowHz=100 could overwrite an accepted lowHz=200 update. The lifecycle-enrolled gesture mutation now compares its captured geometry with authority after draft draining. A changed or deleted target makes the obsolete gesture proposal a no-op, preserving the accepted edit. The check applies both when native work settles while the pointer is held and when it settles ahead of the queued gesture action.

Audit coverage:

| Terminal path | Authority/selection behavior |
|---|---|
| Stationary pointer-up | Resolve saved identity immediately; removed targets clear; temporary identity stays stable |
| Saved move/resize pointer-up | Reconcile current UI selection; queued action rejects changed/deleted captured geometry |
| New/temporary move/resize | Validate the resulting physical region against current media and channel bounds |
| Escape, pointercancel, lost capture | Restore already-reconciled prior state; pending-update integration tests confirm latest geometry |
| View change/unmount cancellation | Use the same reconciled-prior cancellation path; replacement owners retain separate state |
| Context-menu termination | Cancel preview, then resolve the selected target against current authority |
| Pan endings | Only change viewport; never restore a captured selection object |

RED: the actual overlay + `useSelection` regression suite reproduced six failures: stationary release after move/remove, and move/resize proposals with updates completing while held or queued. GREEN: the overlay suite passed; additional passing audit regressions cover valid temporary identity, cancellation/capture loss, deleted queued move/resize targets, and temporary-channel invalidation. Fresh affected suite: 85/85; full frontend suite: 175/175; `npm.cmd run build` (TypeScript + Vite) and `git diff --check` passed.

Per the review dispatch, no native rerun was needed for these deterministic overlay/authority-interleaving corrections. Last actual native evidence remains the run documented above. Logs: `release-fix-red.log`, `release-fix-green.log`, `release-fix-affected.log`, `release-fix-ui.log`, and `release-fix-build.log` under `.test-output/task2-selection/`.
