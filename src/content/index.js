import { buildTimedChunksFromUnits, extractReadableChunks } from "./chunks.js";
import { tokenizeChunkText } from "./tokenizer.js";
import { getKnownGrammarEntries, getKnownWordEntries, setGrammarKnown, setWordKnown } from "./storage.js";
import { clearHighlights, flashElement, highlightLiteral } from "./highlighter.js";
import { STOPWORDS } from "../shared/stopwords.js";
import { CHINESE_HINTS } from "../shared/hints.js";
import { detectGrammarPatterns } from "../shared/grammar.js";
import { scoreVocabularyTokens } from "../shared/scoring.js";
import { normalizedTagName } from "../shared/dom.js";

const MODE_LIMITS = {
  A: { words: 8, patterns: 3, label: "Reading" },
  B: { words: 15, patterns: 6, label: "Study" }
};

const DURATION_OPTIONS = [1, 5, 10, 30];
const ESTIMATED_CHARS_PER_MINUTE = 180;
const DISPLAY_MODES = ["floating", "side"];
const BOUNDARY_CONTAINER_SELECTOR =
  "section,article,[class*='chapter'],[id*='chapter'],[class*='section'],[id*='section']";
const BOUNDARY_MARKER_SELECTOR =
  "h1,h2,h3,h4,h5,h6,hr,.dai-midashi,.naka-midashi,.o-midashi,[class*='midashi'],[class*='chapter-title'],[class*='section-title']";
const HEADING_PREFIX_RE = /^(第[一二三四五六七八九十百千〇零0-9０-９]+[章編節回話]|[一二三四五六七八九十百千〇零0-9０-９]+(?:[、，.．]|$))/u;

const state = {
  paragraphUnits: [],
  chunks: [],
  currentIndex: 0,
  mode: "A",
  durationMinutes: 1,
  displayMode: "floating",
  knownWords: new Set(),
  knownWordEntries: [],
  knownGrammarIds: new Set(),
  knownGrammarEntries: [],
  cache: new Map(),
  renderToken: 0,
  panel: null,
  tooltip: null,
  ui: null,
  currentWords: [],
  currentPatterns: []
};

function createPanel() {
  const panel = document.createElement("div");
  panel.setAttribute("data-aozora-panel", "1");
  panel.className = "aozora-panel";
  panel.setAttribute("data-display-mode", state.displayMode);

  const durationOptions = DURATION_OPTIONS
    .map((minutes) => `<option value="${minutes}"${minutes === state.durationMinutes ? " selected" : ""}>${minutes} min</option>`)
    .join("");
  const displayModeOptions = DISPLAY_MODES
    .map((mode) => {
      const label = mode === "side" ? "Side panel" : "Floating";
      return `<option value="${mode}"${mode === state.displayMode ? " selected" : ""}>${label}</option>`;
    })
    .join("");

  panel.innerHTML = `
    <div class="aozora-panel-header">
      <div class="aozora-title">Aozora Helper</div>
      <div class="aozora-subtitle">Offline / Chunk-based</div>
    </div>
    <div class="aozora-controls">
      <button type="button" data-action="prev">Prev</button>
      <button type="button" data-action="next">Next</button>
      <button type="button" data-action="toggle-mode" class="aozora-span-2">Mode: Reading</button>
      <label class="aozora-duration-wrap aozora-span-2">
        <span>Chunk window</span>
        <select data-action="duration">${durationOptions}</select>
      </label>
      <label class="aozora-duration-wrap aozora-span-2">
        <span>Panel mode</span>
        <select data-action="display-mode">${displayModeOptions}</select>
      </label>
    </div>
    <div class="aozora-meta" data-role="meta"></div>
    <div class="aozora-section">
      <div class="aozora-section-title">Vocabulary</div>
      <div class="aozora-list" data-role="vocab-list"></div>
    </div>
    <div class="aozora-section">
      <div class="aozora-section-title">Grammar</div>
      <div class="aozora-list" data-role="pattern-list"></div>
    </div>
    <div class="aozora-section aozora-personal-dictionary">
      <div class="aozora-section-title">Personal Dictionary</div>
      <div class="aozora-dictionary-subtitle">Known Words (latest)</div>
      <div class="aozora-list aozora-compact-list" data-role="known-words-list"></div>
      <div class="aozora-dictionary-subtitle">Known Grammar (latest)</div>
      <div class="aozora-list aozora-compact-list" data-role="known-grammar-list"></div>
    </div>
  `;

  document.body.appendChild(panel);
  return panel;
}

function createTooltip() {
  const tooltip = document.createElement("div");
  tooltip.setAttribute("data-aozora-tooltip", "1");
  tooltip.className = "aozora-tooltip aozora-hidden";
  document.body.appendChild(tooltip);
  return tooltip;
}

function getCurrentChunk() {
  return state.chunks[state.currentIndex] || null;
}

function findChunkIndexByUnit(unitIndex) {
  return state.chunks.findIndex((chunk) => unitIndex >= chunk.startUnitIndex && unitIndex <= chunk.endUnitIndex);
}

function findBoundaryContainer(el, root) {
  let node = el;
  while (node && node !== root) {
    if (node.matches && node.matches(BOUNDARY_CONTAINER_SELECTOR)) {
      return node;
    }
    node = node.parentElement;
  }
  return root;
}

function isBoundaryMarkerElement(el) {
  return Boolean(el?.matches?.(BOUNDARY_MARKER_SELECTOR));
}

function isUnitBoundaryStart(unitEl) {
  if (!unitEl) {
    return false;
  }
  if (isBoundaryMarkerElement(unitEl)) {
    return true;
  }

  const markerDescendant = unitEl.querySelector(BOUNDARY_MARKER_SELECTOR);
  if (markerDescendant) {
    const walker = document.createTreeWalker(unitEl, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      if (node.nodeType === Node.TEXT_NODE) {
        if ((node.nodeValue || "").trim()) {
          break;
        }
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const element = node;
        if (normalizedTagName(element) !== "BR") {
          return element === markerDescendant || element.contains(markerDescendant);
        }
      }
      node = walker.nextNode();
    }
  }

  const leadingText = (unitEl.textContent || "").replace(/\s+/g, "").slice(0, 20);
  return HEADING_PREFIX_RE.test(leadingText);
}

function isBetween(prevEl, markerEl, nextEl) {
  const prevToMarker = prevEl.compareDocumentPosition(markerEl);
  const markerToNext = markerEl.compareDocumentPosition(nextEl);
  return Boolean(
    prevToMarker & Node.DOCUMENT_POSITION_FOLLOWING &&
    markerToNext & Node.DOCUMENT_POSITION_FOLLOWING
  );
}

function assignBoundaryIds(units, root) {
  if (!units.length) {
    return;
  }

  const markers = [...root.querySelectorAll(BOUNDARY_MARKER_SELECTOR)];
  let boundaryId = 0;
  units[0].boundaryId = boundaryId;

  for (let i = 1; i < units.length; i += 1) {
    const prevUnit = units[i - 1];
    const currentUnit = units[i];

    const prevContainer = findBoundaryContainer(prevUnit.element, root);
    const currentContainer = findBoundaryContainer(currentUnit.element, root);
    const containerChanged = prevContainer !== currentContainer;

    const hasMarkerBetween = markers.some((marker) => {
      if (marker === prevUnit.element || marker === currentUnit.element) {
        return false;
      }
      const text = (marker.textContent || "").trim();
      if (normalizedTagName(marker) !== "HR" && !text) {
        return false;
      }
      return isBetween(prevUnit.element, marker, currentUnit.element);
    });

    const startsAtMarker = isUnitBoundaryStart(currentUnit.element);
    if (containerChanged || hasMarkerBetween || startsAtMarker) {
      boundaryId += 1;
    }

    currentUnit.boundaryId = boundaryId;
  }
}

function rebuildTimedChunks(anchorUnitIndex = 0) {
  const targetChars = state.durationMinutes * ESTIMATED_CHARS_PER_MINUTE;
  state.chunks = buildTimedChunksFromUnits(state.paragraphUnits, targetChars);

  if (!state.chunks.length && state.paragraphUnits.length) {
    state.chunks = buildTimedChunksFromUnits(state.paragraphUnits, 1);
  }

  if (!state.chunks.length) {
    state.currentIndex = 0;
    return;
  }

  const anchoredIndex = findChunkIndexByUnit(anchorUnitIndex);
  if (anchoredIndex >= 0) {
    state.currentIndex = anchoredIndex;
    return;
  }

  state.currentIndex = Math.min(state.currentIndex, state.chunks.length - 1);
}

function applyDisplayMode(nextMode) {
  const mode = DISPLAY_MODES.includes(nextMode) ? nextMode : "floating";
  state.displayMode = mode;

  if (state.panel) {
    state.panel.setAttribute("data-display-mode", mode);
  }
  document.documentElement.classList.toggle("aozora-sidepanel-active", mode === "side");

  if (state.ui?.displayModeSelectEl) {
    state.ui.displayModeSelectEl.value = mode;
  }
}

function setPanelMeta(text) {
  if (!state.ui?.metaEl) {
    return;
  }
  state.ui.metaEl.textContent = text;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(value, max));
}

function positionTooltip(anchorEl) {
  const tooltip = state.tooltip;
  if (!tooltip || !anchorEl) {
    return;
  }

  const rect = anchorEl.getBoundingClientRect();
  const margin = 12;
  const tooltipRect = tooltip.getBoundingClientRect();

  const left = clamp(rect.left, margin, window.innerWidth - tooltipRect.width - margin);
  const top = clamp(rect.bottom + 8, margin, window.innerHeight - tooltipRect.height - margin);

  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}

async function setWordKnownAndRerender(wordOrBase, isKnown) {
  const result = await setWordKnown(wordOrBase, isKnown);
  state.knownWords = result.set;
  state.knownWordEntries = result.entries;
  hideTooltip();
  await renderCurrentChunk(false);
}

async function setGrammarKnownAndRerender(patternOrId, isKnown) {
  const result = await setGrammarKnown(patternOrId, isKnown);
  state.knownGrammarIds = result.set;
  state.knownGrammarEntries = result.entries;
  hideTooltip();
  await renderCurrentChunk(false);
}

function hideTooltip() {
  if (!state.tooltip) {
    return;
  }
  state.tooltip.classList.add("aozora-hidden");
  state.tooltip.replaceChildren();
}

function makeTooltipButton(label, onClick, isPrimary = false) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.className = isPrimary ? "aozora-primary" : "";
  button.addEventListener("click", onClick);
  return button;
}

function showWordTooltip(anchorEl, word) {
  if (!state.tooltip || !word) {
    return;
  }

  const wrap = document.createElement("div");
  const title = document.createElement("div");
  title.className = "aozora-tooltip-title";
  title.textContent = `${word.surface} (${word.base})`;

  const meta = document.createElement("div");
  meta.className = "aozora-tooltip-meta";
  const readingText = word.reading ? `读音: ${word.reading}` : "读音: -";
  const hintText = word.hint ? `提示: ${word.hint}` : "提示: (无词义，仅显示读音)";
  meta.textContent = `${readingText} / ${hintText}`;

  const actions = document.createElement("div");
  actions.className = "aozora-tooltip-actions";
  actions.appendChild(
    makeTooltipButton("Mark known", async (event) => {
      event.stopPropagation();
      await setWordKnownAndRerender(word, true);
    }, true)
  );
  actions.appendChild(
    makeTooltipButton("Mark unknown", async (event) => {
      event.stopPropagation();
      await setWordKnownAndRerender(word.base, false);
    })
  );

  wrap.append(title, meta, actions);
  state.tooltip.replaceChildren(wrap);
  state.tooltip.classList.remove("aozora-hidden");
  positionTooltip(anchorEl);
}

function showPatternTooltip(anchorEl, pattern) {
  if (!state.tooltip || !pattern) {
    return;
  }

  const wrap = document.createElement("div");
  const title = document.createElement("div");
  title.className = "aozora-tooltip-title";
  title.textContent = pattern.name;

  const meta = document.createElement("div");
  meta.className = "aozora-tooltip-meta";
  meta.textContent = pattern.explanationZh;

  const actions = document.createElement("div");
  actions.className = "aozora-tooltip-actions";
  actions.appendChild(
    makeTooltipButton("Mark known", async (event) => {
      event.stopPropagation();
      await setGrammarKnownAndRerender(pattern, true);
    }, true)
  );
  actions.appendChild(
    makeTooltipButton("Mark unknown", async (event) => {
      event.stopPropagation();
      await setGrammarKnownAndRerender(pattern, false);
    })
  );

  wrap.append(title, meta, actions);
  state.tooltip.replaceChildren(wrap);
  state.tooltip.classList.remove("aozora-hidden");
  positionTooltip(anchorEl);
}

function findInChunk(chunk, selector) {
  for (const el of chunk.elements) {
    const match = el.querySelector(selector);
    if (match) {
      return match;
    }
  }
  return null;
}

function scrollToHighlightedWord(base) {
  const chunk = getCurrentChunk();
  if (!chunk) {
    return;
  }

  const selector = `span[data-aozora-hl='1'][data-aozora-hl-kind='word'][data-base='${CSS.escape(base)}']`;
  const target = findInChunk(chunk, selector);
  if (!target) {
    return;
  }

  target.scrollIntoView({ behavior: "smooth", block: "center" });
  flashElement(target);

  const word = state.currentWords.find((item) => item.base === base);
  if (word) {
    showWordTooltip(target, word);
  }
}

function scrollToPattern(patternId) {
  const chunk = getCurrentChunk();
  if (!chunk) {
    return;
  }

  const selector = `span[data-aozora-hl='1'][data-aozora-hl-kind='pattern'][data-pattern-id='${CSS.escape(patternId)}']`;
  const target = findInChunk(chunk, selector);
  if (!target) {
    return;
  }

  target.scrollIntoView({ behavior: "smooth", block: "center" });
  flashElement(target);

  const pattern = state.currentPatterns.find((item) => item.id === patternId);
  if (pattern) {
    showPatternTooltip(target, pattern);
  }
}

function renderVocabularyList() {
  const list = state.ui.vocabListEl;
  list.replaceChildren();

  if (!state.currentWords.length) {
    const empty = document.createElement("div");
    empty.className = "aozora-list-empty";
    empty.textContent = "No vocab candidates in this chunk.";
    list.appendChild(empty);
    return;
  }

  for (const word of state.currentWords) {
    const item = document.createElement("div");
    item.className = "aozora-item";
    item.dataset.base = word.base;

    const text = document.createElement("div");
    text.className = "aozora-item-text";
    const reading = word.reading ? ` (${word.reading})` : "";
    const hint = word.hint ? ` · ${word.hint}` : "";
    text.textContent = `${word.surface} / ${word.base}${reading}${hint}`;

    const button = document.createElement("button");
    button.type = "button";
    const isKnown = state.knownWords.has(word.base);
    button.textContent = isKnown ? "Known" : "Mark known";
    button.dataset.action = isKnown ? "mark-unknown" : "mark-known";
    button.dataset.base = word.base;

    item.append(text, button);
    list.appendChild(item);
  }
}

function renderPatternList() {
  const list = state.ui.patternListEl;
  list.replaceChildren();

  if (!state.currentPatterns.length) {
    const empty = document.createElement("div");
    empty.className = "aozora-list-empty";
    empty.textContent = "No grammar patterns matched.";
    list.appendChild(empty);
    return;
  }

  for (const pattern of state.currentPatterns) {
    const item = document.createElement("div");
    item.className = "aozora-item aozora-item-pattern";
    item.dataset.patternId = pattern.id;

    const text = document.createElement("div");
    text.className = "aozora-item-text";
    text.textContent = `${pattern.name} · ${pattern.explanationZh}`;

    const button = document.createElement("button");
    button.type = "button";
    const isKnown = state.knownGrammarIds.has(pattern.id);
    button.textContent = isKnown ? "Known" : "Mark known";
    button.dataset.action = isKnown ? "mark-grammar-unknown" : "mark-grammar-known";
    button.dataset.patternId = pattern.id;

    item.append(text, button);
    list.appendChild(item);
  }
}

function renderPersonalDictionary() {
  const knownWordsList = state.ui.knownWordsListEl;
  const knownGrammarList = state.ui.knownGrammarListEl;
  knownWordsList.replaceChildren();
  knownGrammarList.replaceChildren();

  if (!state.knownWordEntries.length) {
    const empty = document.createElement("div");
    empty.className = "aozora-list-empty";
    empty.textContent = "No known words yet.";
    knownWordsList.appendChild(empty);
  } else {
    for (const entry of state.knownWordEntries) {
      const row = document.createElement("div");
      row.className = "aozora-item aozora-item-compact";

      const text = document.createElement("div");
      text.className = "aozora-item-text";
      const reading = entry.reading ? ` (${entry.reading})` : "";
      const hint = entry.hint ? ` · ${entry.hint}` : "";
      text.textContent = `${entry.surface} / ${entry.base}${reading}${hint}`;

      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "Forget";
      button.dataset.action = "mark-unknown";
      button.dataset.base = entry.base;

      row.append(text, button);
      knownWordsList.appendChild(row);
    }
  }

  if (!state.knownGrammarEntries.length) {
    const empty = document.createElement("div");
    empty.className = "aozora-list-empty";
    empty.textContent = "No known grammar yet.";
    knownGrammarList.appendChild(empty);
  } else {
    for (const entry of state.knownGrammarEntries) {
      const row = document.createElement("div");
      row.className = "aozora-item aozora-item-pattern aozora-item-compact";
      row.dataset.patternId = entry.id;

      const text = document.createElement("div");
      text.className = "aozora-item-text";
      text.textContent = `${entry.name}${entry.explanationZh ? ` · ${entry.explanationZh}` : ""}`;

      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "Forget";
      button.dataset.action = "mark-grammar-unknown";
      button.dataset.patternId = entry.id;

      row.append(text, button);
      knownGrammarList.appendChild(row);
    }
  }
}

function updateMetaText(tokenizeSource, chunk) {
  const modeLabel = MODE_LIMITS[state.mode].label;
  const displayModeLabel = state.displayMode === "side" ? "Side panel" : "Floating";
  const chunkText = `Chunk ${state.currentIndex + 1}/${state.chunks.length}`;
  const windowText = `Window: ${state.durationMinutes} min`;
  const sizeText = `~${chunk.charCount} chars`;
  const sourceText = `Tokenizer: ${tokenizeSource}`;
  setPanelMeta(`${chunkText} · ${windowText} · ${sizeText} · Mode: ${modeLabel} · Panel: ${displayModeLabel} · ${sourceText}`);

  const modeButton = state.ui?.modeToggleButtonEl;
  if (modeButton) {
    modeButton.textContent = `Mode: ${modeLabel}`;
  }

  if (state.ui?.durationSelectEl) {
    state.ui.durationSelectEl.value = String(state.durationMinutes);
  }
}

async function getChunkAnalysis(chunk) {
  const limits = MODE_LIMITS[state.mode];

  let cached = state.cache.get(chunk.id);
  if (!cached) {
    const tokenized = await tokenizeChunkText(chunk.text);
    cached = {
      text: chunk.text,
      tokens: tokenized.tokens,
      source: tokenized.source
    };
    state.cache.set(chunk.id, cached);
  }

  const words = scoreVocabularyTokens(cached.tokens, state.knownWords, STOPWORDS, limits.words).map((item) => ({
    ...item,
    hint: CHINESE_HINTS[item.base] || ""
  }));

  const patterns = detectGrammarPatterns(cached.text, { topK: limits.patterns + state.knownGrammarIds.size })
    .filter((pattern) => !state.knownGrammarIds.has(pattern.id))
    .slice(0, limits.patterns);

  return {
    source: cached.source,
    words,
    patterns
  };
}

function highlightAcrossChunk(chunk, literal, options = {}) {
  let remaining = options.maxMatches ?? Number.POSITIVE_INFINITY;
  const highlighted = [];

  for (const element of chunk.elements) {
    if (remaining <= 0) {
      break;
    }
    const matches = highlightLiteral(element, literal, {
      ...options,
      maxMatches: remaining
    });
    highlighted.push(...matches);
    remaining -= matches.length;
  }

  return highlighted;
}

function applyHighlights(chunk, words, patterns) {
  for (const element of chunk.elements) {
    clearHighlights(element);
  }

  for (const word of words) {
    let matches = highlightAcrossChunk(chunk, word.surface, {
      kind: "word",
      base: word.base,
      surface: word.surface,
      reading: word.reading,
      hint: word.hint,
      maxMatches: 2
    });

    if (!matches.length && word.base !== word.surface) {
      matches = highlightAcrossChunk(chunk, word.base, {
        kind: "word",
        base: word.base,
        surface: word.surface,
        reading: word.reading,
        hint: word.hint,
        maxMatches: 2
      });
    }

    word.matchCount = matches.length;
  }

  for (const pattern of patterns) {
    if (!pattern.matchText) {
      continue;
    }
    highlightAcrossChunk(chunk, pattern.matchText, {
      kind: "pattern",
      patternId: pattern.id,
      patternName: pattern.name,
      explanation: pattern.explanationZh,
      maxMatches: 1
    });
  }
}

function clearCurrentChunkStyles() {
  for (const unit of state.paragraphUnits) {
    unit.element.classList.remove("aozora-current-chunk");
    clearHighlights(unit.element);
  }
}

async function renderCurrentChunk(scrollIntoView = true) {
  const chunk = getCurrentChunk();
  if (!chunk) {
    return;
  }

  clearCurrentChunkStyles();
  for (const element of chunk.elements) {
    element.classList.add("aozora-current-chunk");
  }

  if (scrollIntoView && chunk.elements[0]) {
    chunk.elements[0].scrollIntoView({ behavior: "smooth", block: "center" });
  }

  const currentRender = ++state.renderToken;
  const analysis = await getChunkAnalysis(chunk);
  if (currentRender !== state.renderToken) {
    return;
  }

  state.currentWords = analysis.words;
  state.currentPatterns = analysis.patterns;

  applyHighlights(chunk, state.currentWords, state.currentPatterns);
  renderVocabularyList();
  renderPatternList();
  renderPersonalDictionary();
  updateMetaText(analysis.source, chunk);
}

async function changeChunk(step) {
  const next = Math.max(0, Math.min(state.currentIndex + step, state.chunks.length - 1));
  if (next === state.currentIndex) {
    return;
  }
  state.currentIndex = next;
  hideTooltip();
  await renderCurrentChunk(true);
}

async function toggleMode() {
  state.mode = state.mode === "A" ? "B" : "A";
  hideTooltip();
  await renderCurrentChunk(false);
}

async function changeDuration(nextDurationMinutes) {
  if (!DURATION_OPTIONS.includes(nextDurationMinutes)) {
    return;
  }
  if (nextDurationMinutes === state.durationMinutes) {
    return;
  }

  const anchorUnitIndex = getCurrentChunk()?.startUnitIndex ?? 0;
  state.durationMinutes = nextDurationMinutes;
  rebuildTimedChunks(anchorUnitIndex);
  hideTooltip();
  await renderCurrentChunk(false);
}

function changeDisplayMode(nextMode) {
  if (!DISPLAY_MODES.includes(nextMode)) {
    return;
  }
  if (nextMode === state.displayMode) {
    return;
  }
  applyDisplayMode(nextMode);
}

function handlePanelClick(event) {
  const actionButton = event.target.closest("button[data-action]");
  if (actionButton) {
    const action = actionButton.dataset.action;
    if (action === "prev") {
      changeChunk(-1);
      return;
    }
    if (action === "next") {
      changeChunk(1);
      return;
    }
    if (action === "toggle-mode") {
      toggleMode();
      return;
    }

    if ((action === "mark-known" || action === "mark-unknown") && actionButton.dataset.base) {
      const base = actionButton.dataset.base;
      const shouldKnow = action === "mark-known";
      const payload = state.currentWords.find((word) => word.base === base) || { base };
      setWordKnownAndRerender(payload, shouldKnow).catch((error) => {
        console.error("[Aozora Helper] mark word failed", error);
      });
      return;
    }

    if ((action === "mark-grammar-known" || action === "mark-grammar-unknown") && actionButton.dataset.patternId) {
      const patternId = actionButton.dataset.patternId;
      const shouldKnow = action === "mark-grammar-known";
      const payload = state.currentPatterns.find((pattern) => pattern.id === patternId) || { id: patternId, name: patternId };
      setGrammarKnownAndRerender(payload, shouldKnow).catch((error) => {
        console.error("[Aozora Helper] mark grammar failed", error);
      });
      return;
    }
  }

  const vocabItem = event.target.closest(".aozora-item[data-base]");
  if (vocabItem) {
    scrollToHighlightedWord(vocabItem.dataset.base);
    return;
  }

  const patternItem = event.target.closest(".aozora-item[data-pattern-id]");
  if (patternItem) {
    scrollToPattern(patternItem.dataset.patternId);
  }
}

function handlePanelChange(event) {
  const durationSelect = event.target.closest("select[data-action='duration']");
  if (durationSelect) {
    const nextDuration = Number(durationSelect.value);
    if (!Number.isFinite(nextDuration)) {
      return;
    }
    changeDuration(nextDuration);
    return;
  }

  const displayModeSelect = event.target.closest("select[data-action='display-mode']");
  if (!displayModeSelect) {
    return;
  }
  changeDisplayMode(displayModeSelect.value);
}

function isEditableTarget(target) {
  if (!(target instanceof Element)) {
    return false;
  }
  const tagName = normalizedTagName(target);
  if (tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT") {
    return true;
  }
  if (target.isContentEditable || target.closest("[contenteditable='true']")) {
    return true;
  }
  return false;
}

function findUnitIndexFromTarget(target) {
  if (!(target instanceof Element)) {
    return -1;
  }
  for (const unit of state.paragraphUnits) {
    if (unit.element === target || unit.element.contains(target)) {
      return unit.index;
    }
  }
  return -1;
}

async function jumpToChunkForClickedTarget(target) {
  const unitIndex = findUnitIndexFromTarget(target);
  if (unitIndex < 0) {
    return false;
  }

  const chunkIndex = findChunkIndexByUnit(unitIndex);
  if (chunkIndex < 0) {
    return false;
  }

  if (chunkIndex === state.currentIndex) {
    hideTooltip();
    return true;
  }

  state.currentIndex = chunkIndex;
  hideTooltip();
  await renderCurrentChunk(false);
  return true;
}

async function handleDocumentClick(event) {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) {
    return;
  }

  const highlight = target.closest("span[data-aozora-hl='1']");
  if (highlight) {
    const kind = highlight.dataset.aozoraHlKind || highlight.getAttribute("data-aozora-hl-kind");
    if (kind === "word") {
      const base = highlight.dataset.base || "";
      const matched =
        state.currentWords.find((word) => word.base === base) ||
        {
          surface: highlight.dataset.surface || highlight.textContent || "",
          base,
          reading: highlight.dataset.reading || "",
          hint: highlight.dataset.hint || ""
        };
      showWordTooltip(highlight, matched);
      return;
    }

    if (kind === "pattern") {
      const patternId = highlight.dataset.patternId || "";
      const matched =
        state.currentPatterns.find((pattern) => pattern.id === patternId) ||
        {
          id: patternId,
          name: highlight.dataset.patternName || highlight.textContent || "Pattern",
          explanationZh: highlight.dataset.explanation || ""
        };
      showPatternTooltip(highlight, matched);
      return;
    }
  }

  if (target.closest("[data-aozora-panel='1']") || target.closest("[data-aozora-tooltip='1']")) {
    return;
  }

  const jumped = await jumpToChunkForClickedTarget(target);
  if (jumped) {
    return;
  }
  hideTooltip();
}

function handleDocumentKeydown(event) {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) {
    return;
  }
  if (event.key !== "ArrowUp" && event.key !== "ArrowDown") {
    return;
  }

  const target = event.target instanceof Element ? event.target : document.activeElement;
  if (isEditableTarget(target)) {
    return;
  }

  if (!state.chunks.length) {
    return;
  }

  event.preventDefault();
  const step = event.key === "ArrowUp" ? -1 : 1;
  changeChunk(step).catch((error) => {
    console.error("[Aozora Helper] keydown chunk change failed", error);
  });
}

function bindEvents() {
  state.panel.addEventListener("click", handlePanelClick);
  state.panel.addEventListener("change", handlePanelChange);
  document.addEventListener("click", (event) => {
    handleDocumentClick(event).catch((error) => {
      console.error("[Aozora Helper] document click handler failed", error);
    });
  });
  document.addEventListener("keydown", handleDocumentKeydown);
}

async function init() {
  if (window.top !== window.self) {
    return;
  }

  const { chunks: paragraphElements, getChunkText, mainContainer } = extractReadableChunks(document);
  if (!paragraphElements.length) {
    return;
  }

  state.paragraphUnits = paragraphElements
    .map((element, index) => {
      const text = getChunkText(element);
      const charCount = text.replace(/\s+/g, "").length;
      return {
        index,
        element,
        text,
        charCount
      };
    })
    .filter((unit) => unit.charCount > 0);

  if (!state.paragraphUnits.length) {
    return;
  }

  assignBoundaryIds(state.paragraphUnits, mainContainer || document.body);
  state.knownWordEntries = await getKnownWordEntries();
  state.knownWords = new Set(state.knownWordEntries.map((entry) => entry.base));
  state.knownGrammarEntries = await getKnownGrammarEntries();
  state.knownGrammarIds = new Set(state.knownGrammarEntries.map((entry) => entry.id));
  rebuildTimedChunks(0);

  state.panel = createPanel();
  state.tooltip = createTooltip();
  state.ui = {
    metaEl: state.panel.querySelector("[data-role='meta']"),
    vocabListEl: state.panel.querySelector("[data-role='vocab-list']"),
    patternListEl: state.panel.querySelector("[data-role='pattern-list']"),
    knownWordsListEl: state.panel.querySelector("[data-role='known-words-list']"),
    knownGrammarListEl: state.panel.querySelector("[data-role='known-grammar-list']"),
    durationSelectEl: state.panel.querySelector("select[data-action='duration']"),
    displayModeSelectEl: state.panel.querySelector("select[data-action='display-mode']"),
    modeToggleButtonEl: state.panel.querySelector("button[data-action='toggle-mode']")
  };

  applyDisplayMode(state.displayMode);
  bindEvents();
  await renderCurrentChunk(false);
}

init().catch((error) => {
  console.error("[Aozora Helper] init failed", error);
});
