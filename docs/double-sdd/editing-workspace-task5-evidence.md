# Task 5 implementation evidence

Date: 2026-10-27. Worktree: `D:/Work/annotator/.worktrees/media-folders`, branch `media-folders`.
Immutable TaskBase: `742ff29575f0106142213fda7ea980f248104783`.
Raw logs: `D:/Work/annotator/.test-output/media-folders/task5-*.log`.

## Scope and contracts

- Required ordered `categoryIds: string[]` for files and annotations, `channelCategoryIds: string[][]` with exactly one array per channel. Empty sets are unclassified. Canonical author-local UUID references, duplicates, null/missing fields, unknown fields, channel counts and max 64 labels are validated.
- Atomic `setMediaCategories` / `setChannelCategories`; annotation changes carry the complete set. Rejected changes preserve the document and history. Removing a category retains every other ID and all notes; one undo/redo restores/reapplies the complete removal.
- Current outer versions: ProjectDocument3, collaboration5, authorLayer2, privateWorkspace2, exchange4. Organization1/catalog2 and author/profile/status envelopes retain their versions. DSP algorithm/edit processing remain1 for this intermediate checkpoint; Task6 owns their upgrade.
- Publication/foreign layers stay author-isolated and whitelist-only. Shared export excludes private edits/settings; SaveAs retains personal DSP and all label arrays. JSON/ZIP imports retain UUID rules, Unicode folders and accepted label order, and leave original source/export bytes unchanged.
- Minimal frontend adaptation renders every label, filters any matching label and counts objects once. Shared label text/color helpers preserve accepted name order and use category-definition order for color. Interim choice controls append to the latest queued label set; explicit unclassified clears it. Full keep-open checkbox/selection/gain UX remains Task7.
- `document-v1.json` and `document-v2.json` stay unchanged as retired rejection fixtures. Current consumers use new `document-v3.json`. No migrations, version metadata, desktop harness or release artifacts changed.

## TDD evidence

1. `cargo test -p annotator-core --test document`: `task5-document-red.log`, 13 passed / 1 intended failure: Project3 multilabel document rejected with UnsupportedVersion. After models/commands/validators/schema implementation, `task5-document-green.log`, 14 passed. Additional exact64/distinct65th, immutable v1/v2, strict DTO and atomic rejection cases produce document15 in final checks.
2. `cargo test -p annotator-core --test collaboration_workspace multilabel_private_roundtrip`: `task5-collaboration-red.log`, 1 intended failure reopening privateWorkspace2 through the old decoder. Decoder dispatch fixed; `task5-collaboration-green.log`, 1 passed. Expanded test verifies all scopes, private reopen, publication/read, foreign category isolation, old authorLayer1 rejection, whitelist and SaveAs.
3. `cargo test -p annotator-core --test exchange multilabel_exchange4_boundary`: `task5-exchange-red.log`, 1 intended failure: direct projection accepted a retired exchange3 envelope. Added the strict projection version gate; `task5-exchange-green.log`, 1 passed, including Unicode-tree JSON/ZIP roundtrips and original-byte invariance.
4. `npm.cmd test -- --maxWorkers=2 src/bridge/contracts.test.ts`: `task5-bridge-red.log`, 7 passed / 1 intended failure accepting the new DTO. After strict TS models/parsers, focused bridge/collaboration/render/preservation checks passed43 (`task5-bridge-ui-green.log`).
5. `npm.cmd test -- --maxWorkers=2 src/features/annotations/classification.test.tsx src/features/collaboration/remote.test.tsx`: `task5-render-preservation-red.log` reproduces loss of the second accepted tag and foreign multiple-label display failure. Array-aware queued merges and shared rendering helpers pass in `task5-bridge-ui-green.log`.
6. Deletion copy regression: `task5-delete-copy-red.log`, 17 passed / 1 failure because confirmation falsely claimed every affected object becomes unclassified. Corrected copy to describe removal of only this label and preservation of other labels/notes; `task5-delete-copy-green.log`, 28 passed across the focused category/annotation/selection suites.
7. Local refactor: shared label text/color/addition helpers; Rust formatting. Final checks below cover the resulting code.

## Validation

- Affected Rust (`cargo test -p annotator-core --test document --test collaboration_workspace --test collaboration_repository --test exchange --test persistence`): 93 passed, 1 ignored, zero failures; `task5-affected-green.log`, exit0.
- `cargo test --workspace`: 345 passed, 5 ignored, zero failures across 26 result summaries; `task5-workspace.log`, exit0. This includes native default-feature82; the independent e2e-feature run below is reported separately, not added to this total.
- `cargo test -p annotator-desktop --features e2e --lib`: 83 passed, zero failures/ignored; `task5-native-e2e.log`, exit0.
- `cargo fmt --all -- --check`: `task5-fmt-check.log`, exit0.
- `cargo clippy --workspace --all-targets -- -D warnings`: `task5-clippy.log`, exit0.
- `npm.cmd test -- --maxWorkers=2`: 509 passed across62 files, zero failures; `task5-frontend.log`, exit0.
- `npm.cmd run typecheck`: `task5-typecheck.log`, exit0.
- `npm.cmd run build`: `task5-build.log`, exit0; 2083 modules, production frontend build successful. Existing Vite >500kB chunk advisory remains; no unrelated bundling refactor.
- Final native/Rust checks, frontend checks and builds ran sequentially. Existing catalog stress test completed in123.59s; no ignored cases were enabled or removed to obtain the result.
- Earlier full failures are retained in `task5-workspace-attempt1.log`, `task5-workspace-attempt2.log`, `task5-workspace-attempt3.log` and `task5-frontend-attempt1.log`; all substantive RED logs above remain separate from final GREEN logs.

## Observed corrections and limits

- Compile attempts exposed ordinary fixture adaptations for Option-to-Vec changes; full-suite attempts exposed stale current/retired version values and a malformed scalar where the prior dangling-reference assertion required an array. Updated those targeted fixtures while preserving the original rejection behavior and expected error codes.
- The SaveAs assertion explicitly accounts for the pre-existing relative-to-absolute source rebasing; all other document fields must match exactly.
- Native tests with `--features e2e` are native unit/integration evidence, not WebView acceptance. Actual desktop workflows, fixture/harness updates and the final DSP2/release acceptance belong to later approved tasks.
- No plan scope deviation. Full-suite fixture corrections include the literal current collaboration format in organization/UUID-author assertions, scalar-to-array expectations, and six-channel empty-set fixtures; retired1–4 collaboration versions remain rejected without writes.
- Shared node_modules/target junctions still point to the main cache directories and were not removed or relinked. No deployment, push, permanent integration or release build performed.
- Implementation and planned checks are complete. Fresh paired reviews over the immutable TaskBase through the temporary Task5 checkpoint are pending; Task6 has not started.
