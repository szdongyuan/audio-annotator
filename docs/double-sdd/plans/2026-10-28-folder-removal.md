# Directory Tree Removal Implementation Plan

> **For agentic workers:** REQUIRED: Use the `subagent-driven-development` skill to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make zero-visible-audio directory trees removable while preserving recycled audio and all annotation data.

**Architecture:** Native atomic organization removal consults recycle state under the catalog commit lock. The existing renderer removeFolder action previews counts and confirms how recycled memberships move to the surviving parent. Persisted formats stay unchanged.

**Tech Stack:** React/TypeScript, Tauri/Rust, Vitest, Rust integration tests, Windows WebDriver.

Spec: `docs/double-sdd/specs/2026-10-28-folder-removal-design.md`. Baseline `9064ab3` with already-reviewed uncommitted indentation in MediaList.tsx/layout.css. Keep these edits. Continue on the existing user-authorized feature branch. User has previously authorized autonomous work without further spec approvals.

## Task 1 — Atomic directory removal and UI

- [x] Add failing core tests for recursive empty removal and preservation/reparenting of recycled members. Test mixed live/hidden descendants and a restored member invalidating removal.
- [x] Implement bounded subtree removal with native recycle recheck under the existing commit lock, using existing operation/schema. Preserve guards and revisions. Recycle lookup is lazy so a tree with no memberships remains removable when recycle metadata is unavailable.
- [x] Add renderer regressions for enabled/disabled conditions, count explanations, confirmation, retained draft on failure and removed-trigger focus.
- [x] Update MediaList confirmation and menu to offer this behavior; retain existing indentation and interactions.
- [x] Focused tests/typecheck and paired compliance/quality review. Core organization/recycle: 22 passed plus 1 intentionally ignored worker; native guards: 6 passed; affected renderer/menu: 175 passed; typecheck passed. Paired review passed. Local RED/GREEN evidence: `.test-output/folder-removal/`.

Ownership: core organization validation/repository, relevant native regressions, MediaList and organization UI tests. No changes to source import, decoding, DSP, author formats or real user project.

## Task 2 — Verification and patch package

- [x] Combined real Windows fixture clicks: expand, normal/hidden/trash filters, cancel/confirm removal, missing trigger focus, blocked live media, restore recycled audio into surviving parent, and keyboard navigation. Local and dedicated NAS six-check reports passed, including 0.7.5 readers. Audio and author data hashes unchanged; prior navigation/gain combination regression passed.
- [x] Run appropriate broader frontend/core/native suites and final review; preserve evidence. Frontend 786 passed, Rust workspace 406 passed / 9 ignored, harness/registration/resources 20 passed. Final full-range paired review passed.
- [x] Bump patch version to 0.7.7; build E2E separately from production. Build normal installer and complete 0.7.5/0.7.6 update payloads; verify no test hooks, 38 entries and 34 resources per ZIP.
- [x] Copy hash-verified new packages into the new NAS software directory `测试版-0.7.7`, preserving prior packages. Installer, two direct update ZIPs, notes, verification record and checksum manifest verified. No installation, user app closure, merge or GitHub Release performed.
