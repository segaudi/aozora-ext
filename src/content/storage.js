const KNOWN_WORDS_KEY = "aozoraKnownWordsV1";
const KNOWN_GRAMMAR_KEY = "aozoraKnownGrammarV1";

function getChromeStorage() {
  if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
    return chrome.storage.local;
  }
  return null;
}

function nowTs() {
  return Date.now();
}

function dedupeBy(entries, keyName) {
  const seen = new Set();
  const output = [];

  for (const entry of entries) {
    const key = entry?.[keyName];
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(entry);
  }

  return output;
}

function normalizeKnownWordEntries(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized = [];
  for (const item of value) {
    if (typeof item === "string") {
      const base = item.trim();
      if (!base) {
        continue;
      }
      normalized.push({ base, surface: base, reading: "", hint: "", updatedAt: 0 });
      continue;
    }

    if (!item || typeof item !== "object") {
      continue;
    }

    const base = String(item.base || "").trim();
    if (!base) {
      continue;
    }

    normalized.push({
      base,
      surface: String(item.surface || base),
      reading: String(item.reading || ""),
      hint: String(item.hint || ""),
      updatedAt: Number(item.updatedAt || 0)
    });
  }

  return dedupeBy(normalized, "base");
}

function normalizeKnownGrammarEntries(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized = [];
  for (const item of value) {
    if (typeof item === "string") {
      const id = item.trim();
      if (!id) {
        continue;
      }
      normalized.push({ id, name: id, explanationZh: "", updatedAt: 0 });
      continue;
    }

    if (!item || typeof item !== "object") {
      continue;
    }

    const id = String(item.id || "").trim();
    if (!id) {
      continue;
    }

    normalized.push({
      id,
      name: String(item.name || id),
      explanationZh: String(item.explanationZh || ""),
      updatedAt: Number(item.updatedAt || 0)
    });
  }

  return dedupeBy(normalized, "id");
}

async function readStorageKey(key) {
  const storage = getChromeStorage();

  if (storage) {
    return new Promise((resolve) => {
      storage.get([key], (result) => {
        if (chrome.runtime?.lastError) {
          console.warn("[Aozora Helper] storage read failed", chrome.runtime.lastError);
          resolve([]);
          return;
        }
        resolve(result?.[key] || []);
      });
    });
  }

  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : [];
  } catch (error) {
    console.warn("[Aozora Helper] localStorage read failed", error);
    return [];
  }
}

async function writeStorageKey(key, value) {
  const storage = getChromeStorage();

  if (storage) {
    return new Promise((resolve) => {
      storage.set({ [key]: value }, () => {
        if (chrome.runtime?.lastError) {
          console.warn("[Aozora Helper] storage write failed", chrome.runtime.lastError);
        }
        resolve();
      });
    });
  }

  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    console.warn("[Aozora Helper] localStorage write failed", error);
  }
}

function upsertLatestFirst(entries, keyName, nextEntry) {
  const keyValue = nextEntry[keyName];
  const filtered = entries.filter((item) => item[keyName] !== keyValue);
  return [{ ...nextEntry, updatedAt: nowTs() }, ...filtered];
}

function removeEntry(entries, keyName, keyValue) {
  return entries.filter((item) => item[keyName] !== keyValue);
}

export async function getKnownWordEntries() {
  const raw = await readStorageKey(KNOWN_WORDS_KEY);
  return normalizeKnownWordEntries(raw);
}

export async function getKnownGrammarEntries() {
  const raw = await readStorageKey(KNOWN_GRAMMAR_KEY);
  return normalizeKnownGrammarEntries(raw);
}

export async function getKnownWords() {
  const entries = await getKnownWordEntries();
  return new Set(entries.map((entry) => entry.base));
}

export async function getKnownGrammarIds() {
  const entries = await getKnownGrammarEntries();
  return new Set(entries.map((entry) => entry.id));
}

export async function setWordKnown(word, isKnown) {
  const entries = await getKnownWordEntries();
  const base = typeof word === "string" ? word : String(word?.base || "").trim();
  if (!base) {
    return { entries, set: new Set(entries.map((entry) => entry.base)) };
  }

  let nextEntries;
  if (isKnown) {
    const nextEntry = {
      base,
      surface: typeof word === "object" ? String(word.surface || base) : base,
      reading: typeof word === "object" ? String(word.reading || "") : "",
      hint: typeof word === "object" ? String(word.hint || "") : ""
    };
    nextEntries = upsertLatestFirst(entries, "base", nextEntry);
  } else {
    nextEntries = removeEntry(entries, "base", base);
  }

  await writeStorageKey(KNOWN_WORDS_KEY, nextEntries);
  return {
    entries: nextEntries,
    set: new Set(nextEntries.map((entry) => entry.base))
  };
}

export async function setGrammarKnown(grammar, isKnown) {
  const entries = await getKnownGrammarEntries();
  const id = typeof grammar === "string" ? grammar : String(grammar?.id || "").trim();
  if (!id) {
    return { entries, set: new Set(entries.map((entry) => entry.id)) };
  }

  let nextEntries;
  if (isKnown) {
    const nextEntry = {
      id,
      name: typeof grammar === "object" ? String(grammar.name || id) : id,
      explanationZh: typeof grammar === "object" ? String(grammar.explanationZh || "") : ""
    };
    nextEntries = upsertLatestFirst(entries, "id", nextEntry);
  } else {
    nextEntries = removeEntry(entries, "id", id);
  }

  await writeStorageKey(KNOWN_GRAMMAR_KEY, nextEntries);
  return {
    entries: nextEntries,
    set: new Set(nextEntries.map((entry) => entry.id))
  };
}
