# Task 7 — complete sharing default and local project copy

Verified 2026-10-23 in `.worktrees/spectral-fidelity-v021`, from TaskBase `bd3cc7d812b0865b1b1feb509e0eba3949cb645e`.

## Scope

ExportDialog now selects and lists `完整项目包（含音频）` first. Direct Save calls `onStart('bundle')` without selecting a radio. `仅标注（不含音频）` requires explicit selection and explains that recipients need matching original audio. Import help, native save filter names, menu, native project-copy picker, failure/close dialogs, user guide and affected desktop selectors use consistent wording.

`另存项目副本…` still calls the original `saveAs`. Existing save barriers, source validation, exchange limits/cancellation/atomic publishing, portable path handling, DSP and v2 document format were not changed. No derived PCM or tiles are added to the bundle. The existing Save As implementation retains projectId while switching directory/runtime; it does not copy original audio. Exchange import creates a new projectId.

## RED / GREEN

- `npm.cmd test -- src/features/exchange src/features/project src/app`: RED 2 failed / 50 passed (`.test-output/fidelity-task7/red.log`), showing old format ordering/names and old menu name. Tests also cover initial checked bundle, direct Save bundle payload, explicit JSON payload and unchanged `saveAs` callback.
- Initial GREEN: 52/52 passed (`green.log`).
- Added actual App error/close dialog callback tests before changing their labels: `npm.cmd test -- src/app/App.test.tsx` RED 2/2 failed (`red-recovery-label.log`).
- Final `npm.cmd test -- src/features/exchange src/features/project src/app`: exit 0, **54/54 passed**, 8 files (`green-final.log`). Included existing accepted-command/draft drain, exchange snapshot/save barrier and Save As runtime-retirement tests.
- `npm.cmd run build`: exit 0 (`build-final.log`); existing large-chunk warning remains.
- `git diff --check`: exit 0.

## Native execution

Completed the exact fresh build and observed exit 0 before launching the native test:

```text
npm.cmd run tauri -- build --debug --no-bundle --features e2e --config src-tauri/tauri.e2e.conf.json
node tests/desktop/sharing-flow.test.mjs
```

Final logs: `.test-output/fidelity-task7/native-build-final.log`, `native-run-final.log`; native test exit **0**. EXE SHA256: `890889fe2c262a92357a76b294738450623ddd37355edb181680306c6b8ef214`.

`sharing-flow.test.mjs` preserves its exported integrated runner and now has a guarded standalone entry invoking `task7-sharing.mjs`. Standalone output is a fresh uniquely owned directory on every invocation. Integrated runner still queues JSON then ZIP, explicitly selecting JSON and leaving ZIP at its default; standalone queues ZIP then JSON and imports in that order.

Final raw report and screenshots are in `.test-output/fidelity-task7/native-n1LQrQ/`:

- `report.json`, `driver-*.log`
- `export-default-bundle.png`, `export-annotations.png`
- `portable-import-originals-unavailable.png`
- `annotations-requires-original-audio.png`

The flow used owned Selenium/tauri-driver/WebView2 processes; only native picker return values were injected. It created two distinct 8-second 48 kHz stereo WAV files under its own output root. Actual pointer/keyboard actions created the project, imported both files, added a category, classified file/channel/region independently, entered notes at all three levels, created a mask with Delete, and saved. Native snapshot/tile/output calls only measured results.

Observed assertions:

1. File, channel 2 and region each retain their category and distinct note; normal v2 settings, media metadata, categories, annotation geometry and mask records compare in full across export/import (excluding the expected root-specific sourceRef and identity/revision timestamps).
2. Renamed local-copy action switches to the new directory. Editing/saving the copy changes only its document; the original project retains its previous note. Both source references continue resolving to the original WAV files, and no audio directory is created in the copy.
3. Bundle is exported by directly pressing Save with its initial radio selection. JSON is exported only after explicitly selecting the secondary option.
4. After export and closing the sender, only the newly generated `owned-originals` directory is renamed to `owned-originals-unavailable`. Both resolved rename targets are checked to remain inside this run's output directory. All original paths are asserted unavailable before import. The directory is restored in `finally`, and both restored SHA256 hashes are checked.
5. Bundle imports into an independent recipient directory with a new projectId. Every source resolves inside that import directory. The two original byte hashes are preserved:
   - `36540138e71148deb787386568246edb1b23f1292d798705f2a88f61021875c3`
   - `43ba3f465645acf0b80b254d3f3bfea3ff0d04beae6d3d83c45aa516653a3d8b`
6. Recipient defaults to 暂存编辑. Real native processed tiles at 1500 Hz change from **−10.457943 dB to −160 dB** (−149.542057 dB); 6000 Hz remains **−10.457841 dB**, delta **0 dB**. These values and processing signature match the sender. Canvas hashes match sender/recipient: masked channel `1544767335`, independent channel `1358696954`. Switching to 原音 restores the masked channel to `1358696954`; switching back restores processed pixels.
7. Real `播放整段` outputs **2496 consumed frames** at the measured playing checkpoint and **5856 frames** by Stop, using `Headphones (High Definition Audio Device)`, 48 kHz stereo, non-silent tail, zero observed underrun frames. Original source paths remain unavailable throughout recipient playback.
8. Explicit JSON import preserves document semantics but shows 缺失 and 重新关联. It does not claim embedded audio.

Two initial harness failures are retained in `native-run-1.log` / `native-wa6OBy` and `native-run-2.log` / `native-riMj26`: Windows canonical path prefix comparison, then an incorrect test assumption that existing Save As creates a new projectId. Tests were corrected to the verified existing contract; product persistence was not changed. `native-run-3.log` / `native-pCzFZH` passed before the final failure-dialog label sweep; final rebuild and rerun above cover the final product code and distinct source fixtures.

## Limits and handoff

This is native device-frame evidence, not subjective listening, physical file-picker operation, a fresh-machine installation test or a 30-second performance/underrun run. Those release checks remain Task 8. No system volume/DPI settings or user audio were changed. No version/release artifacts, dependencies, caches, or other task implementations were modified. Legacy selection/playback-mode selector updates outside the sharing/Save As names remain Task 8 work.
