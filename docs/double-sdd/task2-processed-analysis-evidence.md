# Task 2 — processed analysis source and cache identity

TaskBase: `9eef10f6e95f3444e7b772cba41515c7d2956d8d`. Work is confined to `feature/spectral-fidelity-v021` in the isolated worktree. Task 2 only: the Canvas/hook accept an explicit source, with **original still the default**. Task 5 owns the workspace source selector and its default. No playback, selection, pane, sharing, document-format, DSP-formula, palette or default-FFT change is included.

## Contract and bounds

- Every tile request/echo carries required `analysisSource`, `processingVersion`, and `editSignature`. Native request parsing rejects unknown/missing fields; the bridge also strictly validates the envelope, request, settings, metadata and source identity. Numeric payload and framing remain the bounded AT01 envelope.
- Native cache keys use a new version and include source fingerprint, sample rate/length, source mode, DSP version, enabled-edit digest and the existing analysis geometry. Frontend exact keys and finer-coverage reuse require the same source identity. Old disk entries naturally miss; no cache/document migration.
- The processed digest is SHA256 of sorted, unique channel/version/geometry records for this file's enabled masks. Geometry uses big-endian IEEE754 f64 hex, normalizing signed zero. The shared `tests/fixtures/analysis-signature.json` tests integers, fractional/exponent values, adjacent representable doubles, ordering, duplicate geometry, disabled masks and other-file exclusion in both languages. Native recomputes the digest from its authoritative document; the frontend does not supply mask authority.
- Original uses an empty edit digest: native/core tests prove raw samples/tiles remain unchanged by masks. Processed with no enabled masks still has a distinct digest/source cache identity. Notes, categories, IDs, ordering, disabled masks and other-file edits do not invalidate effective processing geometry.
- Authority checks run before enqueue, after hydration/cache hit/work, after ready notification/encoding, and again before IPC response publication. Source hash/ref, settings and runtime guards remain. Frontend generations and synchronous store checks reject late edit/undo/source/runtime results, including the interval before React effect cleanup.
- `SourceReader` reuses the existing `DspProcessor` Original/Processed modes at the original sample rate, without mix, output volume, resampling or selection cropping. Analysis windows through 32768 frames read globally aligned output blocks of at most 4096 frames. DSP retains its existing global OLA halo; cancellation is checked between blocks and inside the bounded source callbacks.
- Each job retains at most nine mono 4096-frame blocks (147456 bytes / 144 KiB). This covers a maximum window crossing a block boundary and reuses overlapping windows. The two workers' 288 KiB retention is deducted from the existing 96 MiB shared analysis PCM allowance; adding the 32 MiB playback allowance still totals 128 MiB. Native concurrency, 64 MiB numeric tiles, and Task 1's 32 MiB raster budget are unchanged. There is no full-file processed PCM buffer in production; small full-reference PCM exists only in tests.
- Failures retain the accepted masks, expose the existing error/retry path and never silently switch to original. A source change clears the prior source's surface and shows analysis preparation/progress until current data is ready.

## RED → GREEN

Actual logs are under `.test-output/fidelity-task2/`.

| Regression | Observed RED | Observed GREEN |
|---|---|---|
| `cargo test -p annotator-core --test processed_analysis` | Missing analysis source reader and identity fields (`core-red.log`) | 3 tests pass: independent `DspProcessor::Processed` → same STFT equals tile output exactly; no/disabled/overlap/moved/restored masks, both channels, 32768 windows, head/tail/random seeks, overlap reuse and cancellation (`core-green.log`, final workspace log) |
| `cargo test -p annotator-desktop processed_authority` | Native accepted a forged 64-hex edit digest (`native-authority-red.log`) | Forged/old digest rejected; edit during work and edit during ready notification on warm cache hit both reject publication (`native-authority-green.log`, final workspace log) |
| Focused `analysisSource` / `tileClient` tests | Missing canonical signature implementation and extra source-authority fields accepted (`bridge-red.log`) | Shared digest fixture and strict response validation pass |
| `useTiles.test.tsx` | Switching original→processed reused the original request: expected 2 requests, received 1 (`hook-red.log`) | Sources/moved masks separate, undo reuses matching data, notes/other files preserve cache, delayed edit/undo/source results are dropped; processed failures retain masks and retry without fallback |

## Required verification

All commands completed with exit 0 on 2026-10-23:

- `cargo test --workspace`: 121 tests passed (`workspace-test.log`).
- `cargo fmt --all -- --check`: passed; no formatting output.
- `cargo clippy --workspace --all-targets -- -D warnings`: passed (`clippy.log`).
- `npm.cmd test -- src/features/spectrogram src/bridge`: 73 tests / 15 files passed (`frontend-green.log`).
- `npm.cmd run build`: typecheck and production build passed (`build.log`); the existing large third-party-notices chunk warning remains.
- `npm.cmd run typecheck`: final test-only additions passed (`typecheck-final.log`).
- Fresh native build: `npm.cmd run tauri -- build --debug --no-bundle --features e2e --config src-tauri/tauri.e2e.conf.json` passed before either GUI suite (`native-build.log`). Executable SHA256: `c5fa4ee8d77a67a0b93773f71870ea80d710fdc605d42b13eec8fe96ab2a2968` (`build-identity.json`).
- `node tests/desktop/processed-flow.test.mjs`: passed (`native-flow.log`, `native/report.json`).
- `node tests/desktop/fidelity-flow.test.mjs`: all 23 checks passed (`fidelity-regression.log`, copied `fidelity-report.json`). Required because its direct native request fixture gained the mandatory identity fields. Same fresh binary, no intervening product changes. Physical color reference error remains 0, maximum annotation/tick error 0.000485 CSS px, maximum measured raster backing + scratch 23177792 bytes (<32 MiB). DPR1/1.25/2 are isolated WebView simulations, not Windows system-DPI claims.

## Actual native evidence and limitations

The new suite creates/imports via the real desktop UI, then sends **actual native IPC** requests/edits/save/undo/redo/reopen calls. It intentionally does not claim processed-display UI or a user-facing source selector: those belong to Task 5. `native/original-default-ui.png` records the unchanged original-default display. No output device playback was needed or claimed.

Fixture: synthetic 2-second 48 kHz stereo WAV, 1.5 kHz + 6 kHz tones at amplitude 0.3 each; default Hann/2048 FFT/window, hop512. A saved channel-0 1–2 kHz full-duration mask reduced the 1.5 kHz bin by **149.542057 dB** (reaching the existing analysis floor), while the 6 kHz bin changed **0 dB**. Channel 1 stayed unchanged. Original requests remained byte-for-byte equal before/after processing.

The native suite also verifies stale/forged/unsupported/unknown identities, disabled/enabled/moved/deleted masks, undo/redo, unrelated note and other-file edits, regular v2 save/reopen without recovery, same-project old-runtime/retired-view rejection, and preserved edit records. Original WAV SHA256 before/after is `421fd350ee28ad3d0d806840a150c78f53e0c8c61ac1ef2c7abd9693c1a191fc`.

The harness used only owned native/driver/WebView processes and checked ports 4445/4446/9235 before launch. No CUA, existing user app, system DPI or system volume change; no dependency reinstall, cache duplication, main modification, push, merge or cleanup.
