import { DEBUG_MESSAGE_TYPES } from "../shared/debug.js";

const ui = {
  enabled: document.querySelector("#enabled"),
  refresh: document.querySelector("#refresh"),
  clear: document.querySelector("#clear"),
  copy: document.querySelector("#copy"),
  status: document.querySelector("#status"),
  log: document.querySelector("#log")
};

let latestEntries = [];

function setStatus(text) {
  ui.status.textContent = text;
}

function sendMessage(type, payload = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, payload }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error || "Request failed"));
        return;
      }
      resolve(response);
    });
  });
}

function renderEntries(entries) {
  ui.log.replaceChildren();
  if (!entries.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No debug entries.";
    ui.log.appendChild(empty);
    return;
  }

  for (const entry of entries) {
    const item = document.createElement("div");
    item.className = "log-entry";

    const head = document.createElement("div");
    head.className = "head";

    const ts = document.createElement("span");
    ts.className = "ts";
    ts.textContent = entry.ts || "-";

    const source = document.createElement("span");
    source.className = "source";
    source.textContent = entry.source || "unknown";

    const level = document.createElement("span");
    level.className = `lvl-${entry.level || "info"}`;
    level.textContent = (entry.level || "info").toUpperCase();

    const event = document.createElement("span");
    event.className = "event";
    event.textContent = entry.event || "event";

    head.append(ts, source, level, event);

    const payload = document.createElement("pre");
    payload.textContent = JSON.stringify(
      {
        data: entry.data ?? {},
        sender: entry.sender ?? null
      },
      null,
      2
    );

    item.append(head, payload);
    ui.log.appendChild(item);
  }
}

async function refreshAll() {
  setStatus("Refreshing...");
  const [state, list] = await Promise.all([
    sendMessage(DEBUG_MESSAGE_TYPES.GET_STATE),
    sendMessage(DEBUG_MESSAGE_TYPES.LIST, { limit: 500 })
  ]);
  ui.enabled.checked = Boolean(state.enabled);
  latestEntries = list.entries || [];
  renderEntries([...latestEntries].reverse());
  setStatus(`Enabled: ${state.enabled ? "yes" : "no"} · Entries: ${latestEntries.length} · Newest first`);
}

ui.enabled.addEventListener("change", async () => {
  try {
    setStatus("Saving...");
    await sendMessage(DEBUG_MESSAGE_TYPES.SET_ENABLED, { enabled: ui.enabled.checked });
    await refreshAll();
  } catch (error) {
    setStatus(`Error: ${error instanceof Error ? error.message : String(error)}`);
  }
});

ui.refresh.addEventListener("click", () => {
  refreshAll().catch((error) => {
    setStatus(`Error: ${error instanceof Error ? error.message : String(error)}`);
  });
});

ui.clear.addEventListener("click", async () => {
  try {
    setStatus("Clearing...");
    await sendMessage(DEBUG_MESSAGE_TYPES.CLEAR);
    await refreshAll();
  } catch (error) {
    setStatus(`Error: ${error instanceof Error ? error.message : String(error)}`);
  }
});

ui.copy.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(JSON.stringify(latestEntries, null, 2));
    setStatus(`Copied ${latestEntries.length} entries.`);
  } catch (error) {
    setStatus(`Copy failed: ${error instanceof Error ? error.message : String(error)}`);
  }
});

refreshAll().catch((error) => {
  setStatus(`Error: ${error instanceof Error ? error.message : String(error)}`);
});

window.setInterval(() => {
  refreshAll().catch(() => {});
}, 3000);
