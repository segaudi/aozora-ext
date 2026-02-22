# Development Guide

## Prerequisites

- Node.js 18+
- npm
- Chrome (for extension loading)

## Install

```bash
npm install
```

## Build

```bash
npm run build
```

Build output:

- `dist/content.js`
- `dist/styles.css`
- `dist/manifest.json`
- `dist/kuromoji.js`
- `dist/dict/*`

## Load unpacked extension

1. Open `chrome://extensions`
2. Enable Developer mode
3. Click `Load unpacked`
4. Select `/Users/simon/repos/aozora-ext/dist`

## Test

```bash
npm test
```

Current tests cover:

- grammar pattern detection sanity
- vocab scoring sanity
- timed chunk grouping behavior
- boundary-aware chunking behavior
- XHTML tag-name normalization helper behavior

## Typical edit loop

1. Edit source under `src/`
2. Run `npm run build`
3. In Chrome extensions page, click reload on the unpacked extension
4. Refresh the Aozora page
5. Verify panel/chunk behavior and console warnings

## Debugging tips

- Open page DevTools and filter logs by `[Aozora Helper]`.
- For structured extension-level logs (content + background), open extension options (`debug.html`) and enable debug logging.
- Check panel meta line for:
  - chunk index/total
  - window size
  - tokenizer source (`kuromoji` vs `fallback`)
- If tokenization falls back unexpectedly, ensure `dist/dict/` exists.

## Clean build artifacts

```bash
npm run clean
```
