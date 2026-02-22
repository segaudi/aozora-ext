import test from "node:test";
import assert from "node:assert/strict";

import { __tokenizerTestOnly, tokenizeChunkText } from "../src/content/tokenizer.js";

async function withMockGlobals(fn) {
  const prevWindow = globalThis.window;
  const prevChrome = globalThis.chrome;
  try {
    return await fn();
  } finally {
    if (typeof prevWindow === "undefined") {
      delete globalThis.window;
    } else {
      globalThis.window = prevWindow;
    }
    if (typeof prevChrome === "undefined") {
      delete globalThis.chrome;
    } else {
      globalThis.chrome = prevChrome;
    }
    __tokenizerTestOnly.reset();
  }
}

test("tokenizeChunkText recovers from fallback once kuromoji becomes available", async () => {
  await withMockGlobals(async () => {
    globalThis.window = {};
    globalThis.chrome = {
      runtime: {
        getURL(path) {
          return `chrome-extension://test/${path}`;
        }
      }
    };

    const fallbackResult = await tokenizeChunkText("猫です");
    assert.equal(fallbackResult.source, "fallback");

    globalThis.window.kuromoji = {
      builder() {
        return {
          build(callback) {
            callback(null, {
              tokenize() {
                return [{ surface_form: "猫", basic_form: "猫", reading: "ネコ", pos: "名詞" }];
              }
            });
          }
        };
      }
    };

    const kuromojiResult = await tokenizeChunkText("猫です");
    assert.equal(kuromojiResult.source, "kuromoji");
    assert.equal(kuromojiResult.tokens[0].basic_form, "猫");
  });
});

test("tokenizeChunkText tries secondary dictionary path when first candidate fails", async () => {
  await withMockGlobals(async () => {
    const seenDicPaths = [];
    globalThis.chrome = {
      runtime: {
        getURL(path) {
          return `chrome-extension://test/${path}`;
        }
      }
    };
    globalThis.window = {
      kuromoji: {
        builder({ dicPath }) {
          seenDicPaths.push(dicPath);
          return {
            build(callback) {
              if (dicPath.endsWith("/dict/")) {
                callback(new Error("first path fail"), null);
                return;
              }
              callback(null, {
                tokenize() {
                  return [{ surface_form: "名前", basic_form: "名前", reading: "ナマエ", pos: "名詞" }];
                }
              });
            }
          };
        }
      }
    };

    const result = await tokenizeChunkText("名前");
    assert.equal(result.source, "kuromoji");
    assert.equal(seenDicPaths.length, 2);
  });
});
