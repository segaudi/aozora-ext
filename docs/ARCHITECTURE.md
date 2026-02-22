# Architecture

## Goal

`Aozora Reading Helper (Version A)` is a Manifest V3 content-script extension for Aozora pages with offline-first chunk-based reading/study and an optional LLM JSON highlight mode.

## Runtime Flow

1. Content script boots on `aozora.gr.jp`.
2. Main text container is selected (`.main_text`, `#main_text`, etc., with fallback to largest text-heavy container).
3. Paragraph-like units are extracted:
   - Prefer `<p>` blocks when present.
   - For BR-heavy pages, split by direct `<br>` boundaries.
   - Fallback to suitable block children with coverage checks.
4. Boundary IDs are assigned so chunks do not cross chapter/section boundaries.
5. Timed chunks are built from unit character counts (`1/5/10/30 min` windows).
6. Current chunk is analyzed:
   - Tokenization (`kuromoji` preferred, fallback regex).
   - Vocabulary scoring and top-K selection by mode.
   - Grammar pattern matching and top-K selection by mode.
7. Highlights are applied only inside current chunk.
8. Side/floating panel is rendered with controls, vocab/grammar lists, and personal dictionary.
9. User actions update local known-word/known-grammar storage and trigger rerender.

## Modules

- `src/content/index.js`
  - App orchestration: state, UI, events, rendering pipeline, chunk navigation.
- `src/content/chunks.js`
  - Main container detection, paragraph-like extraction, BR splitting, timed chunk builder.
- `src/content/tokenizer.js`
  - `kuromoji` initialization and fallback tokenization switching.
- `src/content/highlighter.js`
  - DOM-range highlighting and cleanup, ruby-safe behavior.
- `src/content/storage.js`
  - Known word/grammar persistence (`chrome.storage.local`, localStorage fallback).
- `src/shared/scoring.js`
  - Token filtering and scoring logic for likely unknown vocabulary.
- `src/shared/grammar.js`
  - Rule-based grammar pattern matching.
- `src/shared/stopwords.js`
  - Function-word noise reduction list.
- `src/shared/hints.js`
  - Optional Chinese hints map.
- `scripts/build.mjs`
  - Bundling and asset copy to `dist/`.

## State Model (content script)

Key in-memory state in `src/content/index.js`:

- `paragraphUnits`: extracted base units from page.
- `chunks`: grouped timed chunks.
- `currentIndex`: active chunk index.
- `mode`: `A` (Reading) or `B` (Study).
- `durationMinutes`: chunk window size.
- `displayMode`: `floating` or `side`.
- `knownWords`, `knownGrammarIds`: suppression sets.
- `knownWordEntries`, `knownGrammarEntries`: latest-first dictionary lists.
- `tokenCache`: tokenizer output cache (`tokens`, `source`).
- `llmChunkCache` / `llmRuntimeCache`: persisted + in-memory LLM analysis caches.

## Non-goals in Version A

- No backend service.
- No automatic page-wide rewriting.
- No mandatory online dependency (offline heuristic mode remains available).
