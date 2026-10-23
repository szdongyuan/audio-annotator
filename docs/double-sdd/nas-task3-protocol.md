# Task 3 native collaboration protocol (format 1)

Task 4 must parse these native shapes strictly. Ordinary `ProjectSnapshot` is unchanged. Ordinary `OpenProject` is also unchanged: `{snapshot, path, persistedRevision, recovery}`. A shared `OpenProject` adds **only** `collaboration: {runtimeNonce, actor, preferences}`. This context and its snapshot/recovery are captured atomically while holding project authority. `actor` is `AuthorIdentity | null`; `preferences` is `PlaybackPreferences | null` (present for an active shared workspace, including recovery preview). `snapshot` remains null until the existing recovery choice succeeds.

Create an immutable command adapter for each adopted ActiveProject. Capture its returned `runtimeNonce` in that adapter. Never bind an older snapshot to a nonce obtained from a later global status request, and never let an old closure read a new actor's nonce from global state. Project IDs and revision numbers can be equal across actors. Native nonce changes on project open/create/close, save-as, exchange adoption, identity adoption, recovery resolution and explicit shared-version load. Guest-copy keeps the current nonce/history and adds one undoable personal change.

All new DTO input objects deny unknown fields. Credentials are transient request values; they never appear in snapshots, cache envelopes, status or responses. There is no renderer author-ID authority argument.

## Common types

`Expected = {runtimeNonce: string, projectId: string, expectedRevision: number}`. Identity/create/guest-copy/load-shared require the current revision to be saved locally. Preferences and refresh require current project/revision/nonce. Refresh permits newer local edits after admission and does not replace the document on completion.

`PlaybackPreferences = {volume: number, deviceId: string|null, loopEnabled: boolean, source: "original"|"processed"}`; defaults are 0.75/null/false/processed. Preferences belong to the native private workspace; persist them with the explicit preference command. Switching identity resets native playback/resources and returns the new identity's preferences; ephemeral UI selection/playback intentions must also reset through the lifecycle barrier.

`AuthorIdentity = {authorId, normalizedLogin, displayName, createdAt}` (all strings). Remote layers use the strict Task 1 public `CollaborationSnapshot` schema, with `{projectId, authors: [{identity, layer: AuthorLayer|null, error: AppError|null}]}`. Categories and IDs resolve within each author's payload. Never merge this into editable `document` or selection/history tables. The snapshot includes the current actor's published layer; exclude that author from foreign overlays and display the live personal document for the current actor, avoiding stale duplicated own annotations.

`Status = {formatVersion: 1, runtimeNonce: string, projectId: string|null, shared: boolean, actor: AuthorIdentity|null, preferences: PlaybackPreferences|null, pending: boolean, recoveryRequired: boolean, busy: boolean, lastSuccessMs: number|null, error: AppError|null, snapshot: CollaborationSnapshot|null}`. `pending` is network pending for authenticated actors; guest annotations are local-only and do not set it. `lastSuccessMs` is Unix milliseconds for a completed repository read. Author-specific failures are in `snapshot.authors[].error`; a top-level error does not erase the last verified layers. `error.code === "RevisionConflict"` uses the existing AppError code serialization (the source enum remains authoritative). Pending means local-save success is distinct from shared publication.

`Transition = {opened: OpenProject, status: Status}`. Both correspond to the same adopted runtime. For guest-copy, accept the personal snapshot as one local change without treating it as an identity switch; its pending publication requires the normal local save.

## Commands

| Command | Input | Result |
| --- | --- | --- |
| `collaboration_status` | none | `Status`, including ordinary/closed state for discovery |
| `collaboration_refresh`, `collaboration_sync` | `{expected}` | `Status`; captures durable pending, attempts publication, then reads fresh layers; overlaps skip work and return current checked status |
| `collaboration_identity` | `{expected, operationId, action}` | `Transition`; action is `{type:"register",login,displayName,password}`, `{type:"login",login,password}` or `{type:"logout"}` |
| `collaboration_create` | `{expected, operationId, target, credentials:{login,displayName,password}, onProgress:Channel}` | `Transition`; target must exist and be empty, source ordinary and locally saved |
| `collaboration_cancel` | `{operationId}` | void; marks only that active identity/copy/layer operation cancelled; no lock stealing or detached replacement worker |
| `collaboration_preferences` | `{expected, preferences}` | `Status`; local persistence only |
| `collaboration_publish_guest` | `{expected, operationId}` | `Transition`; native opens the guest cache and copies its own annotations; no payload argument |
| `collaboration_load_shared` | `{expected, operationId}` | `Transition`; explicit discard-pending/history action; new nonce, new own session, preserved private settings |

Create progress Channel messages are `{operationId, phase, completed}`. Progress is throttled; phases include native decoding phases, `copyMedia` and `publishManifest`. The invoke promise is the terminal result. Keep operationId available while a form submits; cancel before abandoning the operation. Registration may have committed its immutable account before cancellation, but a cancelled operation cannot adopt that identity later. A cancellation cannot interrupt an OS I/O call; the bounded worker slot stays occupied until its worker actually exits. Busy identity/copy operations return `ResourceLimit`; no queue is created. Closing retires the runtime immediately. Poll again after the active worker completes.

Refresh is not a local save. The manual sync button must first commit drafts and save, then invoke sync with the resulting revision. `save_project` returns the durable local revision and schedules one background publication attempt. The future frontend two-second poll drives retries; native has no autonomous timer. A sync error does not prevent a fresh repository read. Unexpected own divergence yields an explicit conflict without replacing live content; only `collaboration_load_shared` installs remote own content. Publication acknowledgement updates only private checkpoint metadata; a later unsaved C remains in the active session while saved B remains in the envelope.

## Existing command adapters in shared mode

These existing commands accept an optional **top-level** `runtimeNonce`. It is mandatory for shared projects and must be the adapter's captured nonce; ordinary calls may omit it:

- `get_project_snapshot`, `apply_change`, `undo`, `redo`, `save_project`, `save_project_as`, `close_project`, `resolve_recovery`.
- `import_media`, `relink_media`, `media_status`, `scan_folder`. Shared import and scan are rejected before jobs begin; existing media task generations also reject stale commit/relink results. Cancel/release operations retain their task-token authority.
- `playback_configure`, `playback_control`, `playback_status`. The nonce is a sibling of `request` or `action`, not a field inside PlaybackRequest. Configure checks both admission and publication, including a request that was delayed until after another actor was adopted. Device enumeration stays unowned.
- `request_tile`, `register_analysis_view`, `retire_analysis_view`, `cancel_generation`. The nonce is a sibling of the existing request/fields. Existing view leases/generations still protect admitted work; the nonce prevents an old actor's delayed registration from acquiring a new current lease.

Exchange `export_annotations`, `export_bundle`, `import_exchange` retain their existing shapes but their nested `expected` accepts optional `runtimeNonce`, mandatory for an active shared project. Shared exports sanitize the personal document. Validated private source mappings exist only in the native bundle byte-read capture; PortableMedia never serializes them. Ordinary export preserves its full existing fields. Shared Save As creates an ordinary personal document and returns ordinary OpenProject without collaboration context.

`open_project` accepts a valid collaboration.json or its root and opens guest. Unknown JSON and shared subdirectories are rejected before ordinary FileStore can create a lock. Ordinary project/recovery/backup admission is read-only first, including a missing project.json with a valid recovery envelope. Production local cache root comes from Tauri `app_local_data_dir`; `ANNOTATOR_E2E_LOCAL_DATA` exists only in an e2e build, and unit tests inject local roots directly.

Playback progress events retain their existing generation contract. Each UI subscription must also belong to its captured ActiveProject; identity transitions reset native playback generation and cancel prior work, and the frontend must retire old listeners/intents. No new collaboration UI is implemented in Task 3.
