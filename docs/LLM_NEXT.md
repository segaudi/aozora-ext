# Next Step: LLM-assisted Version (Planning Notes)

This document defines a migration path from the current offline heuristic demo to an LLM-assisted reader helper.

## What should remain unchanged

- Chunk extraction and navigation model
- Ruby-safe highlighting strategy
- Known-word / known-grammar persistence model
- Side/floating panel UX shell

These parts are already good scaffolding.

## What should be replaced/improved

1. Vocabulary selection quality
   - Replace static scoring-only ranking with contextual difficulty estimation.
2. Grammar explanation quality
   - Replace regex-only match list with context-aware pattern detection and explanation.
3. Hint generation
   - Replace static `CHINESE_HINTS` lookup with generated short contextual glosses.

## Recommended integration boundary

Keep UI and chunking untouched; swap analysis providers.

Introduce an analysis interface such as:

- `analyzeChunk(chunkText, mode, knownWords, knownGrammarIds) -> { words, patterns, source }`

Current provider:

- `offlineHeuristicProvider`

Next provider:

- `llmProvider`

This allows A/B behavior without rewriting UI code.

## Reliability strategy

- Keep current heuristic provider as fallback when LLM fails or is disabled.
- Cache analysis per `chunk.id + mode + modelVersion`.
- Expose source label in panel meta (`offline` / `llm`).

## Data contract suggestions

Word item:

- `surface`
- `base`
- `reading`
- `hint`
- `confidence`
- `reason` (short explanation for why selected)

Pattern item:

- `id`
- `name`
- `explanationZh`
- `matchText`
- `confidence`

## Suggested rollout phases

1. Phase 1: optional LLM path behind flag, keep offline default.
2. Phase 2: collect qualitative feedback on vocab/grammar usefulness.
3. Phase 3: adjust prompts/schema and ranking thresholds.
4. Phase 4: make LLM default with offline fallback still available.

## Testing priorities for LLM version

- schema validation for model output
- deterministic fallback on malformed output
- latency budget and cancellation handling for rapid chunk navigation
- no highlight breakage on ruby-heavy pages
