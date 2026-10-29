# Task 4: playback presentation measurement

Task base: `5d93cffea2111a5778bd931e9b75153f01c04848`.

Confirmed defects were visual cursor reanchoring backward after a quantized native event, and workspace rerendering for every routine native progress event. The presentation clock now keeps one continuous pass monotonic, predicts for at most 250 ms, stays within the native range, and resets on native control/owner/generation changes or confirmed loop wraps. Callback frame consumption also identifies short loops that complete between native events. The playhead and transport subscribe to a small progress store; control changes still notify workspace consumers. Linked-time visibility and zoom placement are retained.

No Rust, decoded audio, DSP, STFT, masking/gain, source-verification or callback code changed. No output starvation was reproduced, so no audio-path optimization was attempted.

## Initial empty-edit Windows comparison (retained)

Both executables embed the frontend and were built with `cargo build --release -p annotator-desktop --features e2e,tauri/custom-protocol`. They are separate owned copies, not the installed user application.

- Baseline executable SHA-256: `463e057a15a18b360643b1276268585cd9a371e5a9192d2bfb32e0ab13509c8f`.
- Candidate executable SHA-256: `8bf20f65fcae66838ed7b6c4554a9350af64f541b09655de080e7a60044e586b`.
- Initial fixture: 877 real native imported media, including an 8.85-second 48 kHz mono file and a 20-second 48 kHz six-channel file. Authors tab open and full catalog mounted. These initial processed-mode trials had empty edits; the nonempty workload follow-up below closes that validation gap.
- Owned unique ephemeral driver/native/debug ports, copied local-data identity, private WebView profile, quiet app volume 0.01. Cleanup kills only spawned PIDs and bounds driver quit. No real NAS project or user app was mutated.
- Fixed viewport 1484 × 901; canvas dimensions were checked unchanged during each steady trial (mono 847 × 669; multichannel two visible channels at 847 × 310 each).

Each cell reports baseline → candidate, in milliseconds. Four steady trials lasted five seconds each.

| Source/mode | Native event p95 | RAF p95 | RAF max | Cursor backsteps | Underrun frames |
| --- | --- | --- | --- | --- | --- |
| Mono original | 42.8 → 40.0 | 33.3 → 16.7 | 83.3 → 66.5 | 1 → 0 | 0 → 0 |
| Mono processed | 56.1 → 46.4 | 33.5 → 16.7 | 66.6 → 33.3 | 1 → 0 | 0 → 0 |
| Six-channel original | 57.5 → 40.8 | 50.0 → 16.7 | 133.0 → 66.6 | 1 → 0 | 0 → 0 |
| Six-channel processed | 63.0 → 40.6 | 49.9 → 16.8 | 83.3 → 49.9 | 0 → 0 | 0 → 0 |

Native consumed frames advanced throughout. Renderer long tasks ≥50 ms still occurred (three baseline, five candidate across the four trials); they were not eliminated. A separately labelled induced 220 ms renderer stall produced native-delivery gaps of 255.4 → 236.2 ms and zero underruns in both runs. It is excluded from steady timing summaries.

Both complete runs passed real pause counter freezing, resume, seek to a new generation, selection looping within the native range, naturally drained end, close, reopen with no stale stream/autoplay, stable dimensions and zero renderer errors. Candidate additionally asserted zero backward cursor steps in each steady trial (20 total checks).

Raw owned output under `.test-output/collaborative-workspace/task4/`:

- `playback/baseline-final-C4OeO9/report.json` — complete initial empty-edit baseline.
- `playback/candidate-da5XuU/report.json` — initial empty-edit candidate and complete observations.
- `playback/baseline-repeat-qe0q4N/report.json` — earlier passing repetition, also reproduced a backward cursor step.
- `playback/baseline-kc2eDR/report.json` — first measurements retained; final close probe mistakenly sent a retired nonce. The suite was corrected to use an unbound status read after close; no product fix was attributed to that harness failure.
- `baseline-diagnostic.log` initially includes an invocation before the baseline executable copy existed; baseline native build subsequently completed successfully. `baseline-build.log` and `candidate-build.log` preserve builds.

## Nonempty mask and gain workload follow-up

The preserved executables above were reused without rebuilding or changing product code. An owned setup app used normal native `apply_change` commands and `save_project`, then retired. Each measurement app freshly reopened its own local-data copy of that saved setup; no React store was directly mutated. The setup has 14 enabled processing-version-2 edits: one mask at 1000–2000 Hz and one −6 dB gain at 5500–6500 Hz on every channel of the mono and six-channel sources, all spanning 0.25–7.75 seconds. Two classified own-region annotations spanning 0.5–7.5 seconds also appear in the open Authors tab.

The exact edit definitions and source/frame parameters are retained in `playback/prepare-edits-qv2KRx/edited-manifest.json`. Every measurement run asserts the saved edit identity and source/analysis settings match that manifest:

- Complete edit JSON SHA-256: `a35f00a25b36c36e94376a60264d017b75955b52ea76fe33c2bb0d45d758fdf3`.
- Mono canonical edit signature: `d63a5eb68ec6eec41a8515b75d7640fa29f864e93a6504e2a5cb74fe2544192e`.
- Six-channel canonical edit signature: `07e89e5c84b3cbb8dfc9b6bda185e0d895c7f6c4ab4d92eab353f282c2e18e8a`.
- Analysis: Hann window, window/FFT 2048, hop 512, Mel bands 128; configuration SHA-256 `a49e0eb7ae49e2e8563d2a3bca9a8650c6211626b32879e4a5b2d13cd943470b`.

Before timing, a separate native analysis lease requests eight numeric STFT frames around two seconds for original and processed channel 0 of each source. Native request headers must acknowledge the exact canonical edit signature and configuration. Both sources measured −141.5834465 dB at the masked 1500 Hz tone and exactly −6 dB at the 6000 Hz gain tone. Original numeric Float32 SHA-256 was `d76668618c3a5e66a68525bb65068cb27464ca0d91c46d99e9c51bbef3de2cc2`; processed was `16649c9383afa4776762f8a3c9e28470706655ae48dcf95be47b106d8e5d28da`. Thus actual processed numeric output differs from original. This is a bounded analysis probe, not a full audio-stream equivalence or acoustic test.

Every five-second steady phase additionally asserts the intended full-file range (0–8.85 or 0–20 seconds), correct project/media identity, loop disabled, at least 90 playing events, at least four seconds of consumed frames at the device rate, and one expected generation. This prevents an early end or short selection from vacuously passing cursor checks. Dimensions, quiet app volume, source files and frame parameters remain as above.

The final edited pair passed 26 baseline and 31 candidate checks. Every steady phase contained 142–151 playing events and 4.96–5.28 seconds of consumed frames. Values below are baseline → candidate; times are milliseconds.

| Source/mode | Native event p95 | RAF p95 | RAF max | Cursor backsteps | Underrun frames |
| --- | --- | --- | --- | --- | --- |
| Mono original | 58.0 → 47.9 | 33.4 → 16.7 | 99.8 → 99.7 | 0 → 0 | 0 → 0 |
| Mono processed | 58.2 → 39.9 | 33.4 → 16.7 | 199.5 → 99.8 | 0 → 0 | 0 → 0 |
| Six-channel original | 52.3 → 56.3 | 49.8 → 16.7 | 116.4 → 83.2 | 0 → 0 | 0 → 0 |
| Six-channel processed | 61.5 → 44.3 | 49.9 → 16.8 | 83.2 → 66.6 | 0 → 0 | 0 → 0 |

This repetition did not reproduce baseline backsteps, although earlier edited runs did (two in `baseline-edited-7ysSpG`, one in `baseline-edited-final-mNrJrV`), as did the retained empty-edit baseline. Candidate steady trials remained monotonic. Native event timing did not improve uniformly, and long tasks persisted (18 baseline, 17 candidate across these steady trials). No native scheduling or DSP improvement is claimed.

The induced 220 ms renderer stall was measured separately from the following pause acknowledgement. Its native-delivery maximum was 250.8 → 235.1 ms, with zero cursor backsteps during continuous playback and zero underruns in both runs; the candidate asserted at least 15 playing events and monotonic cursor movement during this phase. Pause/resume/seek/selection-loop/end/close/reopen checks also passed with the nonempty edits. An earlier aggregate (`candidate-edited-final-IfgStr`) included an expected pause snap from visual 1.508 s to native paused 1.502 s. Its raw event timeline identifies that transition as paused; it was not treated as a continuous-playback defect. The final pair uses explicit phase boundaries to keep pause transitions outside the delayed-event summary.

Edited raw output under `.test-output/collaborative-workspace/task4/playback/`:

- `prepare-edits-qv2KRx/edited-manifest.json` and `report.json`: exact setup, saved edits, classified annotations and identities.
- `baseline-edited-verified-Yc48SM/report.json` and `candidate-edited-verified-3L2qHu/report.json`: final paired measurements with duration/generation guards and pause separated from the induced stall.
- `edited-verified-comparison.json`: derived comparison; a real Node assertion confirmed baseline and candidate processing identities and numeric probes were exactly equal and all recorded checks passed.
- `baseline-edited-7ysSpG`, `baseline-edited-final-mNrJrV`, `candidate-edited-final-IfgStr`: retained earlier edited repetitions and raw observations. They do not replace or relabel the initial empty-edit results.

Reproduce the edited workload from the worktree in PowerShell, assigning an explicit preserved baseline or candidate executable:

```powershell
$env:ANNOTATOR_WORKSPACE_EXE=(Resolve-Path .test-output/collaborative-workspace/task4/candidate-exe/annotator-desktop.exe).Path
$env:ANNOTATOR_PLAYBACK_MANIFEST=(Resolve-Path .test-output/collaborative-workspace/task4/playback/prepare-edits-qv2KRx/edited-manifest.json).Path
$env:ANNOTATOR_PLAYBACK_LABEL='candidate'
$env:ANNOTATOR_PLAYBACK_EXPECT_MONOTONIC='1' # omit for baseline diagnosis
node tests/desktop/playback-timing.test.mjs
```

To prepare a new owned edited fixture, use the original prepared import manifest and run the same suite with `--prepare-edits`; it writes a new `edited-manifest.json` retaining the setup local-data directory. Use that printed manifest for both executable comparisons.

## Verification and limitations

- RED `npm test -- src/features/playback --maxWorkers=1`: native status 1.024 reset the displayed cursor from 1.05; `clock-red.log`. GREEN: 61 tests, `clock-green.log`.
- RED same command: three progress events caused three owning-hook renders (4 → 7); `scheduling-red.log`. GREEN: 62 tests, `scheduling-green.log`.
- RED same command: complete short loop left the cursor at 2.02 instead of native 2.015; `boundaries-red.log`. GREEN boundary/consumer tests: 67 tests, `boundaries-green.log`.
- `npm test -- src/features/playback src/features/project src/features/collaboration src/features/selection src/app/App.test.tsx src/app/AppShell.test.tsx --maxWorkers=1`: 286 tests passed before the last transport/linked-view test additions (`candidate-tests.log`). Final focused playback run: 68 tests passed (`final-playback-tests.log`).
- `npm run typecheck`, `npm run build`, `node --check tests/desktop/playback-timing.test.mjs`, `git diff --check`: passed. No native tests were required because no native source changed.
- Nonempty-workload follow-up changed diagnostic/evidence files only. Both diagnostic modules passed `node --check`; the setup and final baseline/candidate commands above ran on actual Windows and passed. Product RED/GREEN evidence remains the original Task 4 evidence above; no additional product behavior was changed.

Consumed frames describe submission by the output callback, not sound heard at a speaker. There was no acoustic loopback or listening-quality test. These bounded local runs establish a smoother visual cursor and less routine React work; zero measured underruns do not establish that every reported physical playback stutter is fixed. The baseline/candidate runs are sequential and timing varies with Windows load; no reduction in long tasks, DSP cost or audio latency is claimed.
