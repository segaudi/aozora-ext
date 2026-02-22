export const DEBUG_STORAGE_KEY = "aozoraDebugEnabledV1";
export const DEBUG_MAX_ENTRIES = 500;

export const DEBUG_MESSAGE_TYPES = {
  LOG: "aozora-debug-log",
  GET_STATE: "aozora-debug-get-state",
  SET_ENABLED: "aozora-debug-set-enabled",
  LIST: "aozora-debug-list",
  CLEAR: "aozora-debug-clear"
};

const SECRET_KEY_RE = /(api[_-]?key|authorization|token|secret|password)/i;
const MAX_STRING_LENGTH = 2000;
const MAX_ARRAY_LENGTH = 50;
const MAX_OBJECT_KEYS = 50;
const MAX_DEPTH = 4;

function truncateString(value) {
  const text = String(value);
  if (text.length <= MAX_STRING_LENGTH) {
    return text;
  }
  return `${text.slice(0, MAX_STRING_LENGTH)}…[truncated ${text.length - MAX_STRING_LENGTH} chars]`;
}

function sanitizeValue(value, depth = 0) {
  if (value == null) {
    return value;
  }
  if (typeof value === "string") {
    return truncateString(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "bigint") {
    return String(value);
  }
  if (typeof value === "function") {
    return "[function]";
  }
  if (depth >= MAX_DEPTH) {
    return "[max-depth]";
  }

  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_LENGTH).map((item) => sanitizeValue(item, depth + 1));
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: truncateString(value.stack || "")
    };
  }

  if (typeof value === "object") {
    const output = {};
    const entries = Object.entries(value).slice(0, MAX_OBJECT_KEYS);
    for (const [key, raw] of entries) {
      if (SECRET_KEY_RE.test(key)) {
        output[key] = "[redacted]";
      } else {
        output[key] = sanitizeValue(raw, depth + 1);
      }
    }
    return output;
  }

  return String(value);
}

export function makeDebugEntry(source, level, event, data = {}) {
  return {
    ts: new Date().toISOString(),
    source: String(source || "unknown"),
    level: String(level || "info"),
    event: String(event || "event"),
    data: sanitizeValue(data)
  };
}

export function sendDebugLog(source, level, event, data = {}) {
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
    return;
  }
  const entry = makeDebugEntry(source, level, event, data);
  try {
    chrome.runtime.sendMessage({ type: DEBUG_MESSAGE_TYPES.LOG, payload: { entry } }, () => {
      void chrome.runtime?.lastError;
    });
  } catch {
    // Best-effort debug logging must never affect user flow.
  }
}
