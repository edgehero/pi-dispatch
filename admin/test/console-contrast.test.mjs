import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { colorOf, PULSE_TOKENS, PULSE_TOKENS_SHA256, tokenCss } from "../src/console/pulse-tokens.mjs";
import { PULSE_CSS } from "../src/console/pulse-css.mjs";
import { LEGACY_CSS, specificity } from "../src/console/compat-css.mjs";
import { capsule } from "../src/console/kit.mjs";
import { PAGE_CSS, SHELL_CSS, cssBlocks, pageCss, splitSelectors } from "../src/console/page-css.mjs";
import { CONSOLE_CSS } from "../src/console/style.mjs";
import { PARKED_CSS } from "../src/console/parked-css.mjs";
import { RUNS_CSS } from "../src/console/runs-css.mjs";

// The Pulse tokens (issue #737): the copy is the pinned design file, its two functions keep their contract, and every
// foreground the design system puts on a ground passes WCAG 2 contrast in both themes.
//
// WHERE THE PAIRS COME FROM. Three sources, merged, the higher ratio winning where two name the same pair:
// - each colour token's `usage` sentence (`usageContract`): its backticked token names are its grounds, "the same
//   grounds as `x`" means x's grounds, an explicit `N:1` is the ratio, and otherwise a text token needs 4.5:1 (WCAG
//   1.4.3) and any other token 3:1 (1.4.11);
// - the design bundle's tone classes (`TONE_RULES`): what `.tone-*` paints on what;
// - what the design states outside the usage sentences (`extraPairs`).
// The merged set is pinned as `PAIRS`, so a token edit that silently drops a pair fails here instead of nowhere, and
// every colour token is accounted for: in a pair, or in `NO_PAIR` with the reason it has none. A failing pair is a
// defect in the design system to raise with it, never a ratio to lower here.

const COLOR_TOKENS = PULSE_TOKENS.color.tokens;
const NAMES = COLOR_TOKENS.map((token) => token.name);
const TOKEN = new Map(COLOR_TOKENS.map((token) => [token.name, token]));
const THEMES = ["light", "dark"];

/** WCAG 2 relative luminance of `#rrggbb`. The spec's 0.03928 and sRGB's 0.04045 split no 8-bit value apart. */
function luminance(hex) {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!match) throw new Error(`not a #rrggbb colour: ${hex}`);
  const [r, g, b] = match.slice(1).map((pair) => {
    const c = parseInt(pair, 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The WCAG 2 contrast ratio of two colours, from 1 to 21, in either order. */
function contrast(a, b) {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
}

/** A token read as text or a glyph, which needs 4.5:1 unless its usage states a ratio. */
const isText = (name) =>
  ["ink", "ink-muted", "ink-faint"].includes(name) || name.endsWith("-ink") || name.startsWith("on-");

/**
 * A colour token's contract as its `usage` sentence states it: `grounds` (its backticked token names, with "the same
 * grounds as `x`" standing for x's grounds) and `ratio` (an explicit `N:1`, else 4.5 for text and 3 for anything else).
 * A sentence that names no ground gives none. The phrasings, all of which this reads: "3:1 on `surface` and
 * `surface-2`", "Primary text on `canvas`, `surface`, ...", "on the same grounds as `ink`", "4.5:1 on `surface` and
 * `surface-2`", "Text and icons on `primary`", "Text and glyphs that mean running, on `surface`, `surface-2` and
 * `running-tint`", "Text on a solid `running` fill".
 */
function usageContract(name, seen = []) {
  if (seen.includes(name)) throw new Error(`usage grounds loop: ${[...seen, name].join(" -> ")}`);
  const token = TOKEN.get(name);
  if (!token) throw new Error(`usage names ${name}, which is not a colour token`);
  const same = /same grounds as `([^`]+)`/.exec(token.usage);
  const inherited = same ? usageContract(same[1], [...seen, name]).grounds : [];
  const rest = same ? token.usage.replace(same[0], "") : token.usage;
  const own = [...rest.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
  const stated = /(\d+(?:\.\d+)?):1(?!\d)/.exec(token.usage);
  return { grounds: [...inherited, ...own], ratio: stated ? Number(stated[1]) : isText(name) ? 4.5 : 3 };
}

/**
 * The tone classes of the design bundle, `components/bundle.css` (the "tones" block, `.tone-running` to `.tone-idle`;
 * `PULSE_CSS` carries the same file verbatim): each sets `--tone`, `--tone-ink`, `--tone-tint` and `--on-tone` to these
 * tokens. `--tone-ink` is drawn on `--tone-tint` (`.badge`, `.tile`, `.chip`, `.outcome__w`) and `--on-tone` on a solid
 * `--tone` (`.badge--solid`, `.count`, `.outcome__mark`, `.cap__v`). DERIVED from `PULSE_CSS` (`toneRulesOf`), so a
 * bundle that repoints a tone is measured as it is, and PINNED to this table, so a tone that silently changes what it
 * paints fails by name. `idle` is the odd one, as the bundle writes it: its ink is `ink-muted`, its on-colour `ink`.
 */
const TONE_RULES_PINNED = Object.freeze({
  running: { tone: "running", ink: "running-ink", tint: "running-tint", on: "on-running" },
  parked: { tone: "parked", ink: "parked-ink", tint: "parked-tint", on: "on-parked" },
  failed: { tone: "failed", ink: "failed-ink", tint: "failed-tint", on: "on-failed" },
  refused: { tone: "refused", ink: "refused-ink", tint: "refused-tint", on: "on-refused" },
  attention: { tone: "attention", ink: "attention-ink", tint: "attention-tint", on: "on-attention" },
  ok: { tone: "ok", ink: "ok-ink", tint: "ok-tint", on: "on-ok" },
  idle: { tone: "idle", ink: "ink-muted", tint: "idle-tint", on: "ink" },
});

/** `.tone-<status> { --tone: var(--a); --tone-ink: var(--b); --tone-tint: var(--c); --on-tone: var(--d); }` rules of `css`. */
function toneRulesOf(css) {
  const out = {};
  for (const match of css.matchAll(/^\.tone-([a-z]+)\s*\{([^}]*)\}/gm)) {
    const decl = Object.fromEntries([...match[2].matchAll(/(--[a-z-]+)\s*:\s*var\(--([a-z0-9-]+)\)/g)].map((d) => [d[1], d[2]]));
    out[match[1]] = { tone: decl["--tone"], ink: decl["--tone-ink"], tint: decl["--tone-tint"], on: decl["--on-tone"] };
  }
  return out;
}

const TONE_RULES = Object.freeze(toneRulesOf(PULSE_CSS));

/**
 * What the design states outside the usage sentences: `focus` as the 2px keyboard ring on every page and card ground
 * (3:1) and as link text on a card or an inset (4.5:1), and the two body inks on every pastel ground, because a tinted
 * card, banner or diff line still carries ordinary text (`.banner__t`, `.banner__s`, `.d-del`, `.d-add`).
 *
 * And what the console adds: a page shown as last seen draws each panel's card flat (`page-css.mjs` `SHELL_CSS`), so
 * the words a card writes on its own ground sit on the canvas: the two body inks, the link
 * colour and every status ink (each tone's ink, as `TONE_RULES` reads them), at 4.5:1. The faint ink is re-pointed to
 * the muted one there, so it adds no pair. A secondary button's fill (`surface-3`) has no edge on the canvas (1.04:1 in
 * light), so such a panel rings its secondary controls in `line-strong`, held at 3:1 there (WCAG 1.4.11's for a
 * control's boundary).
 */
function extraPairs() {
  const tints = NAMES.filter((name) => name.endsWith("-tint"));
  const staleInks = [...new Set(["ink", "ink-muted", "focus", ...Object.values(TONE_RULES).map((rule) => rule.ink)])];
  return [
    ...["canvas", "surface", "surface-2", "surface-3"].map((bg) => ["focus", bg, 3, "focus ring"]),
    ...["surface", "surface-2"].map((bg) => ["focus", bg, 4.5, "link text"]),
    ...["ink", "ink-muted"].flatMap((fg) => tints.map((bg) => [fg, bg, 4.5, "text on a tint"])),
    ...staleInks.map((fg) => [fg, "canvas", 4.5, "a stale page's flat panel"]),
    ["line-strong", "canvas", 3, "a stale page's secondary button ring"],
  ];
}

/** Every pair from the three sources, one per foreground and ground, at the highest ratio any source asks. */
function derivedPairs() {
  const all = [];
  for (const name of NAMES) {
    const { grounds, ratio } = usageContract(name);
    for (const bg of grounds) all.push([name, bg, ratio, `${name}'s usage`]);
  }
  for (const [status, rule] of Object.entries(TONE_RULES)) {
    all.push([rule.ink, rule.tint, 4.5, `.tone-${status}`], [rule.on, rule.tone, 4.5, `.tone-${status}`]);
  }
  all.push(["on-primary", "primary", 4.5, ".btn--primary"]);
  all.push(...extraPairs());
  const merged = new Map();
  for (const [fg, bg, ratio, source] of all) {
    const prior = merged.get(`${fg} on ${bg}`);
    merged.set(`${fg} on ${bg}`, {
      fg,
      bg,
      ratio: Math.max(ratio, prior ? prior.ratio : 0),
      sources: [...(prior ? prior.sources : []), source],
    });
  }
  return [...merged.values()];
}

/** The derived set, pinned: `<foreground> on <ground> <ratio>`, sorted. */
const PAIRS = Object.freeze([
  "attention-ink on attention-tint 4.5",
  "attention-ink on canvas 4.5",
  "attention-ink on surface 4.5",
  "attention-ink on surface-2 4.5",
  "failed-ink on canvas 4.5",
  "failed-ink on failed-tint 4.5",
  "failed-ink on surface 4.5",
  "failed-ink on surface-2 4.5",
  "focus on canvas 4.5",
  "focus on surface 4.5",
  "focus on surface-2 4.5",
  "focus on surface-3 3",
  "ink on attention-tint 4.5",
  "ink on canvas 4.5",
  "ink on failed-tint 4.5",
  "ink on idle 4.5",
  "ink on idle-tint 4.5",
  "ink on ok-tint 4.5",
  "ink on parked-tint 4.5",
  "ink on refused-tint 4.5",
  "ink on running-tint 4.5",
  "ink on surface 4.5",
  "ink on surface-2 4.5",
  "ink on surface-3 4.5",
  "ink-faint on surface 4.5",
  "ink-faint on surface-2 4.5",
  "ink-muted on attention-tint 4.5",
  "ink-muted on canvas 4.5",
  "ink-muted on failed-tint 4.5",
  "ink-muted on idle-tint 4.5",
  "ink-muted on ok-tint 4.5",
  "ink-muted on parked-tint 4.5",
  "ink-muted on refused-tint 4.5",
  "ink-muted on running-tint 4.5",
  "ink-muted on surface 4.5",
  "ink-muted on surface-2 4.5",
  "ink-muted on surface-3 4.5",
  "line-strong on canvas 3",
  "line-strong on surface 3",
  "line-strong on surface-2 3",
  "ok-ink on canvas 4.5",
  "ok-ink on ok-tint 4.5",
  "ok-ink on surface 4.5",
  "ok-ink on surface-2 4.5",
  "on-attention on attention 4.5",
  "on-failed on failed 4.5",
  "on-ok on ok 4.5",
  "on-parked on parked 4.5",
  "on-primary on primary 4.5",
  "on-refused on refused 4.5",
  "on-running on running 4.5",
  "parked-ink on canvas 4.5",
  "parked-ink on parked-tint 4.5",
  "parked-ink on surface 4.5",
  "parked-ink on surface-2 4.5",
  "refused-ink on canvas 4.5",
  "refused-ink on refused-tint 4.5",
  "refused-ink on surface 4.5",
  "refused-ink on surface-2 4.5",
  "running-ink on canvas 4.5",
  "running-ink on running-tint 4.5",
  "running-ink on surface 4.5",
  "running-ink on surface-2 4.5",
]);

/**
 * The colour tokens with no pair of their own, and why. The status colours as marks (dots, ring arcs, bar fills,
 * timeline pills, legend keys) are not text, and the design never lets one carry a meaning alone: each sits beside its
 * glyph and its word, so the mark is not what a reader needs to tell the state, and WCAG 1.4.11 asks 3:1 only of a
 * graphic that is. They are still grounds for their `on-*` text, and those pairs are held above. Their measured
 * ratios on `surface` are `MARK_RATIOS`.
 */
const NO_PAIR = Object.freeze({
  line: "decorative only, as its usage says: a hairline between rows carries no information",
  running: "a mark, always paired with a glyph and a word",
  parked: "a mark, always paired with a glyph and a word",
  failed: "a mark, always paired with a glyph and a word",
  refused: "a mark, always paired with a glyph and a word",
  attention: "a mark, always paired with a glyph and a word",
  ok: "a mark, always paired with a glyph and a word",
  idle: "a mark, always paired with a glyph and a word",
  "dot-off": "the unlit part of a level (dot matrix, ring track, bar bed): the lit mark and the printed value carry it",
  "canvas-dot": "the dotted texture of the flow canvas: decorative, and nothing in bundle.css draws it yet",
});

/**
 * Each status mark's contrast on `surface`, measured, to two places. Recorded for the design review: in light,
 * `refused` (2.52), `attention` (2.00) and `idle` (2.66) are under 3:1, which is fine only because a mark never stands
 * alone (`NO_PAIR`).
 */
const MARK_RATIOS = Object.freeze({
  running: { light: 4.82, dark: 6.94 },
  parked: { light: 4.7, dark: 7.82 },
  failed: { light: 4.75, dark: 6.97 },
  refused: { light: 2.52, dark: 9.57 },
  attention: { light: 2, dark: 12.47 },
  ok: { light: 5.05, dark: 9.85 },
  idle: { light: 2.66, dark: 3.01 },
});

/** Every object and array inside `value`, `value` included. */
function* objectsIn(value) {
  if (value === null || typeof value !== "object") return;
  yield value;
  for (const member of Object.values(value)) yield* objectsIn(member);
}

test("the tokens are tokens.json verbatim: the copy hashes to the pinned file", () => {
  const digest = createHash("sha256").update(JSON.stringify(PULSE_TOKENS, null, 1)).digest("hex");
  assert.equal(digest, PULSE_TOKENS_SHA256, "PULSE_TOKENS no longer reproduces the pinned tokens.json");
});

test("the tokens are deep-frozen, every colour is #rrggbb in both themes, and the names are unique", () => {
  for (const value of objectsIn(PULSE_TOKENS)) assert.ok(Object.isFrozen(value), JSON.stringify(value).slice(0, 80));
  assert.deepEqual(PULSE_TOKENS.color.themes.map((theme) => theme.id), THEMES);
  assert.equal(new Set(NAMES).size, NAMES.length);
  for (const token of COLOR_TOKENS) {
    assert.deepEqual(Object.keys(token.value), THEMES, token.name);
    for (const theme of THEMES) assert.match(token.value[theme], /^#[0-9a-f]{6}$/, `${token.name} ${theme}`);
  }
});

test("colorOf answers every colour token in both themes and throws on any other name or theme", () => {
  for (const token of COLOR_TOKENS) {
    for (const theme of THEMES) assert.equal(colorOf(token.name, theme), token.value[theme]);
  }
  for (const name of ["Ink", "space-1", "font-sans", "__proto__", "constructor", "", undefined]) {
    assert.throws(() => colorOf(name, "light"), /unknown colour token/, String(name));
  }
  for (const theme of ["Light", "system", "__proto__", "constructor", "", undefined]) {
    assert.throws(() => colorOf("ink", theme), /unknown theme/, String(theme));
  }
});

test("tokenCss: light and the other tokens on :root, dark for the system unless forced light, and forced dark", () => {
  const rules = tokenCss().split("\n");
  assert.equal(rules.length, 3);
  const body = (rule, open, close) => {
    assert.ok(rule.startsWith(open) && rule.endsWith(close), rule.slice(0, 80));
    return rule.slice(open.length, -close.length).split(";");
  };
  const colours = (theme) => NAMES.map((name) => `--${name}:${colorOf(name, theme)}`);
  const { families } = PULSE_TOKENS.type;
  const others = [
    `--font-sans:${families.sans}`,
    `--font-mono:${families.mono}`,
    ...[PULSE_TOKENS.spacing, PULSE_TOKENS.radius, PULSE_TOKENS.layout].flatMap((group) =>
      group.tokens.map((token) => `--${token.name}:${token.value}`),
    ),
  ];
  assert.deepEqual(Object.keys(families), ["sans", "mono"]);
  const light = body(rules[0], ":root{", "}");
  const system = body(rules[1], `@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){`, "}}");
  const forced = body(rules[2], `:root[data-theme="dark"]{`, "}");
  assert.deepEqual(light, ["color-scheme:light", ...colours("light"), ...others]);
  assert.deepEqual(system, ["color-scheme:dark", ...colours("dark")]);
  assert.deepEqual(forced, system);
  // No token value can close its rule, open a tag or fetch anything (the CSP's `style-src 'self'` and the stylesheet
  // test's no-`url(` rule both assume it).
  for (const declaration of [...light, ...system]) assert.match(declaration, /^[a-z0-9-]+:[^;{}<>\\]+$/, declaration);
  assert.ok(!/url\(|@import/.test(tokenCss()));
});

test("the contrast ratio is WCAG 2's", () => {
  assert.ok(Math.abs(contrast("#000000", "#ffffff") - 21) < 1e-9);
  assert.equal(contrast("#ffffff", "#ffffff"), 1);
  const grey = contrast("#777777", "#ffffff");
  assert.ok(grey > 4.47 && grey < 4.49, String(grey));
  assert.equal(contrast("#777777", "#ffffff"), contrast("#ffffff", "#777777"));
  assert.throws(() => luminance("#fff"), /not a #rrggbb/);
});

test("the usage sentences name only colour tokens, and read as their words say", () => {
  for (const token of COLOR_TOKENS) {
    for (const [, named] of token.usage.matchAll(/`([^`]+)`/g)) assert.ok(TOKEN.has(named), `${token.name}: ${named}`);
  }
  assert.deepEqual(usageContract("ink"), { grounds: ["canvas", "surface", "surface-2", "surface-3"], ratio: 4.5 });
  assert.deepEqual(usageContract("ink-muted"), usageContract("ink"));
  assert.deepEqual(usageContract("ink-faint"), { grounds: ["surface", "surface-2"], ratio: 4.5 });
  assert.deepEqual(usageContract("line-strong"), { grounds: ["surface", "surface-2"], ratio: 3 });
  assert.deepEqual(usageContract("on-refused"), { grounds: ["refused"], ratio: 4.5 });
  assert.deepEqual(usageContract("ok-ink"), { grounds: ["surface", "surface-2", "ok-tint"], ratio: 4.5 });
  assert.deepEqual(usageContract("focus"), { grounds: [], ratio: 3 });
  for (const rule of Object.values(TONE_RULES)) {
    for (const name of Object.values(rule)) assert.ok(TOKEN.has(name), name);
  }
});

test("the tone rules are read from the pasted bundle, and are the pinned ones", () => {
  assert.deepEqual(TONE_RULES, TONE_RULES_PINNED);
  for (const rule of Object.values(TONE_RULES)) for (const name of Object.values(rule)) assert.ok(NAMES.includes(name), `${name} is a colour token`);
});

test("the derived pair set is the pinned one", () => {
  const derived = derivedPairs()
    .map((pair) => `${pair.fg} on ${pair.bg} ${pair.ratio}`)
    .sort();
  assert.deepEqual(derived, PAIRS);
});

test("every colour token is in a pair, or in NO_PAIR with its reason", () => {
  const pairs = derivedPairs();
  const inPair = new Set(pairs.flatMap((pair) => [pair.fg, pair.bg]));
  const foregrounds = new Set(pairs.map((pair) => pair.fg));
  for (const name of NAMES) {
    assert.ok(inPair.has(name) || Object.hasOwn(NO_PAIR, name), `${name} has no pair and no NO_PAIR reason`);
  }
  for (const [name, reason] of Object.entries(NO_PAIR)) {
    assert.ok(TOKEN.has(name), `NO_PAIR names ${name}, which is not a colour token`);
    assert.ok(reason.trim().length > 0, name);
    assert.ok(!foregrounds.has(name), `${name} is in NO_PAIR but is the foreground of a pair`);
  }
});

for (const theme of THEMES) {
  test(`every declared pair passes in the ${theme} theme`, () => {
    const failures = derivedPairs()
      .map((pair) => ({ ...pair, measured: contrast(colorOf(pair.fg, theme), colorOf(pair.bg, theme)) }))
      .filter((pair) => pair.measured < pair.ratio)
      .map((pair) => {
        const sources = pair.sources.join(", ");
        return `${pair.fg} on ${pair.bg}: ${pair.measured.toFixed(2)} < ${pair.ratio} (${sources})`;
      });
    assert.deepEqual(failures, []);
  });
}

test("the status mark ratios recorded beside NO_PAIR are measured", () => {
  assert.deepEqual(Object.keys(MARK_RATIOS), Object.keys(TONE_RULES));
  for (const [mark, recorded] of Object.entries(MARK_RATIOS)) {
    assert.equal(NO_PAIR[mark], "a mark, always paired with a glyph and a word");
    for (const theme of THEMES) {
      const measured = Number(contrast(colorOf(mark, theme), colorOf("surface", theme)).toFixed(2));
      assert.equal(measured, recorded[theme], `${mark} on surface, ${theme}`);
    }
  }
});

// ---- placement: where a page draws a pair the tokens hold only when the stylesheet puts it there -----------------------

/** `fg` laid over `bg` at `alpha`, channel by channel in sRGB, as a browser composites a fill's opacity. */
function over(fg, alpha, bg) {
  const ch = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const [f, b] = [ch(fg), ch(bg)];
  return `#${f.map((c, i) => Math.round(alpha * c + (1 - alpha) * b[i]).toString(16).padStart(2, "0")).join("")}`;
}

/** Every rule of `css` (inside `@media` too) as `[selector, body]`, one selector each. */
function rulesIn(css) {
  return cssBlocks(css).flatMap(({ prelude, body }) => (prelude.startsWith("@") ? (/^@media[\s(]/.test(prelude) ? rulesIn(body) : []) : splitSelectors(prelude).map((sel) => [sel, body])));
}

test("on the overview a running pill's host is at full opacity, so its label is the on-running on running pair (a placement check)", () => {
  // bundle.css draws a pill's second word (`.tp-sub`, the host a run is on) at 85% opacity, inside the running pill's
  // label: on its fill that is 3.94:1 in the light theme, under AA.
  assert.match(PULSE_CSS, /\n\.tp-sub \{[^}]*fill-opacity: \.85; \}/);
  assert.match(PULSE_CSS, /\n\.tp-l--run \{ fill: var\(--on-running\); \}/);
  assert.match(PULSE_CSS, /\n\.tp--run \{ fill: var\(--running\); \}/);
  const dimmed = contrast(over(colorOf("on-running", "light"), 0.85, colorOf("running", "light")), colorOf("running", "light"));
  assert.equal(dimmed.toFixed(2), "3.94");
  // The overview's page CSS, where the timeline is drawn, sets it to 1: served under the overview's body, after
  // bundle.css, and more specific than `.tp-sub`, so it wins wherever both apply on that page.
  const rule = 'body[data-page="overview"] .tp-l--run .tp-sub{fill-opacity:1}';
  assert.match(PAGE_CSS.overview, /\n\.tp-l--run \.tp-sub\{fill-opacity:1\}\n/);
  assert.ok(pageCss().split("\n").includes(rule));
  assert.ok(CONSOLE_CSS.indexOf(rule) > CONSOLE_CSS.indexOf(PULSE_CSS) + PULSE_CSS.length - 1, "after bundle.css");
  assert.ok(specificity('body[data-page="overview"] .tp-l--run .tp-sub') > specificity(".tp-sub"));
  // Nothing else in the console's own rules touches that opacity, so the effective one there is 1.
  const others = [SHELL_CSS, pageCss(), LEGACY_CSS].flatMap(rulesIn).filter(([sel, body]) => /\.tp-sub(?![\w-])/.test(sel) && /fill-opacity/.test(body));
  assert.deepEqual(others.map(([sel]) => sel), ['body[data-page="overview"] .tp-l--run .tp-sub']);
  // At full opacity the label is a pinned pair, which holds in both themes.
  assert.ok(PAIRS.includes("on-running on running 4.5"));
  for (const theme of THEMES) assert.ok(contrast(colorOf("on-running", theme), colorOf("running", theme)) >= 4.5, theme);
});

/** Each tone's ink, as bundle.css's tone classes set `--tone-ink` (the idle tone's is `ink-muted`). */
const TONE_INKS = [...new Set(Object.values(TONE_RULES_PINNED).map((rule) => rule.ink))];

/**
 * Where the runs and parked pages' own rules (PR 4: `runs-css.mjs`, `parked-css.mjs`) put a colour, and on what: every
 * declaration that sets a colour, by selector, property and value, with the pairs it draws (the ink on the ground it
 * sits on, or the inks drawn on a ground it sets). A `--tone-ink` ink is each tone's (`TONE_INKS`). The filter bar is on
 * the page's canvas, the strip and the question card on a card's `surface` (the strip's items on `surface-2` when a
 * pointer is over one), a chip on its `surface-2`.
 */
const PAGE_COLOURS = Object.freeze({
  runs: [
    [".filterbar .search:focus-within", "outline", "2px solid var(--focus)", ["focus on canvas"]],
    [".filterbar .select", "background-color", "var(--surface)", ["ink on surface"]],
    [".filterbar>.field>.input", "background", "var(--surface)", ["ink on surface", "ink-faint on surface"]],
    [".filterbar>.field>.input:focus-visible", "outline", "2px solid var(--focus)", ["focus on canvas"]],
    [".chip__x", "color", "var(--ink-muted)", ["ink-muted on surface-2"]],
    [".chip__x:hover", "color", "var(--ink)", ["ink on surface-2"]],
    ["a.sumstrip__i:hover", "background", "var(--surface-2)", ["ink on surface-2", "ink-muted on surface-2", ...TONE_INKS.map((ink) => `${ink} on surface-2`)]],
    [".sumstrip__i>b", "color", "var(--tone-ink,var(--ink))", ["ink on surface", "ink on surface-2", ...TONE_INKS.flatMap((ink) => [`${ink} on surface`, `${ink} on surface-2`])]],
    [".sumstrip__i.tone-idle>b", "color", "var(--ink)", ["ink on surface", "ink on surface-2"]],
    [".sumstrip__i>b>small", "color", "var(--ink-muted)", ["ink-muted on surface", "ink-muted on surface-2"]],
    [".sumstrip__i>span", "color", "var(--ink-muted)", ["ink-muted on surface", "ink-muted on surface-2"]],
    [".sumstrip__i>span>.ic", "color", "var(--tone-ink,var(--ink-muted))", ["ink-muted on surface", "ink-muted on surface-2", ...TONE_INKS.flatMap((ink) => [`${ink} on surface`, `${ink} on surface-2`])]],
    [".tbl .tbl-group>th", "background", "var(--surface-2)", ["ink-muted on surface-2"]],
    [".tbl .tbl-group>th", "color", "var(--ink-muted)", ["ink-muted on surface-2"]],
  ],
  parked: [
    [".qcard__wait", "color", "var(--parked-ink)", ["parked-ink on surface"]],
    [".qcard__meta", "color", "var(--ink-muted)", ["ink-muted on surface"]],
    [".qcard__body", "background", "var(--parked-tint)", ["ink on parked-tint"]],
    [".qcard__body", "color", "var(--ink)", ["ink on parked-tint"]],
  ],
});

test("the runs and parked pages' own colours are pinned pairs: each colour rule placed, each pair passing in both themes (a placement check)", () => {
  const COLOUR_PROPS = new Set(["color", "background", "background-color", "outline", "fill", "stroke", "box-shadow", "border", "border-color"]);
  for (const [page, css] of [["runs", RUNS_CSS], ["parked", PARKED_CSS]]) {
    // Every declaration of the page's rules that names a colour token, as `selector property value`.
    const found = rulesIn(css).flatMap(([sel, body]) => body.split(";").filter((d) => d.includes(":")).map((d) => [sel, d.slice(0, d.indexOf(":")).trim(), d.slice(d.indexOf(":") + 1).trim()]))
      .filter(([, prop, value]) => COLOUR_PROPS.has(prop) && /var\(--(?!space-|radius-|control-h|side-w|font-)/.test(value));
    const listed = PAGE_COLOURS[page];
    assert.deepEqual(found.map((d) => d.join(" ")).sort(), listed.map(([sel, prop, value]) => `${sel} ${prop} ${value}`).sort(), `${page}: every colour rule is placed, and only those`);
    for (const [sel, , , pairs] of listed) {
      assert.ok(pairs.length > 0, sel);
      for (const pair of pairs) {
        const m = /^(\S+) on (\S+)$/.exec(pair);
        assert.ok(PAIRS.some((p) => p.startsWith(`${pair} `)), `${page} ${sel}: ${pair} is a pinned pair`);
        const ratio = Number(PAIRS.find((p) => p.startsWith(`${pair} `)).split(" ").pop());
        for (const theme of THEMES) assert.ok(contrast(colorOf(m[1], theme), colorOf(m[2], theme)) >= ratio, `${page} ${sel}: ${pair} in ${theme}`);
      }
    }
  }
});

test("a capsule's percent is the on-status on status pair: its tone is on the svg the percent is drawn in (a placement check)", () => {
  // bundle.css paints the pill `--tone` and the percent `--on-tone`; the percent is the pill's sibling, not its child.
  assert.match(PULSE_CSS, /\n\.cap__pill \{ fill: var\(--tone\); \}/);
  assert.match(PULSE_CSS, /\n\.cap__v \{[^}]*fill: var\(--on-tone\); \}/);
  for (const [pct, tone] of [[10, "ok"], [85, "attention"], [100, "failed"]]) {
    const s = String(capsule({ name: "Jobs", window: "today", pct, hold: 80 }));
    // The tone class is on the <svg>, an ancestor of both the pill and the percent.
    assert.match(s, new RegExp(`<svg class="tone-${tone}"[^>]*>(?:(?!</svg>).)*<rect class="cap__pill"(?:(?!</svg>).)*<text class="cap__v"`), tone);
    assert.doesNotMatch(s, /class="cap__pill tone-/, "not on the pill alone, where the percent would not read it");
    assert.ok(PAIRS.includes(`on-${tone} on ${tone} 4.5`), tone);
    for (const theme of THEMES) assert.ok(contrast(colorOf(`on-${tone}`, theme), colorOf(tone, theme)) >= 4.5, `${tone} ${theme}`);
  }
  // On the pill alone (the card's markup) the percent read no tone and was SVG's default black: under AA in light.
  assert.equal(contrast("#000000", colorOf("ok", "light")).toFixed(2), "4.16");
  assert.equal(contrast("#000000", colorOf("failed", "light")).toFixed(2), "4.42");
});

test("a user transcript timestamp uses muted ink on its running tint, in both themes (#747 placement)", () => {
  assert.match(PULSE_CSS, /\n\.tx__t \{[^}]*color: var\(--ink-muted\);/);
  assert.match(PULSE_CSS, /\.tx__e--user[^}]*\{[^}]*background: var\(--running-tint\);/);
  assert.ok(PAIRS.includes("ink-muted on running-tint 4.5"));
  assert.equal(contrast(colorOf("ink-faint", "light"), colorOf("running-tint", "light")).toFixed(2), "4.30", "the old placement missed AA");
  for (const theme of THEMES) assert.ok(contrast(colorOf("ink-muted", theme), colorOf("running-tint", theme)) >= 4.5, theme);
});
