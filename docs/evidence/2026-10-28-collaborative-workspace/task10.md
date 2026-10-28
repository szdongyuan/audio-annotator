# Task 10 · combined Windows/NAS acceptance

Source audit anchor: `47e2f0a2caa650a20e690b99b4cc7a3bdddb4e4f`. Incoming main pinned to `be32e1e7cd02d4536200bfdc364d9705b2e22785`; temporary integration checkpoint `906ff53`. NAS fixes: `6a1b439`, followed by `6b09638` after review caught stale error recovery. Task 10 checkpoints are temporary and will be squashed onto the pinned delivery base.

All raw command output, reports, failures and synthetic screenshots remain under the ignored worktree directory `.test-output/collaborative-workspace/task10/`. No real project/audio/identity is included in this evidence. Actual acceptance uses synthetic UI content and a uniquely owned project beneath `N:/精成数据标注/项目测试` or its unique local run directory. The real shared project and running user application were untouched.

## Automated verification

| Command | Observed result | Raw log |
| --- | --- | --- |
| `npm test -- --maxWorkers=1` before upstream merge | 105 files / 954 tests PASS, exit 0 | `logs/frontend-baseline.log` |
| Same command after upstream merge | 109 files / 1076 tests PASS, exit 0 | `logs/frontend-postmerge.log` |
| Same command after first NAS fix | 109 files / 1077 tests PASS, exit 0 | `logs/frontend-final.log` |
| Same command after save-error follow-up | 109 files / 1078 tests PASS, exit 0 | `logs/frontend-followup-final.log` |
| `cargo test --release --workspace --features annotator-desktop/e2e` | 423 PASS / 9 existing ignores, exit 0 | `logs/native-postmerge.log` |
| `npm test -- src/features/project src/features/collaboration src/features/playback --maxWorkers=1` | 196 tests / 21 files PASS, exit 0 | `logs/guarded-save-error-green.log` |
| `npm test -- src/features/media/randomNavigation.test.ts src/features/media/randomNavigation.test.tsx src/features/media/navigation.test.ts src/features/media/quickNavigation.test.tsx src/app/randomNavigation.test.tsx --maxWorkers=1` | 134 tests PASS, exit 0 | `logs/upstream-navigation-green.log` |
| Harness/menu/output/registration Node tests | 21 PASS, exit 0, final suite registration included | `logs/harness-registration-frozen.log` |
| `npm run build` | Typecheck + Vite PASS, exit 0; existing bundle-size advisory | `logs/build-frozen-frontend.log` |
| `cargo build --release -p annotator-desktop --features e2e,tauri/custom-protocol` | PASS, exit 0 | `logs/build-frozen-native.log` |

The E2E candidate is isolated at `e2e-final/annotator-desktop.exe`, version 0.7.8, SHA-256 `48947c8a535ca0c441f53d215c8cc5d67c4f6476442fc438c85d5b8a328ad863`. It includes E2E picker hooks and must never be delivered as production. The final rebuild only revised help wording after the earlier combined NAS pass; selected suites below use this exact final candidate.

Driver setup detects installed WebView2. It updated during acceptance from 155 to 156. Early failed diagnostic attempts recorded the mismatch warning. Subsequent runs use Microsoft EdgeDriver/WebView2 `156.0.4314.50`, official tauri-driver 2.1.0. Driver Microsoft signature is Valid; SHA-256 `dd728c934e491abe7e8a07fa366aad135ea15d934cbba99192ad872da59c39d3`. Setup evidence: `logs/webdriver-current.log`.

## Reproduced failures and TDD

- Harness executable selection: RED `harness-lifecycle.test.mjs` lacked the environment-aware resolver; GREEN selects `ANNOTATOR_WORKSPACE_EXE` for every suite, with explicit executable taking precedence. Desktop runner registration also went through missing-phase RED/GREEN. This prevents silently testing the old debug executable.
- Upstream merge: using project-wide arrow candidates for R broke the incoming selected-directory/search test. New flat-scope regression also failed. Separate random candidates use the current displayed scope and filters; arrows retain project scope and reveal outside flat scope. Flat all ignores the retained import destination. Incoming AppShell fixtures now explicitly Jump from the unified List viewer and supply the identity refresh boundary required by the existing examples feature. No product behavior was removed to satisfy old tests.
- Actual NAS starvation: runs 02–05 left A at two files after peer import, despite stopped playback, all four guards allowing adoption, no dialogs/drafts, controller `canAdoptCatalog=true`, no errors, `paused=0` and no flight. Read-only diagnostics and native command observations are retained in `logs/catalog-diagnostic-*.json`. Minimal local acceptance passed; minimal NAS failed at `catalog-idle-vnKzfb/report.json`.
- Native status trace confirmed the save-triggered refresh takes the native single-flight after the idle preflight. A deterministic regression then failed on the second idle poll (`logs/nas-self-refresh-red.log`). The guarded clean-save skip passed 195 affected tests and the real NAS adoption groups. The prior-error follow-up failed with a retained `SaveFailed` after successful preference resubmission (`logs/guarded-save-error-red.log`); requiring real save acknowledgement when a prior save error exists passed all 196 affected tests.

The retained minimal NAS diagnostic also passes with the exact final binary (`catalog-idle-DOvbgu/report.json`, `logs/catalog-idle-final.log`, exit 0), after its pre-fix NAS failure. Its native response trace and readonly owner/guard diagnostics are preserved.

Fixture corrections are preserved as failures, not reported as product fixes: run 01 Space reopened a still-focused gain trigger; the scenario now focuses the actual fresh audio row first. Run 06 awaited no acceptance after hiding audio; it now observes native completion. Run 07's arbitrary 30-color threshold was invalid for a stationary pure tone; the replacement checks a nonblank image and its known 1500 Hz peak within four display rows in linear coordinates. Run 08 expected a gain field absent from `PlaybackStatus`; the assertion now checks the exact 6 dB native request and visible input, plus unchanged generation, continued consumed frames and zero underrun. Run 09 incorrectly expected no List entries after hiding a classified category; seven unclassified file/channel objects correctly remain and are explicitly asserted. Run 10 needed to return to the Authors tab after normal interior cue behavior. Run 11 attempted to inspect an undo-restored peer row before the next poll; it now waits for that verified row to appear before one click.

## Actual desktop acceptance

`nas/desktop-e9kBen/report.json`: complete combined run 12, 14 groups PASS, exit 0. It covers two independent clients, own pending note plus auto append, unchanged polls/history/media/view/selection, actual looping playback deferral then stop/idle adoption, live peer trash/restore with author/audio preservation, isolated personal hide; own/foreign region/file/channel and own List unified viewing; known-frequency spectrum, original/processed device consumption and independent channel/STFT/Mel/window/hop/log/zoom/seek/pause/live gain; author/category include-self visibility and exact shared hashes; measured foreign border versus interior in linear/log/Mel; live peer metadata/range/deletion; explicit Jump; Save As and JSON/ZIP exports; full same-profile process relaunch with panel/tab/cue/view/gain/flat/filter restoration and stopped playback; missing owned path, retained record, retry, later start empty, choose another project and forget.

Startup relaunch uses Windows WM_CLOSE through the real save/close barrier, waits for the owned process and its reserved ports to retire, then reuses the identical WebView directory and local appdata. There is no localStorage injection or fresh-profile substitution. The earlier profile reuse hang was not reproduced under this clean shutdown sequence; no speculative application fix or claim about its original cause is made.

The final product source is frozen at `7b7c0c2`. The following runs use the exact final candidate above. Each command exited 0 and each report records completed assertions without an error (most also set `passed: true`). Reports live beneath the ignored Task 10 directory.

| Actual suite | Groups | Report |
| --- | ---: | --- |
| Combined local | 16 | `final-local/desktop-CSsNp6/report.json` |
| Combined NAS | 16 | `final-nas/desktop-zEL9B6/report.json` |
| Independent inspection processing | 3 | `processing/desktop-rXCNay/report.json` |
| Startup identity/read-only modes | 2 | `startup-modes/desktop-6Hrc79/report.json` |
| Startup identity/read-only/recovery modes, extended | 3 | `startup-recovery/desktop-Q5KhnR/report.json` |
| Folder navigation | 7 | `legacy/folder-navigation/desktop-0LJ9CD/report.json` |
| Random unclassified navigation | 6 | `legacy/random-navigation/actual-oI1x5d/report.json` |
| List viewer and explicit Jump workflow | 8 | `legacy/list-workflow-barrier/run-tBvyyS/report.json` |
| Editing workspace | 13 | `legacy/editing-workspace-final/actual-8kfq5S/report.json` |
| Selection flow (pointer/keyboard evidence, boolean report) | PASS | `legacy/selection-flow-revised/report.json` |
| Default collaboration | 11 | `legacy/default-collaboration-revised/two-default-ruVewA/report.json` |
| Collaboration layers | 17 | `legacy/collaboration-layers-filter/two-ui-VjQpcp/report.json` |
| Batch hide/recycle/restore/restart/Save As | 6 | `legacy/media-batch-controls/desktop-4K6cDc/report.json` |
| Global settings (fresh owned current fixture) | 8 | `legacy/global-workspace-clean/desktop-LSpBGb/report.json` |
| Examples (owned synthetic NAS project) | 7 | `legacy/examples-restore/desktop-GSx2LJ/report.json` |
| Media folders | 16 | `legacy/media-folders-current/actual-Qsa9rq/report.json` |

The final combined runs add measured own-border priority, a foreign edge over an own interior without changing main selection, and a genuinely clipped visible edge after UI zoom. Both also exercise an actual same-UUID writer lease during startup restore and retry after the owned holder closes. Client error arrays are empty. A failed local final attempt clicked an inherited clipped/selected region rather than blank time; the corrected fixture measures a clear blank coordinate and waits for the visible cue and durable session record before shutdown. This is a fixture correction, not a product fix.

Legacy fixture changes retain their original invariants while using current controls: List and Authors open the unified viewer, and only explicit Jump moves the main workspace; readonly metadata excludes writable fields while independent preview controls remain available. The selection fixture's old saved-Delete-to-mask expectation was replaced with the current explicit mask command and a separate saved-Delete/Undo assertion that verifies no DSP edit. List runs 02/03 observed a previous Jump's accepted debounced viewport update after their before-snapshot; a real UI Save barrier now acknowledges that prior action before the full-document immutability comparison. The passing run retains full snapshot equality.

Further legacy failures remain in their original logs/screenshots: unqualified author-filter XPath selected a background control behind the dialog, and custom mode now correctly inherits the preceding mine-only selection rather than implicitly showing everyone. The corrected fixture scopes the dialog and explicitly starts from All before excluding self. Restart fixtures now use the actual restore prompt. Global settings uses the eight current tabs, including Examples, and the clean WM_CLOSE barrier before reusing its profile; the prior forced-termination attempt returned null global localStorage and is not counted as a passing persistence check. The global fixture is freshly UI-created in the current candidate, so its results do not claim a 0.7.1 compatibility run. Old-version compatibility is separately established below.

The media-folder fixture first searched the previous selected tree directory after moving its file out of that directory. It now explicitly selects All before global reveal. Its next failed attempt used a normal-navigation helper on the hidden-list row, which correctly selects for batch actions without moving the main workspace; the fixture now restores with the row's actual context action. The final 16-group run retains exact folder membership/deletion protection, concurrent rename preservation, pending-note/playback/history invariants, export and original-audio hashes. No import/dedup implementation was changed.

Actual suite commands are `node tests/desktop/<suite>.test.mjs`, with `ANNOTATOR_WORKSPACE_EXE` fixed to the copied final candidate and each suite's output environment directed to its table directory. `global-workspace` additionally uses `--fresh-fixture`. Examples receives a unique `ANNOTATOR_EXAMPLES_PROJECT` beneath `N:/精成数据标注/项目测试`. Combined local/NAS vary only their explicitly owned project root; their appdata, WebView profiles and driver/native/debug ports remain independent. The final Node harness/registration confirmation passed all 21 tests (`logs/harness-registration-completion.log`). This is a selected regression set, not a claim that every historical desktop phase was executed.

Completion checks at 20:26:56 +08:00 found no remaining owned native/WebView/driver process and no listeners on the reserved driver/native/debug ports (4445/4446/9235, 4455/4456/9245, 4485–4556 and corresponding 9285–9355 triples). The copied E2E SHA-256 was rechecked unchanged (`completion-owned-retirement.json`). Raw reports, failed attempts and synthetic screenshots are retained; fixture directories were not recursively removed.

The processing run creates an actual private 6000 Hz mask and a 1500 Hz gain edit through UI. Read-only original/processed tile measurements show exactly −6 dB at the gain tone and −141.5833 dB at the masked tone; rendered pixels differ. Both sources consume actual device frames with zero underrun. Analysis change, close, rapid opening and an explicitly checked owned source rename stop stale audition. Main history, preferences, edits and audio remain unchanged.

Startup modes reuse the identical persisted profile after full process exit. A changed current UUID discards the previous actor's transient panel/tab/cue state; explicit read-only/null-actor mode restores while the matching writer is open. The extended run creates a separate ordinary legacy fixture from synthetic UI-produced content, with a valid checksum backup and an explicitly interrupted primary. Same-profile startup restore enters the actual recovery choice, exposes no editable workspace before selection, and opens the verified backup stopped. No shared/default format is changed. None autoplays.

Prior-version compatibility uses the known isolated 0.7.5 and 0.7.7 E2E assets, synthetic saved projects and the final candidate. The 0.7.5 round trip passed both checks (`compat-root/075/compatibility-j8f3IO/report.json`). The initial 0.7.7 run passed old-to-current audio/identity/labels/notes/private edits/+20 dB read compatibility, then timed out waiting for WM_CLOSE after explicit project close (`compat-root/077/compatibility-TsW35w/report.json`). Its screenshot and failure remain. A bounded diagnostic continuation with unchanged 20 s timeout first verified native project null, no file pane/inert UI, and idle frontend, then recorded the exact owned HWND/PID/title. WM_CLOSE was accepted and exited in about 560 ms; both round-trip checks passed (`compat-root/077-diagnosis/results/compatibility-TV0VSm/report.json`). This supports an ordering-sensitive fixture; it does not establish the original cause or justify a product change. The tracked compatibility fixture now waits for that explicit ready boundary.

## Limits

IPC, DOM geometry, canvas reads and lifecycle diagnostics are read-only assertions; actual imports, labels, edits, trash/restore, visibility and playback use UI. Synthetic fixtures and an explicitly checked owned-directory rename supply path/source failures. Runtime lease/presence artifacts are excluded from protected shared hashes; project/catalog/organization/recycle/author/audio content is included. Personal filters do not project into export.

No acoustic loopback, subjective listening, real-project modification, automatic installation, merge or GitHub Release occurred. The previous Task 4 measured 877 media/six-channel workload and native/RAF limits remain as documented; it was not rerun without a new playback scheduling change. Deferred evaluation/reannotation and paused import/dedup work remain outside the release. Production installer, complete updates, production hook exclusion, package hashes and NAS software delivery belong to the subsequent packaging step.
