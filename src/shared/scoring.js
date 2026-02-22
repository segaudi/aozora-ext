const JP_PUNCT_OR_SYMBOL = /^[\s。、！？・「」『』（）【】〈〉《》〔〕…―〜♪，．・]+$/u;
const NUMERIC_ONLY = /^[0-9０-９]+$/u;
const KANJI_RE = /[一-龯々]/u;

function normalizeReading(token) {
  if (token.reading && token.reading !== "*") {
    return token.reading;
  }
  return "";
}

function normalizeBase(token) {
  const base = token.basic_form && token.basic_form !== "*" ? token.basic_form : token.surface_form;
  return base ? base.trim() : "";
}

function normalizeSurface(token) {
  const surface = token.surface_form || "";
  return surface.trim();
}

function shouldIgnoreToken(token) {
  const surface = normalizeSurface(token);
  const base = normalizeBase(token);
  const pos = token.pos || "";

  if (!surface || !base) {
    return true;
  }
  if (NUMERIC_ONLY.test(surface) || NUMERIC_ONLY.test(base)) {
    return true;
  }
  if (JP_PUNCT_OR_SYMBOL.test(surface)) {
    return true;
  }
  if (pos === "記号") {
    return true;
  }
  if (surface.length === 1 && (pos === "助詞" || pos === "助動詞")) {
    return true;
  }
  return false;
}

function toScoredToken(token, frequency, knownWords, stopwords) {
  const surface = normalizeSurface(token);
  const base = normalizeBase(token);

  let score = 0;
  if (!knownWords.has(base)) {
    score += 3;
  }
  if (KANJI_RE.test(surface) && surface.length >= 2) {
    score += 2;
  }
  if (frequency >= 2) {
    score += 1;
  }
  if (stopwords.has(base) || stopwords.has(surface)) {
    score -= 3;
  }

  return {
    surface,
    base,
    reading: normalizeReading(token),
    pos: token.pos || "",
    frequency,
    score
  };
}

export function fallbackTokenize(text) {
  const matches = text.match(/[一-龯々〆ヶぁ-んァ-ンー]{2,}/gu) || [];
  return matches.map((word) => ({
    surface_form: word,
    basic_form: word,
    reading: "",
    pos: "fallback"
  }));
}

export function scoreVocabularyTokens(tokens, knownWords, stopwords, maxWords) {
  const freqByBase = new Map();
  const filtered = [];

  for (const token of tokens) {
    if (shouldIgnoreToken(token)) {
      continue;
    }
    const base = normalizeBase(token);
    if (knownWords.has(base)) {
      continue;
    }
    freqByBase.set(base, (freqByBase.get(base) || 0) + 1);
    filtered.push(token);
  }

  const bestByBase = new Map();
  for (const token of filtered) {
    const base = normalizeBase(token);
    const frequency = freqByBase.get(base) || 1;
    const scored = toScoredToken(token, frequency, knownWords, stopwords);
    if (scored.score <= 0) {
      continue;
    }
    const prev = bestByBase.get(base);
    if (!prev || scored.score > prev.score || scored.frequency > prev.frequency) {
      bestByBase.set(base, scored);
    }
  }

  const ranked = [...bestByBase.values()].sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    if (b.frequency !== a.frequency) {
      return b.frequency - a.frequency;
    }
    return b.surface.length - a.surface.length;
  });

  return ranked.slice(0, maxWords);
}
