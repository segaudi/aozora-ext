# Chunking and Boundaries

## Why this exists

Aozora pages are inconsistent:

- Some pages use semantic paragraphs (`<p>`).
- Many pages are BR-heavy XHTML with long inline text and ruby.
- Section boundaries can be headings, divider elements, or short heading-like lines.

This module handles all three.

## Main-text container selection

Implemented in `src/content/chunks.js`:

1. Prefer known selectors:
   - `#main_text`, `.main_text`, `#honbun`, `.honbun`, `article.main_text`, `article`, `main`
2. If none suitable, fallback to largest text-heavy container (`article/main/section/div/td`) excluding likely boilerplate.

## Paragraph-like extraction strategy

`collectParagraphLikeChunks(container)`:

1. Use `<p>` candidates when available.
2. If many direct `<br>` nodes (`>= 8`), split by direct BR first.
3. Else use block candidates (`div/section/blockquote/li`) only when:
   - enough count
   - enough text coverage of container
4. Else use direct children with coverage checks.
5. Final fallback: BR splitting.
6. Last resort: whole container as one unit.

Coverage checks prevent selecting only small helper nodes (for example, one decorative `div`) and missing the real body text.

## BR splitting behavior

`splitContainerByBr(container)`:

- Splits by direct child `<br>` only.
- Trims whitespace-only text nodes around each segment.
- Combines very short fragments into neighboring segments.
- Detects heading-like segments and keeps them as boundary-start units.
- Removes direct `<br>` nodes after wrappers are created.

## Boundary detection (no crossing)

Implemented in `src/content/index.js` (`assignBoundaryIds`):

A boundary increments when any of these is true:

- Containing boundary container changed (`section/article/*chapter*/*section*`).
- A boundary marker lies between two adjacent units.
- The next unit itself starts at a marker/heading-like text.

Boundary markers include:

- `h1..h6`, `hr`
- common Aozora heading classes (`*midashi*`, `*chapter-title*`, `*section-title*`)

Heading-like line detection includes:

- `第...章/編/節/回/話`
- standalone numeric heading lines (including `1`, `2`, `3` style).

## XHTML robustness note

Aozora XHTML may expose lowercase tag names (`br`, `hr`, `div`).
Tag checks are normalized with `normalizedTagName()` to avoid case-related chunking failures.

## Timed chunking

`buildTimedChunksFromUnits(units, targetChars)`:

- Aggregates unit char counts until target is reached.
- Flushes early on boundary-ID change.
- Produces chunk metadata:
  - `startUnitIndex`, `endUnitIndex`, `elements`, `text`, `charCount`

## User interactions tied to chunking

- `Prev` / `Next` buttons.
- `ArrowUp` / `ArrowDown` keyboard navigation.
- Clicking main text jumps to the chunk containing the clicked unit.
- Changing window size (`1/5/10/30 min`) rebuilds chunks and keeps anchor near current position.
