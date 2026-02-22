import { fallbackTokenize } from "../shared/scoring.js";

let tokenizerPromise = null;

function getKuromojiGlobal() {
  if (typeof window !== "undefined" && window.kuromoji) {
    return window.kuromoji;
  }
  return null;
}

function initTokenizer() {
  if (tokenizerPromise) {
    return tokenizerPromise;
  }

  const kuromoji = getKuromojiGlobal();
  if (!kuromoji) {
    tokenizerPromise = Promise.resolve(null);
    return tokenizerPromise;
  }

  tokenizerPromise = new Promise((resolve) => {
    kuromoji
      .builder({
        dicPath: chrome.runtime.getURL("dict/")
      })
      .build((error, tokenizer) => {
        if (error || !tokenizer) {
          console.warn("[Aozora Helper] kuromoji initialization failed. Falling back to regex tokenization.", error);
          resolve(null);
          return;
        }
        resolve(tokenizer);
      });
  });

  return tokenizerPromise;
}

export async function tokenizeChunkText(text) {
  const tokenizer = await initTokenizer();
  if (!tokenizer) {
    if (!getKuromojiGlobal()) {
      console.warn("[Aozora Helper] kuromoji global not found. Falling back to regex tokenization.");
    }
    return {
      tokens: fallbackTokenize(text),
      source: "fallback"
    };
  }

  try {
    return {
      tokens: tokenizer.tokenize(text),
      source: "kuromoji"
    };
  } catch (error) {
    console.warn("[Aozora Helper] kuromoji tokenize failed. Falling back to regex tokenization.", error);
    return {
      tokens: fallbackTokenize(text),
      source: "fallback"
    };
  }
}
