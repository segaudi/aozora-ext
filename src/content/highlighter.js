function shouldSkipTextNode(node) {
  if (!node || !node.nodeValue || !node.nodeValue.trim()) {
    return true;
  }
  const parent = node.parentElement;
  if (!parent) {
    return true;
  }
  if (parent.closest("rt,rp,script,style,noscript,textarea")) {
    return true;
  }
  if (parent.closest("[data-aozora-panel='1'],[data-aozora-tooltip='1']")) {
    return true;
  }
  if (parent.closest("span[data-aozora-hl='1']")) {
    return true;
  }
  return false;
}

function collectTextNodes(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      return shouldSkipTextNode(node) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
    }
  });

  const nodes = [];
  let current = walker.nextNode();
  while (current) {
    nodes.push(current);
    current = walker.nextNode();
  }
  return nodes;
}

function createHighlightSpan(options) {
  const span = document.createElement("span");
  span.setAttribute("data-aozora-hl", "1");
  span.setAttribute("data-aozora-hl-kind", options.kind || "word");
  span.className = options.kind === "pattern" ? "aozora-hl aozora-hl-pattern" : "aozora-hl aozora-hl-word";

  if (options.base) {
    span.dataset.base = options.base;
  }
  if (options.surface) {
    span.dataset.surface = options.surface;
  }
  if (options.reading) {
    span.dataset.reading = options.reading;
  }
  if (options.hint) {
    span.dataset.hint = options.hint;
  }
  if (options.patternId) {
    span.dataset.patternId = options.patternId;
  }
  if (options.patternName) {
    span.dataset.patternName = options.patternName;
  }
  if (options.explanation) {
    span.dataset.explanation = options.explanation;
  }

  return span;
}

export function clearHighlights(root) {
  const spans = [...root.querySelectorAll("span[data-aozora-hl='1']")];
  for (const span of spans) {
    const parent = span.parentNode;
    if (!parent) {
      continue;
    }
    while (span.firstChild) {
      parent.insertBefore(span.firstChild, span);
    }
    parent.removeChild(span);
  }
}

export function highlightLiteral(root, literal, options = {}) {
  const normalized = (literal || "").trim();
  if (!normalized) {
    return [];
  }

  const maxMatches = options.maxMatches ?? Number.POSITIVE_INFINITY;
  let remaining = maxMatches;
  const highlighted = [];
  const textNodes = collectTextNodes(root);

  for (const textNode of textNodes) {
    if (remaining <= 0) {
      break;
    }

    let currentNode = textNode;
    while (currentNode && remaining > 0) {
      const index = currentNode.nodeValue.indexOf(normalized);
      if (index < 0) {
        break;
      }

      const range = document.createRange();
      range.setStart(currentNode, index);
      range.setEnd(currentNode, index + normalized.length);

      const span = createHighlightSpan(options);
      try {
        range.surroundContents(span);
      } catch {
        break;
      }

      highlighted.push(span);
      remaining -= 1;
      const next = span.nextSibling;
      currentNode = next && next.nodeType === Node.TEXT_NODE ? next : null;
    }
  }

  return highlighted;
}

export function flashElement(el) {
  if (!el) {
    return;
  }
  el.classList.add("aozora-hl-flash");
  window.setTimeout(() => {
    el.classList.remove("aozora-hl-flash");
  }, 700);
}
