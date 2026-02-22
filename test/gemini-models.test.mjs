import test from "node:test";
import assert from "node:assert/strict";
import { GEMINI_FREE_TIER_MODEL_CANDIDATES } from "../src/shared/gemini-models.js";

test("gemini free-tier model fallback order stays deterministic", () => {
  assert.deepEqual(GEMINI_FREE_TIER_MODEL_CANDIDATES, [
    "gemini-2.5-flash-lite",
    "gemini-2.5-flash",
    "gemma-3-27b-it"
  ]);
});

test("gemini free-tier model fallback list has no duplicates", () => {
  const uniqueCount = new Set(GEMINI_FREE_TIER_MODEL_CANDIDATES).size;
  assert.equal(uniqueCount, GEMINI_FREE_TIER_MODEL_CANDIDATES.length);
});
