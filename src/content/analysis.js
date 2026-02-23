const RAW_TOKEN_PUNCT_RE = /^[\s。、！？・「」『』（）【】〈〉《》〔〕…―〜♪，．・]+$/u;
const MAX_LLM_VOCAB_ITEMS = 120;
const MAX_LLM_GRAMMAR_ITEMS = 120;
const MAX_LLM_SENTENCE_ITEMS = 80;

function toCleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function toCleanStringList(value, maxItems = 12) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => toCleanString(item))
    .filter(Boolean)
    .slice(0, maxItems);
}

function extractJsonPayloadText(responseText) {
  const raw = String(responseText || "").trim();
  if (!raw) {
    return "";
  }
  const fencedMatch = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fencedMatch?.[1]) {
    return fencedMatch[1].trim();
  }
  return raw;
}

function parseJsonPayload(responseText) {
  const candidate = extractJsonPayloadText(responseText);
  if (!candidate) {
    return null;
  }

  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

function findAnchoredIndex(text, target, before, after) {
  if (!target) {
    return -1;
  }
  const hasAnchors = Boolean(before || after);

  if (before && after) {
    const withBoth = `${before}${target}${after}`;
    const bothIndex = text.indexOf(withBoth);
    if (bothIndex >= 0) {
      return bothIndex + before.length;
    }
  }

  if (before) {
    const withBefore = `${before}${target}`;
    const beforeIndex = text.indexOf(withBefore);
    if (beforeIndex >= 0) {
      return beforeIndex + before.length;
    }
  }

  if (after) {
    const withAfter = `${target}${after}`;
    const afterIndex = text.indexOf(withAfter);
    if (afterIndex >= 0) {
      return afterIndex;
    }
  }

  if (hasAnchors) {
    return -1;
  }
  return text.indexOf(target);
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

function makeLlmGrammarId(item) {
  const seed = [
    toCleanString(item.title_zh),
    toCleanString(item.explain_zh),
    toCleanString(item.matched_text),
    toCleanString(item.anchor_before),
    toCleanString(item.anchor_after)
  ].join("::");
  return `llm-${hashText(seed)}`;
}

function normalizeLlmVocabItems(payload, chunkText) {
  if (!Array.isArray(payload)) {
    return [];
  }

  const words = [];
  for (let index = 0; index < payload.length; index += 1) {
    const item = payload[index];
    if (!item || typeof item !== "object") {
      continue;
    }

    const surface = toCleanString(item.surface_in_text);
    const base = toCleanString(item.lemma) || surface;
    const reading = toCleanString(item.reading_hira);
    const anchorBefore = toCleanString(item.anchor_before);
    const anchorAfter = toCleanString(item.anchor_after);
    if (!surface) {
      continue;
    }
    if (!chunkText.includes(surface)) {
      continue;
    }
    if (findAnchoredIndex(chunkText, surface, anchorBefore, anchorAfter) < 0) {
      continue;
    }

    const glosses = Array.isArray(item.zh_gloss)
      ? item.zh_gloss.map((entry) => toCleanString(entry)).filter(Boolean)
      : [];
    const hint = glosses.join(" / ");
    const noteZh = toCleanString(item.note_zh);

    words.push({
      surface,
      base,
      reading,
      hint,
      noteZh,
      anchorBefore,
      anchorAfter
    });
  }
  return words.slice(0, MAX_LLM_VOCAB_ITEMS);
}

function normalizeLlmGrammarItems(payload, chunkText) {
  if (!Array.isArray(payload)) {
    return [];
  }

  const patterns = [];
  for (let index = 0; index < payload.length; index += 1) {
    const item = payload[index];
    if (!item || typeof item !== "object") {
      continue;
    }

    const matchedText = toCleanString(item.matched_text);
    const titleZh = toCleanString(item.title_zh);
    const explainZh = toCleanString(item.explain_zh);
    const exampleJa = toCleanString(item.example_ja);
    const anchorBefore = toCleanString(item.anchor_before);
    const anchorAfter = toCleanString(item.anchor_after);
    if (!matchedText) {
      continue;
    }
    if (!chunkText.includes(matchedText)) {
      continue;
    }
    if (findAnchoredIndex(chunkText, matchedText, anchorBefore, anchorAfter) < 0) {
      continue;
    }

    const id = makeLlmGrammarId(item);
    patterns.push({
      id,
      name: titleZh || `Pattern ${index + 1}`,
      explanationZh: explainZh || "LLM grammar item",
      exampleJa,
      matchText: matchedText,
      anchorBefore,
      anchorAfter
    });
  }
  return patterns.slice(0, MAX_LLM_GRAMMAR_ITEMS);
}

function normalizeLlmSentenceItems(payload, chunkText) {
  if (!Array.isArray(payload)) {
    return [];
  }

  const rows = [];
  for (const item of payload) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const sentence = toCleanString(item.sentence_in_text || item.sentence_ja || item.sentence || item.jp_text);
    const anchorBefore = toCleanString(item.anchor_before);
    const anchorAfter = toCleanString(item.anchor_after);
    if (!sentence) {
      continue;
    }
    if (!chunkText.includes(sentence)) {
      continue;
    }
    if (findAnchoredIndex(chunkText, sentence, anchorBefore, anchorAfter) < 0) {
      continue;
    }

    const translationZh = toCleanString(item.translation_zh || item.zh_translation || item.translation);
    const structureZh = toCleanString(item.structure_zh || item.structure_note_zh || item.structure);
    const grammarHints = toCleanStringList(item.grammar_points || item.grammar_hints || item.grammar, 10);
    const vocabHints = toCleanStringList(item.vocab_focus || item.vocab_hints || item.vocab, 12);

    rows.push({
      sentence,
      translationZh,
      structureZh,
      grammarHints,
      vocabHints,
      anchorBefore,
      anchorAfter
    });
  }
  return rows.slice(0, MAX_LLM_SENTENCE_ITEMS);
}

function normalizeLlmTranslation(value) {
  return toCleanString(value);
}

function normalizeLlmChunkResultPayload(payload, chunkText) {
  return {
    words: normalizeLlmVocabItems(payload?.vocab, chunkText),
    patterns: normalizeLlmGrammarItems(payload?.grammar, chunkText),
    translationZh: normalizeLlmTranslation(payload?.translation_zh || payload?.chunk_translation_zh),
    sentenceAnalyses: normalizeLlmSentenceItems(payload?.sentence_analysis, chunkText)
  };
}

function normalizeLlmChunkPayload(responseText, chunkText) {
  const payload = parseJsonPayload(responseText);
  if (!payload || typeof payload !== "object") {
    return { words: [], patterns: [], translationZh: "", sentenceAnalyses: [] };
  }

  return normalizeLlmChunkResultPayload(payload, chunkText);
}

export function normalizeLlmBatchPayload(responseText, batchChunks) {
  const payload = parseJsonPayload(responseText);
  const chunkById = new Map(batchChunks.map((chunk) => [chunk.id, chunk]));
  const output = new Map();

  if (!payload || typeof payload !== "object") {
    for (const chunk of batchChunks) {
      output.set(chunk.id, { words: [], patterns: [], translationZh: "", sentenceAnalyses: [] });
    }
    return output;
  }

  if (Array.isArray(payload.results)) {
    for (const item of payload.results) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const chunkId = toCleanString(item.chunk_id);
      const chunk = chunkById.get(chunkId);
      if (!chunk) {
        continue;
      }
      output.set(chunkId, normalizeLlmChunkResultPayload(item, chunk.text));
    }
    for (const chunk of batchChunks) {
      if (!output.has(chunk.id)) {
        output.set(chunk.id, { words: [], patterns: [], translationZh: "", sentenceAnalyses: [] });
      }
    }
    return output;
  }

  if (batchChunks.length === 1) {
    output.set(batchChunks[0].id, normalizeLlmChunkPayload(responseText, batchChunks[0].text));
    return output;
  }

  for (const chunk of batchChunks) {
    output.set(chunk.id, { words: [], patterns: [], translationZh: "", sentenceAnalyses: [] });
  }
  return output;
}

export function toRawTokenEntry(token, index) {
  const surface = String(token?.surface_form || "").trim();
  const base = String(token?.basic_form && token.basic_form !== "*" ? token.basic_form : surface).trim();
  const reading = String(token?.reading && token.reading !== "*" ? token.reading : "").trim();
  const pos = String(token?.pos || "").trim();
  return {
    index,
    surface,
    base: base || surface,
    reading,
    pos
  };
}

export function toRawHighlightWords(rawTokens) {
  const seen = new Set();
  const words = [];
  for (const token of rawTokens) {
    if (!token.surface || RAW_TOKEN_PUNCT_RE.test(token.surface)) {
      continue;
    }
    if (seen.has(token.surface)) {
      continue;
    }
    seen.add(token.surface);
    words.push({
      surface: token.surface,
      base: token.base || token.surface,
      reading: token.reading || "",
      hint: token.pos ? `POS: ${token.pos}` : ""
    });
  }
  return words;
}
