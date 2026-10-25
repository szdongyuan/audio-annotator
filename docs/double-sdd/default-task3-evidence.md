# Task 3 — default native lifecycle, media and exchange

Task base: `002370d95fd457a97419b9591dd35c0b330fe173`. Scope is native lifecycle/media/exchange plus narrowly needed core capability access. No frontend, dependency versions, release files, protected agent configuration, or user projects changed. The root's pending plan/spec edits are included unchanged in this checkpoint. Raw logs are retained at `.test-output/default-collaboration-v040/task3/`.

## Frontend protocol handoff

`create_project({path,name})` now creates an empty format2 project with the DPAPI-backed automatic local author. `open_project({path})` auto-authenticates format2 using `Service.local()` outside project storage. Empty directory and project-ancestor guards remain enforced. Opening the same local actor in a second writable runtime fails; identity corruption fails without replacing credentials or silently falling back. `open_project_view_only({path})` is the explicit format2-only alternative. It never authenticates/registers a local account and has no annotation/import capability. Legacy format1 still opens its original guest workspace via normal open; old ordinary files remain explicit readers.

`OpenProject.collaboration` remains present only for shared projects. It now contains exactly:

```
{
  runtimeNonce: string,
  actor: AuthorIdentity | null,
  preferences: PlaybackPreferences | null,
  projectFlavor: "ordinary" | "legacyShared" | "default",
  identityMode: "ordinary" | "guest" | "local" | "account" | "viewOnly",
  canWriteAnnotations: boolean,
  canImportMedia: boolean,
  hiddenMediaIds: string[],
  catalogPending: boolean
}
```

`Status` retains all previous fields (`formatVersion:1`, `runtimeNonce`, `projectId`, `shared`, `actor`, `preferences`, `pending`, `recoveryRequired`, `busy`, `lastSuccessMs`, `error`, `snapshot`) and adds the same six capability/catalog fields above. No credentials or new secret-bearing DTO is serializable. No-project status has false write/import capabilities. Ordinary is writable/importable; legacyShared guest/account may annotate but cannot import; default local/account may annotate/import; default viewOnly permits private controls only. Core remains the authority for all mutation families, not these UI booleans.

`collaboration_identity` keeps its strict existing `Expected` and tagged action DTO. Default `logout` returns the stable local actor. Logout while already local is a true no-op that retains the existing author/workspace leases, runtime nonce, history, publication state, prepared media and personal state. Explicit account registration/login remains optional and session-only; switching does not copy another author's content. An actual identity change, open or copy replaces the runtime nonce. Catalog adoption and per-user hide changes keep the nonce and existing author lease.

### Admission and cancellation

A single collaboration permit covers creation/open, identity, refresh/publication, accepted media publication, catalog adoption, copies and exchange import. `Service.begin` rejects concurrent work with `ResourceLimit`, `retryable:true`, `details:{operationBusy:true}`. Other ResourceLimit failures (counts, byte budgets, prepared capacity) are **not** this retry signal. Retirement cancels but does not release the permit until its worker exits. No unbounded queued transition waiters were introduced.

Task4 must suspend polling around lifecycle actions and accepted media publication, save registered drafts where appropriate, and wait for matching-owner `status.busy === false`; bounded retries are permitted only for `details.operationBusy === true`. This applies to ordinary Ready→apply confirmation too, since a 2-second refresh can otherwise win admission. A saved project may have just scheduled publication, so Save As/import/identity/adopt should use this same wait/retry contract. Closing then creating/opening also waits for an old retiring worker. A deterministic native test holds the scheduled publication, observes structured busy rejection without target writes, releases it, and successfully retries Save As.

Exchange import uses the same cancellation Arc for its exchange task and collaboration permit; both `cancel_exchange` and runtime retirement stop its copy/extraction loops. Accepted catalog publication ignores cancellation that arrives after durable record publication; it still adopts/reports the completed item. A retired runtime cannot install into the new session.

### Media import and explicit acknowledgement

The existing `import_media` / folder-scan / Ready / `apply_change(ImportMedia)` APIs remain the route. On writable format2, native prepares a `PreparedCatalogMedia` **before** emitting Ready. The Ready descriptor ID, native bank key, retry ID and committed catalog UUID match. Preparation decodes/fingerprints/copies off global locks; raw renderer descriptors cannot produce this sealed capability. The bank checks the entire original Ready descriptor, runtime nonce and captured author lease at admission. Publication rechecks revision/runtime before publishing and adopts through the core reconciliation API, preserving existing drafts, history and personal state.

A separate native bank retains `Arc<PreparedCatalogMedia>` after a successful `apply_change` response. It is not removed by ordinary `MediaTasks::commit`. The real Channel test intentionally discards a successful response and retries the **original** Ready with its old expected revision: native returns the existing current snapshot without another item/revision. Retrying after changing source bytes or losing the source also uses the same sealed UUID once already committed. Do not prepare/decode again to recover an uncertain acknowledgement.

After confirmed success, Task4 must call the existing `release_media_import({taskId,mediaId})` as acknowledgement. The same command explicitly abandons an uncommitted Ready. Wrong task IDs are no-ops. Release removes bank authority synchronously and queues native resource disposal; errors are returned only for service access failure, not best-effort filesystem cleanup. Cleanup failure may leave invisible unreferenced temporary files (core Drop behavior); it never deletes a committed record/media, never claims a physical cleanup guarantee, and is not a failed import. Reset/identity replacement retires all old bank entries. A dedicated single disposal worker performs potential NAS cleanup outside application/runtime locks. At most 256 bank-plus-queued owned items are admitted; an admitted publication can additionally hold its one Arc clone. Source staging retains exact OS file ownership. Runtime resource disposal is joined when the service shuts down.

If durable publication succeeds but catalog reload/private adoption fails, `apply_change` returns the original error with `retryable:true` and:

```
{ catalogCommitted: true, catalogAdoptionRequired: true, mediaId: string }
```

For the still-current runtime, status also retains that error and `catalogPending:true`. Task4 must show **accepted, adoption pending**, count the item accepted, and retain the original Ready for retry; it must not mark the audio failed or start a duplicate decode. Once retry/adoption confirms the item in the snapshot, acknowledge/release it. A stale owner must not apply the old response. Native tests cover cancellation/retirement after publication, including a durable media record plus no installation into a replacement runtime.

`collaboration_adopt_catalog({expected,operationId}) -> Transition` requires a saved current revision (draft/save barrier). It reloads outside locks, then reconciles the live workspace/history without relogin, updates remembered layer authority and returns `opened` plus `status`. Polling only changes layer/status metadata: it never adopts media or reconfigures playback/document. A valid author head requiring newly discovered media is pending rather than corrupt/missing. Native retains only deferred author IDs and the last verified display layer, within the original aggregate layer budget; full authoritative layers are reread on adoption. It does not duplicate old+new payloads in long-lived state or rewrite/filter foreign payloads.

`collaboration_hide_media({expected,mediaId,hidden}) -> Status` persists private visibility after the runtime/revision barrier. It does not change the document revision or public catalog, and works for viewOnly private state too. The returned `hiddenMediaIds` drives sidebar/comparison filtering; exports remain complete. Task4 handles visible selection cleanup. No native physical RemoveMedia operation was added.

### Copies and exchange

`save_project_as` keeps its current arguments for existing callers and returns a new default project/automatic actor with a new project ID. Task4 should use the cancellable `save_project_as_controlled` command described in the review-fix section below. It copies the current author's live saved document, keeps media UUIDs across all annotation/mask/analysis/mix/view references, and transfers private playback preferences/hidden IDs. Media are independently decoded and fingerprint-checked; target staging is exclusive, final media are fingerprint-checked after transfer, and collaboration.json is published last. Failed/stale/cancelled copy keeps the source session. `collaboration_create` is the old ordinary-project conversion entry and now uses this default copy path; its optional old credentials object is accepted but no registration is required or performed from it. Task4 should omit credentials.

`import_exchange` adds optional `bindings`. ZIP stays one step; actual exported ZIP media are extensionless `media/<uuid>`. Native decoder verification plus content magic selects the final wav/flac/mp3 extension, preserving the validated UUID. Temporary legacy extraction is confined to an exclusively owned hidden `.native-import-*` parent; it is never the final opened project.

Annotation-only JSON with required audio and no bindings emits the terminal event:

```
{ type:"sourcesRequired", taskId, sourceSha256,
  media:[{id,displayName,sha256,byteLength,sampleRate,frameCount,
          channelCount,channelLayout}] }
```

No target project is published and the active project remains unchanged. Task4 associates each required ID with a user-selected audio file, then calls `import_exchange` again with the same source/parent and:

```
bindings: { sourceSha256, media:[{mediaId,path}] }
```

Both request structs deny unknown fields. All media must be provided exactly once; unknown/duplicate/missing IDs, non-absolute paths, changed source digest, wrong bytes or decoder metadata fail. Native rereads/parses the source and checks its stamp/digest, independently validates associated files, then creates a default project. No selected source paths enter shared catalog/export DTOs. Empty-media JSON completes without bindings. ZIP rejects bindings. `sourcesRequired` ends that exchange task just like completed/failed/cancelled; a subsequent continuation gets a fresh task ID and current expected runtime barrier.

The normal `completed` event now carries a default `OpenProject` and the final default-project root path. Share imports carry only portable current-author annotations; masks/settings remain excluded by the existing exchange DTO. JSON malformed/wrong-digest/wrong-audio, mid-copy cancellation, actual ZIP roundtrip, and unadopted copy rollback are native tests.

## Core additions and cleanup

- `PrivateWorkspace::author_session() -> Option<Arc<AuthorSession>>` captures the already held native lease; never serialized or renderer-supplied.
- `CollaborationRepository::prepare_media_copy(source,cache,cancel,expected,progress)` independently decodes and validates all identity metadata, then retains the validated existing UUID/name. It does not trust a raw descriptor as proof. Regular preparation uses the same internal decoder/copy path.
- The already implemented OS file identity check `atomic::verify_lock_path` is public for native exact-owned rollback. Owned files retain handles; cleanup checks the same file identity before removing the path and closes each handle before removing parent directories. A regression replaces an owned file at the same path and verifies rollback preserves the foreign replacement.

No change to format1 catalog/publication authority or format2 catalog count/byte/entry limits. Existing legacy copy tests are explicit compatibility fixtures; production creation uses the new default path.

## Observed verification

RED logs: `lifecycle-red.log` (missing default create/open-mode APIs), `catalog-red.log` (missing native prepared publication/adoption module), `copy-red.log` (missing default copy), `exchange-red.log` (missing two-stage exchange contract), `deferred-layer-red.log` (actual false missing/regressed error for a valid new-media author), `owned-cleanup-red.log` (rollback deleted a same-path foreign replacement).

GREEN logs include `lifecycle-green.log` (18 native collaboration tests), `catalog-green.log` (19), `copy-exchange-green2.log` (21 after fixing new-project creation/update timestamp validation), `deferred-layer-green.log`, `native-boundaries-green.log`, `parallel-boundaries.log`, `owned-cleanup-green.log`, and `native-disposal.log` (26 collaboration tests). Additional integration cases verify real Channel preparation/folder scanning, successful response-loss retry, private preferences/hidden IDs through Save As, independently concurrent same-byte imports, stale creation, corrupt local identity refusal, and structured busy retry. These are real decoder/filesystem/DPAPI/native paths, not mocked media descriptors.

Final verification:

- `cargo test --workspace -- --skip catalog_collection_limit_and_record_versions_are_enforced`: **231 passed**, 0 failed, 2 ignored subprocess entry points, 1 filtered capacity test; exit 0 (`workspace-verified.log`). The ignored workers are launched by their parent integration tests.
- A final native-only regression then demonstrated that the explicit view-only command must reject legacy format1 rather than opening an editable guest (`view-only-legacy-red.log`). After that narrow guard, `cargo test -p annotator-desktop`: **36 passed**, 0 failed; exit 0 (`native-verified-final.log`). Together the current core/native coverage is 196 core + 36 desktop passing tests. The full workspace run precedes only this native guard/test; all native tests were rerun afterward.
- `cargo fmt --all -- --check`: pass, exit 0 (`fmt-final-verified.log`).
- `cargo clippy --workspace --all-targets -- -D warnings`: pass, exit 0 (`clippy-final-verified.log`).
- `git diff --check`: pass (terminal observation).

 The unchanged exact-capacity catalog test is intentionally skipped as authorized: Task1 verified that exact path in 103.79 seconds; this task changes preparation/copy identity plumbing, not capacity enforcement. Physical SMB/NAS, second Windows-user DPAPI isolation, frontend, production UI and release builds remain Task5 verification rather than claims of this native task.

One intermediate workspace rerun (`workspace-final2.log`) reached the native executable while another verification command was replacing it and failed to launch with Windows error 32. That was a test-run scheduling error, not a test assertion failure. Subsequent final workspace verification is serialized with no concurrent builds. Initial clippy style warnings were fixed and retained in their logs.


Implementation is ready for paired Task3 review. No Task4 frontend or Task5 release changes are included. The JSON two-stage source-association protocol is the root-approved refinement needed because annotation-only JSON has no audio bytes; it is recorded in the shared spec/plan. Bounded resource-disposal and exact-file-identity cleanup are narrow native correctness additions required by off-lock NAS cleanup and owned rollback.


## Task3 review fixes

Applied `D:/Work/annotator/.agents/skills/systematic-debugging/SKILL.md` and reproduced the actual defects before fixing them. Original Task3 base remains `002370d95fd457a97419b9591dd35c0b330fe173`; this pass follows checkpoint `8f7de1b9adc3400f883742a0d09d3397bed0de11`.

### Correctness fixes

1. Same-local logout had reused the author lease but attempted to reacquire the already-held private workspace lock. It failed with ProjectLocked. It now returns the existing workspace as an idempotent transition with the **same runtimeNonce** and no playback/resource reset. Task4 must keep the current owner for this no-op. The regression covers direct logout immediately after creation and logout after saved annotation/private playback changes, checking unchanged snapshot/history flags, preferences and nonce.
2. Explicit adoption had committed the private catalog/document before `RememberedLayers.update` could reject aggregate retained-author count/byte limits. Native now captures a clone of the remembered state, loads and fully validates its proposed catalog/layers outside the application lock, and only then crosses the saved revision barrier and commits/install all state together. No fallible remembered-layer step remains after durable adoption. The regression fills the retained-author bound, adds media, triggers ResourceLimit, and verifies unchanged live snapshot, persisted revision, private envelope, runtime repository pointer, remembered layers, and actual undo/redo contents. Accepted import also validates its remembered catalog extension before private adoption.
3. Another media append between the adoption catalog capture and snapshot read used to create false missing/regressed-layer errors. Refresh/adoption now share last-good substitution for verified deferred author IDs. The deterministic interleaving test appends and publishes after capture: the first adoption exposes its captured catalog, keeps the previous author layer without false corruption, and leaves catalogPending true; the next adoption reads the complete layer. A truly corrupt published file still reports an error and retains the prior good layer. No permanent duplicate full deferred payload retention was introduced.

### Cancellable Save As command

The existing command remains unchanged for compatibility. Task4's normal Save As UI should call:

```
save_project_as_controlled({
  runtimeNonce, path, projectId, expectedRevision,
  operationId, onProgress
}) -> OpenProject
```

`operationId` is caller-owned, nonempty and at most 128 UTF-8 bytes (a UUID is recommended). `onProgress` is a required Tauri Channel receiving the existing strict output shape `{operationId,phase,completed}`. Phases preserve native decoder/copy phases; copyMedia reports bytes for the current file and publishManifest reports the media count, not an overall percentage. Progress is emitted on phase changes and otherwise throttled to 100 ms. Channel delivery failure cancels the copy. Call `collaboration_cancel({operationId})` to cancel the in-flight Save As, without closing/retiring the source runtime. The one collaboration permit remains owned until its worker actually exits. Cancellation rejects the promise with Cancelled, retains source snapshot/nonce, and cleans only exact-owned target files. The real Channel regression cancels during copyMedia and verifies those outcomes.

Tauri's `Channel<T>` uses its command-argument implementation and does **not** implement Deserialize for `Option<Channel<T>>`; compilation verified that an optional channel argument is unsupported here. Therefore the dedicated controlled command is the equivalent typed API authorized by the review dispatch, rather than changing existing callers to require a channel. Both commands call the same copy implementation. No frontend files were changed.

### Atomic hidden-list transfer

`PrivateWorkspace::set_hidden_media_ids(Vec<String>)` validates and persists the complete bounded list in one atomic private-envelope transaction. It requires format2 and resolved recovery state, canonicalizes order, rejects duplicate/unknown/invalid IDs, and does nothing for an unchanged list. Existing single-item hiding delegates to it. Save As now transfers the full hidden list once rather than writing the complete envelope once per ID. The native regression verifies rejected lists leave the envelope unchanged, a multiple-ID list advances sequence exactly once, reordered identical input is a no-op, and the copied workspace incurs exactly one hidden-list write beyond its equivalent seed/preference baseline.

### Default preparation lifetime admission

Default NAS preparation now owns a separate `Permit` from before the worker starts until the worker exits. Reset/close/identity change cancels it but cannot free its slot while an old worker is still in OS decode/copy work. It shares the existing media task's cancellation Arc. The distinct slot allows already emitted Ready items to publish while the one admitted batch continues preparing later files. Legacy ordinary decoder behavior is unchanged.

A new default import-start rejected by this slot returns:

```
code: ResourceLimit
retryable: true
details: { operationBusy: true, operationKind: "mediaPreparation" }
```

`Status.busy` continues to describe the collaboration publication/lifecycle slot; it does not prove preparation admission is available. For this specific import-start signal, Task4 should use a bounded delay/retry (or wait for the previous worker's Finished event), preserving its current owner. It must not retry arbitrary resource limits. Native has no queued waiters. The deterministic regression pauses an admitted preparation worker, retires/resets its runtime, creates another default project, and verifies a new preparation is rejected until the old worker actually exits, then a bounded retry emits Ready successfully.

### Fix-pass RED/GREEN and verification

`review-core-red2.log` records all three actual failures: local logout ProjectLocked, failed adoption changed the document/revision, and the adoption race reported missing/regressed author data. `review-core-green.log` records all three passing after fixes. An initial combined RED aborted because the fixture destructor retried a poisoned test mutex during assertion unwinding; the fixture cleanup was made poison-tolerant before the valid RED run.

`review-copy-red.log` records missing progress-control and batch-hidden APIs. `review-copy-green.log` records the unsupported Option<Channel> compiler finding. `review-copy-green2.log` exposed an incorrect test assumption about initial envelope sequence; the test now compares against an equivalent real copy seed rather than assuming initial write count. `review-six-green.log` records all six focused regressions passing.

`review-preparation-red.log` proves the old retired worker allowed a second default preparation. The lifetime-bound permit fixes it; the same test passes in `review-six-green.log`. Its pause is a deterministic native test seam, not a claim of physical SMB stall testing.

Final current-code fix-pass verification:

- `cargo test -p annotator-desktop`: **42 passed**, 0 failed, exit 0 (`review-native-final.log`).
- `cargo test --workspace -- --skip catalog_collection_limit_and_record_versions_are_enforced`: **238 passed** (196 core including doctests + 42 native), 0 failed, 2 ignored subprocess entry points, 1 filtered unchanged capacity case, exit 0 (`review-workspace-final.log`). The parent integration tests actually launch the ignored workers. Capacity coverage remains inherited from Task1 as explicitly authorized; this fix does not touch catalog capacity/publication enforcement.
- `cargo fmt --all -- --check`: pass, exit 0 (`review-fmt-final.log`).
- `cargo clippy --workspace --all-targets -- -D warnings`: pass, exit 0 (`review-clippy-final.log`). An initial test-only err/expect style lint was fixed; its output is preserved.
- `git diff --check`: pass (terminal observation).

The final workspace run was fully serialized with no overlapping builds. All six requested review issues have deterministic regressions, and actual history/corruption checks remain in the expanded adoption tests. The root's saved plan/spec clarifications are included; no frontend, release, dependency or protected configuration changes belong to this pass.
