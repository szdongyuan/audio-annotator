# Remove exhausted directory trees without deleting audio

The user repeatedly reports a disabled “delete empty folder” action on a branch showing zero visible audio. Read-only inspection confirms that the branch still contains nested directories and recycled audio. The existing leaf-only rule cannot satisfy the requested cleanup.

## Behavior

- Allow removing an entire directory subtree when it contains no media memberships, or when every associated media item is already in the shared recycle bin.
- Remove only directory metadata. Move memberships of already-recycled audio to the removed root's surviving parent, or project root when there is no parent. Preserve original filenames, UUIDs, catalog records, audio bytes, author annotations/notes, private settings and recycle contents. Restoring these audio items then places them in that surviving directory.
- Any associated audio not in shared recycle blocks removal, including hidden, filtered-out and unadopted media. Display meaningful reason/counts. Unknown/unavailable recycle state must not authorize removal of associated audio.
- Confirmation explains subtree removal and, when applicable, how many recycled items retain their data and move to the parent. No physical filesystem folder or audio deletion occurs.
- Native repository rechecks current organization revision and current recycle membership under the existing catalog commit lock; the renderer is not an authority for recycled IDs. Concurrent restore or import must cause safe rejection, cancellation/stale owner guards remain, and failure preserves the dialog/draft.
- Menus, selected folders and focus must recover safely when the whole subtree disappears. Existing compact indentation changes remain included.

## Compatibility / Migration

Backward compatibility: required. All persisted formats remain unchanged. Reuse existing removeFolder operation and valid organization membership fields; older applications can read the resulting project. No migration, destructive merge, physical deletion or automatic edit of the user's real project. The user performs removal through the new confirmation action.

ZIP identity and import admission changes remain paused. Delivery is a Windows patch test installer/update on the previously requested NAS software location; include earlier tree indentation and 0.7.6 fixes. Do not install or close the user's running application, merge PRs or publish a GitHub Release automatically.

## Verification

RED/GREEN native and renderer regressions cover deep empty trees, all-recycled trees, mixed live/recycled/hidden descendants, unknown membership, parent/root reattachment, stale organization and recycle restore immediately before mutation, cancellation and guard failure, preserved audio/catalog/author layers/recycle, and focus after removal. Real Windows combined clicks on an owned fixture must exercise confirmation/cancel/remove, list filtering, keyboard navigation and recycled audio restoration to the parent. Real NAS project remains read-only. Run focused tests, appropriate broader suites, typecheck/build and paired review before delivery.
