# UUID identities — Task 3 frontend evidence

Task base: `9aceafe72910959468015519213346979bc14075`. This checkpoint contains only the frontend bridge, application identity UI/controller and focused project lifecycle extension. Task 2 native IPC evidence remains authoritative. No native code, version metadata, desktop suite, release artifacts, NAS data or dependency junctions were changed. Parent-agent paired reviews are pending.

## Implementation

`src/bridge/profiles.ts` implements the six native `profile_*` commands with explicit nullable project expectations and the exact `ProfileSnapshot`/`ProfileResponse` envelopes. `profileMetadata.ts` supplies the shared three-field profile/author identity validator without a circular collaboration/profile dependency. Collaboration capabilities now accept only `ordinary | profile | viewOnly` and `ordinary | default`; `collaboration_create` sends no credentials. Retired identity/login/logout/guest-publication methods and forms are removed.

Nickname validation counts Unicode scalar values, checks UTF-8 bytes, rejects C0/C1 controls before trimming, and uses Unicode White_Space rather than JavaScript's different FEFF trim behavior. Timestamp validation mirrors the installed chrono RFC3339 parser: uppercase Z, four-digit calendar-valid year/date, T/t/space separator, arbitrary fractional precision, and seconds up to 60. Tests cover a valid exactly 4096-byte native portable profile with long fractional leap seconds, malformed dates, and 64 supplementary-plane nickname characters.

Profile metadata is bounded separately from the full annotation transition/status. The 1 MiB store budget is measured with the native store envelope, so a valid maximal store remains accepted when IPC adds runtime/project fields. Profiles are checked and counted individually before aggregating metadata. Full project documents and status layers continue through existing validators; a response containing an annotation note above 1 MiB is accepted. Warning details reuse the existing bounded collaboration error parser, rejecting cyclic/oversized metadata without stringifying the whole response.

`features/identity/IdentityController` owns application-level snapshots, selected UUID, dialog/result/warning state, single-flight cancellation and stale-list generations independently of `CollaborationController`. `useIdentity` loads the native persisted default on startup, including React StrictMode; no fallback UUID or browser identity storage exists. List refresh takes the native process-selected UUID exactly, never the last-selected preference of another process.

The existing compact collaboration menu now exposes create, switch, rename, import and export with no open project. It shows the global nickname while project sync/author actions remain gated. A focused dialog shows duplicate nicknames with short UUIDs and read-only full UUID/copy controls. Create-and-use calls create then explicit select with a fresh snapshot between them; a failed selection leaves the created profile available with the old selected UUID. Import never selects; duplicate import reports retention of local metadata and offers an explicit Use button. Export uses `identity-<canonical UUID>.json`, never nickname-derived paths. Idle dialogs support Escape/outside dismissal and focus return; active operations expose explicit cancellation. Existing project status/conflict/copy UI remains.

## Lifecycle and commit acknowledgement

`useProjectLifecycle.performIdentity` shares the existing occupied/deferred-close admission and refresh suspension with new/open/exchange/collaboration operations. It accepts a nullable owner, so a projectless profile operation also serializes against new/open. Selection/create-and-use drain drafts and save via `transitionAfterSave`; metadata-only mutations drain under the existing transition barrier. Native publication, retained media/source preview/release and recovery checks remain authoritative. The existing import acknowledgement and source recovery UI/tests remain intact.

Every mutation obtains `profile_list` inside the barrier, after draft/save completion, and checks current owner, cancellation, project ID/current revision and shared runtime nonce. It does not reuse startup project revisions. Create persists before invoking select; cancellation between creation and use preserves the created profile and skips select. A successful native selection result is committed: it is adopted before deferred close even if cancellation arrived after commit. Same UUID is an immediate true no-op, preserving drafts/history/selection/private preferences and avoiding save/native selection. Ordinary/view-only responses do not replace or promote the project actor/editor. Partial rename warnings retain the committed snapshot and apply status metadata without replacing the owner/history.

## Verification and TDD evidence

Raw logs are in `D:/Work/annotator/.test-output/uuid-identities`.

- Initial profile/controller/dialog RED runs failed because their new modules were absent: `ui-bridge-red.log`, `ui-controller-red.log`, `ui-dialog-red.log`.
- Nullable identity lifecycle RED reproduced missing `performIdentity`; the same early run also exposed old backend-incompatible fixtures: `ui-lifecycle-red.log`. The existing fixtures were adapted to format-3 profile capabilities and three-field authors while retaining annotation, payload-size, playback, copy/exchange, media import and private-state assertions.
- Focused GREEN after implementation: 67 tests across 10 files, `ui-focused-green.log`. The intermediate controller run had one test using a nonexistent error-code name; it was corrected to native `InvalidInput`, retaining the failure/state assertions.
- Warning metadata RED accepted cyclic/oversized details; reuse of bounded error validation passes: `ui-warning-bounds-red.log` / `ui-warning-bounds-green.log`.
- Native maximal-store RED rejected a valid 1 MiB store because IPC overhead was counted against its file budget; native-envelope accounting passes: `ui-metadata-envelope-red.log` / `ui-metadata-envelope-green.log`.
- Import result UI RED incorrectly claimed selection was unchanged after explicit Use; corrected feedback passes: `ui-import-feedback-red.log` / `ui-import-feedback-green.log`.
- Supplemental controller/UI/hook regressions cover cancellation during fresh-list/picker awaits, replaced owners and late list responses, failed select retaining creation, no import autoselect, duplicate UUIDs/nicknames, hard resource limits, partial rename warnings, fresh revision after draft/save, late committed cancel, deferred close, same UUID, ordinary/view-only private-state retention, failed save/publication, and StrictMode native startup. The hook tests were added after the shared implementation as additional coverage rather than claiming an individual RED for every integration assertion (`ui-integration-initial.log`, `ui-identity-extended.log`). This is a minor test sequencing deviation from strict per-behavior RED.

Final checks on the final product source:

| Command | Observed result | Raw log |
| --- | --- | --- |
| `npm.cmd test -- --maxWorkers=2` | Exit 0; 56 files, 450 tests passed | `ui-tests-final.log` |
| `npm.cmd run typecheck` | Exit 0 | `ui-typecheck-final.log` |
| `npm.cmd run build` | Exit 0; production Vite build completed | `ui-build.log` |
| `git diff --check` | Exit 0 | `ui-diff-check.log` |

Build reports the standard >500 kB chunk-size advisory (main bundle and third-party notices); no bundling change is included. Earlier passing broad run (436 tests before supplemental tests) is preserved as `ui-tests-initial.log`. Final test totals include 24 new identity controller/dialog/hook tests and 7 profile bridge tests; existing shared lifecycle adds two nullable/fresh-admission checks. Actual Tauri/WebView UI and production delivery remain Task 4 and are not claimed here. No main integration, push or cleanup was performed.


## Spec-review repair: expose partial rename cause

Repair base: `f6d2f2e277b64cc113104f42cc3d8b68eb3ac4f9`; the original full Task 3 review base remains `9aceafe72910959468015519213346979bc14075`.

The spec review found that the UI rendered the committed-local-rename warning but omitted the native `warning.details.cause.message`. The dialog now displays that reason alongside the warning while retaining the successful local metadata feedback. It narrows the optional details object and validates the nested native AppError through the existing bounded collaboration error parser. Absent, null, non-object, malformed, unknown-code and oversized optional causes leave the original warning usable. React renders only the validated message as text; no raw details object is dumped. Controller, native status refresh, project ownership and history code are unchanged.

- RED: the UI regression passes the actual native nested warning shape through `parseProfileResponse` and confirms that the cause message was missing; one failed, 12 passed (`ui-rename-cause-red.log`).
- GREEN: identity controller/dialog/lifecycle and profile bridge suites pass, 39 tests across four files (`ui-rename-cause-green.log`). The regression also asserts retained local-success text, unchanged profile snapshot and no controller error. Eight optional-cause cases exercise safe omission.
- `npm.cmd test -- --maxWorkers=2`: exit 0, 56 files / 458 tests (`ui-rename-cause-full.log`).
- `npm.cmd run typecheck`: exit 0 (`ui-rename-cause-typecheck.log`).
- `npm.cmd run build`: exit 0, with the same chunk-size advisory (`ui-rename-cause-build.log`).
- `git diff --check`: exit 0 (`ui-rename-cause-diff-check.log`).

This repair follows RED/GREEN sequencing without an additional deviation. No other task scope is changed. Fresh paired Task 3 reviews remain the parent-agent gate.
Parent completion: fresh spec and quality reviews PASS at 6de9c4d54cf821aa5cd8080f8a778ebe13b8783e over original Task 3 base. Root independently ran 31 focused bridge/identity tests before the warning-only repair; all passed (root-ui-focused.log). Task 4 remains pending.
