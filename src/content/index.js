import { buildTimedChunksFromUnits, extractReadableChunks } from "./chunks.js";
import { tokenizeChunkText } from "./tokenizer.js";
import { getKnownGrammarEntries, getKnownWordEntries, setGrammarKnown, setWordKnown } from "./storage.js";
import { clearHighlights, flashElement, highlightByContext, highlightLiteral } from "./highlighter.js";
import { normalizeLlmBatchPayload, toRawHighlightWords, toRawTokenEntry } from "./analysis.js";
import { sendDebugLog } from "../shared/debug.js";
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
const ANALYSIS_MODES = ["kuromoji", "llm"];
const LLM_PROVIDERS = ["openai", "gemini"];
const LLM_SETTINGS_KEY = "aozoraLlmSettingsV1";
const LLM_CHUNK_CACHE_KEY = "aozoraLlmChunkCacheV1";
const PROMPT_PLACEHOLDER = "<%CONTENT%>";
const LEARNER_PROFILE_PLACEHOLDER = "<%LEARNER_PROFILE%>";
const DEFAULT_LEARNER_PROFILE = "a Chinese-speaking beginner of N5 level";
const LLM_BATCH_TARGET_CHARS = 10 * ESTIMATED_CHARS_PER_MINUTE;
const LLM_CHUNK_CACHE_LIMIT = 500;
const DEFAULT_LLM_TEMPLATE = `SYSTEM:
You are a Japanese reading tutor for Chinese-speaking learners.
Learner profile: ${LEARNER_PROFILE_PLACEHOLDER}
Given MULTIPLE Japanese chunks, output key vocabulary and grammar patterns with concise Chinese explanations.
IMPORTANT:
- Output MUST be valid JSON only (no extra text).
- You MUST return one result object for every input chunk_id.
- All fields that reference original text MUST be exact substrings copied from the matching chunk text (character-for-character).
  This includes: surface_in_text, matched_text, anchor_before, anchor_after.
- Select items that are most important for understanding. Avoid proper nouns/time numbers unless essential.
- Do not mix text across chunks.


JSON schema:
{
  "template_version": "batch_v1",
  "results": [
    {
      "chunk_id": "<same as input chunk_id>",
      "vocab": [
        {
          "surface_in_text": "<exact substring>",
          "reading_hira": "<hiragana reading>",
          "lemma": "<dictionary form (kanji if standard)>",
          "zh_gloss": ["<short Chinese meaning 1>", "<meaning 2 optional>"],
          "note_zh": "<1 sentence contextual note>",
          "anchor_before": "<6-12 chars before surface in the chunk, exact>",
          "anchor_after": "<6-12 chars after surface in the chunk, exact>"
        }
      ],
      "grammar": [
        {
          "title_zh": "<short name>",
          "explain_zh": "<1-2 sentence explanation in Chinese>",
          "example_ja": "<one simple Japanese example sentence>",
          "matched_text": "<exact substring from chunk, ideally 12-30 chars>",
          "anchor_before": "<6-12 chars before matched_text, exact>",
          "anchor_after": "<6-12 chars after matched_text, exact>"
        }
      ]
    }
  ]
}

USER:
batch = ${PROMPT_PLACEHOLDER}`;
const DEFAULT_OPENAI_MODEL = "gpt-5-mini";
const OPENAI_SERVICE_TIERS = ["standard", "flex"];
const DEFAULT_OPENAI_SERVICE_TIER = "flex";
const BOUNDARY_CONTAINER_SELECTOR =
  "section,article,[class*='chapter'],[id*='chapter'],[class*='section'],[id*='section']";
const BOUNDARY_MARKER_SELECTOR =
  "h1,h2,h3,h4,h5,h6,hr,.dai-midashi,.naka-midashi,.o-midashi,[class*='midashi'],[class*='chapter-title'],[class*='section-title']";
const HEADING_PREFIX_RE = /^(第[一二三四五六七八九十百千〇零0-9０-９]+[章編節回話]|[一二三四五六七八九十百千〇零0-9０-９]+(?:[、，.．]|$))/u;

function isLegacySingleChunkTemplate(template) {
  const text = String(template || "");
  if (!text.trim()) {
    return true;
  }
  if (text.includes("Given ONE Japanese chunk")) {
    return true;
  }
  if (/chunk\s*=\s*["']?\s*<%CONTENT%>/i.test(text)) {
    return true;
  }
  return false;
}

function normalizePromptTemplate(template) {
  const value = typeof template === "string" ? template.trim() : "";
  if (!value) {
    return DEFAULT_LLM_TEMPLATE;
  }
  if (isLegacySingleChunkTemplate(value)) {
    return DEFAULT_LLM_TEMPLATE;
  }
  return value;
}

const state = {
  paragraphUnits: [],
  chunks: [],
  currentIndex: 0,
  mode: "A",
  analysisMode: "kuromoji",
  durationMinutes: 1,
  displayMode: "side",
  kuromojiRawMode: false,
  llmProvider: "openai",
  llmOpenaiModel: DEFAULT_OPENAI_MODEL,
  llmOpenaiServiceTier: DEFAULT_OPENAI_SERVICE_TIER,
  llmLearnerProfile: DEFAULT_LEARNER_PROFILE,
  llmPromptTemplate: DEFAULT_LLM_TEMPLATE,
  llmApiKeys: {
    openai: "",
    gemini: ""
  },
  llmLastPrompt: "",
  llmLastResponse: "",
  llmLastUsage: null,
  llmLastCost: null,
  llmStatus: "",
  llmBusy: false,
  llmChunkCache: new Map(),
  llmChunkCacheDirty: false,
  llmInflightByCacheKey: new Map(),
  knownWords: new Set(),
  knownWordEntries: [],
  knownGrammarIds: new Set(),
  knownGrammarEntries: [],
  tokenCache: new Map(),
  llmRuntimeCache: new Map(),
  renderToken: 0,
  panel: null,
  tooltip: null,
  ui: null,
  currentWords: [],
  currentPatterns: [],
  currentRawTokens: [],
  lastTokenizeSource: "pending"
};

function createPanel() {
  const panel = document.createElement("div");
  panel.setAttribute("data-aozora-panel", "1");
  panel.className = "aozora-panel";
  panel.setAttribute("data-display-mode", state.displayMode);
  panel.setAttribute("data-kuromoji-raw", state.kuromojiRawMode ? "on" : "off");

  const durationOptions = DURATION_OPTIONS
    .map((minutes) => `<option value="${minutes}"${minutes === state.durationMinutes ? " selected" : ""}>${minutes} min</option>`)
    .join("");
  const displayModeOptions = DISPLAY_MODES
    .map((mode) => {
      const label = mode === "side" ? "Side panel" : "Floating";
      return `<option value="${mode}"${mode === state.displayMode ? " selected" : ""}>${label}</option>`;
    })
    .join("");
  const llmProviderOptions = LLM_PROVIDERS
    .map((provider) => {
      const label = provider === "gemini" ? "Gemini" : "OpenAI";
      return `<option value="${provider}"${provider === state.llmProvider ? " selected" : ""}>${label}</option>`;
    })
    .join("");
  const llmTierOptions = OPENAI_SERVICE_TIERS
    .map((tier) => {
      const label = tier === "standard" ? "Standard" : "Flex";
      return `<option value="${tier}"${tier === state.llmOpenaiServiceTier ? " selected" : ""}>${label}</option>`;
    })
    .join("");
  const analysisModeOptions = ANALYSIS_MODES
    .map((mode) => {
      const label = mode === "llm" ? "LLM JSON" : "Kuromoji";
      return `<option value="${mode}"${mode === state.analysisMode ? " selected" : ""}>${label}</option>`;
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
    </div>
    <details class="aozora-advanced">
      <summary>Advanced settings</summary>
      <div class="aozora-controls aozora-controls-advanced">
        <button type="button" data-action="toggle-mode" class="aozora-span-2">Mode: Reading</button>
        <button type="button" data-action="toggle-kuromoji" class="aozora-span-2">Kuromoji Raw: Off</button>
        <label class="aozora-duration-wrap aozora-span-2">
          <span>Chunk window</span>
          <select data-action="duration">${durationOptions}</select>
        </label>
        <label class="aozora-duration-wrap aozora-span-2">
          <span>Panel mode</span>
          <select data-action="display-mode">${displayModeOptions}</select>
        </label>
        <label class="aozora-duration-wrap aozora-span-2">
          <span>Highlight mode</span>
          <select data-action="analysis-mode">${analysisModeOptions}</select>
        </label>
      </div>
    </details>
    <div class="aozora-meta" data-role="meta"></div>
    <div class="aozora-section aozora-vocab-section">
      <div class="aozora-section-title" data-role="vocab-title">Vocabulary</div>
      <div class="aozora-list" data-role="vocab-list"></div>
    </div>
    <div class="aozora-section aozora-grammar-section">
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
    <div class="aozora-section aozora-llm-section">
      <div class="aozora-section-title">LLM Formatter</div>
      <label class="aozora-duration-wrap">
        <span>Provider</span>
        <select data-action="llm-provider">${llmProviderOptions}</select>
      </label>
      <label class="aozora-duration-wrap">
        <span>OpenAI model</span>
        <input type="text" data-action="llm-openai-model" autocomplete="off" spellcheck="false" />
      </label>
      <label class="aozora-duration-wrap">
        <span>OpenAI tier</span>
        <select data-action="llm-openai-tier">${llmTierOptions}</select>
      </label>
      <label class="aozora-duration-wrap">
        <span>Learner profile</span>
        <input type="text" data-action="llm-learner-profile" autocomplete="off" spellcheck="false" />
      </label>
      <label class="aozora-duration-wrap">
        <span>API Key (stored locally only)</span>
        <input type="password" data-action="llm-key" autocomplete="off" spellcheck="false" />
      </label>
      <label class="aozora-duration-wrap">
        <span>Prompt formatter (${PROMPT_PLACEHOLDER} required, ${LEARNER_PROFILE_PLACEHOLDER} optional)</span>
        <textarea data-action="llm-template" rows="5"></textarea>
      </label>
      <button type="button" data-action="run-llm">LLM Format Chunk</button>
      <div class="aozora-list-empty" data-role="llm-status"></div>
      <div class="aozora-list-empty" data-role="llm-usage"></div>
      <div class="aozora-list-empty" data-role="llm-cost"></div>
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
  const mode = DISPLAY_MODES.includes(nextMode) ? nextMode : "side";
  state.displayMode = mode;

  if (state.panel) {
    state.panel.setAttribute("data-display-mode", mode);
  }
  document.documentElement.classList.toggle("aozora-sidepanel-active", mode === "side");

  if (state.ui?.displayModeSelectEl) {
    state.ui.displayModeSelectEl.value = mode;
  }
}

function updateVocabSectionTitle() {
  if (!state.ui?.vocabTitleEl) {
    return;
  }
  if (state.kuromojiRawMode) {
    state.ui.vocabTitleEl.textContent = "Kuromoji Raw Output";
    return;
  }
  if (state.analysisMode === "llm") {
    state.ui.vocabTitleEl.textContent = "LLM Vocabulary";
    return;
  }
  state.ui.vocabTitleEl.textContent = "Vocabulary";
}

function applyAnalysisMode(nextMode) {
  const mode = ANALYSIS_MODES.includes(nextMode) ? nextMode : "kuromoji";
  state.analysisMode = mode;
  if (state.ui?.analysisModeSelectEl) {
    state.ui.analysisModeSelectEl.value = mode;
  }
  updateVocabSectionTitle();
}

function applyKuromojiRawMode(nextValue) {
  state.kuromojiRawMode = Boolean(nextValue);
  if (state.panel) {
    state.panel.setAttribute("data-kuromoji-raw", state.kuromojiRawMode ? "on" : "off");
  }
  if (state.ui?.kuromojiToggleButtonEl) {
    state.ui.kuromojiToggleButtonEl.textContent = state.kuromojiRawMode ? "Kuromoji Raw: On" : "Kuromoji Raw: Off";
  }
  updateVocabSectionTitle();
}

function normalizeStoredLlmSettings(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  const provider = value.provider === "gemini" ? "gemini" : "openai";
  const openaiModel = typeof value.openaiModel === "string" && value.openaiModel.trim()
    ? value.openaiModel.trim()
    : DEFAULT_OPENAI_MODEL;
  const openaiServiceTier = OPENAI_SERVICE_TIERS.includes(value.openaiServiceTier)
    ? value.openaiServiceTier
    : DEFAULT_OPENAI_SERVICE_TIER;
  const analysisMode = ANALYSIS_MODES.includes(value.analysisMode) ? value.analysisMode : "kuromoji";
  return {
    analysisMode,
    provider,
    openaiModel,
    openaiServiceTier,
    learnerProfile: typeof value.learnerProfile === "string" && value.learnerProfile.trim()
      ? value.learnerProfile.trim()
      : DEFAULT_LEARNER_PROFILE,
    promptTemplate: normalizePromptTemplate(value.promptTemplate),
    openaiApiKey: typeof value.openaiApiKey === "string" ? value.openaiApiKey : "",
    geminiApiKey: typeof value.geminiApiKey === "string" ? value.geminiApiKey : ""
  };
}

function getStorageLocal() {
  if (typeof chrome !== "undefined" && chrome.storage?.local) {
    return chrome.storage.local;
  }
  return null;
}

async function loadLlmSettings() {
  const storage = getStorageLocal();
  if (!storage) {
    return;
  }

  const stored = await new Promise((resolve) => {
    storage.get([LLM_SETTINGS_KEY], (result) => {
      if (chrome.runtime?.lastError) {
        console.warn("[Aozora Helper] LLM settings read failed", chrome.runtime.lastError);
        resolve(null);
        return;
      }
      resolve(result?.[LLM_SETTINGS_KEY] || null);
    });
  });

  const settings = normalizeStoredLlmSettings(stored);
  state.analysisMode = settings.analysisMode;
  state.llmProvider = settings.provider;
  state.llmOpenaiModel = settings.openaiModel;
  state.llmOpenaiServiceTier = settings.openaiServiceTier;
  state.llmLearnerProfile = settings.learnerProfile;
  state.llmPromptTemplate = settings.promptTemplate;
  state.llmApiKeys = {
    openai: settings.openaiApiKey,
    gemini: settings.geminiApiKey
  };
}

async function persistLlmSettings() {
  const storage = getStorageLocal();
  if (!storage) {
    return;
  }

  const payload = {
    analysisMode: state.analysisMode,
    provider: state.llmProvider,
    openaiModel: state.llmOpenaiModel,
    openaiServiceTier: state.llmOpenaiServiceTier,
    learnerProfile: state.llmLearnerProfile,
    promptTemplate: state.llmPromptTemplate,
    openaiApiKey: state.llmApiKeys.openai,
    geminiApiKey: state.llmApiKeys.gemini
  };

  await new Promise((resolve) => {
    storage.set({ [LLM_SETTINGS_KEY]: payload }, () => {
      if (chrome.runtime?.lastError) {
        console.warn("[Aozora Helper] LLM settings write failed", chrome.runtime.lastError);
      }
      resolve();
    });
  });
}

function getEffectiveLearnerProfile() {
  const value = String(state.llmLearnerProfile || "").trim();
  return value || DEFAULT_LEARNER_PROFILE;
}

function normalizeStoredLlmAnalysisEntry(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const words = Array.isArray(raw.words) ? raw.words : [];
  const patterns = Array.isArray(raw.patterns) ? raw.patterns : [];
  const source = typeof raw.source === "string" && raw.source ? raw.source : "llm-cache";
  const updatedAt = Number(raw.updatedAt);
  return {
    source,
    words,
    patterns,
    rawTokens: [],
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : Date.now()
  };
}

async function loadLlmChunkCache() {
  const storage = getStorageLocal();
  if (!storage) {
    return;
  }

  const stored = await new Promise((resolve) => {
    storage.get([LLM_CHUNK_CACHE_KEY], (result) => {
      if (chrome.runtime?.lastError) {
        console.warn("[Aozora Helper] LLM chunk cache read failed", chrome.runtime.lastError);
        resolve(null);
        return;
      }
      resolve(result?.[LLM_CHUNK_CACHE_KEY] || null);
    });
  });

  state.llmChunkCache.clear();
  if (!stored || typeof stored !== "object") {
    return;
  }
  for (const [key, value] of Object.entries(stored)) {
    const normalized = normalizeStoredLlmAnalysisEntry(value);
    if (normalized) {
      state.llmChunkCache.set(key, normalized);
    }
  }
}

function trimLlmChunkCacheInMemory() {
  if (state.llmChunkCache.size <= LLM_CHUNK_CACHE_LIMIT) {
    return;
  }
  const entries = [...state.llmChunkCache.entries()]
    .sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0))
    .slice(0, LLM_CHUNK_CACHE_LIMIT);
  state.llmChunkCache = new Map(entries);
}

function trimLlmRuntimeCacheInMemory() {
  while (state.llmRuntimeCache.size > LLM_CHUNK_CACHE_LIMIT) {
    const oldestKey = state.llmRuntimeCache.keys().next().value;
    if (!oldestKey) {
      break;
    }
    state.llmRuntimeCache.delete(oldestKey);
  }
}

async function persistLlmChunkCache() {
  const storage = getStorageLocal();
  if (!storage || !state.llmChunkCacheDirty) {
    return;
  }

  trimLlmChunkCacheInMemory();
  const payload = Object.fromEntries(state.llmChunkCache.entries());
  await new Promise((resolve) => {
    storage.set({ [LLM_CHUNK_CACHE_KEY]: payload }, () => {
      if (chrome.runtime?.lastError) {
        console.warn("[Aozora Helper] LLM chunk cache write failed", chrome.runtime.lastError);
      }
      resolve();
    });
  });
  state.llmChunkCacheDirty = false;
}

function setLlmStatus(text) {
  state.llmStatus = text;
  if (state.ui?.llmStatusEl) {
    state.ui.llmStatusEl.textContent = text;
  }
}

function formatUsd(value) {
  if (!Number.isFinite(value) || value < 0) {
    return "n/a";
  }
  if (value === 0) {
    return "$0.00";
  }
  if (value < 0.0001) {
    return `$${value.toFixed(6)}`;
  }
  return `$${value.toFixed(4)}`;
}

function formatLlmUsageText(usage) {
  if (!usage) {
    return "Tokens: -";
  }
  const input = Number(usage.inputTokens || 0).toLocaleString("en-US");
  const output = Number(usage.outputTokens || 0).toLocaleString("en-US");
  const total = Number((usage.totalTokens ?? (usage.inputTokens || 0) + (usage.outputTokens || 0)) || 0).toLocaleString("en-US");
  const cached = Number(usage.cachedInputTokens || 0);
  const cachedPart = cached > 0 ? ` (cached input ${cached.toLocaleString("en-US")})` : "";
  return `Tokens: input ${input}, output ${output}, total ${total}${cachedPart}`;
}

function formatLlmCostText(cost) {
  if (!cost) {
    return state.llmProvider === "openai"
      ? "Estimated cost: unavailable."
      : "Estimated cost: OpenAI pricing only.";
  }
  if (!Number.isFinite(cost.estimatedUsd)) {
    const reason = cost.reason ? ` (${cost.reason})` : "";
    return `Estimated cost: unavailable${reason}`;
  }
  const tierLabel = cost.tier === "standard" ? "standard" : "flex";
  const modelLabel = cost.pricingModelKey || cost.model || state.llmOpenaiModel;
  const rates = `input $${cost.inputRatePer1M}/1M, cached $${cost.cachedInputRatePer1M}/1M, output $${cost.outputRatePer1M}/1M`;
  return `Estimated cost (${tierLabel}, ${modelLabel}): ${formatUsd(cost.estimatedUsd)} · ${rates}`;
}

function renderLlmState() {
  if (!state.ui) {
    return;
  }
  if (state.ui.analysisModeSelectEl) {
    state.ui.analysisModeSelectEl.value = state.analysisMode;
  }
  if (state.ui.llmProviderSelectEl) {
    state.ui.llmProviderSelectEl.value = state.llmProvider;
  }
  if (state.ui.llmOpenaiModelInputEl) {
    state.ui.llmOpenaiModelInputEl.value = state.llmOpenaiModel;
    state.ui.llmOpenaiModelInputEl.disabled = state.llmProvider !== "openai";
  }
  if (state.ui.llmOpenaiTierSelectEl) {
    state.ui.llmOpenaiTierSelectEl.value = state.llmOpenaiServiceTier;
    state.ui.llmOpenaiTierSelectEl.disabled = state.llmProvider !== "openai";
  }
  if (state.ui.llmLearnerProfileInputEl) {
    state.ui.llmLearnerProfileInputEl.value = state.llmLearnerProfile;
  }
  if (state.ui.llmKeyInputEl) {
    state.ui.llmKeyInputEl.value = state.llmApiKeys[state.llmProvider] || "";
  }
  if (state.ui.llmTemplateTextAreaEl) {
    state.ui.llmTemplateTextAreaEl.value = state.llmPromptTemplate;
  }
  if (state.ui.llmPromptPreEl) {
    state.ui.llmPromptPreEl.textContent = state.llmLastPrompt;
  }
  if (state.ui.llmResponsePreEl) {
    state.ui.llmResponsePreEl.textContent = state.llmLastResponse;
  }
  if (state.ui.llmUsageEl) {
    state.ui.llmUsageEl.textContent = formatLlmUsageText(state.llmLastUsage);
  }
  if (state.ui.llmCostEl) {
    state.ui.llmCostEl.textContent = formatLlmCostText(state.llmLastCost);
  }
  if (state.ui.llmRunButtonEl) {
    state.ui.llmRunButtonEl.disabled = state.llmBusy;
    state.ui.llmRunButtonEl.textContent = state.llmBusy ? "Running..." : "LLM Format Chunk";
  }
  setLlmStatus(state.llmStatus);
}

function getChunkWithTemplate(contentPayload, template, learnerProfile) {
  if (!template.includes(PROMPT_PLACEHOLDER)) {
    return "";
  }
  const profile = String(learnerProfile || "").trim() || DEFAULT_LEARNER_PROFILE;
  let prompt = template.split(PROMPT_PLACEHOLDER).join(contentPayload);
  if (prompt.includes(LEARNER_PROFILE_PLACEHOLDER)) {
    prompt = prompt.split(LEARNER_PROFILE_PLACEHOLDER).join(profile);
  } else {
    prompt = `Learner profile: ${profile}\n\n${prompt}`;
  }
  return prompt;
}

function callLlmProvider(payload) {
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
    return Promise.reject(new Error("Chrome runtime messaging is unavailable."));
  }

  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: "aozora-llm-run", payload }, (response) => {
      if (chrome.runtime?.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error || "LLM request failed."));
        return;
      }
      resolve(response);
    });
  });
}

function buildLlmBatchChunks(targetChunk) {
  const targetIndex = state.chunks.findIndex((chunk) => chunk.id === targetChunk.id);
  if (targetIndex < 0) {
    return [targetChunk];
  }

  const batch = [];
  let charBudget = 0;
  for (let index = targetIndex; index < state.chunks.length; index += 1) {
    const chunk = state.chunks[index];
    batch.push(chunk);
    charBudget += chunk.charCount;
    if (charBudget >= LLM_BATCH_TARGET_CHARS) {
      break;
    }
  }

  return batch.length ? batch : [targetChunk];
}

function buildLlmBatchPayload(chunks) {
  return JSON.stringify(
    chunks.map((chunk) => ({ chunk_id: chunk.id, text: chunk.text })),
    null,
    2
  );
}

function getCachedLlmChunkAnalysis(cacheKey) {
  const inMemory = state.llmRuntimeCache.get(cacheKey);
  if (inMemory) {
    return inMemory;
  }
  const persisted = state.llmChunkCache.get(cacheKey);
  if (!persisted) {
    return null;
  }
  const analysis = {
    source: persisted.source || `llm-${state.llmProvider}-cache`,
    words: Array.isArray(persisted.words) ? persisted.words : [],
    patterns: Array.isArray(persisted.patterns) ? persisted.patterns : [],
    rawTokens: []
  };
  state.llmRuntimeCache.set(cacheKey, analysis);
  trimLlmRuntimeCacheInMemory();
  return analysis;
}

async function cacheLlmChunkAnalysis(cacheKey, analysis, options = {}) {
  const shouldPersist = options.persist !== false;
  const normalizedAnalysis = {
    source: analysis.source || `llm-${state.llmProvider}`,
    words: Array.isArray(analysis.words) ? analysis.words : [],
    patterns: Array.isArray(analysis.patterns) ? analysis.patterns : [],
    rawTokens: []
  };
  state.llmRuntimeCache.set(cacheKey, normalizedAnalysis);
  trimLlmRuntimeCacheInMemory();
  state.llmChunkCache.set(cacheKey, {
    source: normalizedAnalysis.source,
    words: normalizedAnalysis.words,
    patterns: normalizedAnalysis.patterns,
    updatedAt: Date.now()
  });
  state.llmChunkCacheDirty = true;
  if (shouldPersist) {
    await persistLlmChunkCache();
  }
}

async function requestLlmForBatch(batchChunks) {
  const apiKey = String(state.llmApiKeys[state.llmProvider] || "").trim();
  if (!apiKey) {
    throw new Error("Enter an API key for the selected provider.");
  }

  const template = normalizePromptTemplate(state.llmPromptTemplate);
  if (template !== state.llmPromptTemplate) {
    state.llmPromptTemplate = template;
    renderLlmState();
    await persistLlmSettings();
  }

  const contentPayload = buildLlmBatchPayload(batchChunks);
  const prompt = getChunkWithTemplate(contentPayload, template, getEffectiveLearnerProfile());
  if (!prompt) {
    throw new Error(`Prompt formatter must include ${PROMPT_PLACEHOLDER}.`);
  }

  sendDebugLog("content.llm", "info", "request.batch.prepare", {
    provider: state.llmProvider,
    ...(state.llmProvider === "openai"
      ? {
          openaiModel: state.llmOpenaiModel,
          openaiServiceTier: state.llmOpenaiServiceTier
        }
      : {}),
    chunkCount: batchChunks.length,
    chunkIds: batchChunks.map((item) => item.id),
    promptLength: prompt.length,
    promptPreview: prompt
  });

  const providerPayload = {
    provider: state.llmProvider,
    apiKey,
    prompt
  };
  if (state.llmProvider === "openai") {
    providerPayload.openaiModel = state.llmOpenaiModel;
    providerPayload.openaiServiceTier = state.llmOpenaiServiceTier;
  }

  const result = await callLlmProvider(providerPayload);

  sendDebugLog("content.llm", "info", "request.batch.done", {
    provider: state.llmProvider,
    providerModel: result?.model || "",
    responseLength: String(result?.responseText || "").length,
    responsePreview: String(result?.responseText || ""),
    usage: result?.usage || null,
    hasCost: Boolean(result?.cost)
  });

  return { prompt, result };
}

async function runLlmFormatter() {
  const chunk = getCurrentChunk();
  if (!chunk) {
    setLlmStatus("No active chunk.");
    sendDebugLog("content.llm", "warn", "run.no_chunk");
    return;
  }
  try {
    await getLlmChunkAnalysis(chunk, { allowRequest: true });
    if (state.analysisMode === "llm" && !state.kuromojiRawMode) {
      await renderCurrentChunk(false);
    } else {
      renderLlmState();
    }
  } catch (error) {
    state.llmStatus = `LLM error: ${error instanceof Error ? error.message : String(error)}`;
    sendDebugLog("content.llm", "error", "run.error", {
      error: error instanceof Error ? error.message : String(error)
    });
    renderLlmState();
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
  if (state.kuromojiRawMode) {
    const note = document.createElement("div");
    note.className = "aozora-list-empty";
    note.textContent = "Kuromoji raw mode: marking is disabled.";
    wrap.append(title, meta, note);
    state.tooltip.replaceChildren(wrap);
    state.tooltip.classList.remove("aozora-hidden");
    positionTooltip(anchorEl);
    return;
  }

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

function scrollToHighlightedSurface(surface) {
  const chunk = getCurrentChunk();
  if (!chunk || !surface) {
    return;
  }

  const selector = `span[data-aozora-hl='1'][data-aozora-hl-kind='word'][data-surface='${CSS.escape(surface)}']`;
  const target = findInChunk(chunk, selector);
  if (!target) {
    return;
  }

  target.scrollIntoView({ behavior: "smooth", block: "center" });
  flashElement(target);

  const word = state.currentWords.find((item) => item.surface === surface);
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

  if (state.kuromojiRawMode) {
    if (!state.currentRawTokens.length) {
      const empty = document.createElement("div");
      empty.className = "aozora-list-empty";
      empty.textContent = "No Kuromoji tokens found in this chunk.";
      list.appendChild(empty);
      return;
    }

    for (const token of state.currentRawTokens) {
      const item = document.createElement("div");
      item.className = "aozora-item";
      item.dataset.base = token.base || token.surface;
      item.dataset.rawSurface = token.surface;

      const text = document.createElement("div");
      text.className = "aozora-item-text";
      const reading = token.reading ? ` (${token.reading})` : "";
      const pos = token.pos ? ` · ${token.pos}` : "";
      text.textContent = `${token.index + 1}. ${token.surface} / ${token.base}${reading}${pos}`;
      item.append(text);
      list.appendChild(item);
    }
    return;
  }

  if (!state.currentWords.length) {
    const empty = document.createElement("div");
    empty.className = "aozora-list-empty";
    empty.textContent = state.analysisMode === "llm"
      ? "No LLM vocabulary items returned for this chunk."
      : "No vocab candidates in this chunk.";
    list.appendChild(empty);
    return;
  }

  for (const word of state.currentWords) {
    const item = document.createElement("div");
    item.className = "aozora-item";
    item.dataset.base = word.base;
    item.dataset.surface = word.surface;

    const text = document.createElement("div");
    text.className = "aozora-item-text";
    const reading = word.reading ? ` (${word.reading})` : "";
    const hint = word.hint ? ` · ${word.hint}` : "";
    const noteZh = state.analysisMode === "llm" && word.noteZh ? ` · ${word.noteZh}` : "";
    text.textContent = `${word.surface} / ${word.base}${reading}${hint}${noteZh}`;

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

  if (state.kuromojiRawMode) {
    const empty = document.createElement("div");
    empty.className = "aozora-list-empty";
    empty.textContent = "Grammar detection is hidden in Kuromoji raw mode.";
    list.appendChild(empty);
    return;
  }

  if (!state.currentPatterns.length) {
    const empty = document.createElement("div");
    empty.className = "aozora-list-empty";
    empty.textContent = state.analysisMode === "llm"
      ? "No LLM grammar items returned for this chunk."
      : "No grammar patterns matched.";
    list.appendChild(empty);
    return;
  }

  for (const pattern of state.currentPatterns) {
    const item = document.createElement("div");
    item.className = "aozora-item aozora-item-pattern";
    item.dataset.patternId = pattern.id;

    const text = document.createElement("div");
    text.className = "aozora-item-text";
    const exampleJa = state.analysisMode === "llm" && pattern.exampleJa ? ` · 例: ${pattern.exampleJa}` : "";
    text.textContent = `${pattern.name} · ${pattern.explanationZh}${exampleJa}`;

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

  if (state.kuromojiRawMode) {
    const emptyWords = document.createElement("div");
    emptyWords.className = "aozora-list-empty";
    emptyWords.textContent = "Hidden in Kuromoji raw mode.";
    knownWordsList.appendChild(emptyWords);

    const emptyGrammar = document.createElement("div");
    emptyGrammar.className = "aozora-list-empty";
    emptyGrammar.textContent = "Hidden in Kuromoji raw mode.";
    knownGrammarList.appendChild(emptyGrammar);
    return;
  }

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
  state.lastTokenizeSource = tokenizeSource;

  const modeLabel = MODE_LIMITS[state.mode].label;
  const displayModeLabel = state.displayMode === "side" ? "Side panel" : "Floating";
  const chunkText = `Chunk ${state.currentIndex + 1}/${state.chunks.length}`;
  const windowText = `Window: ${state.durationMinutes} min`;
  const sizeText = `~${chunk.charCount} chars`;
  const sourceText =
    !state.kuromojiRawMode && state.analysisMode === "llm"
      ? `Source: ${tokenizeSource}`
      : `Tokenizer: ${tokenizeSource}`;
  const analysisText = state.kuromojiRawMode
    ? "Analysis: Kuromoji raw"
    : state.analysisMode === "llm"
      ? "Analysis: LLM JSON"
      : `Mode: ${modeLabel}`;
  setPanelMeta(`${chunkText} · ${windowText} · ${sizeText} · ${analysisText} · Panel: ${displayModeLabel} · ${sourceText}`);

  const modeButton = state.ui?.modeToggleButtonEl;
  if (modeButton) {
    modeButton.textContent = `Mode: ${modeLabel}`;
  }

  if (state.ui?.durationSelectEl) {
    state.ui.durationSelectEl.value = String(state.durationMinutes);
  }
}

function refreshMetaText() {
  const chunk = getCurrentChunk();
  if (!chunk) {
    return;
  }
  updateMetaText(state.lastTokenizeSource, chunk);
}

function hashText(value) {
  let hash = 2166136261;
  const text = String(value || "");
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return (hash >>> 0).toString(16);
}

function getLlmAnalysisCacheKey(chunk) {
  const pageKey = `${location.origin}${location.pathname}`;
  const learnerProfile = getEffectiveLearnerProfile();
  const openaiCacheModel = state.llmProvider === "openai" ? state.llmOpenaiModel : "";
  const openaiCacheTier = state.llmProvider === "openai" ? state.llmOpenaiServiceTier : "";
  return [
    "llm",
    pageKey,
    chunk.id,
    hashText(chunk.text),
    state.llmProvider,
    openaiCacheModel,
    openaiCacheTier,
    learnerProfile,
    state.llmPromptTemplate
  ].join("::");
}

async function getLlmChunkAnalysis(chunk, options = {}) {
  const allowRequest = options.allowRequest === true;
  const cacheKey = getLlmAnalysisCacheKey(chunk);
  const cached = getCachedLlmChunkAnalysis(cacheKey);
  if (cached) {
    state.llmLastPrompt = "(cache hit; no API request sent)";
    state.llmLastResponse = "";
    state.llmLastUsage = null;
    state.llmLastCost = null;
    state.llmStatus = "LLM highlights loaded from cache.";
    sendDebugLog("content.llm", "info", "cache.hit", {
      cacheKey,
      chunkId: chunk.id,
      vocabCount: cached.words.length,
      grammarCount: cached.patterns.length
    });
    renderLlmState();
    return cached;
  }

  const inflight = state.llmInflightByCacheKey.get(cacheKey);
  if (inflight) {
    return inflight;
  }
  if (!allowRequest) {
    state.llmStatus = "No cached LLM highlights for this chunk. Click 'LLM Format Chunk' to fetch.";
    sendDebugLog("content.llm", "info", "cache.miss.pending", { cacheKey, chunkId: chunk.id });
    renderLlmState();
    return {
      source: `llm-${state.llmProvider}-pending`,
      words: [],
      patterns: [],
      rawTokens: []
    };
  }

  const task = (async () => {
    state.llmBusy = true;
    state.llmStatus = "Sending batch request for LLM highlight mode...";
    sendDebugLog("content.llm", "info", "request.start", { chunkId: chunk.id, cacheKey });
    renderLlmState();
    await persistLlmSettings();

    try {
      const batchChunks = buildLlmBatchChunks(chunk);
      const pendingChunks = batchChunks.filter((item) => !getCachedLlmChunkAnalysis(getLlmAnalysisCacheKey(item)));
      const chunksToRequest = pendingChunks.length ? pendingChunks : [chunk];

      const { prompt, result } = await requestLlmForBatch(chunksToRequest);
      state.llmLastPrompt = prompt;
      state.llmLastResponse = String(result?.responseText || "");
      state.llmLastUsage = result?.usage || null;
      state.llmLastCost = result?.cost || null;

      const parsedByChunk = normalizeLlmBatchPayload(state.llmLastResponse, chunksToRequest);
      sendDebugLog("content.llm", "info", "response.parsed", {
        requestedChunkCount: chunksToRequest.length,
        requestedChunkIds: chunksToRequest.map((item) => item.id)
      });
      for (const requestedChunk of chunksToRequest) {
        const parsed = parsedByChunk.get(requestedChunk.id) || { words: [], patterns: [] };
        const requestedChunkCacheKey = getLlmAnalysisCacheKey(requestedChunk);
        await cacheLlmChunkAnalysis(requestedChunkCacheKey, {
          source: `llm-${state.llmProvider}`,
          words: parsed.words,
          patterns: parsed.patterns,
          rawTokens: []
        }, { persist: false });
      }
      await persistLlmChunkCache();

      const finalAnalysis = getCachedLlmChunkAnalysis(cacheKey) || {
        source: `llm-${state.llmProvider}`,
        words: [],
        patterns: [],
        rawTokens: []
      };
      const providerModel = typeof result?.model === "string" && result.model
        ? ` · model ${result.model}`
        : "";
      state.llmStatus =
        `LLM highlights ready (batch ${chunksToRequest.length} chunks): ` +
        `vocab ${finalAnalysis.words.length}, grammar ${finalAnalysis.patterns.length}${providerModel}.`;
      sendDebugLog("content.llm", "info", "request.ready", {
        chunkId: chunk.id,
        providerModel: result?.model || "",
        vocabCount: finalAnalysis.words.length,
        grammarCount: finalAnalysis.patterns.length
      });
      return finalAnalysis;
    } catch (error) {
      state.llmLastResponse = "";
      state.llmLastUsage = null;
      state.llmLastCost = null;
      state.llmStatus = `LLM highlight error: ${error instanceof Error ? error.message : String(error)}`;
      sendDebugLog("content.llm", "error", "request.error", {
        chunkId: chunk.id,
        error: error instanceof Error ? error.message : String(error)
      });
      return {
        source: `llm-${state.llmProvider}-error`,
        words: [],
        patterns: [],
        rawTokens: []
      };
    } finally {
      state.llmBusy = false;
      renderLlmState();
    }
  })();

  state.llmInflightByCacheKey.set(cacheKey, task);
  try {
    return await task;
  } finally {
    state.llmInflightByCacheKey.delete(cacheKey);
  }
}

async function getChunkAnalysis(chunk) {
  const limits = MODE_LIMITS[state.mode];

  if (!state.kuromojiRawMode && state.analysisMode === "llm") {
    return getLlmChunkAnalysis(chunk, { allowRequest: false });
  }

  let cached = state.tokenCache.get(chunk.id);
  if (!cached) {
    const tokenized = await tokenizeChunkText(chunk.text);
    cached = {
      text: chunk.text,
      tokens: tokenized.tokens,
      source: tokenized.source
    };
    state.tokenCache.set(chunk.id, cached);
  }

  const rawTokens = cached.tokens
    .map((token, index) => toRawTokenEntry(token, index))
    .filter((token) => token.surface);

  if (state.kuromojiRawMode) {
    return {
      source: cached.source,
      words: toRawHighlightWords(rawTokens),
      patterns: [],
      rawTokens: rawTokens.slice(0, 400)
    };
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
    patterns,
    rawTokens
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

function highlightAcrossChunkByContext(chunk, literal, anchorBefore, anchorAfter, options = {}) {
  let remaining = options.maxMatches ?? Number.POSITIVE_INFINITY;
  const highlighted = [];

  for (const element of chunk.elements) {
    if (remaining <= 0) {
      break;
    }
    const matches = highlightByContext(element, literal, anchorBefore, anchorAfter, {
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

  if (state.kuromojiRawMode) {
    for (const word of words) {
      highlightAcrossChunk(chunk, word.surface, {
        kind: "word",
        base: word.base,
        surface: word.surface,
        reading: word.reading,
        hint: word.hint,
        maxMatches: 1
      });
    }
    return;
  }

  if (state.analysisMode === "llm") {
    for (const word of words) {
      let matches = highlightAcrossChunkByContext(
        chunk,
        word.surface,
        word.anchorBefore || "",
        word.anchorAfter || "",
        {
          kind: "word",
          base: word.base,
          surface: word.surface,
          reading: word.reading,
          hint: word.hint,
          maxMatches: 1
        }
      );
      if (!matches.length && word.base && word.base !== word.surface) {
        matches = highlightAcrossChunk(chunk, word.base, {
          kind: "word",
          base: word.base,
          surface: word.surface,
          reading: word.reading,
          hint: word.hint,
          maxMatches: 1
        });
      }
      word.matchCount = matches.length;
    }

    for (const pattern of patterns) {
      if (!pattern.matchText) {
        continue;
      }
      highlightAcrossChunkByContext(
        chunk,
        pattern.matchText,
        pattern.anchorBefore || "",
        pattern.anchorAfter || "",
        {
          kind: "pattern",
          patternId: pattern.id,
          patternName: pattern.name,
          explanation: pattern.explanationZh,
          maxMatches: 1
        }
      );
    }
    return;
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
  state.currentRawTokens = analysis.rawTokens || [];

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
  refreshMetaText();
}

async function toggleKuromojiRawMode() {
  applyKuromojiRawMode(!state.kuromojiRawMode);
  hideTooltip();
  await renderCurrentChunk(false);
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
    if (action === "toggle-kuromoji") {
      toggleKuromojiRawMode().catch((error) => {
        console.error("[Aozora Helper] kuromoji toggle failed", error);
      });
      return;
    }
    if (action === "run-llm") {
      runLlmFormatter().catch((error) => {
        console.error("[Aozora Helper] LLM formatter failed", error);
      });
      return;
    }

    if ((action === "mark-known" || action === "mark-unknown") && actionButton.dataset.base) {
      if (state.kuromojiRawMode) {
        return;
      }
      const base = actionButton.dataset.base;
      const shouldKnow = action === "mark-known";
      const payload = state.currentWords.find((word) => word.base === base) || { base };
      setWordKnownAndRerender(payload, shouldKnow).catch((error) => {
        console.error("[Aozora Helper] mark word failed", error);
      });
      return;
    }

    if ((action === "mark-grammar-known" || action === "mark-grammar-unknown") && actionButton.dataset.patternId) {
      if (state.kuromojiRawMode) {
        return;
      }
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
    if (state.kuromojiRawMode && vocabItem.dataset.rawSurface) {
      scrollToHighlightedSurface(vocabItem.dataset.rawSurface);
      return;
    }
    if (state.analysisMode === "llm" && vocabItem.dataset.surface) {
      scrollToHighlightedSurface(vocabItem.dataset.surface);
      return;
    }
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

  const analysisModeSelect = event.target.closest("select[data-action='analysis-mode']");
  if (analysisModeSelect) {
    applyAnalysisMode(analysisModeSelect.value);
    hideTooltip();
    persistLlmSettings().catch((error) => {
      console.warn("[Aozora Helper] analysis mode save failed", error);
    });
    renderCurrentChunk(false).catch((error) => {
      console.error("[Aozora Helper] analysis mode render failed", error);
    });
    return;
  }

  const llmProviderSelect = event.target.closest("select[data-action='llm-provider']");
  if (llmProviderSelect) {
    state.llmProvider = llmProviderSelect.value === "gemini" ? "gemini" : "openai";
    state.llmStatus = "Provider updated. Click 'LLM Format Chunk' to refresh highlights.";
    renderLlmState();
    persistLlmSettings().catch((error) => {
      console.warn("[Aozora Helper] LLM provider save failed", error);
    });
    return;
  }

  const llmOpenaiTierSelect = event.target.closest("select[data-action='llm-openai-tier']");
  if (llmOpenaiTierSelect) {
    state.llmOpenaiServiceTier = OPENAI_SERVICE_TIERS.includes(llmOpenaiTierSelect.value)
      ? llmOpenaiTierSelect.value
      : DEFAULT_OPENAI_SERVICE_TIER;
    state.llmStatus = "Pricing tier updated. Click 'LLM Format Chunk' to refresh highlights.";
    renderLlmState();
    persistLlmSettings().catch((error) => {
      console.warn("[Aozora Helper] OpenAI tier save failed", error);
    });
    return;
  }

  const displayModeSelect = event.target.closest("select[data-action='display-mode']");
  if (!displayModeSelect) {
    return;
  }
  changeDisplayMode(displayModeSelect.value);
}

function handlePanelInput(event) {
  const modelInput = event.target.closest("input[data-action='llm-openai-model']");
  if (modelInput) {
    state.llmOpenaiModel = modelInput.value.trim() || DEFAULT_OPENAI_MODEL;
    state.llmStatus = "Model updated. Click 'LLM Format Chunk' to refresh highlights.";
    renderLlmState();
    persistLlmSettings().catch((error) => {
      console.warn("[Aozora Helper] OpenAI model save failed", error);
    });
    return;
  }

  const learnerProfileInput = event.target.closest("input[data-action='llm-learner-profile']");
  if (learnerProfileInput) {
    state.llmLearnerProfile = learnerProfileInput.value.trim() || DEFAULT_LEARNER_PROFILE;
    state.llmStatus = "Learner profile updated. Click 'LLM Format Chunk' to refresh highlights.";
    renderLlmState();
    persistLlmSettings().catch((error) => {
      console.warn("[Aozora Helper] learner profile save failed", error);
    });
    return;
  }

  const keyInput = event.target.closest("input[data-action='llm-key']");
  if (keyInput) {
    state.llmApiKeys[state.llmProvider] = keyInput.value;
    persistLlmSettings().catch((error) => {
      console.warn("[Aozora Helper] LLM key save failed", error);
    });
    return;
  }

  const templateTextArea = event.target.closest("textarea[data-action='llm-template']");
  if (!templateTextArea) {
    return;
  }
  state.llmPromptTemplate = normalizePromptTemplate(templateTextArea.value);
  if (state.llmPromptTemplate !== templateTextArea.value) {
    renderLlmState();
  }
  persistLlmSettings().catch((error) => {
    console.warn("[Aozora Helper] LLM template save failed", error);
  });
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
  state.panel.addEventListener("input", handlePanelInput);
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
  await loadLlmSettings();
  await loadLlmChunkCache();
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
    analysisModeSelectEl: state.panel.querySelector("select[data-action='analysis-mode']"),
    modeToggleButtonEl: state.panel.querySelector("button[data-action='toggle-mode']"),
    kuromojiToggleButtonEl: state.panel.querySelector("button[data-action='toggle-kuromoji']"),
    vocabTitleEl: state.panel.querySelector("[data-role='vocab-title']"),
    llmProviderSelectEl: state.panel.querySelector("select[data-action='llm-provider']"),
    llmOpenaiModelInputEl: state.panel.querySelector("input[data-action='llm-openai-model']"),
    llmOpenaiTierSelectEl: state.panel.querySelector("select[data-action='llm-openai-tier']"),
    llmLearnerProfileInputEl: state.panel.querySelector("input[data-action='llm-learner-profile']"),
    llmKeyInputEl: state.panel.querySelector("input[data-action='llm-key']"),
    llmTemplateTextAreaEl: state.panel.querySelector("textarea[data-action='llm-template']"),
    llmRunButtonEl: state.panel.querySelector("button[data-action='run-llm']"),
    llmStatusEl: state.panel.querySelector("[data-role='llm-status']"),
    llmUsageEl: state.panel.querySelector("[data-role='llm-usage']"),
    llmCostEl: state.panel.querySelector("[data-role='llm-cost']"),
    llmPromptPreEl: state.panel.querySelector("[data-role='llm-prompt']"),
    llmResponsePreEl: state.panel.querySelector("[data-role='llm-response']")
  };

  applyDisplayMode(state.displayMode);
  applyAnalysisMode(state.analysisMode);
  applyKuromojiRawMode(state.kuromojiRawMode);
  renderLlmState();
  bindEvents();
  await renderCurrentChunk(false);
}

init().catch((error) => {
  console.error("[Aozora Helper] init failed", error);
});
