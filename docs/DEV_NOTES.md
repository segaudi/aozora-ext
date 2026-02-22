# Dev Notes

## Current quality level

This codebase is now a functional demo-grade baseline:

- core flows are stable (chunking, highlighting, panel controls, storage)
- behavior is deterministic and offline
- tests cover key scoring/chunking utilities

## Recent cleanup

- Reduced repeated known-word/known-grammar update logic in `src/content/index.js`.
- Centralized tag-name normalization for XHTML robustness (`src/shared/dom.js`).
- Added regression check for lowercase XHTML tag names.

## Practical constraints in Version A

1. Grammar matching is regex-only.
2. Vocab ranking is heuristic-only.
3. Chinese hints rely on static map coverage.
4. No sentence-level semantic disambiguation.

## Where most maintenance cost sits

- `src/content/index.js` is the largest file and holds UI + orchestration logic.
- Boundary logic depends on heterogeneous Aozora HTML conventions.
- Heuristic tuning (stopwords/scoring/grammar regex) can cause regressions if not tested.

## Suggested incremental refactors

1. Split `src/content/index.js` into:
   - `panel-ui.js`
   - `chunk-controller.js`
   - `analysis-controller.js`
2. Add unit tests for:
   - BR-splitting edge cases
   - boundary heading detection (`1`, `2`, `3`, `第X章`)
3. Add fixture-based HTML tests for known problematic Aozora pages.

## Data persistence schema

Storage keys:

- `aozoraKnownWordsV1`
- `aozoraKnownGrammarV1`

Both are latest-first arrays with timestamps (`updatedAt`) and are normalized on read.

## UX behavior decisions kept intentionally simple

- Only current chunk is highlighted.
- List click scrolls to matched highlight.
- Side panel is DOM-injected instead of Chrome sidePanel API.
- Keyboard navigation uses `ArrowUp` / `ArrowDown` unless focus is in editable controls.
