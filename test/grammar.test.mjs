import test from "node:test";
import assert from "node:assert/strict";

import { detectGrammarPatterns } from "../src/shared/grammar.js";
import { scoreVocabularyTokens } from "../src/shared/scoring.js";
import { STOPWORDS } from "../src/shared/stopwords.js";
import { buildTimedChunksFromUnits } from "../src/content/chunks.js";
import { tagNameIs } from "../src/shared/dom.js";

test("detectGrammarPatterns finds high-value grammar rules", () => {
  const text = "雨が降っているので、出かけない。行ってもいいが、遅れてはいけない。";
  const patterns = detectGrammarPatterns(text, { topK: 6 });
  const names = patterns.map((item) => item.name);

  assert.ok(names.includes("ので"));
  assert.ok(names.includes("てもいい"));
  assert.ok(names.includes("てはいけない"));
});

test("scoreVocabularyTokens favors unknown kanji words", () => {
  const tokens = [
    { surface_form: "学校", basic_form: "学校", reading: "ガッコウ", pos: "名詞" },
    { surface_form: "学校", basic_form: "学校", reading: "ガッコウ", pos: "名詞" },
    { surface_form: "先生", basic_form: "先生", reading: "センセイ", pos: "名詞" },
    { surface_form: "する", basic_form: "する", reading: "スル", pos: "動詞" }
  ];

  const knownWords = new Set(["先生"]);
  const ranked = scoreVocabularyTokens(tokens, knownWords, STOPWORDS, 5);

  assert.equal(ranked[0].base, "学校");
  assert.equal(ranked.some((item) => item.base === "する"), false);
});

test("buildTimedChunksFromUnits combines short paragraphs up to target", () => {
  const units = [
    { index: 0, text: "a", charCount: 30, element: { id: "p0" } },
    { index: 1, text: "b", charCount: 25, element: { id: "p1" } },
    { index: 2, text: "c", charCount: 60, element: { id: "p2" } },
    { index: 3, text: "d", charCount: 20, element: { id: "p3" } }
  ];

  const chunks = buildTimedChunksFromUnits(units, 80);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].startUnitIndex, 0);
  assert.equal(chunks[0].endUnitIndex, 2);
  assert.equal(chunks[1].startUnitIndex, 3);
  assert.equal(chunks[1].endUnitIndex, 3);
});

test("buildTimedChunksFromUnits does not cross boundary ids", () => {
  const units = [
    { index: 0, text: "a", charCount: 60, boundaryId: 0, element: { id: "p0" } },
    { index: 1, text: "b", charCount: 60, boundaryId: 0, element: { id: "p1" } },
    { index: 2, text: "c", charCount: 60, boundaryId: 1, element: { id: "p2" } },
    { index: 3, text: "d", charCount: 60, boundaryId: 1, element: { id: "p3" } }
  ];

  const chunks = buildTimedChunksFromUnits(units, 500);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].startUnitIndex, 0);
  assert.equal(chunks[0].endUnitIndex, 1);
  assert.equal(chunks[1].startUnitIndex, 2);
  assert.equal(chunks[1].endUnitIndex, 3);
});

test("tagNameIs handles XHTML-style lowercase tag names", () => {
  assert.equal(tagNameIs({ tagName: "br" }, "BR"), true);
  assert.equal(tagNameIs({ tagName: "hr" }, "HR"), true);
  assert.equal(tagNameIs({ tagName: "div" }, "SECTION"), false);
});
