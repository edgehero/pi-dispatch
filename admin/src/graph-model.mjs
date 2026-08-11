/**
 * The PURE side of the trigger/flow graph (issue #54): text scanners over skill content, and (next
 * slice) the model assembler every graph consumer renders from. No fs, no child_process, no redis,
 * no queue, no env -- read-model.mjs supplies bytes and joins, this module supplies meaning. The
 * purity is enforced by a source-regex test, the render.mjs/panel.mjs/costs.mjs pattern.
 */

// One frontmatter value line: `key: value`, an optional surrounding double quote, single-line only.
// The same block-isolation discipline as flow-gate.mjs's aiTriggerAllows, and deliberately NOT a YAML
// parser for the same recorded reason: two display strings do not justify js-yaml, and a scanner that
// accepts only what it understands cannot be driven into surprising shapes by hostile frontmatter.
const FRONTMATTER_BLOCK_RE = /^---\n([\s\S]*?)\n---(?:\n|$)/;

// Display values are CLIPPED, not refused: a viewer degrades. 120 chars covers every honest
// name/description and bounds what a hostile one can push into a panel row or an HTML tooltip.
const META_VALUE_MAX_CHARS = 120;

/**
 * Read a skill's display metadata (`name`, `description`) from its SKILL.md frontmatter.
 * Total function: any input shape yields `{ name, description }` with nulls, never a throw.
 */
export function parseSkillMeta(text) {
  const empty = { name: null, description: null };
  if (typeof text !== "string") return empty;
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const block = FRONTMATTER_BLOCK_RE.exec(normalized);
  if (!block) return empty;
  return {
    name: frontmatterValue(block[1], "name"),
    description: frontmatterValue(block[1], "description"),
  };
}

function frontmatterValue(block, key) {
  const m = new RegExp(`^${key}:[ \\t]*(.*)$`, "m").exec(block);
  if (!m) return null;
  let value = m[1].trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
  if (value === "") return null;
  return value.length > META_VALUE_MAX_CHARS ? `${value.slice(0, META_VALUE_MAX_CHARS)}…` : value;
}

// A mention is "strong" when it sits near chaining vocabulary -- the outbox protocol's own words.
// Distance, not co-occurrence-anywhere: a README-style skill that lists every sibling once should
// not promote all of them to likely chain targets.
const CHAIN_VOCAB_RE = /outbox|request-|"flow"|\bchain\b|follow-up/i;
const CHAIN_VOCAB_RADIUS = 200;

/**
 * Find which sibling skill names a skill's text mentions -- the heuristic half of the potential
 * flow->flow edge (the exact half is the target's own `ai-trigger: allow`). The name space makes
 * this workable where free-text search would not be: SKILL_NAME_RE names are a closed, enumerable
 * set the caller supplies, so this scans for a handful of known literals and nothing else.
 *
 * Boundary-matched against the SKILL NAME charset itself, not `\b`: a skill name may contain `-`,
 * and `\b` calls a hyphen a boundary, so `\bfix\b` would fire inside `prefix-fix` -- the lookarounds
 * refuse any neighbouring name-charset character instead. A name that is also an English word can
 * still false-positive in prose, which is exactly why these edges render as "potential" and never as
 * observed. Returns `[{ name, strong }]` in the callers' name order; total function, never throws.
 */
export function findSiblingMentions(text, siblingNames) {
  if (typeof text !== "string" || !Array.isArray(siblingNames)) return [];
  const mentions = [];
  for (const name of siblingNames) {
    if (typeof name !== "string" || name === "") continue;
    const re = new RegExp(`(?<![a-z0-9_-])${escapeRegExp(name)}(?![a-z0-9_-])`);
    const at = text.search(re);
    if (at === -1) continue;
    const windowStart = Math.max(0, at - CHAIN_VOCAB_RADIUS);
    const windowEnd = Math.min(text.length, at + name.length + CHAIN_VOCAB_RADIUS);
    mentions.push({ name, strong: CHAIN_VOCAB_RE.test(text.slice(windowStart, windowEnd)) });
  }
  return mentions;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
