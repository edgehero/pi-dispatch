import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { COLLISIONS, LEGACY_CLASSES, LEGACY_CSS, NEUTRALISED, PD_TOKENS, SVG_EXTRA } from "../src/console/compat-css.mjs";
import { PAGE_CSS, SHELL_CSS, cssBlocks, selectorsOf, splitSelectors } from "../src/console/page-css.mjs";
// A static import, so a pages.mjs that stops exporting the list fails this file at load instead of skipping its checks.
import { LEGACY_PAGES, PAGES, renderPage } from "../src/console/pages.mjs";
import { PULSE_CSS } from "../src/console/pulse-css.mjs";
import { ERROR_KINDS, errorPage } from "../src/console/error-pages.mjs";
import { loginCodePage, loginPage } from "../src/console/shell.mjs";
import { PAGE_THEME } from "../src/graph-html.mjs";
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
 * legacy, the shared `common.mjs` while any page is), the transcript, the document (`html.mjs`), the page assembly
 * (`pages.mjs`: the transcript section) and the insights renderers. The `panels.mjs` barrel only re-exports, so it is
 * not read. The action previews left the list with PR 2 of issue #737: their bars are `confirm-view.mjs`'s Pulse markup,
 * drawn outside every wrapper, and `actions.mjs` writes no markup of its own. The sign-in pages and the operators-only
 * refusal converted in the same pull request (`signin.mjs`, `error-pages.mjs`), so no old markup is read from them.
 */
function legacySources() {
  const files = ["console/html.mjs", "console/pages.mjs", "insights-html.mjs", "graph-html.mjs"];
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

/** The sign-in pages as drawn, by name, beside their goldens (the static shots), in every notice. */
const SIGN_IN = Object.freeze({ login: String(loginPage({ notice: "idle" })), "login-code": String(loginCodePage()) });

/**
 * A class built from a bare name (`class="${cls}"`): the values that name can hold, by name. Pinned both ways: every
 * such name found in the sources must be listed, and every value listed must still be a string the sources hold.
 */
const DYNAMIC = Object.freeze({
  cls: ["act", "note", "warn"],
});

/**
 * The classes the browser script puts on old markup: the transcript's status and the topology's highlight. Listed,
 * because the script builds them by string concatenation; each must still be a literal there. (The live pill's classes
 * and `main.stale` are the shell's, and since PR 2 the confirm bar is the server's markup, put in the slot whole.)
 */
const SCRIPT_CLASSES = Object.freeze(["dim", "hi"]);

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
  for (const text of legacySources().map((file) => readFileSync(join(SRC, file), "utf8"))) {
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
  for (const c of ["note", "warn", "mono", "kpi", "wl", "bl", "cap", "preview-area", "act", "good"]) assert.ok(EMITTED.classes.has(c), `${c} is old markup`);
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
  for (const c of ["banner", "kpi", "badge", "cap", "wl", "note", "facts"]) assert.ok(COLLISIONS.includes(c), `.${c} collides`);
  // The write flow's bar and diff are the server's Pulse markup since PR 2, outside every wrapper: nothing old is called
  // so any more, so bundle.css's rules for them need no reverting (and a revert inside a wrapper would be dead).
  for (const c of ["confirm", "diff"]) assert.ok(!COLLISIONS.includes(c) && !EMITTED.classes.has(c), `.${c} is no old markup`);
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

test("the pages PR 2 converted are not legacy: the audit log, the sign-in pages and the operators-only refusal", () => {
  for (const name of ["audit", "login", "login-code", "forbidden"]) assert.ok(!LEGACY_PAGES.includes(name), name);
  for (const [name, html] of Object.entries(SIGN_IN)) assert.equal(legacyBoxes(html).length, 0, name);
  assert.ok(!legacySources().includes("console/panels/audit.mjs"), "the audit panels are read as old markup no more");
  assert.ok(!legacySources().includes("console/actions.mjs"));
});

test("the overview PR 3 converted is not legacy: its panels are read as old markup no more, and no rule of the layer went with them", () => {
  assert.ok(!LEGACY_PAGES.includes("overview"));
  assert.ok(!legacySources().includes("console/panels/overview.mjs"), "the overview's panels are Pulse markup");
  // Its old panels drew only classes another old page or the shared helpers still draw: the dead-rule check and the
  // neutraliser's derived set (above) hold with them gone, so the layer kept every rule.
  for (const c of ["note", "warn", "plain", "num"]) assert.ok(EMITTED.classes.has(c), `.${c} is still old markup`);
});

test("the runs and parked pages PR 4 converted are not legacy: their panels are read as old markup no more, and the old pager went with them", () => {
  for (const name of ["runs", "parked"]) {
    assert.ok(!LEGACY_PAGES.includes(name), name);
    assert.ok(!legacySources().includes(`console/panels/${name}.mjs`), `${name}'s panels are Pulse markup`);
  }
  // The runs table's Newer and Older links were the last old `.pager`: no old markup draws one, so neither the layer's
  // two rules for it nor its collision with bundle.css's `.pager` are left.
  assert.ok(!EMITTED.classes.has("pager") && !COLLISIONS.includes("pager") && !LEGACY_CLASSES.includes("pager"));
  for (const c of ["note", "warn"]) assert.ok(EMITTED.classes.has(c), `.${c} is still old markup`);
  for (const c of ["filters", "range", "answer", "hidden-tips"]) assert.ok(!EMITTED.classes.has(c) && !LEGACY_CLASSES.includes(c), `Spend no longer leaves .${c} in the legacy layer`);
});

test("an empty LEGACY_PAGES leaves no legacy layer: the last converted page deletes it", () => {
  assert.ok(Array.isArray(LEGACY_PAGES) && Object.isFrozen(LEGACY_PAGES), "LEGACY_PAGES is a frozen list of page names");
  // The shell names the wrapper in one rule alone, a stale page's flat panels (page-css.mjs: a legacy panel is its own
  // card), and that half goes with the layer.
  const shellLegacy = selectorsOf(SHELL_CSS).filter((sel) => /\.legacy(?![\w-])/.test(sel));
  if (LEGACY_PAGES.length === 0) {
    assert.equal(LEGACY_CSS, "", "no page is legacy: delete compat-css.mjs and its import");
    assert.deepEqual(LEGACY_CLASSES, []);
    assert.deepEqual(shellLegacy, [], "no page is legacy: drop the shell's stale rule for a legacy panel");
  } else {
    assert.notEqual(LEGACY_CSS, "");
    assert.deepEqual(shellLegacy, ["main.stale .legacy>section[data-panel]"]);
  }
});

test("the wrapper draws no box of its own: its one section is the grid's cell, so an empty panel leaves no gap", () => {
  // The last rule on the wrapper itself (the layer's own Pulse look, after the insights page's body rule) is the one
  // that holds: no box, and only what its section inherits.
  const own = cssBlocks(LEGACY_CSS).filter((b) => b.prelude === ".legacy");
  assert.equal(own.at(-1).body, "display:contents;color:var(--ink);font:inherit");
  // Nothing else on the wrapper draws a box that display: contents would drop and a reader would miss: the earlier rules
  // set the old properties (inherited), and the insights page's ground and font, which the Pulse look replaces.
  for (const { body } of own.slice(0, -1)) for (const decl of body.split(";")) assert.match(decl, /^(?:--pd-[a-z-]+|background|color|font):/, decl);
  // The rule that keeps an empty panel off the page is the shell's, on the section; with a wrapper that draws no box,
  // the section is the cell. Not `:has()`, which needs Chrome 105, Safari 15.4 and Firefox 121, past the floor.
  assert.match(SHELL_CSS, /(?:^|\n)section\[data-panel\]:empty\{display:none\}/);
  assert.doesNotMatch(LEGACY_CSS, /\.legacy:has\(/);
});

/**
 * The page a golden draws, by its file name: a screen's (`<shot>.<role>.html`, a `SHOTS` row) is its screen, or
 * `forbidden` for an operators-only screen drawn for a viewer, which is the refusal although its `<body>` says the
 * screen's `data-page` (the audit log's viewer golden). Keyed by name, not by `data-page`, so the audit log and the
 * refusal can convert in different pull requests and each golden is judged by its own page's entry. The static
 * goldens PR 2 adds (the sign-in pages, signed out, and the error pages) are `login`, `login-code` and `error`, each
 * with its own `data-page`.
 */
function goldenPage(file) {
  const m = /^(.+)\.([a-z]+)\.html$/.exec(file);
  const row = m ? SHOTS.find(([shot]) => shot === m[1]) : undefined;
  if (row === undefined) {
    const still = m ? /^(login|login-code)$|^error-\d{3}$/.exec(m[1]) : null;
    assert.ok(still && [...ROLES, "anonymous"].includes(m[2]), `${file} is a SHOTS golden or a static one`);
    const page = still[1] ?? "error";
    return { screen: page, page };
  }
  assert.ok(ROLES.includes(m[2]), `${file} is a SHOTS golden`);
  const name = row[1];
  return { screen: name, page: PAGES[name].auth === "operator" && m[2] !== "operator" ? "forbidden" : name };
}

/** The top-level sections of a page's `<main>` with their place: each panel and the run page's transcript section. */
function sectionsOf(html) {
  return [...html.matchAll(/<section id="(p-[a-z0-9-]+|transcript)"(?: data-panel| class="transcript-section")>/g)].map((m) => ({ id: m[1], at: m.index }));
}

/** The `[start, end)` of each `.legacy` box in a page, its nested divs balanced. */
function boxSpans(html) {
  const spans = [];
  const open = '<div class="legacy">';
  for (let at = html.indexOf(open); at !== -1; at = html.indexOf(open, at + 1)) {
    const tags = /<div\b|<\/div>/g;
    tags.lastIndex = at;
    let depth = 0;
    for (let m = tags.exec(html); m !== null; m = tags.exec(html)) {
      depth += m[0] === "</div>" ? -1 : 1;
      if (depth === 0) {
        spans.push([at, m.index + m[0].length]);
        break;
      }
    }
  }
  return spans;
}

/** Each screen for each role, drawn over no data (every panel says what it could not read), and the static pages. */
async function renderedPages() {
  const out = [];
  for (const name of Object.keys(PAGES)) {
    for (const role of ROLES) {
      const query = name === "run" ? { id: "gh-1" } : {};
      const html = String((await renderPage(name, { query, session: { name: "ops", role }, data: { now: 0, env: {} }, readOnly: false })).html);
      out.push({ key: `${name}.${role} (rendered)`, page: PAGES[name].auth === "operator" && role !== "operator" ? "forbidden" : name, html });
    }
  }
  for (const [name, html] of Object.entries(SIGN_IN)) out.push({ key: `${name} (rendered)`, page: name, html });
  for (const kind of ERROR_KINDS) out.push({ key: `error ${kind} (rendered)`, page: "error", html: String(errorPage({ kind, session: { name: "ops", role: "operator" } }).html) });
  return out;
}

test("a converted page carries no .legacy and no class only the legacy layer styles; a legacy page wraps each section in a .legacy of its own", async () => {
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
  // The pages as rendered too, so the rule holds before a golden is regenerated and for the states no golden draws.
  drawn.push(...(await renderedPages()));
  for (const { key, page, html } of drawn) {
    if (LEGACY_PAGES.includes(page)) {
      // One wrapper per section, so the confirm slot the script puts after a section lands between wrappers. Each
      // box is one section, whole, and every section is in one.
      const spans = boxSpans(html);
      const sections = sectionsOf(html);
      assert.ok(sections.length > 0, `${key}: ${page} has sections`);
      assert.equal(spans.length, sections.length, `${key}: ${page} is legacy, so each of its ${sections.length} sections sits in a <div class="legacy"> of its own`);
      for (const [i, [a, b]] of spans.entries()) {
        const box = html.slice(a + '<div class="legacy">'.length, b - "</div>".length);
        assert.ok(box.startsWith("<section ") && box.endsWith("</section>"), `${key}: box ${i} holds a section and nothing else`);
        assert.equal(sectionsOf(box).length, 1, `${key}: box ${i} holds one section`);
      }
      const slot = html.indexOf('id="confirm-slot"');
      if (slot !== -1) assert.ok(!spans.some(([a, b]) => slot > a && slot < b), `${key}: the confirm slot is outside every wrapper`);
      continue;
    }
    assert.ok(!/class="(?:[^"]* )?legacy(?: [^"]*)?"/.test(html), `${key}: ${page} is converted, so nothing is legacy`);
    const used = new Set([...html.matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/)));
    const own = new Set(selectorsOf(PAGE_CSS[page] ?? "").flatMap(classesIn));
    assert.deepEqual([...used].filter((c) => legacyOnly.has(c) && !own.has(c)), [], `${key}: ${page} is converted but uses a class only the legacy layer styles`);
  }
});

test("the Pulse run and transcript leave no legacy transcript classes or rules (#747)", () => {
  assert.ok(!LEGACY_PAGES.includes("run"));
  assert.ok(!legacySources().includes("console/transcript.mjs"));
  assert.ok(!legacySources().includes("console/panels/run.mjs"));
  for (const c of ["t-entry", "t-status", "transcript-section", "big", "phases"]) {
    assert.ok(!EMITTED.classes.has(c), c);
    assert.ok(!LEGACY_CLASSES.includes(c), c);
  }
});
