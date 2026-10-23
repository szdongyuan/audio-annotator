# NAS collaboration Task 4 evidence

Date: 2026-10-23. Worktree: `D:/Work/annotator/.worktrees/nas-collaboration-v030`.
TaskBase: `9696af18fa6aa23e4654235bd34d2b1b351d6b5c`.

## Implemented scope

Task 4 adds the strict renderer collaboration protocol, immutable per-ActiveProject command adapters, separate polling/controller state, lifecycle-bound identity changes and preferences, compact collaboration menu/status/filter controls, credential/copy dialogs, guest-copy and explicit shared-version load actions. Shared catalog import controls are disabled while relinking, personal annotations, masks and analysis remain usable. Shared export labels explain the current-author scope. Ordinary ProjectSnapshot and native command argument shapes remain unchanged.

Shared OpenedProject context is adopted together with its snapshot. Recovery retains its preview nonce until resolve returns a new context. Shared project/persistence, media, folder, playback and analysis transports capture that nonce; exchange includes it in nested expected. Actual useTiles/media/folder/playback/save-as/recovery callsites use these adapters. No global status lookup is used to bind shared closures. Ordinary create-copy obtains its initial nonce only inside the saved-source lifecycle barrier and validates the project identity.

Polling is every two seconds and skips overlap. Manual sync coalesces repeated requests, submits drafts and saves first. Identity work suspends polling, waits for an existing local-save publication worker to release its native slot, and retries ResourceLimit admission within a bounded 30-second loop. Cancellation is checked both before and after asynchronous admission reads. Failed authentication does not retire the old owner or turn its acknowledged local save into a save failure. Native operation completion remains the authority for adoption; cancellation cannot discard a successfully adopted native result.

Preferences use a registered lifecycle draft containing only volume/device/loop/source. A failed preference write retains its draft and prevents identity switching. New runtime adoption restores native preferences/defaults once; periodic status does not overwrite optimistic UI options. Ephemeral playback intents/cues and selection are reset on adoption. Retired playback callbacks and asynchronous command completions check their captured owner; they cannot stop or configure the new identity. Guest-copy keeps the ActiveProject and nonce, accepting one undoable native personal change. Explicit shared-version load uses a new runtime/history.

Credentials remain transient form/request values. Password input is cleared on submission and never enters ProjectStore drafts, localStorage, snapshots or application logs. Whitespace passwords are passed unchanged, with the native 8–128 character / 512-byte bounds. Unknown response fields, credential-shaped error-detail fields, invalid versions/geometry/identities, excessive counts, cyclic/deep graphs and byte budgets are rejected. Bounded parsing counts strings incrementally instead of serializing an untrusted whole graph.

## RED / GREEN evidence

Raw logs are under ignored `.test-output/nas-task4/`.

| Logs | Observed behavior |
| --- | --- |
| `red-bridge.log` → `green-bridge.log` | Missing bridge API initially fails import; implemented parser accepts native shapes and rejects unknown fields, credentials, invalid versions, oversized authors and invalid geometry. This initial RED is an absent-API failure. |
| `red-runtime.log` → `green-runtime.log` | Missing captured adapter API initially fails import. Adapter tests then verify old nonce capture and unchanged ordinary calls. An intermediate test caught an unnecessary third `undefined` argument in ordinary invoke calls; ordinary transport now delegates directly. |
| `red-controller.log` → `green-controller.log` | Missing controller API initially fails import. Controller and preference-draft tests pass single-flight polling, retired results, save ordering and failed-write retention. |
| `red-playback.log` → `green-playback.log` | Existing playback hook leaks default/current options instead of adopting private preferences; adoption now restores the correct volume/device/loop/source and clears cues. |
| `red-manual-flight.log` → `green-manual-flight.log` | Two manual sync calls issue two requests; coalescing reduces them to one in-flight operation. |
| `red-cancel.log` → `green-cancel.log` | Cancellation during the status await still dispatches credentials; post-await ownership/cancellation validation prevents dispatch. |
| `red-nested-credentials.log` → `green-nested-credentials.log` | Credential injection inside generic error details is accepted; bounded graph validation rejects it and cyclic input. |
| `red-identity-save-status.log` → `green-identity-save-status.log` | Rejected identity action incorrectly marks successful local persistence failed; operation errors now remain separate from the save ledger. |
| `red-password-boundary.log` → `green-password-boundary.log` | Valid whitespace-only password is rejected by trimmed nonempty validation; explicit password validation now preserves exact bytes. |
| `red-unsaved-status.log` → `green-unsaved-status.log` | Unsaved live drafts are described as synchronized; compact state now says 本机未保存. |
| `red-retired-playback.log` → `green-retired-playback.log` | Retained prior-owner playback callbacks issue another control command; owner checks at admission and completion prevent affecting the new identity. |

Additional integration/characterization tests cover atomic context adoption, shared recovery, nested exchange authority, personal Save As, same-runtime guest-copy, failed identity preservation, successful foreign reads and repeated errors without ProjectStore mutation, pure-form outside/Escape dismissal, submitted cancellation, double-submit coalescing and credential clearing. An individual RED run is not claimed for every integration/UI branch. No assertions were weakened.

## Initial checkpoint verification

- `npm.cmd test -- src/features/collaboration src/features/project src/features/playback src/bridge src/app`: PASS, **102 tests / 14 files**; `focused.log`.
- `npm.cmd test`: PASS, **333 tests / 45 files**; `frontend-tests.log`.
- `npm.cmd run typecheck`: PASS, including the final playback changes. The final native build repeats it through `npm.cmd run build`.
- `npm.cmd run tauri -- build --debug --no-bundle --features e2e --config src-tauri/tauri.e2e.conf.json`: PASS, includes full typecheck and Vite production build; `debug-build.log`. Existing notices-chunk warning remains.
- `cargo test -p annotator-desktop commands::collaboration`: PASS, **17 tests / 0 failed**; `native-tests.log`. No Rust source changes were needed in Task 4.
- `git diff --check`: PASS.
- `node tests/desktop/collaboration-controls.test.mjs`: PASS on the freshly rebuilt native app, with official tauri-driver and matching Edge/WebView2 155.0.4283.62; `ui-controls.log` and final fixture `ui-WgPTQD/report.json`. Earlier successful fixtures `ui-JX2rbZ` and `ui-PUyys1` are retained.

The desktop suite actually clicks the File/Collaboration menus and credential forms. It creates an ordinary project/imports WAV, creates the shared copy as Alice, changes/saves private volume/loop/source, logs out to default guest, adds guest data, verifies wrong-password preservation, registers Bob, copies guest data through the explicit native action, undoes/redoes once without nonce change, manually syncs, changes author display, checks personal-only export wording, logs back into Alice, closes/reopens collaboration.json as guest, logs in again, confirms shared-version load with a new nonce/cleared undo history and preserved preferences, then saves a personal ordinary copy. IPC is read-only assertion in this suite; it does not substitute native commands for the UI actions.

Screenshots: `ui-WgPTQD/identity-1280x800.png`, `identity-1920x1080.png`, and `author-filter.png`. The first two use measured **native outer** sizes 1280×800 and 1920×1080; WebView screenshot client areas are 1264×761 and 1904×1041. Header + toolbar remain 32 + 40 px with no page overflow. Screenshots were visually inspected. Harness keeps its unknown-port refusal and owned-PID teardown; one GUI ran at a time.

- Initial Task 4 debug EXE SHA256: `6933ba79c7ecfe7860e3c3303e9a8271a427243684e18c4640ce930be56b7f72`.
- Shared copied WAV SHA256 before/after the workflow: `192d1008c5d0f6d58a9f917d27eee6dcebe3992501f2c994750f4601ba79d34e`.

## Task 5 handoff API

- `useCollaborationContext()` returns the current `CollaborationUI` (null outside the provider). App supplies it around AppShell. `ui.active` is the captured current project; `ui.controller` is null for ordinary projects.
- `controller.status?.snapshot.authors` contains independent `AuthorSnapshot` entries. Each has identity, last-good layer or null, and per-author error. `controller.error` describes a renderer/transport failure; `status.error` is the native synchronization error. Native retained layers survive errors; failed parser/transport reads leave the controller's previous status intact.
- `controller.filter` is `{mode:'all'}`, `{mode:'mine'}`, or `{mode:'custom', authorIds:string[]}`. `setFilter` updates display state only; `visible(authorId: string | null)` resolves visibility (null denotes the live guest). The context rerenders on controller changes.
- Exclude `active.collaboration.actor?.authorId` from foreign overlays and render current own data from `active.store.snapshot.document`, because the status snapshot also includes the actor's older published layer. Do not merge layers into ProjectStore, SelectionState or the command queue. Resolve categories within each layer.
- Captured native APIs are `active.commands?.project/projects/media/folders/playback/tiles`. Ordinary consumers retain their existing injected defaults. Any new delayed playback/analysis action must retain the owning ActiveProject and its adapter across awaits, then recheck ownership before displaying completion.
- `active.collaboration` is immutable context, not a polling object. `active.preferences` is the lifecycle draft writer. Remote refresh must not adopt a project or reinitialize playback preferences. Only identity/open/recovery/load/shared-to-personal transitions create a new ActiveProject; guest-copy deliberately retains the old object/history.

Foreign overlay hit testing, readonly inspection, cross-author visibility/rendering, two-client UI concurrency, full 18-stage desktop regression, physical SMB/NAS hardware, performance/release verification and version 0.3.0 packaging remain Tasks 5/6. This task does not claim those results. No main checkout, release directory, user configuration, owned target-cache location, or remote branch was changed.

## Review repair: native payload text compatibility

The first quality review identified a confirmed P2 protocol mismatch in checkpoint `8cb8e8b9b3fa25aedf79bb7fba54884e90da3cd8`: the new renderer parser imposed a 1,048,576-character note limit, a 4096-character category-name limit and a NUL ban on shared payload text. Native `LayerPayload::project` delegates to ordinary ProjectDocument validation, which permits these strings within the layer byte budget. A valid foreign note could therefore reject the entire status response, including the status admission needed to switch identity.

The repair removes only those invented payload restrictions. Category and region structures still use the ordinary change validators; file/channel notes require strings. The existing strict fields, IDs, geometry, counts and credential-injection protections remain. Account, password, path and preference-specific validation is unchanged. Notes/category names remain bounded by the 16 MiB layer limit and aggregate 64 MiB layer limit. An additional regression showed the 1 MiB status metadata allowance could admit combined layers slightly above 64 MiB; the parser now sums validated layer byte counts separately from that metadata allowance.

- `red-review-payload-text.log`: **4 failed / 6 passed**, reproducing >1 MiB region/file/channel notes and >4096-character/NUL-containing payload text being rejected.
- `green-review-payload-text.log`: **10 passed**, after aligning payload text validation. Tests JSON-roundtrip native-shaped statuses and complete identity Transition responses, including atomically paired ordinary snapshots, so the status/adoption path is exercised. The fixtures are native-shaped renderer integration data, not a claim of newly invoked native commands.
- `red-review-layer-budget.log`: **1 failed / 10 passed**, reproducing five individually valid-size layers above the 64 MiB aggregate budget being accepted under the status metadata allowance.
- `green-review-layer-budget.log`: **11 passed**, including malformed/non-string text, whitespace-only category rejection, >16 MiB layer rejection, >64 MiB total rejection and unchanged account text protections.
- `npm.cmd test -- src/features/collaboration src/features/project src/features/playback src/bridge src/app`: **109 passed / 14 files**; `review-focused.log`.
- `npm.cmd test`: **340 passed / 45 files**; `review-frontend-tests.log`.
- `npm.cmd run build`: PASS, includes both TypeScript checks and Vite production build; `review-build.log`. Existing notices-chunk warning remains.
- `git diff --check`: PASS; `review-diff-check.log`.

Only the collaboration parser, its tests and this evidence document changed in the repair. No native acceptance rules or UI contracts changed. The desktop reports/screenshots and debug EXE hash above remain evidence for the initial Task 4 checkpoint; no additional GUI/native build is claimed for this parser-only repair. The parent explicitly accepted focused parser integration plus full frontend/build verification for this repair. Fresh dual review should compare the original TaskBase against the repaired head.

## Review repair: visible per-author read failures

The next spec review found that `syncLabel` inspected only top-level errors. Native refresh can successfully read the repository while retaining an individual author's prior layer and placing its corruption/read error in `snapshot.authors[].error`. With a successful timestamp and no top-level error, the compact control incorrectly displayed 已同步 (or the normal guest label), leaving the problem visible only inside the status dialog.

The existing compact button and its title now display 部分作者读取异常 when any author entry has an error. If current own work is unsaved or pending, the compact text combines the author-error indication with 未保存 or 待同步, putting the error first so truncation cannot hide it. A healthy subsequent snapshot restores the normal signed-in/guest label. Existing per-author details, retained layers, and dialog layout remain unchanged; no banner or row was added.

- `red-review-author-status.log`: **3 failed / 6 passed**. Tests reproduce signed-in and guest statuses with `error: null`, successful `lastSuccessMs`, and an author-level error being incorrectly described as healthy; they also reproduce the missing indication during own pending work.
- `green-review-author-status.log`: **9 passed**, including healthy recovery for both identities and combined pending/unsaved indications.
- `npm.cmd test`: **343 passed / 45 files**; `review-author-status-frontend.log`.
- `npm.cmd run build`: PASS, including both TypeScript checks and Vite production build; `review-author-status-build.log`. Existing notices-chunk warning remains.
- `git diff --check`: PASS; `review-author-status-diff-check.log`.

Only the status-label function, focused controller tests and this evidence document changed in this repair. No additional GUI/native run is claimed. Earlier desktop screenshots remain the initial checkpoint's layout evidence. Fresh dual review should again compare original TaskBase `9696af18fa6aa23e4654235bd34d2b1b351d6b5c` against the new head.
