# Aozora Reading Helper (Version A, Offline)

Chrome Extension (Manifest V3) that runs on `aozora.gr.jp` and helps beginner Japanese reading chunk-by-chunk (paragraph-like units), fully offline.

## Features

- Works on `https://www.aozora.gr.jp/*` (also `http://` variant).
- Chunk navigation: `Prev` / `Next`.
- Keyboard navigation: `ArrowUp` (prev), `ArrowDown` (next).
- Chunk window selector: `1 / 5 / 10 / 30 min` (estimated by reading-speed char budget).
- Boundary-aware chunking: does not merge across detected chapter/section boundaries.
- Click-to-jump: clicking main text jumps back to the chunk containing the clicked location.
- Panel display mode selector: `Floating` or `Side panel`.
- Side-panel personal dictionary (latest-first) for known words and known grammar.
- Mode toggle:
  - `Reading` (fewer highlights): words <= 8, grammar <= 3
  - `Study` (more highlights): words <= 15, grammar <= 6
- Vocabulary detection:
  - kuromoji tokenization (browser-side)
  - fallback regex tokenizer if kuromoji fails
  - score-based selection of likely unknown words
- Grammar detection:
  - ~20 high-value rule patterns via regex matching
- Right-side overlay panel:
  - vocab list: surface/base/reading/Chinese hint (if available)
  - grammar list: pattern + short Chinese explanation
- Highlights only inside current chunk.
- Ruby-safe behavior: no `innerHTML` rewriting of content blocks.
- Known words persistence (`chrome.storage.local`): mark known/unknown to suppress future highlights.

## Setup

1. Install dependencies:

```bash
npm install
```

2. Build extension:

```bash
npm run build
```

3. Load unpacked in Chrome:

1. Open `chrome://extensions`
2. Enable Developer mode
3. Click `Load unpacked`
4. Select `/Users/simon/repos/aozora-ext/dist`

4. Open an Aozora page, for example:
- `https://www.aozora.gr.jp/cards/000081/files/456_15050.html`

## Dev commands

- Build: `npm run build`
- Test (sanity): `npm test`
- Clean: `npm run clean`

## Manual test checklist

1. Panel appears on right side on Aozora text page.
2. `Prev` / `Next` switches chunk and scrolls chunk into view.
3. `Chunk window` selector (1/5/10/30 min) re-groups chunks by paragraph and estimated read time.
4. `Mode: Reading/Study` changes number of vocab and grammar items.
5. Chunks do not cross natural boundaries (chapter/section headings) when detected.
6. Clicking main text outside current highlight jumps to the corresponding chunk.
7. `Panel mode` switches between floating overlay and right side-panel behavior.
8. Only current chunk is highlighted.
9. Ruby/furigana layout remains intact (no text collapse or broken ruby).
10. Clicking highlighted vocab shows tooltip with reading/hint and mark buttons.
11. Clicking vocab list row scrolls to highlight and opens tooltip.
12. `Mark known` removes/suppresses that base form in re-render.
13. Reloading page preserves known words from local storage.
14. If kuromoji fails to init, fallback tokenization still yields some candidates.
15. In side-panel mode, `Personal Dictionary` lists known words/grammar in latest-added order.
16. `ArrowUp` / `ArrowDown` moves to previous/next chunk unless focus is in an input/select/textarea.

## Documentation

- `docs/README.md`: documentation index
- `docs/ARCHITECTURE.md`: module-level architecture
- `docs/CHUNKING.md`: extraction + boundary/chunk behavior
- `docs/DEVELOPMENT.md`: local build/test/dev workflow
- `docs/DEV_NOTES.md`: implementation notes and cleanup priorities
- `docs/LLM_NEXT.md`: migration plan for LLM-assisted quality improvements
