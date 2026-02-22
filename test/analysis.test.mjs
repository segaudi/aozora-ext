import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { normalizeLlmBatchPayload, toRawHighlightWords, toRawTokenEntry } from "../src/content/analysis.js";

function loadFixtureText() {
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  const fixturePath = path.resolve(thisDir, "../local_llm_test/test0_edogawa.htm");
  const html = readFileSync(fixturePath, "utf8");
  return html
    .replace(/<script[\s\S]*?<\/script>/giu, " ")
    .replace(/<style[\s\S]*?<\/style>/giu, " ")
    .replace(/<rt[\s\S]*?<\/rt>/giu, " ")
    .replace(/<rp[\s\S]*?<\/rp>/giu, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function pickSampleWord(text) {
  const words = text.match(/[^\x00-\x7F]{2,}/g) || [];
  return words[0] || "";
}

function contextAround(text, target, contextSize = 6) {
  const start = text.indexOf(target);
  if (start < 0) {
    return { before: "", after: "", start: -1 };
  }
  const before = text.slice(Math.max(0, start - contextSize), start);
  const after = text.slice(start + target.length, start + target.length + contextSize);
  return { before, after, start };
}

test("normalizeLlmBatchPayload accepts anchored vocab/grammar from fixture text", () => {
  const fixtureText = loadFixtureText();
  const firstMultibyte = fixtureText.search(/[^\x00-\x7F]/);
  const start = firstMultibyte >= 0 ? firstMultibyte : 0;
  const chunkText = fixtureText.slice(start, start + 2400);
  const surface = pickSampleWord(chunkText);
  assert.ok(surface.length >= 2);
  const wordCtx = contextAround(chunkText, surface);
  assert.ok(wordCtx.start >= 0);

  const matchedText = chunkText.slice(wordCtx.start, Math.min(chunkText.length, wordCtx.start + Math.max(surface.length + 8, 12)));
  const grammarCtx = contextAround(chunkText, matchedText);
  assert.ok(grammarCtx.start >= 0);

  const response = {
    template_version: "batch_v1",
    results: [
      {
        chunk_id: "chunk-0",
        vocab: [
          {
            surface_in_text: surface,
            reading_hira: "よみ",
            lemma: surface,
            zh_gloss: ["词义"],
            note_zh: "上下文说明",
            anchor_before: wordCtx.before,
            anchor_after: wordCtx.after
          }
        ],
        grammar: [
          {
            title_zh: "文法",
            explain_zh: "说明",
            example_ja: "例文です。",
            matched_text: matchedText,
            anchor_before: grammarCtx.before,
            anchor_after: grammarCtx.after
          }
        ]
      }
    ]
  };

  const parsed = normalizeLlmBatchPayload(JSON.stringify(response), [{ id: "chunk-0", text: chunkText }]);
  const result = parsed.get("chunk-0");
  assert.ok(result);
  assert.equal(result.words.length, 1);
  assert.equal(result.words[0].surface, surface);
  assert.equal(result.patterns.length, 1);
  assert.ok(result.patterns[0].id.startsWith("llm-"));
});

test("normalizeLlmBatchPayload grammar IDs are stable across ordering", () => {
  const chunkText = "吾輩は猫である。名前はまだ無い。";
  const target = "名前はまだ無い";
  const ctx = contextAround(chunkText, target, 4);
  assert.ok(ctx.start >= 0);

  const stableItem = {
    title_zh: "Stable ID",
    explain_zh: "说明",
    example_ja: "例文",
    matched_text: target,
    anchor_before: ctx.before,
    anchor_after: ctx.after
  };
  const extraItem = {
    title_zh: "Other",
    explain_zh: "说明",
    example_ja: "例文",
    matched_text: "吾輩は猫である",
    anchor_before: "",
    anchor_after: "。"
  };

  const responseA = JSON.stringify({
    results: [{ chunk_id: "c0", vocab: [], grammar: [stableItem] }]
  });
  const responseB = JSON.stringify({
    results: [{ chunk_id: "c0", vocab: [], grammar: [extraItem, stableItem] }]
  });
  const chunks = [{ id: "c0", text: chunkText }];

  const parsedA = normalizeLlmBatchPayload(responseA, chunks).get("c0");
  const parsedB = normalizeLlmBatchPayload(responseB, chunks).get("c0");
  const stableIdA = parsedA.patterns.find((item) => item.name === "Stable ID")?.id;
  const stableIdB = parsedB.patterns.find((item) => item.name === "Stable ID")?.id;

  assert.ok(stableIdA);
  assert.equal(stableIdA, stableIdB);
});

test("normalizeLlmBatchPayload rejects mismatched anchors", () => {
  const chunkText = "吾輩は猫である。";
  const response = JSON.stringify({
    results: [
      {
        chunk_id: "c0",
        vocab: [
          {
            surface_in_text: "吾輩",
            reading_hira: "わがはい",
            lemma: "吾輩",
            zh_gloss: ["我"],
            note_zh: "",
            anchor_before: "不存在",
            anchor_after: "猫"
          }
        ],
        grammar: []
      }
    ]
  });

  const parsed = normalizeLlmBatchPayload(response, [{ id: "c0", text: chunkText }]).get("c0");
  assert.equal(parsed.words.length, 0);
});

test("Kuromoji raw-mode helpers dedupe by surface and skip punctuation", () => {
  const fixtureText = loadFixtureText();
  const firstWord = pickSampleWord(fixtureText);
  const secondWord = (fixtureText.match(/[^\x00-\x7F]{2,}/g) || [])[1] || "token2";

  const rawTokens = [
    toRawTokenEntry({ surface_form: firstWord, basic_form: "*", reading: "*", pos: "名詞" }, 0),
    toRawTokenEntry({ surface_form: firstWord, basic_form: firstWord, reading: "ヨミ", pos: "名詞" }, 1),
    toRawTokenEntry({ surface_form: "。", basic_form: "。", reading: "", pos: "記号" }, 2),
    toRawTokenEntry({ surface_form: secondWord, basic_form: secondWord, reading: "", pos: "動詞" }, 3)
  ];

  const words = toRawHighlightWords(rawTokens);
  assert.equal(words.length, 2);
  assert.equal(words[0].surface, firstWord);
  assert.equal(words[0].base, firstWord);
  assert.equal(words[0].hint, "POS: 名詞");
  assert.equal(words[1].surface, secondWord);
});
