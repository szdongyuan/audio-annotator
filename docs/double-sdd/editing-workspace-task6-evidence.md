# Task 6 evidence: typed regional DSP gain and private realtime monitoring

- TaskBase: `af3eff3367e9591e8ebce7be2f7de799a87f762e` (reviewed Task 5).
- Workspace: `D:/Work/annotator/.worktrees/media-folders`, branch `media-folders`.
- Authority: approved `specs/2026-10-27-editing-workspace-design.md` §2/§6 and Task 6 of `plans/2026-10-27-editing-workspace.md`.
- Initial working-tree change was the root-owned Task 5 PASS status in the plan; it is preserved in this checkpoint. The prior Task 5 baseline was supplied by the orchestrator; the new verification below was executed by this implementer.
- Raw logs: `D:/Work/annotator/.test-output/media-folders/task6-*.log`. Failed and intermediate attempts remain available.
- Checkpoint identity is the Git commit containing this evidence. Review the entire immutable TaskBase..checkpoint range.

## Implemented scope

`SpectralEdit` now requires DSP/processing version 2 and an `operation` object: `{type:"mask"}` or `{type:"gain",gainDb:number}`. Regional gain must be finite and within -60..24 dB. Project3 rejects retired DSP/edit headers explicitly as UnsupportedVersion before decoding the new operation field. Retired document fixtures remain unchanged. Analysis algorithm 1, organization 1, catalog 2, and the outer formats established in Task 5 remain unchanged.

`AddEdit` validates even a zero-gain command but creates no document/revision/history change for 0 dB. `ResetMediaMasks` removes enabled and disabled masks for exactly one known medium in one atomic undo step; gains, other media, labels and notes survive, and an empty reset creates no history. Private DSP/reset operations remain allowed for view-only collaboration; annotation permission checks remain intact.

The existing 2048 FFT/512 hop processor, tapers, conjugate bins, globally aligned overlap-add and bounded source reads are shared by playback and processed analysis. The multiplier is `(1-max(maskWeights))*10^(clamp(sum(weightedGainDb),-120,48)/20)`. Repeated gains accumulate. Native and TS `analysis-edits-v2` identities include operation, gain value, and gain multiplicity; masks still geometry-deduplicate. Shared IEEE754 fixtures now cover both masks and repeated gains. Original/processed sources remain distinct and tile processingVersion is uniformly 2; the analysis algorithm itself stays 1.

Mixer, resampler and ring retain finite float headroom until monitoring and final device conversion. The resampler had an additional early +/-1 clamp and required the same correction as mixer/ring. Device F32/I16/U16 conversion bounds output and prevents NaN/integer wraparound. Monitoring uses an atomic target scalar and a callback-local amplitude ramp of at most 10ms. The actual sample-output loop is directly tested for mono/stereo/six-channel devices: one ramp step per frame and one shared scalar across channels. No new callback lock, allocation or I/O is introduced.

Private `PlaybackPreferences` stores `monitorGainDb` (default 0) and `mediaMonitorGainDb` (UUID -> nullable absolute override). Null/absent entries follow the default; equal numeric values remain explicit overrides. Native validation requires finite -60..24 values and current canonical media identities, bounds map size, and rejects duplicate map keys. Recovery, author isolation, private disk inventory and native Save As tests exercise nonzero preferences. The bridge keeps bounded credential/cycle/unknown-field checks while permitting the validated UUID map to exceed the generic 32-field DTO limit; a 6000-entry regression checks the expanded 1MiB context allowance. Ordinary projects use hook/runtime state without a new persistence service.

`playback_configure` requires the initial effective monitor gain. New `playback_monitor_gain` is separately bound to runtime/project/media/generation and changes only the scalar; it does not configure, prebuffer, seek, rebuild PCM, change generation, or change the document. Buffer publication uses the latest desired scalar even when gain changes during buffering. Native tests exercise stream counters, queued frames, buffering, stale owner/source/generation, invalid values, and reset. TS validates the request and complete response, including response stream identity.

`usePlayback` owns independent monitoring state outside audioSignature/configurationKey and shares its command tail for serialized updates. It reads the latest desired gain after pending configure acknowledgement, defers no-stream updates until configure, preserves absolute overrides/follow behavior per medium, prunes removed-medium overrides, and drops retired-owner/source callbacks. Realtime errors and preference draft errors can be retried independently. Original/processed file/selection requests and output-volume interaction are covered. Mask creation now only reuses a mask, never a gain at matching geometry.

Full controls, selection gesture/menu changes, layout, actual WebView desktop acceptance and release work remain Tasks 7/8.

## TDD and failure evidence

| Behavior | Observed RED | Observed GREEN |
| --- | --- | --- |
| Typed DSP2 document boundary | `task6-document-red.log`: valid new typed gain rejected | `task6-document-green.log`; final document suite |
| Zero gain and atomic scoped reset | `task6-history-red.log`: zero edit changed document/history | final document suite |
| Measured regional gain | `task6-dsp-red.log`: +6 gain behaved like a mask, measured -inf dB | `task6-dsp-green.log`; final DSP suite |
| Repeated gain cache identity | `task6-cache-red.log`: one/repeated gain signatures equal | `task6-cache-green.log`; final processed suite |
| TS cache identity | `task6-ts-cache-red.log`: v1 geometry-only identity collapsed gains | `task6-ts-cache-green.log`; final frontend suite |
| Float headroom | `task6-headroom-red.log`: pipeline returned [1,-1] before attenuation | `task6-headroom-green.log`; actual +24/-24 DSP pipeline regression |
| Device conversion and ramp | `task6-device-red.log`, `task6-device-ramp-red.log`: nonfinite output / immediate step | `task6-device-green.log`, `task6-device-callback-final.log` |
| Private monitoring preferences | `task6-preferences-red.log`, `task6-ts-prefs-red.log`: new fields rejected | corresponding GREEN logs; recovery/Save As/inventory suites |
| Native realtime scalar | `task6-native-monitor-red.log`: scalar unchanged | `task6-native-monitor-green2.log`, final native suite |
| Strict realtime bridge | `task6-monitor-bridge-red.log`: realtime method missing | final bridge/native suites, including captured runtime transport |
| Independent mask and gain | `task6-mask-independent-red.log`: mask action reused gain | final selection action suite |
| Playback monitor state | `task6-hook-red.log`: monitor setter missing | `task6-hook-green.log`; final integrated hook/tile suites |
| Current-media overrides | `task6-prefs-media-red2.log`: unknown medium accepted | `task6-prefs-media-green.log` |
| Strict zero command validation | `task6-zero-validation-red.log`: malformed zero-gain entity accepted | `task6-zero-validation-green.log` |
| Duplicate private map keys | `task6-duplicate-map-red.log`: duplicate key accepted | `task6-duplicate-map-green.log` |
| Retired processing versions | `task6-retired-red.log`: InvalidInput instead of UnsupportedVersion | final document suite |
| Large valid private map | `task6-prefs-budget-red.log`: valid 6000-entry map rejected; first budget-only attempt still hit generic DTO field limit | `task6-prefs-budget-green2.log`; final frontend suite |

The DSP suite computes RMS/amplitude values directly: +6/-6/0 dB, repeated +12 dB, +/- combination, -120/+48 combined clamps, mask dominance, channel isolation and exact chunk/seek equivalence. Processed tile values measure +6 dB numerically and match independent DSP-then-STFT results, including large analysis windows. The +24 regional/-24 monitor regression compares clean interior samples within 1e-6; headroom also covers 48kHz and 44.1kHz resampling.

Local refactoring extracted the existing callback sample loop for direct frame/channel tests; its numerical/conversion/ramp tests and final checks pass. A temporary overly broad test edit changed existing recovery assertions; the original expected-error assertions were restored, with no product lifecycle change to accommodate them. `task6-core-focused-final.log` retains that failed test-authoring attempt; `task6-core-focused-final2.log` passes all 104 focused cases. Intermediate typecheck/build logs retain duplicate-import/mock-annotation failures; only test imports/types were corrected before the final successful checks.

## Final actual verification

Heavy suites/builds were run sequentially. Every final log below records EXIT=0.

| Command | Actual result | Raw log |
| --- | --- | --- |
| `cargo test -p annotator-core --test document --test dsp --test processed_analysis --test playback_state --test collaboration_workspace --test exchange` | 104 passed | `task6-core-focused-final2.log` |
| `cargo test --workspace` | 363 passed, 5 expected ignored | `task6-workspace-final.log` |
| `cargo test -p annotator-desktop --features e2e --lib` | 86 passed | `task6-native-final2.log` |
| `cargo clippy --workspace --all-targets -- -D warnings` | passed | `task6-clippy-final.log` |
| `npm.cmd test -- --maxWorkers=2` | 523 passed, 63 files | `task6-frontend-final2.log` |
| `npm.cmd run typecheck` | passed | `task6-typecheck-final2.log` |
| `npm.cmd run build` | passed; existing large-chunk advisory | `task6-build-final2.log` |
| `cargo fmt --all -- --check` | passed | `task6-fmt-final2.log` |

The 5 ignored Rust cases retain their existing explicit subprocess/NAS fixture requirements. Native tests with the e2e feature are not actual WebView desktop acceptance. No listening, physical device, desktop layout, real NAS acceptance, installer or production release verification is claimed here.

No migration, release/version metadata change, main integration, push, cleanup, dependency junction deletion, or NAS/release write was performed. The existing chunk-size advisory is the only build advisory; bundling changes are outside Task 6. No material outstanding Task 6 concern remains.

## Plan compliance

Minor necessary target extension: removed the resampler's early +/-1 clipping because preserving only mixer/ring headroom could not satisfy the approved +24 regional/-24 monitoring contract. Tests prove both unchanged-rate and resampled headroom. Other work remains within Task 6. Root-owned plan tracking is left for the orchestrator; the previously pending Task 5 PASS status is included intact.
