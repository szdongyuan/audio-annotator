# Audio Tree Indentation Implementation Plan

> **For agentic workers:** REQUIRED: Use the `subagent-driven-development` skill to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make file rows visibly subordinate to their containing folder.

**Architecture:** Apply a single depth model to existing nested tree containers; retain compact list rows and interactions.

**Tech Stack:** React, CSS, browser geometry verification.

Spec: `docs/double-sdd/specs/2026-10-28-media-tree-indent-design.md`. Baseline `9064ab3`, existing authorized feature branch. User deferred all import fixes and packaging.

- [x] Inspect MediaList and layout CSS to establish conflicting depth offsets.
- [x] Apply the smallest consistent indentation fix in MediaList.tsx/layout.css only, preserving interaction semantics.
- [x] Verify existing focused media tree tests/typecheck and actual nested rendered geometry in normal/batch mode. Three focused suites / 53 tests and typecheck pass. Actual Edge geometry verified at 190px and 232px widths, normal/batch, three nested levels; root placement and 28px rows unchanged. Evidence is retained locally in `.test-output/tree-indent/`.
- [x] Paired spec and quality review passed. Import code, versions and packages are unchanged. Changes remain on the existing branch without a new release.
