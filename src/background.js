import { DEBUG_MAX_ENTRIES, DEBUG_MESSAGE_TYPES, DEBUG_STORAGE_KEY, makeDebugEntry } from "./shared/debug.js";
import { GEMINI_FREE_TIER_MODEL_CANDIDATES } from "./shared/gemini-models.js";

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const OPENAI_DEFAULT_MODEL = "gpt-5-mini";
const ONE_MILLION = 1_000_000;
const FETCH_TIMEOUT_MS = 90_000;

const debugState = {
  enabled: false,
  entries: []
};

const OPENAI_TEXT_PRICING_PER_1M = {
  standard: {
    "gpt-5.2": { input: 1.75, cachedInput: 0.175, output: 14.0 },
    "gpt-5.1": { input: 1.25, cachedInput: 0.125, output: 10.0 },
    "gpt-5": { input: 1.25, cachedInput: 0.125, output: 10.0 },
    "gpt-5-mini": { input: 0.25, cachedInput: 0.025, output: 2.0 },
    "gpt-5-nano": { input: 0.05, cachedInput: 0.005, output: 0.4 },
    "gpt-5.2-chat-latest": { input: 1.75, cachedInput: 0.175, output: 14.0 },
    "gpt-5.1-chat-latest": { input: 1.25, cachedInput: 0.125, output: 10.0 },
    "gpt-5-chat-latest": { input: 1.25, cachedInput: 0.125, output: 10.0 },
    "gpt-5.2-codex": { input: 1.75, cachedInput: 0.175, output: 14.0 },
    "gpt-5.1-codex-max": { input: 1.25, cachedInput: 0.125, output: 10.0 },
    "gpt-5.1-codex": { input: 1.25, cachedInput: 0.125, output: 10.0 },
    "gpt-5-codex": { input: 1.25, cachedInput: 0.125, output: 10.0 },
    "gpt-5.2-pro": { input: 21.0, cachedInput: null, output: 168.0 },
    "gpt-5-pro": { input: 15.0, cachedInput: null, output: 120.0 },
    "gpt-4.1": { input: 2.0, cachedInput: 0.5, output: 8.0 },
    "gpt-4.1-mini": { input: 0.4, cachedInput: 0.1, output: 1.6 },
    "gpt-4.1-nano": { input: 0.1, cachedInput: 0.025, output: 0.4 },
    "gpt-4o": { input: 2.5, cachedInput: 1.25, output: 10.0 },
    "gpt-4o-2024-05-13": { input: 5.0, cachedInput: null, output: 15.0 },
    "gpt-4o-mini": { input: 0.15, cachedInput: 0.075, output: 0.6 },
    "gpt-realtime": { input: 4.0, cachedInput: 0.4, output: 16.0 },
    "gpt-realtime-mini": { input: 0.6, cachedInput: 0.06, output: 2.4 },
    "gpt-4o-realtime-preview": { input: 5.0, cachedInput: 2.5, output: 20.0 },
    o3: { input: 2.0, cachedInput: 0.5, output: 8.0 },
    "o4-mini": { input: 1.1, cachedInput: 0.275, output: 4.4 }
  },
  flex: {
    "gpt-5.2": { input: 0.875, cachedInput: 0.0875, output: 7.0 },
    "gpt-5.1": { input: 0.625, cachedInput: 0.0625, output: 5.0 },
    "gpt-5": { input: 0.625, cachedInput: 0.0625, output: 5.0 },
    "gpt-5-mini": { input: 0.125, cachedInput: 0.0125, output: 1.0 },
    "gpt-5-nano": { input: 0.025, cachedInput: 0.0025, output: 0.2 },
    "gpt-5.2-chat-latest": { input: 0.875, cachedInput: 0.0875, output: 7.0 },
    "gpt-5.1-chat-latest": { input: 0.625, cachedInput: 0.0625, output: 5.0 },
    "gpt-5-chat-latest": { input: 0.625, cachedInput: 0.0625, output: 5.0 },
    "gpt-5.2-codex": { input: 0.875, cachedInput: 0.0875, output: 7.0 },
    "gpt-5.1-codex-max": { input: 0.625, cachedInput: 0.0625, output: 5.0 },
    "gpt-5.1-codex": { input: 0.625, cachedInput: 0.0625, output: 5.0 },
    "gpt-5-codex": { input: 0.625, cachedInput: 0.0625, output: 5.0 },
    "gpt-5.2-pro": { input: 10.5, cachedInput: null, output: 84.0 },
    "gpt-5-pro": { input: 7.5, cachedInput: null, output: 60.0 },
    "gpt-4.1": { input: 1.0, cachedInput: 0.25, output: 4.0 },
    "gpt-4.1-mini": { input: 0.2, cachedInput: 0.05, output: 0.8 },
    "gpt-4.1-nano": { input: 0.05, cachedInput: 0.0125, output: 0.2 },
    "gpt-4o": { input: 1.25, cachedInput: 0.625, output: 5.0 },
    "gpt-4o-2024-05-13": { input: 2.5, cachedInput: null, output: 7.5 },
    "gpt-4o-mini": { input: 0.075, cachedInput: 0.0375, output: 0.3 },
    "gpt-realtime": { input: 2.0, cachedInput: 0.2, output: 8.0 },
    "gpt-realtime-mini": { input: 0.3, cachedInput: 0.03, output: 1.2 },
    "gpt-4o-realtime-preview": { input: 2.5, cachedInput: 1.25, output: 10.0 },
    o3: { input: 1.0, cachedInput: 0.25, output: 4.0 },
    "o4-mini": { input: 0.55, cachedInput: 0.138, output: 2.2 }
  }
};

function toNonNegativeNumber(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return 0;
  }
  return numeric;
}

function normalizeModelKey(model) {
  return String(model || "").trim().toLowerCase();
}

function findPricingModelKey(model, tierPricingTable) {
  const normalized = normalizeModelKey(model);
  if (!normalized) {
    return "";
  }
  if (tierPricingTable[normalized]) {
    return normalized;
  }

  const keys = Object.keys(tierPricingTable).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (normalized.startsWith(`${key}-`)) {
      return key;
    }
  }
  return "";
}

function extractOpenAiUsage(payload) {
  const usage = payload?.usage || {};
  const inputTokens = toNonNegativeNumber(usage.prompt_tokens ?? usage.input_tokens);
  const outputTokens = toNonNegativeNumber(usage.completion_tokens ?? usage.output_tokens);
  const cachedInputTokens = toNonNegativeNumber(
    usage.prompt_tokens_details?.cached_tokens ??
    usage.input_tokens_details?.cached_tokens ??
    usage.cached_input_tokens
  );

  const totalTokens = toNonNegativeNumber(
    usage.total_tokens ??
    usage.totalTokens ??
    inputTokens + outputTokens
  );

  return {
    inputTokens,
    outputTokens,
    totalTokens: totalTokens || inputTokens + outputTokens,
    cachedInputTokens
  };
}

function extractGeminiUsage(payload) {
  const usage = payload?.usageMetadata || {};
  const inputTokens = toNonNegativeNumber(usage.promptTokenCount);
  const outputTokens = toNonNegativeNumber(usage.candidatesTokenCount);
  const totalTokens = toNonNegativeNumber(usage.totalTokenCount) || inputTokens + outputTokens;
  const cachedInputTokens = toNonNegativeNumber(usage.cachedContentTokenCount);

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    cachedInputTokens
  };
}

function estimateOpenAiCost(model, tier, usage) {
  const tierPricing = OPENAI_TEXT_PRICING_PER_1M[tier] || OPENAI_TEXT_PRICING_PER_1M.flex;
  const pricingModelKey = findPricingModelKey(model, tierPricing);
  const pricing = pricingModelKey ? tierPricing[pricingModelKey] : null;
  if (!pricing) {
    return {
      tier,
      model,
      pricingModelKey: "",
      estimatedUsd: null,
      reason: "Pricing row not found for selected model."
    };
  }

  const inputTokens = toNonNegativeNumber(usage?.inputTokens);
  const outputTokens = toNonNegativeNumber(usage?.outputTokens);
  const cachedInputTokens = Math.min(inputTokens, toNonNegativeNumber(usage?.cachedInputTokens));
  const uncachedInputTokens = Math.max(0, inputTokens - cachedInputTokens);
  const cachedInputRate = pricing.cachedInput ?? pricing.input;

  const inputCost = (uncachedInputTokens * pricing.input) / ONE_MILLION;
  const cachedInputCost = (cachedInputTokens * cachedInputRate) / ONE_MILLION;
  const outputCost = (outputTokens * pricing.output) / ONE_MILLION;
  const estimatedUsd = inputCost + cachedInputCost + outputCost;

  return {
    tier,
    model,
    pricingModelKey,
    estimatedUsd,
    inputRatePer1M: pricing.input,
    cachedInputRatePer1M: cachedInputRate,
    outputRatePer1M: pricing.output
  };
}

function extractOpenAiText(payload) {
  const choice = payload?.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function extractGeminiText(payload) {
  const parts = payload?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) {
    return "";
  }
  return parts
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
}

function extractGeminiNoTextReason(payload) {
  const promptBlock = payload?.promptFeedback?.blockReason;
  if (promptBlock) {
    return `prompt blocked (${promptBlock})`;
  }
  const finishReason = payload?.candidates?.[0]?.finishReason;
  if (finishReason) {
    return `finish reason: ${finishReason}`;
  }
  return "no text candidate returned";
}

function previewText(value, maxLength = 1200) {
  const text = String(value || "");
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}…[truncated ${text.length - maxLength} chars]`;
}

function appendDebugEntry(entry, sender = null) {
  if (!debugState.enabled) {
    return;
  }
  const normalized = {
    ...entry,
    sender: sender?.url
      ? {
          url: sender.url,
          tabId: sender.tab?.id ?? null
        }
      : undefined
  };
  debugState.entries.push(normalized);
  if (debugState.entries.length > DEBUG_MAX_ENTRIES) {
    debugState.entries = debugState.entries.slice(debugState.entries.length - DEBUG_MAX_ENTRIES);
  }
}

function logDebug(source, level, event, data = {}, sender = null) {
  const entry = makeDebugEntry(source, level, event, data);
  appendDebugEntry(entry, sender);
}

function getStorageLocal() {
  if (typeof chrome !== "undefined" && chrome.storage?.local) {
    return chrome.storage.local;
  }
  return null;
}

function loadDebugEnabled() {
  const storage = getStorageLocal();
  if (!storage) {
    debugState.enabled = false;
    return;
  }
  storage.get([DEBUG_STORAGE_KEY], (result) => {
    if (chrome.runtime?.lastError) {
      return;
    }
    debugState.enabled = Boolean(result?.[DEBUG_STORAGE_KEY]);
  });
}

function persistDebugEnabled(enabled, onDone) {
  const storage = getStorageLocal();
  if (!storage) {
    debugState.enabled = enabled;
    onDone?.();
    return;
  }
  storage.set({ [DEBUG_STORAGE_KEY]: enabled }, () => {
    if (chrome.runtime?.lastError) {
      onDone?.(chrome.runtime.lastError);
      return;
    }
    debugState.enabled = enabled;
    onDone?.();
  });
}

function getManifestHostPermissions() {
  const manifest = chrome.runtime?.getManifest?.();
  return Array.isArray(manifest?.host_permissions) ? manifest.host_permissions : [];
}

function hasHostPermissionForEndpoint(endpoint) {
  const hostPermissions = getManifestHostPermissions();
  if (endpoint.includes("api.openai.com")) {
    return hostPermissions.some((value) => String(value).includes("api.openai.com"));
  }
  if (endpoint.includes("generativelanguage.googleapis.com")) {
    return hostPermissions.some((value) => String(value).includes("generativelanguage.googleapis.com"));
  }
  return true;
}

function formatNetworkError(provider, endpoint, error, context = {}) {
  const message = error instanceof Error ? error.message : String(error);
  const timeoutHint = context.timedOut
    ? `request timed out after ${Math.round((context.timeoutMs || FETCH_TIMEOUT_MS) / 1000)}s`
    : "network request failed";
  const permissionHint = hasHostPermissionForEndpoint(endpoint)
    ? "host permission present"
    : "host permission missing (reload unpacked extension after manifest changes)";
  const freeTierHint = provider === "Gemini" && context.timedOut
    ? " Free-tier queues can be slow; retrying or reducing prompt size may help."
    : "";
  return `${provider} network error (${timeoutHint}) at ${endpoint}. Detail: ${message}. ` +
    `${freeTierHint}` +
    `Check internet/VPN/firewall/adblock/proxy and verify extension service worker is active; ${permissionHint}.`;
}

async function fetchJsonWithTimeout(url, options, providerLabel) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort("request-timeout");
  }, FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    const payload = await response.json().catch(() => ({}));
    return { response, payload };
  } catch (error) {
    throw new Error(formatNetworkError(providerLabel, url, error, {
      timedOut,
      timeoutMs: FETCH_TIMEOUT_MS
    }));
  } finally {
    clearTimeout(timer);
  }
}

async function fetchOpenAi(apiKey, prompt, model, openaiServiceTier) {
  const { response, payload } = await fetchJsonWithTimeout(OPENAI_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      service_tier: openaiServiceTier,
      messages: [{ role: "user", content: prompt }]
    })
  }, "OpenAI");
  if (!response.ok) {
    const detail = payload?.error?.message || response.statusText || "OpenAI request failed";
    throw new Error(detail);
  }

  const text = extractOpenAiText(payload);
  if (!text.trim()) {
    throw new Error("OpenAI returned an empty response.");
  }
  const usage = extractOpenAiUsage(payload);
  const tierForPricing = openaiServiceTier === "default" ? "standard" : "flex";

  return {
    responseText: text,
    usage,
    cost: estimateOpenAiCost(model, tierForPricing, usage)
  };
}

async function fetchGemini(apiKey, prompt, sender = null) {
  const errors = [];

  for (const model of GEMINI_FREE_TIER_MODEL_CANDIDATES) {
    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}` +
      `:generateContent?key=${encodeURIComponent(apiKey)}`;

    let response;
    let payload;
    logDebug("background", "info", "gemini.candidate.start", { model }, sender);
    try {
      const result = await fetchJsonWithTimeout(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: "application/json"
          }
        })
      }, "Gemini");
      response = result.response;
      payload = result.payload;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      errors.push(`${model}: ${detail}`);
      logDebug("background", "warn", "gemini.candidate.network_error", {
        model,
        detail
      }, sender);
      continue;
    }

    if (!response.ok) {
      const detail = payload?.error?.message || response.statusText || "Gemini request failed";
      errors.push(`${model}: HTTP ${response.status} ${detail}`);
      logDebug("background", "warn", "gemini.candidate.http_error", {
        model,
        status: response.status,
        detail,
        payloadPreview: previewText(JSON.stringify(payload || {}))
      }, sender);
      continue;
    }

    const text = extractGeminiText(payload);
    if (!text.trim()) {
      const reason = extractGeminiNoTextReason(payload);
      errors.push(`${model}: empty response (${reason})`);
      logDebug("background", "warn", "gemini.candidate.empty_text", {
        model,
        reason,
        payloadPreview: previewText(JSON.stringify(payload || {}))
      }, sender);
      continue;
    }

    logDebug("background", "info", "gemini.candidate.success", {
      model,
      responsePreview: previewText(text)
    }, sender);
    return {
      responseText: text,
      usage: extractGeminiUsage(payload),
      cost: null,
      model
    };
  }

  throw new Error(
    `Gemini request failed for all free-tier model candidates: ${errors.join(" | ")}`
  );
}

async function runLlmRequest(payload, sender = null) {
  const provider = payload?.provider === "gemini" ? "gemini" : "openai";
  const apiKey = String(payload?.apiKey || "").trim();
  const prompt = String(payload?.prompt || "");
  const openaiModel = String(payload?.openaiModel || "").trim() || OPENAI_DEFAULT_MODEL;
  const openaiServiceTier = payload?.openaiServiceTier === "standard" ? "default" : "flex";

  if (!apiKey) {
    throw new Error("Missing API key.");
  }
  if (!prompt.trim()) {
    throw new Error("Prompt is empty.");
  }

  const debugMetadata = provider === "gemini"
    ? {
        provider,
        promptLength: prompt.length,
        modelCandidates: GEMINI_FREE_TIER_MODEL_CANDIDATES.slice()
      }
    : {
        provider,
        promptLength: prompt.length,
        model: openaiModel,
        tier: openaiServiceTier
      };
  logDebug("background", "info", "llm.request.start", debugMetadata, sender);

  if (provider === "gemini") {
    return fetchGemini(apiKey, prompt, sender);
  }
  return fetchOpenAi(apiKey, prompt, openaiModel, openaiServiceTier);
}

loadDebugEnabled();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === DEBUG_MESSAGE_TYPES.LOG) {
    const incoming = message?.payload?.entry;
    if (incoming && typeof incoming === "object") {
      appendDebugEntry(makeDebugEntry(incoming.source, incoming.level, incoming.event, incoming.data), sender);
    }
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === DEBUG_MESSAGE_TYPES.GET_STATE) {
    sendResponse({
      ok: true,
      enabled: debugState.enabled,
      count: debugState.entries.length,
      max: DEBUG_MAX_ENTRIES
    });
    return false;
  }

  if (message?.type === DEBUG_MESSAGE_TYPES.SET_ENABLED) {
    const enabled = Boolean(message?.payload?.enabled);
    persistDebugEnabled(enabled, (error) => {
      if (error) {
        sendResponse({ ok: false, error: error.message || String(error) });
        return;
      }
      logDebug("background", "info", "debug.toggle", { enabled }, sender);
      sendResponse({ ok: true, enabled });
    });
    return true;
  }

  if (message?.type === DEBUG_MESSAGE_TYPES.LIST) {
    const limit = Math.max(1, Math.min(2000, Number(message?.payload?.limit) || 300));
    const entries = debugState.entries.slice(-limit);
    sendResponse({ ok: true, entries });
    return false;
  }

  if (message?.type === DEBUG_MESSAGE_TYPES.CLEAR) {
    debugState.entries = [];
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type !== "aozora-llm-run") {
    return false;
  }

  runLlmRequest(message.payload, sender)
    .then((result) => {
      const provider = message?.payload?.provider === "gemini" ? "gemini" : "openai";
      logDebug("background", "info", "llm.request.success", {
        provider,
        providerModel: result?.model || "",
        usage: result?.usage || null,
        hasCost: Boolean(result?.cost),
        responseLength: String(result?.responseText || "").length,
        responsePreview: previewText(result?.responseText || "")
      }, sender);
      sendResponse({ ok: true, ...result });
    })
    .catch((error) => {
      logDebug("background", "error", "llm.request.error", {
        error: error instanceof Error ? error.message : String(error)
      }, sender);
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
    });

  return true;
});
