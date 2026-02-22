import { fallbackTokenize } from "../shared/scoring.js";
import { sendDebugLog } from "../shared/debug.js";

let tokenizerPromise = null;
let tokenizerInstance = null;
let initFailureCount = 0;
const MAX_INIT_FAILURES_LOG = 3;
const DIC_PATH_CANDIDATES = ["dict/", "dict"];

function getKuromojiGlobal() {
  if (typeof window !== "undefined" && window.kuromoji) {
    return window.kuromoji;
  }
  return null;
}

function getDictPathCandidates() {
  if (typeof chrome === "undefined" || !chrome.runtime?.getURL) {
    return [];
  }
  return DIC_PATH_CANDIDATES.map((path) => chrome.runtime.getURL(path));
}

function buildTokenizerWithPath(kuromoji, dicPath) {
  return new Promise((resolve, reject) => {
    try {
      kuromoji
        .builder({ dicPath })
        .build((error, tokenizer) => {
          if (error || !tokenizer) {
            reject(error || new Error("Kuromoji builder returned no tokenizer."));
            return;
          }
          resolve(tokenizer);
        });
    } catch (error) {
      reject(error);
    }
  });
}

function initTokenizer() {
  if (tokenizerInstance) {
    return Promise.resolve(tokenizerInstance);
  }
  if (tokenizerPromise) {
    return tokenizerPromise;
  }

  tokenizerPromise = (async () => {
    const kuromoji = getKuromojiGlobal();
    if (!kuromoji) {
      sendDebugLog("content.tokenizer", "warn", "kuromoji.global_missing");
      return null;
    }

    const dicPaths = getDictPathCandidates();
    if (!dicPaths.length) {
      initFailureCount += 1;
      sendDebugLog("content.tokenizer", "error", "kuromoji.dict_path_unavailable", {
        failureCount: initFailureCount
      });
      console.warn("[Aozora Helper] Chrome runtime URL API unavailable. Falling back to regex tokenization.");
      return null;
    }

    let lastError = null;
    for (const dicPath of dicPaths) {
      try {
        const tokenizer = await buildTokenizerWithPath(kuromoji, dicPath);
        tokenizerInstance = tokenizer;
        initFailureCount = 0;
        sendDebugLog("content.tokenizer", "info", "kuromoji.init_success", { dicPath });
        return tokenizer;
      } catch (error) {
        sendDebugLog("content.tokenizer", "warn", "kuromoji.init_path_failed", {
          dicPath,
          error: error instanceof Error ? error.message : String(error)
        });
        lastError = error;
      }
    }

    initFailureCount += 1;
    sendDebugLog("content.tokenizer", "error", "kuromoji.init_failed", {
      failureCount: initFailureCount,
      error: lastError instanceof Error ? lastError.message : String(lastError || "")
    });
    console.warn(
      `[Aozora Helper] kuromoji initialization failed (attempt ${initFailureCount}, threshold ${MAX_INIT_FAILURES_LOG}).` +
      " Falling back to regex tokenization.",
      lastError
    );
    return null;
  })().finally(() => {
    tokenizerPromise = null;
  });

  return tokenizerPromise;
}

function fallbackResult(text) {
  return {
    tokens: fallbackTokenize(text),
    source: "fallback"
  };
}

export async function tokenizeChunkText(text) {
  const tokenizer = await initTokenizer();
  if (!tokenizer) {
    if (!getKuromojiGlobal()) {
      console.warn("[Aozora Helper] kuromoji global not found. Falling back to regex tokenization.");
    }
    return fallbackResult(text);
  }

  try {
    const result = {
      tokens: tokenizer.tokenize(text),
      source: "kuromoji"
    };
    sendDebugLog("content.tokenizer", "info", "kuromoji.tokenize_success", {
      tokenCount: result.tokens.length
    });
    return result;
  } catch (error) {
    tokenizerInstance = null;
    initFailureCount += 1;
    sendDebugLog("content.tokenizer", "error", "kuromoji.tokenize_failed", {
      error: error instanceof Error ? error.message : String(error)
    });
    console.warn("[Aozora Helper] kuromoji tokenize failed. Falling back to regex tokenization.", error);
    return fallbackResult(text);
  }
}

export const __tokenizerTestOnly = {
  reset() {
    tokenizerPromise = null;
    tokenizerInstance = null;
    initFailureCount = 0;
  },
  getInitFailureCount() {
    return initFailureCount;
  }
};
