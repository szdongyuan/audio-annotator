# Task 2 native example IPC contract

All library commands take `runtimeNonce: string` and `projectId: string` from current collaboration status, including ordinary projects. Names below are exact Tauri command names; arguments use camelCase.

`Scope = "private" | "shared"`.
`Entry = { sampleId, projectId, creatorId, scope, name, originalFilename, media: MediaDescriptor, revision: number }`.
`Library = { entries: Entry[], revisions: Record<creatorId, number> }`.
The revision belongs to one author/scope manifest. Use `revisions[currentActorId] ?? 0` for new imports/copies, and the current listed `entry.revision` for rename/remove. Refresh after every mutation/conflict. Duplicate names are legal. Max 1000 entries per author/scope. Names are 1–128 non-control characters and cannot be whitespace-only. A command imports one file; UI batches should cap at 32 files and retain per-row success/error results.

- `examples_list({runtimeNonce,projectId,scope}) -> Library`
- `examples_import({runtimeNonce,projectId,scope,path,name,expectedRevision}) -> Entry`
- `examples_from_project({runtimeNonce,projectId,scope,mediaId,name,expectedRevision}) -> Entry`
- `examples_rename({runtimeNonce,projectId,scope,creatorId,sampleId,name,expectedRevision}) -> Entry`
- `examples_remove({runtimeNonce,projectId,scope,creatorId,sampleId,expectedRevision}) -> void`
- `examples_copy({runtimeNonce,projectId,scope,creatorId,sampleId,targetScope,expectedRevision}) -> Entry` (revision refers to destination current actor/scope)

Guests may list/read shared entries; private and all mutations require a stable active UUID. Only the creator may rename/remove; any identified reader may copy to their own record. Private files are always under the app-local data directory, including ordinary/legacy projects. Shared bytes are under `<project>/examples/<creatorId>/`. Invalid/corrupt metadata yields a clear library error; an intact record with missing/changed media fails preview with an item error. Listing never creates files.

## Preview

- `example_preview_open({runtimeNonce,projectId,scope,creatorId,sampleId,analysisSettings: AnalysisSettings,requestId?:string}) -> {previewId:string,snapshot:ProjectSnapshot}`
- `example_preview_cancel_open({runtimeNonce,projectId,requestId:string}) -> void`

UI callers supply a fresh canonical UUID `requestId` for every opening and retain it while the Promise is pending. Closing the modal before `previewId` exists calls `cancel_open` with that request ID. Cancellation is idempotent and affects only that opening; cancelling an older ID leaves newer pending openings and current playback alone. The optional field preserves older callers; omitted IDs are generated natively, so those callers can close only after receiving the preview ID. The returned DTO is unchanged.

Cancellation may arrive before the asynchronous open handler starts. Native retains up to 256 unmatched early cancellation IDs; overflow returns retryable `ResourceLimit` instead of forgetting an accepted cancellation. Once the corresponding opening starts, its cancellation ID is consumed.

The returned snapshot is an isolated transient project. Its `document.projectId` differs from the parent project; its one media descriptor and local analysis settings are valid for SpectrogramCanvas. Keep parent `projectId` in every outer IPC argument, and use snapshot project/media IDs in nested tile/playback requests. No annotations or masks exist. `snapshot.canUndo/canRedo` are false.

Every following command takes `{runtimeNonce, projectId, previewId}` (parent project binding):

- `example_preview_register_view(...) -> string` (view ID)
- `example_preview_request_tile({...binding, request:TileRequest, onEvent:Channel<TileProgress>}) -> binary ArrayBuffer` (existing tile format). Only `analysisSource:"original"`, `editSignature:""` accepted.
- `example_preview_cancel_generation({...binding,viewId,generation}) -> void`
- `example_preview_retire_view({...binding,viewId}) -> void`
- `example_preview_media_status(...) -> {mediaId:string,status:"ready"|"missing"|"changed"}[]`
- `example_preview_playback_configure({...binding, request:PlaybackRequest}) -> PlaybackStatus`. Use transient snapshot project/media IDs, `mode:{mode:"original"}`, `bypass:false`, current deviceId/volume/monitorGainDb, looping/seekSeconds/play. It uses the same output worker and `playback-progress` event as normal playback. Filter events by the transient project ID.
- `example_preview_playback_control({...binding,action:"pause"|"stop"}) -> PlaybackStatus`
- `example_preview_playback_status(...) -> PlaybackStatus` (stopped default if output belongs to the main document)
- `example_preview_close(...) -> void`

The latest accepted opening wins. Superseded/cancelled openings return `Cancelled` before replacement or output reset. Opening also captures the singleton source-acquisition revision: a newer main or preview playback configuration makes an older pending open return `Cancelled`, preserving the newer source. Stopping/closing an old preview does not invalidate a newer pending opening. `close(previewId)` closes only that completed preview, while `cancel_open(requestId)` cancels only its pending intent. Switching project/identity invalidates all pending openings and retires current views/media generations. Preview cleanup stops only its owned playback. Main document media, selection, labels, revisions, catalogs and saved settings remain unchanged. Analysis settings cannot be edited through preview IPC; reopen for different local settings. UI must discard late owner-bound responses and cancel/close on owner changes. PCM decode/FFT/playback use the existing bounded pipelines; no PCM arrays cross IPC.
