# Task 6 — selection-local playback and annotation toolbar

Date: 2026-10-23. Task base: `418f5db9c366c2e1fe10e0c627e9b336bfffe701`. Branch: `feature/spectral-fidelity-v021`. Scope: approved specification §7.2 and implementation plan Task 6 only.

## Implemented

- One compact toolbar belongs to the current active, valid selection, for temporary regions, saved annotations and masks. It uses the same physical coordinate mapping as the overlay and intersects the frame with its plot, scroll clipping ancestors and viewport. Resize, scroll, view bounds and frequency-axis changes update positioning. Inactive, hidden-channel and fully offscreen targets have no visible controls.
- Selection gesture state now notifies subscribers at begin/end, including canvas Alt-left/middle panning. Toolbar controls disappear throughout drawing, movement, resizing and panning, then follow the completed frame. The existing overlay gesture implementation remains unchanged.
- Playback uses Task 5 `playSelection(region, sourceOverride?)`. The default button has no override; explicit menu labels are “试听选区原音” and “试听选区（应用屏蔽）”. Neither changes workspace source or analysis graphs.
- Right-click and toolbar share captured-target execution in `targetCommands.ts`: owner/runtime checks through `withTarget`, authoritative saved geometry, latest readiness, and existing classification/mask/note action queues. Classification creates a temporary annotation once, binds its ID, updates existing annotations, or creates a separate annotation from a mask. Late accepted results do not steal a newer selection.
- Toolbar and portaled menu controls are marked as pane controls, preventing FilePane's capture-phase implicit playback-source switch. Pointer events cannot reach the plot gesture handlers; keyboard focus/activation use native buttons and the existing Menu.
- For a retained active selection whose source becomes missing/changed, FilePane keeps its axes/overlay and classification controls, preserves the existing unavailable/relink feedback, clears/releases the canvas backing and disables audition with a reason. Other unavailable panes keep their existing presentation.

## RED / GREEN evidence

1. Added nine toolbar interaction cases before implementation with a null-rendering component scaffold. `npm.cmd test -- src/features/selection/selectionToolbar.test.tsx` failed **9/9**, with absent toolbar/buttons (2026-10-23 17:01 local). The implemented toolbar passed these cases after adding the same PointerEvent polyfill used by existing overlay tests.
2. Added actual SpectrogramCanvas Alt-left/middle pan cases. The same command failed **2/11** because the toolbar remained visible during pan (17:04); adding explicit pan begin/end notifications made **11/11** pass.
3. Added real FilePane missing/changed-source cases. After correcting the playback test fixture, **2/13** failed because the unavailable branch removed the selection toolbar (17:07). Retaining valid selection plots and clearing their backing made **13/13** pass.
4. Added characterization coverage for nonlinear mapping, actual resize/new draw events, deleted captured menus, and delayed classification versus a newer selection. Final toolbar suite: **16/16**.

## Final checks

| Command | Observed result |
|---|---|
| `npm.cmd test -- src/features/selection src/features/playback` | Exit 0; 6 files, 99 tests passed. Log: `.test-output/fidelity-task6/selection-playback.log` |
| `npm.cmd test` | Exit 0; 39 files, 306 tests passed. Log: `.test-output/fidelity-task6/full-ui.log` |
| `npm.cmd run build` | Exit 0, TypeScript and Vite passed; existing large-notices chunk warning only. Log: `.test-output/fidelity-task6/build.log` |
| `npm.cmd run tauri -- build --debug --no-bundle --features e2e --config src-tauri/tauri.e2e.conf.json` | Exit 0 before desktop tests; fresh native executable built in this worktree. Log: `.test-output/fidelity-task6/native-build.log` |
| `node tests/desktop/interaction-flow.test.mjs` with `ANNOTATOR_INTERACTION_OUTPUT=.test-output/fidelity-task6/interaction-rerun3` | Exit 0; retained Task 3/5 checks plus Task 6 real UI cases. Log: `.test-output/fidelity-task6/interaction-rerun3.log`; raw report/screenshots: `.test-output/fidelity-task6/interaction-rerun3/` |

No product code changed after the successful native build. Later changes only strengthened tests/evidence. Desktop harness retains its refusal to attach to occupied ports and closes only its own native/driver processes. No system DPI, device volume or source-audio changes were made.

## Native observations

Fresh debug/e2e executable, owned WebView2, real 1280×800 outer window, original system DPI. Previous Task 5 simulated DPR and cue checks remain in the interaction suite; they are not claimed as physical Windows DPI coverage.

- Temporary selection one-click playback: **4,416 consumed frames**, 48 kHz, zero reported underrun frames.
- Right comparison selection classified through toolbar, then changed to “未分类” using keyboard Home/Enter: exactly one annotation ID. Classification left the explicitly selected primary playback source intact. Shift-Tab/Tab within toolbar and Escape focus restoration passed.
- Saved annotation moved from **0.7942238267–2.1949458484 s** to **0.9819494585–2.3826714801 s**, preserving ID. Toolbar playback used **0.9819583333–2.3826875000 s** (native sample-aligned range), **4,416 consumed frames**, zero reported underrun frames.
- Delete created one mask; toolbar classification of that mask produced a separate annotation while retaining the mask. Both opposite explicit auditions consumed **3,936 frames**, with zero reported underrun frames. Both canvases' hashes and the workspace source control were unchanged across each audition.
- Tiny top-right frame remained **11×7 CSS px**. Its toolbar was **113.40625×30 px**, right edge **961 px**, exactly the own-plot right edge; the toolbar moved inside below the top boundary without stretching the frame. Screenshot: `toolbar-tiny-top-right.png`.
- Actual sixth-channel selection after scrolling: toolbar **(321,541)–(434.40625,571)** within plot **(279,521)–(556,701)**. Scrolling the native DOM scroll container away hid it; scrolling back restored it. Hiding channel 6 removed the active toolbar. Screenshot: `toolbar-sixth-channel-scrolled.png`.
- Continuous trusted pointer sequences measured hidden toolbar during the held gesture via an animation-frame observation; saved drag and Alt-left/middle pan all restored it afterward.

## Harness refinements and limits

Earlier Task 6 runs are retained in `interaction/`, `interaction-rerun1/`, and `interaction-rerun2/`; they failed harness assumptions, not silently discarded product failures. Tab from the last toolbar control naturally reaches the next channel title, whose existing focus behavior deactivates selection; the test now checks navigation within the toolbar. Pointer hover can change the active menu row, so the keyboard test explicitly uses Home then Enter. Splitting a held drag across separate WebDriver `perform()` calls caused WebView2 to emit `lostpointercapture` with buttons still held; the app correctly cancelled it. A diagnostic owned-session event trace confirmed that sequence, and the test now uses one continuous action sequence with a pause.

Scroll clipping is exercised by changing the native scroll container's `scrollTop`, which emits real scroll events; it is not claimed as a physical scrollbar or OS mouse-wheel test. Missing/changed sources, stale owner/deletion/readiness and async binding are covered in component tests. This task does not claim the legacy `selection-flow`/`playback-smoke` suites pass with their old mode selectors; their migration remains Task 8. No Task 7 sharing or Task 8 release work was performed.
