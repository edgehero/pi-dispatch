import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

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

// ---- reading the design cards (issue #752) ------------------------------------------------------------------------
// The console tests read the cards themselves, so a rebuilt card cannot drift from them unseen. A test that held a copy
// went on passing when its card moved (the ParkedPhone ledger listed question text for days after #769 dropped it).

const COMPONENTS = new URL("../../../design/system/components/", import.meta.url);
const SPOT_PANEL = /(?:^|[^a-z0-9-])((?:p|cf)-[a-z0-9]+(?:-[a-z0-9]+)*)(?![a-z0-9-])/g;

/** A card's preview, as committed. */
export const cardPreview = (card) => readFileSync(new URL(`${card}/preview.html`, COMPONENTS), "utf8");

/** A card's README, as committed. */
export const cardReadme = (card) => readFileSync(new URL(`${card}/README.md`, COMPONENTS), "utf8");

/** The panels a card's README lists: the ids in its `**Panels.**` line or `## Panels` section, in order. Empty when it lists none. */
export function cardReadmePanels(card) {
  const readme = cardReadme(card);
  const part = readme.match(/\*\*Panels\.\*\*([^\n]*)/)?.[1] ?? readme.match(/^## Panels\n+([\s\S]*?)(?=\n## |\n\*\*|$)/m)?.[1] ?? "";
  return [...new Set([...part.matchAll(/`([^`]+)`/g)].flatMap((m) => [...m[1].matchAll(SPOT_PANEL)].map((id) => id[1])))];
}

/** The panels a card's preview draws, in order. */
export function cardPreviewPanels(card) {
  return [...new Set([...cardPreview(card).matchAll(/\bid="((?:p|cf)-[a-z0-9-]+)"[^>]*\bdata-panel/g)].map((m) => m[1]))];
}

/** Every panel a card names or draws. */
export const cardPanels = (card) => [...new Set([...cardReadmePanels(card), ...cardPreviewPanels(card)])];

/**
 * The hash of a card's words: its README and its preview's visible text. Not its bytes, because a measured height or a
 * stylesheet rule moves on every rebuild and says nothing about what the card claims; and not its status ribbon, which
 * is the design's note about this repository rather than part of the screen.
 */
export function cardWords(card) {
  const preview = cardPreview(card).replace(/<div class="ds-status"[\s\S]*?<\/div>/g, "");
  const words = `${cardReadme(card)}\n${cardText(cardDocument(preview).source)}`.replace(/\s+/g, " ").trim();
  return createHash("sha256").update(words).digest("hex");
}

/** Markup with what only spelling separates taken out: the whitespace between tags, runs of it, and how `<use>` closes. */
const sameMarkup = (s) => String(s).replace(/>\s+</g, "><").replace(/\s+/g, " ").replace(/(<use [^>]*?)\/>/g, "$1></use>").trim();

/**
 * `sample`, a fragment a test keeps beside its assertion, after proving the named card still draws it. The fragment stays
 * readable where it is used, and a rebuild that moves the card fails here, naming the card, instead of leaving the test
 * pinned to a screen the design no longer has.
 */
export function onCard(card, sample) {
  assert.ok(sameMarkup(cardPreview(card)).includes(sameMarkup(sample)), `${card} no longer draws this fragment; re-read the card and update the test:\n${sample}`);
  return sample;
}
