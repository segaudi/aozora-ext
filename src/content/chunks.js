import { normalizedTagName } from "../shared/dom.js";

const KNOWN_MAIN_SELECTORS = [
  "#main_text",
  ".main_text",
  "#honbun",
  ".honbun",
  "article.main_text",
  "article",
  "main"
];

const BLOCK_TAGS = new Set(["P", "DIV", "SECTION", "BLOCKQUOTE", "LI"]);
const SPLIT_BOUNDARY_MARKER_SELECTOR =
  "h1,h2,h3,h4,h5,h6,hr,.dai-midashi,.naka-midashi,.o-midashi,[class*='midashi'],[class*='chapter-title'],[class*='section-title']";
const HEADING_PREFIX_RE = /^(第[一二三四五六七八九十百千〇零0-9０-９]+[章編節回話]|[一二三四五六七八九十百千〇零0-9０-９]+(?:[、，.．]|$))/u;

function isLikelyBoilerplate(el) {
  if (!el) {
    return true;
  }
  if (el.closest("nav,header,footer,aside,form,[role='navigation']")) {
    return true;
  }
  const clue = `${el.id || ""} ${el.className || ""}`.toLowerCase();
  return /(nav|menu|header|footer|copyright|index|toc|sidebar|pager)/.test(clue);
}

function textLength(el) {
  const raw = (el.innerText || el.textContent || "").replace(/\s+/g, "");
  return raw.length;
}

function findMainByKnownSelectors(doc) {
  let best = null;
  let bestLen = 0;

  for (const selector of KNOWN_MAIN_SELECTORS) {
    const elements = [...doc.querySelectorAll(selector)];
    for (const el of elements) {
      if (isLikelyBoilerplate(el)) {
        continue;
      }
      const len = textLength(el);
      if (len > bestLen && len > 200) {
        best = el;
        bestLen = len;
      }
    }
  }
  return best;
}

function findLargestTextContainer(doc) {
  const candidates = [...doc.querySelectorAll("article,main,section,div,td")];
  let best = null;
  let bestScore = 0;

  for (const el of candidates) {
    if (isLikelyBoilerplate(el)) {
      continue;
    }
    const len = textLength(el);
    if (len < 200) {
      continue;
    }
    const linkPenalty = (el.querySelectorAll("a").length || 0) * 20;
    const score = len - linkPenalty;
    if (score > bestScore) {
      bestScore = score;
      best = el;
    }
  }

  return best;
}

function isChunkCandidate(el, root) {
  if (!el || !root.contains(el) || el === root) {
    return false;
  }
  if (!BLOCK_TAGS.has(normalizedTagName(el))) {
    return false;
  }
  if (isLikelyBoilerplate(el)) {
    return false;
  }
  if (el.closest("rt,rp")) {
    return false;
  }
  return textLength(el) >= 20;
}

function hasTextHeavyBlockChild(el) {
  for (const child of [...el.children]) {
    if (!BLOCK_TAGS.has(normalizedTagName(child))) {
      continue;
    }
    if (textLength(child) >= 20) {
      return true;
    }
  }
  return false;
}

function hasEnoughCoverage(candidates, container, minimumCoverage = 0.55) {
  if (!candidates.length) {
    return false;
  }
  const containerLen = textLength(container);
  if (containerLen <= 0) {
    return false;
  }
  const coveredLen = candidates.reduce((sum, el) => sum + textLength(el), 0);
  return coveredLen / containerLen >= minimumCoverage;
}

function countDirectBr(container) {
  return [...container.childNodes].filter(
    (node) => node.nodeType === Node.ELEMENT_NODE && normalizedTagName(node) === "BR"
  ).length;
}

function collectParagraphLikeChunks(container) {
  const paragraphs = [...container.querySelectorAll("p")].filter((p) => isChunkCandidate(p, container));
  if (paragraphs.length >= 1) {
    return paragraphs;
  }

  const directBrCount = countDirectBr(container);
  if (directBrCount >= 8) {
    const brSplitUnits = splitContainerByBr(container);
    if (brSplitUnits.length >= 2) {
      return brSplitUnits;
    }
  }

  const blockCandidates = [...container.querySelectorAll("div,section,blockquote,li")]
    .filter((el) => isChunkCandidate(el, container))
    .filter((el) => !hasTextHeavyBlockChild(el));

  if (blockCandidates.length >= 3 && hasEnoughCoverage(blockCandidates, container, 0.6)) {
    return blockCandidates;
  }

  const directChildren = [...container.children].filter((el) => isChunkCandidate(el, container));
  if (directChildren.length >= 2 && hasEnoughCoverage(directChildren, container, 0.7)) {
    return directChildren;
  }

  const brSplitUnits = splitContainerByBr(container);
  if (brSplitUnits.length >= 2) {
    return brSplitUnits;
  }

  return [container];
}

function getChunkTextFromClone(chunkEl) {
  const clone = chunkEl.cloneNode(true);
  clone.querySelectorAll("rt,rp").forEach((node) => node.remove());
  return (clone.textContent || "").replace(/\s+/g, " ").trim();
}

function isBrNode(node) {
  return node && node.nodeType === Node.ELEMENT_NODE && normalizedTagName(node) === "BR";
}

function textLengthFromNodes(nodes) {
  const text = nodes
    .map((node) => (node.textContent || ""))
    .join("")
    .replace(/\s+/g, "");
  return text.length;
}

function trimWhitespaceTextNodes(nodes) {
  let start = 0;
  let end = nodes.length;

  while (start < end) {
    const node = nodes[start];
    if (node.nodeType === Node.TEXT_NODE && !(node.nodeValue || "").trim()) {
      start += 1;
    } else {
      break;
    }
  }

  while (end > start) {
    const node = nodes[end - 1];
    if (node.nodeType === Node.TEXT_NODE && !(node.nodeValue || "").trim()) {
      end -= 1;
    } else {
      break;
    }
  }

  return nodes.slice(start, end);
}

function splitContainerByBr(container) {
  const childNodes = [...container.childNodes];
  if (!childNodes.length) {
    return [];
  }

  const segments = [];
  let current = [];

  for (const node of childNodes) {
    if (isBrNode(node)) {
      segments.push(trimWhitespaceTextNodes(current));
      current = [];
      continue;
    }
    current.push(node);
  }
  segments.push(trimWhitespaceTextNodes(current));

  const nonEmpty = segments.filter((segment) => textLengthFromNodes(segment) > 0);
  if (nonEmpty.length < 2) {
    return [];
  }

  const units = [];
  let carryShortNodes = [];

  const appendNodesToLatestOrNew = (nodes) => {
    if (!nodes.length) {
      return;
    }
    if (units.length) {
      for (const node of nodes) {
        units[units.length - 1].appendChild(node);
      }
      return;
    }
    const wrapper = document.createElement("div");
    wrapper.setAttribute("data-aozora-split-unit", "1");
    wrapper.className = "aozora-split-unit";
    container.insertBefore(wrapper, nodes[0]);
    for (const node of nodes) {
      wrapper.appendChild(node);
    }
    units.push(wrapper);
  };

  const createWrapperForNodes = (nodes) => {
    if (!nodes.length) {
      return null;
    }
    const wrapper = document.createElement("div");
    wrapper.setAttribute("data-aozora-split-unit", "1");
    wrapper.className = "aozora-split-unit";
    container.insertBefore(wrapper, nodes[0]);
    for (const node of nodes) {
      wrapper.appendChild(node);
    }
    units.push(wrapper);
    return wrapper;
  };

  const segmentText = (nodes) =>
    nodes
      .map((node) => (node.textContent || ""))
      .join("")
      .replace(/\s+/g, "")
      .trim();

  const segmentLooksLikeBoundary = (nodes) => {
    for (const node of nodes) {
      if (node.nodeType === Node.ELEMENT_NODE && node.matches?.(SPLIT_BOUNDARY_MARKER_SELECTOR)) {
        return true;
      }
      if (node.nodeType === Node.ELEMENT_NODE) {
        const markerDescendant = node.querySelector?.(SPLIT_BOUNDARY_MARKER_SELECTOR);
        if (markerDescendant) {
          return true;
        }
      }
    }
    const text = segmentText(nodes).slice(0, 20);
    return HEADING_PREFIX_RE.test(text);
  };

  for (const segment of segments) {
    if (!segment.length) {
      continue;
    }

    const isBoundarySegment = segmentLooksLikeBoundary(segment);
    if (isBoundarySegment) {
      appendNodesToLatestOrNew(carryShortNodes);
      carryShortNodes = [];
      createWrapperForNodes(segment);
      continue;
    }

    const merged = [...carryShortNodes, ...segment];
    const len = textLengthFromNodes(merged);
    if (len < 20) {
      carryShortNodes = merged;
      continue;
    }

    carryShortNodes = [];
    createWrapperForNodes(merged);
  }

  if (carryShortNodes.length) {
    appendNodesToLatestOrNew(carryShortNodes);
  }

  for (const node of [...container.childNodes]) {
    if (isBrNode(node)) {
      node.remove();
    }
  }

  return units;
}

export function buildTimedChunksFromUnits(units, targetChars) {
  const safeTargetChars = Math.max(1, targetChars || 1);
  const chunks = [];

  let current = [];
  let currentCharCount = 0;
  let currentTextParts = [];
  let startUnitIndex = -1;

  const flush = () => {
    if (!current.length) {
      return;
    }
    const endUnitIndex = current[current.length - 1].index;
    chunks.push({
      id: `${startUnitIndex}-${endUnitIndex}`,
      startUnitIndex,
      endUnitIndex,
      elements: current.map((item) => item.element),
      text: currentTextParts.join("\n"),
      charCount: currentCharCount
    });
    current = [];
    currentCharCount = 0;
    currentTextParts = [];
    startUnitIndex = -1;
  };

  for (const unit of units) {
    const prevUnit = current[current.length - 1] || null;
    if (prevUnit && unit.boundaryId !== undefined && prevUnit.boundaryId !== unit.boundaryId) {
      flush();
    }

    if (!current.length) {
      startUnitIndex = unit.index;
    }
    current.push(unit);
    currentCharCount += unit.charCount;
    currentTextParts.push(unit.text);

    if (currentCharCount >= safeTargetChars) {
      flush();
    }
  }

  flush();
  return chunks;
}

export function extractReadableChunks(doc = document) {
  const main = findMainByKnownSelectors(doc) || findLargestTextContainer(doc) || doc.body;
  const chunks = collectParagraphLikeChunks(main);

  return {
    mainContainer: main,
    chunks,
    getChunkText: getChunkTextFromClone
  };
}
