# Task 7 evidence: labels, ephemeral editing and compact central transport

- Immutable TaskBase: `4dce966ef692b105c0106596fae70ce5a7ff7e88` (reviewed Task 6).
- Workspace: `D:/Work/annotator/.worktrees/media-folders`, branch `media-folders`.
- Authority: approved editing-workspace spec §§3–5 and Task 7 of `plans/2026-10-27-editing-workspace.md`.
- Root-owned pending Task 6 PASS/checkbox tracking and the §4 cue/source-switch clarification are preserved and included. Product and test implementation was sequential; no implementation was delegated.
- Raw stdout/stderr and retained attempts: `D:/Work/annotator/.test-output/media-folders/task7-*.log`.
- Checkpoint identity is the Git commit containing this evidence. Both reviews must cover the entire original TaskBase..checkpoint range.

## Implemented scope

Temporary selection and retained candidate clear together on one completed external blank gesture; saved annotations remain in the document. The first external gesture only retires the prior selection, and subsequent drags can draw. Blank deactivation commits on pointer release so the gesture can establish the next cue before the playback hook observes selection removal. Threshold, cancellation, inside grab/resize, pan, ruler/control/menu priorities remain protected by existing and extended overlay tests. A captured deactivation cannot clear a newer selection.

Plain blank clicks update the media-UUID cue shared by that audio's channels. A new cue replaces an old paused/resumable explicit intent; a same-audio click during playback changes the next start without configure/control/autoplay. The combined actual AnnotationOverlay + useSelection + usePlayback + CueLine regression captures native configure `mediaId`, `mode` and `seekSeconds` and checks both channel cue lines. Blank linked tails remain visible markers but are rejected as playback seeks.

Per the root-confirmed clarification now in spec §4: interacting with a **different audio's spectrum** preserves the established source-switch/reset contract and stops the old stream without starting the new one. This is different from a same-playing-audio cue click. Comparison selectors, channel/display controls and analysis settings update their own context without silently switching playback source. An actual AppShell/pane/native-boundary test exercises those distinctions. No separate live-media architecture was introduced.

Region/file/channel classification uses continuous toggle sets. Menus expose menuitemcheckbox/aria-checked and keep-open actions, with default action menus still closing. Mouse, Space/Enter, submenu navigation, outside/Escape and focus remain supported. Inspector checkboxes, title file/channel controls, toolbar, context and main menu all merge against the latest queued authority, preserve notes and clear all explicitly. Actual integrated entrypoint tests exercise rapid same-label and different-label clicks. A SelectionState binding lineage distinguishes legitimate first temporary-to-saved binding/authority reconciliation from a new user selection; the toolbar menu survives its first annotation creation, and rapid pre-ack clicks create exactly one annotation. Main menu items refresh from current authority, with new selection intents retiring open menus. Category-definition-order color, compact names, readonly remote labels and any-label filtering remain intact.

Mask and gain edits are processing operations. They have no persistent overlay frames, hits or overlap-menu objects. The processing list displays mask or signed gain value and supports enable/remove/view-only location. DSP acknowledgement clears only the originating selection intent; saved annotations and their labels/notes survive. Rejected commands retain selection. A small frontend queue `onAccepted` completion hook is retained with a failed command so explicit native retry also clears only its original selection after actual acknowledgement. UI callback errors are outside the native-failure path and cannot make accepted DSP content replayable.

The explicit region-gain modal opens from floating selection controls, context menu and central transport. It validates finite -60..24 dB/0.1 dB inputs, applies only on the Apply action, and makes zero a no-op without native/history mutation. Repeated gains remain separate edits. Failure retains input/selection and offers an explicit retry of the same failed command. Owner/target retirement, pending double admission, Escape/outside and pre-inert focus restoration are guarded. Late completion cannot close a newer modal or clear a newer selection.

The monitor control binds the Task 6 APIs directly: global default, absolute current-audio override, numeric 0.1 dB and restore-follow. An equal numeric value remains an explicit override. The small bar-anchored popover includes output volume at compact widths. Realtime output failure and private-preference save failure have independent reachable retry controls; success on one side leaves the other failure available. Monitor controls do not configure audio or change analysis/document history.

The transport is the final child of the central analysis workspace, immediately below spectra. It targets playback.sourceId/media, including a comparison source, rather than always the primary pane. It measures its own container with ResizeObserver; 420px/1100px component tests verify compact/full control availability. Narrow layouts keep stop/play/loop/clock/monitor and a same-row overflow menu; sound version/source, regional gain and resets remain reachable. No permanent explanatory strip was added. Reset view patches full [0,duration]/[0,Nyquist] ranges while retaining Mel/STFT, palette, display gain, dynamic range, axis mix and visible channels, through the existing linked-time patch contract. Reset masks issues exactly one resetMediaMasks command for the current operation audio, includes disabled records, preserves gains/other audio and is disabled when empty. Task 6 core tests remain the authority for native atomic undo.

Media cards are 28px single rows with icon/name/short status. Metadata and full source remain in title. Hide/move/relink are context actions, with Shift+F10/ContextMenu keyboard entry. Existing organization tree, search, counts, hidden restore, readonly handling and stale-menu/modal focus regressions remain. Older tests now inspect the enriched title/accessibility status and the approved full-duration reset while retaining their substantive assertions.

No Rust/native/schema, package/version, desktop-runner registration, release, main, NAS or raw-audio implementation change was made. The existing shared dependency/cache junctions were untouched.

## Actual RED/GREEN and correction evidence

| Slice | Observed RED | Observed GREEN |
| --- | --- | --- |
| Selection/cue/DSP operation | `task7-selection-red.log`: 5 failures (retained candidate, bound mask, paused old cue) | `task7-selection-green.log`: 77/77 |
| Continuous checkbox and first binding | `task7-labels-red-confirmed.log`: 3 intended missing-checkbox failures | `task7-integration-green-attempt2.log`: 173/173 |
| Regional gain/playing cue | `task7-gain-cue-red.log`: missing gain action and selection deactivation stopping playback | later focused/full GREEN |
| Reconciled selection and keyboard target | `task7-authority-keyboard-red.log`: 2 failures | `task7-controls-green.log`: 23/23 combined |
| Central transport/media row | `task7-layout-red.log`: outside-analysis transport and redundant row buttons | `task7-integration-green-attempt2.log` |
| Gain failure/retry/late dialog | `task7-controls-red-confirmed.log`: missing retry and late completion closing newer modal | `task7-controls-green.log`; final 6-control suite |
| Retried DSP acknowledgement | `task7-dsp-retry-red.log`: acknowledged retry left original selection active | `task7-context-retry-green.log`: 34/34 |
| New context selection retirement | `task7-context-retirement-red.log`: old nested menus remained (initial single-menu query reported multiple) | corrected zero-menu assertion and `task7-context-retry-green.log` |
| Keyboard row context | `task7-row-keyboard-red.log`: no context actions after Shift+F10 | `task7-row-keyboard-green.log`: 18/18 |
| Real overlay + playback click | `task7-real-overlay-cue-red.log`: pointer-down deactivation stopped live stream before pointer-up cue | `task7-real-overlay-cue-green.log`: 69/69 |
| Container-driven transport | `task7-container-red-confirmed.log`: no container measurement | `task7-container-green.log`: 6/6 |
| Runtime-bound reset | `task7-reset-owner-red.log`: retained command mutated prior owner | `task7-reset-owner-green.log`: 40/40 |
| Blank-tail marker | `task7-blank-tail-red.log`: marker was discarded by overly strict playback-only validation | `task7-blank-tail-reset-green-confirmed.log`: 44/44 |
| Accepted-callback isolation | `task7-queue-ack-red.log`: observer exception entered native command failure path | `task7-queue-ack-green.log`: 33/33 |

Failed/intermediate attempts are retained. Initial labels RED also exposed an old playback test double lacking setCue; that test double was corrected before the confirmed intentional RED. Initial controls RED had a test subscriber using a nonexistent store getter and an unrealistic same-value change event; those test-authoring issues were corrected, and the subsequent RED retained the real retry/late-modal failures. Initial container RED called an absent observer callback; the confirmed RED explicitly asserts the missing measurement mechanism. New transport observation required a jsdom ResizeObserver boundary stub; an intermediate focused attempt records its absence. Explicit measurement tests provide actual contentRect callbacks and do not infer rendered browser geometry from jsdom.

The first full frontend run retained 3 old-contract failures (text status versus accessible icon status, old exact title versus enriched metadata title, 10-second reset versus approved full current-audio duration). These assertions were adapted to the new required semantics without dropping source/status/layout assertions. `task7-frontend-final.log` passed 556 tests. The first checkpoint current-tree run included the additional explicit cross-pane source-switch contract and passed 557 tests. The first review correction added one regression and passed 558 tests; the subsequent StrictMode correction below brings the final current-tree run to 563 tests. Local refactoring renamed the label helper to toggleLabel, removed retired mask rendering branches/styles and made the central transport/processing list readable; final checks cover those changes.

## Final actual verification

| Command | Actual result | Raw log |
| --- | --- | --- |
| `npm.cmd test -- --maxWorkers=2` | 563 passed, 65 files, exit 0 after StrictMode review correction | `task7-review-strictmode-frontend-final.log` (prior 557/558-pass logs retained) |
| `npm.cmd run typecheck` | passed, exit 0 after StrictMode review correction; also rerun inside final build | `task7-review-strictmode-typecheck-final.log`, `task7-review-strictmode-build-final.log` |
| `npm.cmd run build` | passed, exit 0 after StrictMode review correction; existing Vite >500kB chunk advisory | `task7-review-strictmode-build-final.log` |
| `node --test tests/desktop/harness-menu.test.mjs tests/desktop/harness-lifecycle.test.mjs tests/desktop/harness-output-init.test.mjs tests/desktop/release-suite-registration.test.mjs` | 12 passed, exit 0 | `task7-harness-units.log` |
| `git diff --check` | passed, exit 0 after StrictMode review correction | `task7-review-strictmode-diff-check.log` |

No native contract changed, so no Rust rerun is required by Task 7. Task 6's native/core verification is not relabeled as new Task 7 evidence. No actual WebView desktop layout, 1000×680 screenshot, physical device or listening acceptance is claimed by jsdom/component tests. Those checks, combined desktop scenarios, production metadata/build and delivery remain Task 8, after paired Task 7 reviews. The root's separately owned read-only NAS test is Task 8 evidence and is not claimed here.

## Plan compliance and remaining review boundary

Task 7 product scope is complete. Minor necessary file-target extension: the frontend CommandQueue acknowledgement callback supports the required successful retry/selection-clear contract without optimistic clearing; its replay/error behavior has regression coverage. Shared jsdom setup adds only the absent layout observer boundary. No format or native correction was necessary. The root-owned source-switch wording clarification records the existing contract rather than adding new playback architecture.

Root retains plan completion/review tracking. This checkpoint is ready for paired reviews against the immutable TaskBase; do not start Task 8 implementation from this report alone.


## First-pair review correction: explicit-selection audition followed by a new playing cue

The first Task 7 spec review found a material sequence missed by the earlier automatic-play and stop/replay regression: explicit `playSelection(region, 'original')` → same-audio blank click while playing → Pause → Play. The cue click correctly preserved the current stream and invalidated resumability, but the retained explicit-selection intent still won when resolving the next playback mode/range. The first spec review was FAIL; the interrupted quality review was discarded. Those outcomes are not represented as passing reviews.

A new integrated regression uses the actual AnnotationOverlay/useSelection/usePlayback path and captures the playback boundary. It draws a temporary region, explicitly auditions that region as original audio, clicks blank at exactly 1.875 seconds, asserts unchanged stream/status/source and no configure/control call during the click, verifies the first subsequent command is Pause, and then requires file/processed mode at the exact new cue on Play.

- Genuine RED: `task7-review-cue-red.log`, exit 1, 1 failed/70 passed. The actual second configure had mode `selection` and seekSeconds `0.5` rather than file mode `processed` and seekSeconds `1.875`.
- Minimal GREEN: on a new start only, a non-resumable intent is retired before resolving automatic selection/cue behavior. The running stream's explicit source/range remains untouched by the cue click and the first Pause. Normal pause/resume when no cue changes remains protected by the existing explicit-original override regression.
- Focused GREEN: `task7-review-cue-green.log`, exit 0, 71 passed across actual overlay and playback hook suites.
- Full GREEN: `task7-review-frontend-final.log`, exit 0, 558 passed/65 files; `task7-review-typecheck-final.log`, exit 0; `task7-review-build-final.log`, exit 0 with the existing chunk advisory.
- No native, schema, source-switch architecture, Task 8 or other product scope change was made. The original TaskBase remains `4dce966ef692b105c0106596fae70ce5a7ff7e88`; fresh paired reviews must cover that original base through the new checkpoint containing this correction.


## Second-pair review correction: StrictMode gain-form lifecycle replay

The second pair returned spec PASS and quality FAIL for one material lifecycle defect. `main.tsx` renders React.StrictMode, whose development effect setup/cleanup/setup replay left GainForm's alive ref false: its effect cleanup set false but its setup did not restore true. Zero-gain completion and native rejection therefore returned before clearing applying/pending; the still-mounted modal stayed busy with no usable cancellation, Escape, retry or error. This quality failure is retained as a failed review, not relabeled as passing.

The gain test harness now optionally renders the actual selection/dialog tree inside StrictMode. Four new regressions cover zero-gain completion (no native command, snapshot/history unchanged, selection retained, dialog closes and can reopen/dismiss), native rejection followed by exactly one accepted gain on retry, and rejected-command Escape/outside dismissal with input/selection retained until dismissal. The existing pending-old-action/new-selection/new-dialog regression also runs under StrictMode to protect actual unmount behavior.

- Genuine RED: `task7-review-strictmode-red.log`, exit 1, four failed/seven passed. The zero-gain dialog stayed mounted; rejected commands left both action and Cancel disabled and exposed no retry/error.
- Minimal fix: the existing layout effect sets alive.current=true in setup and false in cleanup. No other guard, queue, DSP, native, schema or playback behavior changed.
- Focused GREEN: `task7-review-strictmode-green.log`, exit 0, 24 passed across gain/monitor/transport component tests and selection actions. Both normal and StrictMode late-old-completion/new-dialog cases pass.
- Full GREEN: `task7-review-strictmode-frontend-final.log`, exit 0, 563 passed/65 files; `task7-review-strictmode-typecheck-final.log`, exit 0; `task7-review-strictmode-build-final.log`, exit 0 with the unchanged chunk advisory.
- Immutable TaskBase is still `4dce966ef692b105c0106596fae70ce5a7ff7e88`. This correction is ready for fresh paired whole-original-range reviews; no Task 8 work was started by this implementer.
