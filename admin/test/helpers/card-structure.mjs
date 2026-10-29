/** Minimal structural reader for our rendered HTML fixtures, with no browser or network dependency. */
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr", "use"]);
export function cardDocument(markup) {
  const source = String(markup).replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
  const stack = [];
  const nodes = [];
  const byId = new Map();
  const tags = /<!--[^]*?-->|<\/?[A-Za-z][^>]*>/g;
  for (const match of source.matchAll(tags)) {
    const token = match[0];
    if (token.startsWith("<!--")) continue;
    const tag = /^<\/?([A-Za-z][\w:-]*)/.exec(token)?.[1].toLowerCase();
    if (!tag) continue;
    if (token.startsWith("</")) {
      const at = stack.findLastIndex((node) => node.tag === tag);
      if (at !== -1) {
        for (const node of stack.splice(at)) node.end = match.index + token.length;
      }
      continue;
    }
    const attrs = {};
    for (const attr of token.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) attrs[attr[1]] = attr[2] ?? attr[3] ?? attr[4];
    const node = { tag, attrs, classes: (attrs.class ?? "").split(/\s+/).filter(Boolean), ancestors: [...stack], start: match.index, end: source.length };
    nodes.push(node);
    if (attrs.id) byId.set(attrs.id, node);
    if (!VOID.has(tag) && !token.endsWith("/>")) stack.push(node);
    else node.end = match.index + token.length;
  }
  return { source, nodes, byId, within: (node) => source.slice(node.start, node.end), descendants: (node) => nodes.filter((child) => child.ancestors.includes(node)) };
}
export function cardText(markup) {
  return String(markup).replace(/<[^>]*>/g, " ").replace(/&#(x[0-9a-f]+|\d+);/gi, (_, n) => String.fromCodePoint(n[0].toLowerCase() === "x" ? parseInt(n.slice(1), 16) : Number(n))).replace(/&(amp|lt|gt|quot|apos|#39|nbsp);/g, (_, name) => ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'", nbsp: " " })[name]).replace(/\s+/g, " ").trim();
}
