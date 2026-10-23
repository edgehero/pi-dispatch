import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { COLLISIONS, LEGACY_CLASSES, LEGACY_CSS, NEUTRALISED, PD_TOKENS, SVG_EXTRA } from "../src/console/compat-css.mjs";
import { cssBlocks, selectorsOf, splitSelectors } from "../src/console/page-css.mjs";
// A static import, so a pages.mjs that stops exporting the list fails this file at load instead of skipping its checks.
import { LEGACY_PAGES, PAGES } from "../src/console/pages.mjs";
import { PULSE_CSS } from "../src/console/pulse-css.mjs";
import { loginCodePage, loginPage } from "../src/console/shell.mjs";
import { PAGE_THEME } from "../src/graph-html.mjs";
import { TONE_CLASS } from "../src/words.mjs";
import { ROLES, SHOTS } from "./helpers/console-pages-harness.mjs";

// The compatibility layer's ratchet (issue #737, `compat-css.mjs`). The layer is temporary, and these tests are what
// make it shrink: a rule whose class the old markup no longer emits fails, the collision neutraliser must equal what can
// still collide, a converted page may carry nothing of the layer, and once no page is legacy the layer must be gone.
//
// The old markup is read from its sources, not from the goldens alone, because the goldens draw only the states the
// fixture deployment reaches (no preview, no transcript entry kinds, one budget state).

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const FIXTURES = fileURLToPath(new URL("./fixtures/console/", import.meta.url));

/**
 * The files whose markup is the old markup: the panels (each page's module under `console/panels/` while its page is
 * legacy, the shared `common.mjs` while any page is), the transcript, the action previews, the document (`html.mjs`),
 * the page assembly (`pages.mjs`: the transcript section, the operators-only page) and the insights renderers. The
 * `panels.mjs` barrel only re-exports, so it is not read. The sign-in pages' old markup is not a file of its own: it is
 * the content `shell.mjs` puts in their `.legacy` box, read from the rendered pages by `signInLegacy` (reading
 * `shell.mjs` itself would count the Pulse frame's classes as old markup).
 */
function legacySources() {
  const files = ["console/transcript.mjs", "console/actions.mjs", "console/html.mjs", "console/pages.mjs", "insights-html.mjs", "graph-html.mjs"];
  for (const f of readdirSync(join(SRC, "console/panels")).filter((x) => x.endsWith(".mjs")).sort()) {
    const page = f.slice(0, -".mjs".length);
    if (page === "common" ? LEGACY_PAGES.length > 0 : LEGACY_PAGES.includes(page)) files.push(`console/panels/${f}`);
  }
  return files;
}

/** The inner HTML of each `<div class="legacy">` box in a page, its nested divs balanced. */
function legacyBoxes(html) {
  const boxes = [];
  const open = '<div class="legacy">';
  for (let at = html.indexOf(open); at !== -1; at = html.indexOf(open, at + 1)) {
    const tags = /<div\b|<\/div>/g;
    tags.lastIndex = at;
    let depth = 0;
    for (let m = tags.exec(html); m !== null; m = tags.exec(html)) {
      depth += m[0] === "</div>" ? -1 : 1;
      if (depth === 0) {
        boxes.push(html.slice(at + open.length, m.index));
        break;
      }
    }
  }
  return boxes;
}

/** The sign-in pages as drawn (they have no golden yet: PR 2 of issue #737 adds one with their conversion), by name. */
const SIGN_IN = Object.freeze({ login: String(loginPage()), "login-code": String(loginCodePage()) });

/** The old markup the sign-in pages draw: what their `.legacy` boxes hold, while they are legacy. */
function signInLegacy() {
  return Object.entries(SIGN_IN).filter(([name]) => LEGACY_PAGES.includes(name)).flatMap(([, html]) => legacyBoxes(html));
}

/**
 * A class built from a bare name (`class="${cls}"`): the values that name can hold, by name. Pinned both ways: every
 * such name found in the sources must be listed, and every value listed must still be a string the sources hold.
 */
const DYNAMIC = Object.freeze({
  cls: ["act", "note", "warn"],
  tone: [...Object.values(TONE_CLASS).filter((c) => c !== null), "good"],
});

/**
 * The classes the browser script puts on old markup: the preview's confirm bar, the transcript's status, the topology's
 * highlight. Listed, because the script builds them by string concatenation; each must still be a literal there. (The
 * live pill's classes are the shell's, not old markup.)
 */
const SCRIPT_CLASSES = Object.freeze(["confirm", "dim", "ended", "hi", "off", "on", "t-status"]);

const CLASS_TOKEN = /^[A-Za-z_][\w-]*$/;

/** The class tokens in a JavaScript expression: its string literals' words, a template's static words, its bare names. */
function expressionValues(expr, out) {
  const bare = /^\s*([A-Za-z_$][\w$]*)\s*$/.exec(expr);
  if (bare) {
    out.names.add(bare[1]);
    return;
  }
  for (const m of expr.matchAll(/"([^"\\]*)"|'([^'\\]*)'/g)) for (const t of (m[1] ?? m[2]).split(/\s+/)) if (CLASS_TOKEN.test(t)) out.classes.add(t);
  for (const m of expr.matchAll(/`([^`]*)`/g)) {
    for (const part of m[1].split(/\$\{([^}]*)\}/).map((p, i) => [p, i % 2 === 1])) {
      if (part[1]) expressionValues(part[0], out);
      else for (const t of part[0].split(/\s+/)) if (CLASS_TOKEN.test(t)) out.classes.add(t);
    }
  }
}

/**
 * Every class a source's markup can carry: each `class="..."` attribute (in a template literal or an escaped string),
 * its static words, and each `${...}` inside it read by `expressionValues`. A word glued to an expression
 * (`t-${kind}`) is a prefix: the class's ending is not known here.
 */
function classesOf(text) {
  const out = { classes: new Set(), names: new Set(), prefixes: new Set() };
  for (const m of text.matchAll(/class=(\\?)"/g)) {
    const escaped = m[1] === "\\";
    let i = m.index + m[0].length;
    let value = "";
    while (i < text.length) {
      if (text.startsWith("${", i)) {
        let depth = 1;
        let j = i + 2;
        while (j < text.length && depth > 0) {
          if (text[j] === "{") depth += 1;
          else if (text[j] === "}") depth -= 1;
          j += 1;
        }
        const expr = text.slice(i + 2, j - 1);
        if (/[\w-]$/.test(value) && /^\s*[A-Za-z_$][\w$]*\s*$/.test(expr)) out.prefixes.add(value.split(/\s+/).pop());
        else expressionValues(expr, out);
        value += " ";
        i = j;
        continue;
      }
      if (escaped ? text.startsWith('\\"', i) : text[i] === '"') break;
      value += text[i];
      i += 1;
    }
    for (const t of value.split(/\s+/)) if (CLASS_TOKEN.test(t)) out.classes.add(t);
  }
  return out;
}

/** The old markup's classes, by reading every legacy source and the script's own list; `problems` says what is unlisted. */
function legacyEmitted() {
  const all = { classes: new Set(), names: new Set(), prefixes: new Set(), problems: [] };
  const check = (ok, problem) => {
    if (!ok) all.problems.push(problem);
  };
  const texts = [];
  for (const text of [...legacySources().map((file) => readFileSync(join(SRC, file), "utf8")), ...signInLegacy()]) {
    texts.push(text);
    const got = classesOf(text);
    for (const k of ["classes", "names", "prefixes"]) for (const v of got[k]) all[k].add(v);
  }
  for (const name of all.names) {
    check(Object.hasOwn(DYNAMIC, name), `a class is built from \`${name}\`: list the values it can hold in DYNAMIC`);
    for (const v of DYNAMIC[name] ?? []) all.classes.add(v);
  }
  for (const [name, values] of Object.entries(DYNAMIC)) {
    check(all.names.has(name), `DYNAMIC.${name}: no class is built from it any more; drop the entry`);
    for (const v of values) check(texts.some((t) => t.includes(`"${v}"`)) || Object.values(TONE_CLASS).includes(v), `DYNAMIC.${name} lists "${v}", which no source holds`);
  }
  const script = readFileSync(join(SRC, "console/script.mjs"), "utf8");
  for (const c of SCRIPT_CLASSES) {
    check(new RegExp(`["']${c}[ "']`).test(script), `SCRIPT_CLASSES lists ${c}, which the script no longer sets`);
    all.classes.add(c);
  }
  return all;
}

/** A selector's classes, those only inside `:not(...)` and attribute values aside. */
const classesIn = (selector) => [...selector.replace(/:not\([^)]*\)/g, "").replace(/\[[^\]]*\]/g, "").matchAll(/\.([A-Za-z_][\w-]*)/g)].map((m) => m[1]);

/** bundle.css's selectors that can match the old markup: those naming at least one class, every one of them emitted. */
function reachable(emitted) {
  return [...new Set(selectorsOf(PULSE_CSS).filter((s) => classesIn(s).length > 0 && classesIn(s).every((c) => emitted.has(c))))].sort();
}

/** The leading `:where(.legacy) :is(...){all:revert}` rules' members, and the index of the first other rule. */
function neutraliserOf(css) {
  const blocks = cssBlocks(css);
  const members = [];
  let i = 0;
  for (; i < blocks.length; i += 1) {
    const m = /^:where\(\.legacy\) :is\((.*)\)$/.exec(blocks[i].prelude);
    if (!m || blocks[i].body !== "all:revert") break;
    members.push(...splitSelectors(m[1]));
  }
  return { members, rest: blocks.slice(i) };
}

const EMITTED = legacyEmitted();

test("the class scan reads the old markup: static, escaped, ternary and template-built classes", () => {
  const got = classesOf('html`<p class="big${n > 0 ? " warn" : ""}">` + `<td class="${tone}">` + "<i class=\\"a b\\">" + `<g class="${w ? "gwire gcron" : "gwire"}">` + `<x class="t-${kind}">`');
  assert.deepEqual([...got.classes].sort(), ["a", "b", "big", "gcron", "gwire", "t-", "warn"].sort());
  assert.deepEqual([...got.names], ["tone"], "a bare name is resolved through DYNAMIC");
  assert.deepEqual([...got.prefixes], ["t-"], "a word glued to a name is a prefix");
  assert.deepEqual(EMITTED.problems, [], "every class the old markup builds at run time is accounted for");
  for (const c of ["note", "warn", "mono", "kpi", "wl", "bl", "cap", "t-entry", "preview-area", "act", "good", "transcript-section"]) assert.ok(EMITTED.classes.has(c), `${c} is old markup`);
});

test("a class glued to a run-time value never collides: bundle.css styles no class with that prefix", () => {
  const bundle = new Set(selectorsOf(PULSE_CSS).flatMap(classesIn));
  for (const prefix of EMITTED.prefixes) {
    assert.deepEqual([...bundle].filter((c) => c.startsWith(prefix)), [], `bundle.css styles a class starting ${prefix}, which old markup builds at run time`);
  }
});

test("the neutraliser is first and covers exactly the bundle.css selectors the old markup can still match", () => {
  assert.deepEqual([...NEUTRALISED].sort(), reachable(EMITTED.classes), "NEUTRALISED is the derived set: add what can collide, drop what no longer can");
  assert.deepEqual(COLLISIONS, [...new Set(NEUTRALISED.map((s) => classesIn(s)[0]))].sort(), "the collisions are the classes the neutralised selectors start with");
  for (const c of ["banner", "kpi", "badge", "cap", "wl", "big", "note", "facts", "pager", "diff", "confirm", "phases"]) assert.ok(COLLISIONS.includes(c), `.${c} collides`);
  const { members, rest } = neutraliserOf(LEGACY_CSS);
  assert.ok(LEGACY_CSS.startsWith(":where(.legacy) :is("), "the neutraliser is the layer's first rule");
  assert.deepEqual([...members].sort(), [...NEUTRALISED].sort(), "every neutralised selector, once");
  assert.equal(new Set(members).size, members.length);
  assert.ok(!rest.some((b) => /all\s*:\s*revert/.test(b.body)), "no revert after the neutraliser, which would undo the old rules");
});

test("every rule of the layer is confined to .legacy, and every class it names is still old markup (a dead rule fails)", () => {
  for (const s of selectorsOf(LEGACY_CSS)) assert.match(s, /^(?:\.legacy(?![\w-])|:where\(\.legacy\) )/, `${s} is inside .legacy`);
  assert.deepEqual(LEGACY_CLASSES, [...new Set(selectorsOf(LEGACY_CSS).flatMap(classesIn))].filter((c) => c !== "legacy").sort());
  const dead = LEGACY_CLASSES.filter((c) => !EMITTED.classes.has(c));
  assert.deepEqual(dead, [], "a class the layer styles that no old markup emits: delete its rule");
  // The checks words.test.mjs and insights-html.test.mjs make on the served stylesheet still hold, inside .legacy.
  for (const needle of [".legacy .warn{", ".legacy .bad{", ".legacy .good{", ".legacy #split{"]) assert.ok(LEGACY_CSS.includes(needle), needle);
});

test("the old palette follows the theme: each role is a Pulse token, and every chart colour the renderers draw is re-pointed", () => {
  assert.deepEqual(PD_TOKENS, {
    canvas: "canvas",
    panel: "surface",
    border: "line",
    fg: "ink",
    dim: "ink-muted",
    accent: "focus",
    amber: "attention-ink",
    danger: "failed-ink",
    green: "ok-ink",
    chipStroke: "line-strong",
    bannerBg: "failed-tint",
    control: "surface-3",
  });
  for (const role of Object.keys(PAGE_THEME)) assert.ok(Object.hasOwn(PD_TOKENS, role), `PAGE_THEME.${role} has a token`);
  // The renderers' every colour literal, against the palette plus SVG_EXTRA: a new colour fails until it is mapped, and a
  // mapping for a colour no renderer draws any more fails until it is dropped.
  const literals = new Set();
  for (const file of ["graph-html.mjs", "insights-html.mjs"]) for (const m of readFileSync(join(SRC, file), "utf8").matchAll(/["'](#[0-9a-fA-F]{3,8})["']/g)) literals.add(m[1]);
  assert.deepEqual([...literals].sort(), [...new Set([...Object.values(PAGE_THEME), ...Object.keys(SVG_EXTRA)])].sort());
  for (const hex of literals) {
    assert.ok(LEGACY_CSS.includes(`.legacy svg [fill="${hex}"]{fill:var(--`), `fill ${hex} is re-pointed`);
    assert.ok(LEGACY_CSS.includes(`.legacy svg [stroke="${hex}"]{stroke:var(--`), `stroke ${hex} is re-pointed`);
  }
  assert.ok(LEGACY_CSS.includes('.legacy svg [fill="#58a6ff"]{fill:var(--pd-accent)}'));
  assert.ok(LEGACY_CSS.includes(".legacy{--pd-canvas:var(--canvas);"), "the old properties are defined on the wrapper, from tokens");
});

test("/insights fits a phone: the chart grids are one column there, and only a chart that can scale is shrunk", () => {
  const phone = cssBlocks(LEGACY_CSS).filter((b) => /^@media \(max-width: 760px\)$/.test(b.prelude)).map((b) => b.body).join("");
  assert.match(phone, /\.legacy #grid,\.legacy #flows,\.legacy #sizes\{grid-template-columns:minmax\(0,1fr\)\}/);
  assert.match(phone, /\.legacy svg\[viewBox\]\{max-width:100%;height:auto\}/);
  assert.match(phone, /\.legacy section\[data-panel\] section\{overflow-x:auto\}/, "a pixel-drawn chart scrolls in its section instead of being cropped");
});

test("the sign-in pages' old markup is read from their .legacy boxes, one per page while it is legacy", () => {
  for (const [name, html] of Object.entries(SIGN_IN)) assert.equal(legacyBoxes(html).length, LEGACY_PAGES.includes(name) ? 1 : 0, name);
  assert.ok(signInLegacy().some((box) => box.includes('<form id="login-form"')), "the sign-in form is in what the scan reads");
});

test("an empty LEGACY_PAGES leaves no legacy layer: the last converted page deletes it", () => {
  assert.ok(Array.isArray(LEGACY_PAGES) && Object.isFrozen(LEGACY_PAGES), "LEGACY_PAGES is a frozen list of page names");
  if (LEGACY_PAGES.length === 0) {
    assert.equal(LEGACY_CSS, "", "no page is legacy: delete compat-css.mjs and its import");
    assert.deepEqual(LEGACY_CLASSES, []);
  } else {
    assert.notEqual(LEGACY_CSS, "");
  }
});

/**
 * The page a golden draws, by its file name (`<shot>.<role>.html`, a `SHOTS` row): the shot's screen, or `forbidden`
 * for an operators-only screen drawn for a viewer, which is the refusal page although its `<body>` says the screen's
 * `data-page` (the audit log's viewer golden). Keyed by name, not by `data-page`, so the audit log and the refusal can
 * convert in different pull requests and each golden is judged by its own page's entry.
 */
function goldenPage(file) {
  const m = /^(.+)\.([a-z]+)\.html$/.exec(file);
  const row = m ? SHOTS.find(([shot]) => shot === m[1]) : undefined;
  assert.ok(row && ROLES.includes(m[2]), `${file} is a SHOTS golden`);
  const name = row[1];
  return { screen: name, page: PAGES[name].auth === "operator" && m[2] !== "operator" ? "forbidden" : name };
}

test("a converted page carries no .legacy and no class only the legacy layer styles; a legacy page's content is in one .legacy box", () => {
  const bundle = new Set(selectorsOf(PULSE_CSS).flatMap(classesIn));
  const legacyOnly = new Set(LEGACY_CLASSES.filter((c) => !bundle.has(c)));
  const drawn = readdirSync(FIXTURES).filter((f) => f.endsWith(".html")).sort().map((f) => {
    const html = readFileSync(join(FIXTURES, f), "utf8");
    const { screen, page } = goldenPage(f);
    assert.equal(/<body data-page="([a-z-]+)"/.exec(html)?.[1], screen, `${f} is drawn as ${screen}`);
    return { key: f, page, html };
  });
  assert.ok(drawn.length > 0);
  assert.ok(drawn.some((d) => d.page === "forbidden"), "the refusal page has a golden (the audit log's viewer)");
  // The sign-in pages have no golden yet (PR 2 adds them): their render is judged by the same rule meanwhile.
  for (const [name, html] of Object.entries(SIGN_IN)) drawn.push({ key: `${name} (rendered)`, page: name, html });
  for (const { key, page, html } of drawn) {
    if (LEGACY_PAGES.includes(page)) {
      assert.equal(legacyBoxes(html).length, 1, `${key}: ${page} is legacy, so its content sits in one <div class="legacy">`);
      continue;
    }
    assert.ok(!/class="(?:[^"]* )?legacy(?: [^"]*)?"/.test(html), `${key}: ${page} is converted, so nothing is legacy`);
    const used = new Set([...html.matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/)));
    assert.deepEqual([...used].filter((c) => legacyOnly.has(c)), [], `${key}: ${page} is converted but uses a class only the legacy layer styles`);
  }
});
