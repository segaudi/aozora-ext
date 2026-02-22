export function normalizedTagName(node) {
  return (node?.tagName || "").toUpperCase();
}

export function tagNameIs(node, expectedTagName) {
  return normalizedTagName(node) === String(expectedTagName || "").toUpperCase();
}
