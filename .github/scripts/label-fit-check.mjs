#!/usr/bin/env node
// Measures the insights page's drawn labels in a real browser (issue #422): builds the page from a corpus of
// scripts the static column estimate cannot size, serves it from memory, lets headless Chrome run the page's own
// view-time fit, and reads back where every left-anchored label ends against the box it sits in. Not run in CI:
// it needs a Chrome, and the unit suite pins the fit's logic with an injected measure.
//
//   node .github/scripts/label-fit-check.mjs [path-to-chrome]
//
// Exits 1 when any label runs past its box or collides with another label with the fit on, or when an ASCII
// label the static builder sized was changed by it. The same page with the fit stripped is measured too, and its
// overflow count is printed for comparison only.

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { buildInsightsHtml } = await import(path.join(root, "admin/src/insights-html.mjs"));
const { buildGraphModel } = await import(path.join(root, "admin/src/graph-model.mjs"));
const { FIT_JS } = await import(path.join(root, "admin/src/graph-html.mjs"));

const CHROME = process.argv[2] ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const NOW = 1770000000000;
const cp = (...points) => String.fromCodePoint(...points);
const run = (from, n, step = 1) => Array.from({ length: n }, (_, i) => cp(from + i * step)).join("");

// The corpus: each residual the issue names, plus the shapes #418 already handled, so a regression there shows.
const CORPUS = {
  tamil: run(0x0b95, 6),
  malayalam: run(0x0d15, 8),
  myanmar: run(0x1000, 10),
  thai: run(0x0e01, 12),
  lao: run(0x0e81, 3) + run(0x0e94, 6),
  ethiopic: run(0x1200, 8),
  khmer: run(0x1780, 8),
  javanese: run(0xa98f, 8),
  balinese: run(0x1b13, 8),
  cuneiform: cp(0x1242b).repeat(4),
  hieroglyph: run(0x13000, 6),
  ligature: cp(0xfdfd).repeat(3),
  dashes: "a" + cp(0x2e3a) + cp(0x2e3b) + cp(0x2031) + "b",
  wide: "WWWWWWWWWWWWWWWWWW",
  mmm: "mmmmmmmmmmmmmmmmmmmmmm",
  cjk: run(0x4f1a, 12),
  emoji: cp(0x1f680).repeat(9),
  flags: (cp(0x1f1ef, 0x1f1f5)).repeat(6),
  keycap: (cp(0x31, 0xfe0f, 0x20e3)).repeat(6),
  family: (cp(0x1f469, 0x200d, 0x1f469, 0x200d, 0x1f467)).repeat(5),
  arabic: [cp(0x0645, 0x0631, 0x062d, 0x0628, 0x0627), cp(0x0628, 0x0627, 0x0644, 0x0639, 0x0627, 0x0644, 0x0645)].join(" ").repeat(3),
  hebrew: [cp(0x05e9, 0x05dc, 0x05d5, 0x05dd), cp(0x05e2, 0x05d5, 0x05dc, 0x05dd)].join(" ").repeat(3),
  zalgo: ("e" + cp(0x301, 0x302, 0x303, 0x304, 0x306, 0x307, 0x308)).repeat(14),
  devanagari: cp(0x0915, 0x094d, 0x0937, 0x0924, 0x094d, 0x0930, 0x091c, 0x094d, 0x091e).repeat(3),
  wideW: "W".repeat(40),
  longflag: "x".repeat(50) + cp(0x1f1ef, 0x1f1f5),
};
const NAMES = Object.keys(CORPUS);
const LONG_FOLDER = "/srv/" + "a-very-long-deployment-folder-name".repeat(3);
// Every hour listed: about 340px at the 10px label font, far past the loop under a 160px chip (about 187px drawn), so the
// page's cron fit has something to cut. A pattern that fits its loop (the realistic page's) must not be touched.
const LONG_CRON = `0 ${Array.from({ length: 24 }, (_, h) => h).join(",")} * * *`;

const usd = (n, cls, over = {}) => ({ usd: n, class: cls, floor: false, ...over });

function model(corpus, folder, cron) {
  const skills = NAMES.map((k, i) => ({
    name: `${k}-${corpus[k]}`, isSub: false, group: null, aiTrigger: i % 2 === 0, meta: null, mentions: [],
    loops: i === 0 ? [{ hint: `until ${corpus.malayalam}${corpus.wide}` }] : [], unread: false,
  }));
  // A skill group whose name, sub chips and loop hints all run long: the titles the builder never cuts.
  const group = `a-very-long-skill-group-name-${corpus.wide}`;
  skills.push({ name: group, isSub: false, group: null, aiTrigger: false, meta: null, mentions: [], unread: false, loops: [{ hint: `until ${corpus.wide}` }, { hint: `repeat ${corpus.cuneiform}` }] });
  for (const sub of ["s1", `s2${corpus.mmm}`, corpus.arabic]) skills.push({ name: `${group}/${sub}`, isSub: true, group, aiTrigger: false, meta: null, mentions: [], unread: false });
  const triggers = NAMES.map((k, i) => ({
    type: "cron", index: i, id: `${k}${corpus[k]}`, pattern: i === 0 ? cron : "*/5 * * * *", folder,
    flow: `${k}-${corpus[k]}`, model: null, packages: true, image: null, skillsDir: null, instructions: false, resume: false,
  }));
  return {
    triggers: { triggers },
    schedulers: triggers.map((t) => ({ key: t.id, name: t.id, pattern: t.pattern, every: null, next: "2026-08-12T03:00:00.000Z", overdueMs: null })),
    folderSkills: { [folder]: { head: "abc123", truncated: false, unreachable: null, skills } },
    injectedSkills: {},
    overlaySkills: { skills: [], truncated: false, unreachable: null },
    stagedSkills: { skills: [], unenumerable: [], truncated: false },
    forgeRepos: {},
    cronStats: { byId: {} },
    runJoin: { byIndex: {}, unattributed: 0 },
    chainEdges: { edges: [], refusals: {}, truncated: false },
    caps: { chainDepthMax: 1, chainMaxPerJob: 2, windowDays: 30 },
    nowMs: NOW,
  };
}

function fold(corpus) {
  const flows = NAMES.map((k, i) => ({
    flow: `${k}-${corpus[k]}`, flowKey: k, runs: i + 1, tokens: 1000 * (i + 1),
    cost: i % 3 === 0 ? usd(0, "plan", { planId: `plan-${corpus[k]}` }) : usd(0.25 * (i + 1), "metered"), apiEquiv: usd(1234567.891 * (i + 1), "metered"),
  }));
  return {
    window: { fromMs: Date.parse("2026-07-20T00:00:00.000Z"), toMs: Date.parse("2026-08-01T00:00:00.000Z"), days: 12, firstRunMs: Date.parse("2026-07-29T10:00:00.000Z") },
    daily: [{ day: "2026-07-29", cost: usd(1.1, "metered"), runs: 3 }],
    dailyByFlow: [],
    byFlow: flows,
    byModel: NAMES.map((k, i) => ({ provider: `p-${corpus[k]}`, model: `m-${corpus[k]}`, runs: 1, calls: 1, input: 1, output: 1, cacheRead: 0, cacheWrite: 0, tokens: 2, cost: usd(0.1 * (i + 1), "metered") })),
    byTrigger: [],
    byRepo: NAMES.map((k, i) => ({ key: `r${i}`, label: `acme/${corpus[k]}`, kind: "github", runs: 1, tokens: 1, cost: usd(0.2, "unknown-class") })),
    plans: [],
    provenance: { total: usd(1, "metered"), runsTotal: 1, runsUnmetered: 0, runsUnledgered: 0, runsLedgerTruncated: 0, ratesDrifted: 0, piAiPin: "0.9.7" },
  };
}

// The probe measures what the page drew, written apart from the fit rather than borrowed from it: for every
// left-anchored label, the rect in its group that holds its start, the nearest rect after it in its band, the
// next left-anchored label on its line, and the outermost svg's own box. A cut label also reports how wide the
// text the builder drew would be, so a cut that was not needed shows.
const PROBE = `<script>
(function () {
  function num(el, name) { var v = parseFloat(el.getAttribute(name)); return v === v ? v : 0; }
  function report() {
    var out = [];
    var parents = [];
    var texts = document.getElementsByTagName("text");
    for (var i = 0; i < texts.length; i++) {
      var t = texts[i];
      var a = t.getAttribute("text-anchor");
      var len = t.getComputedTextLength();
      if (!(len > 0)) continue;
      // A centred label under a cron loop: its drawn box against the loop path's drawn box.
      if (a === "middle" && / gcron /.test(" " + (t.parentNode.getAttribute("class") || "") + " ")) {
        var loop = t.parentNode.querySelector("path").getBBox();
        var tb = t.getBBox();
        out.push({ text: t.firstChild.nodeValue, x: tb.x, y: num(t, "y"), end: tb.x + tb.width, holds: loop.x + loop.width, after: null, next: null,
          parent: -1 - i, box: [0, 0, 0, 0], svgLeft: 0, svgRight: 1, drawn: t.fitFull || null, drawnEnd: null, titled: t.querySelector("title") !== null,
          tipped: false, left: tb.x, loopLeft: loop.x });
        continue;
      }
      if (a !== null && a !== "start") continue;
      var x = num(t, "x");
      var y = num(t, "y");
      var holds = null;
      var after = null;
      var next = null;
      var kids = t.parentNode.children;
      for (var j = 0; j < kids.length; j++) {
        var k = kids[j];
        if (k.localName === "rect") {
          var rx = num(k, "x"), ry = num(k, "y"), rw = num(k, "width"), rh = num(k, "height");
          if (y < ry || y > ry + rh) continue;
          if (rx <= x && x < rx + rw && rw > 20) { if (holds === null || rx + rw < holds) holds = rx + rw; }
          else if (rx > x) { if (after === null || rx < after) after = rx; }
        } else if (k !== t && k.localName === "text" && num(k, "y") === y && num(k, "x") > x) {
          var ka = k.getAttribute("text-anchor");
          if (ka === null || ka === "start") { if (next === null || num(k, "x") < next) next = num(k, "x"); }
        }
      }
      var root = t.ownerSVGElement;
      while (root && root.ownerSVGElement) root = root.ownerSVGElement;
      var br = t.getBoundingClientRect();
      var sr = root.getBoundingClientRect();
      var drawnLen = null;
      if (typeof t.fitFull === "string") {
        var cur = t.firstChild.nodeValue;
        t.firstChild.nodeValue = t.fitFull;
        drawnLen = t.getComputedTextLength();
        t.firstChild.nodeValue = cur;
      }
      var pi = parents.indexOf(t.parentNode);
      if (pi < 0) { parents.push(t.parentNode); pi = parents.length - 1; }
      var titled = false;
      for (var c = 0; c < t.children.length; c++) if (t.children[c].localName === "title") titled = true;
      out.push({ text: t.firstChild ? t.firstChild.nodeValue : "", x: x, y: y, end: x + len, holds: holds, after: after, next: next, parent: pi,
        box: [br.left, br.top, br.right, br.bottom], svgLeft: sr.left, svgRight: sr.right, drawn: t.fitFull || null,
        drawnEnd: drawnLen === null ? null : x + drawnLen, titled: titled, tipped: t.parentNode.getAttribute("data-tip") !== null || / gnode /.test(" " + (t.parentNode.getAttribute("class") || "") + " ") });
    }
    document.getElementById("fitout").textContent = JSON.stringify(out);
  }
  setTimeout(report, 400);
})();
</script>`;

function page(graph, fitFold, withFit) {
  let html = buildInsightsHtml({ graph, fold: fitFold, costsUnreachable: null, window: "30d", costByTrigger: {}, budget: null }, { now: NOW });
  if (!withFit) {
    if (!html.includes(FIT_JS)) throw new Error("the page does not carry FIT_JS verbatim");
    html = html.replace(FIT_JS, "");
  }
  return html.replace("</body>", `<pre id="fitout"></pre>${PROBE}</body>`);
}

function measure(html) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => { res.setHeader("content-type", "text/html; charset=utf-8"); res.end(html); });
    server.listen(0, "127.0.0.1", () => {
      const url = `http://127.0.0.1:${server.address().port}/`;
      const args = ["-e", "alarm 60; exec @ARGV", CHROME, "--headless", "--disable-gpu", "--no-first-run", "--window-size=1400,1000", "--virtual-time-budget=5000", "--dump-dom", url];
      const child = spawn("perl", args, { stdio: ["ignore", "pipe", "ignore"] });
      // Decoded as one stream: a character split across two chunks decoded apart reads as garbage.
      child.stdout.setEncoding("utf8");
      let dom = "";
      child.stdout.on("data", (d) => { dom += d; });
      child.on("close", () => {
        server.close();
        const m = /<pre id="fitout">([^<]*)<\/pre>/.exec(dom);
        if (!m || m[1] === "") return reject(new Error("no probe output (Chrome did not run the page?)"));
        const decoded = m[1].replace(/&quot;/g, "\"").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
        resolve(JSON.parse(decoded));
      });
    });
  });
}

// Rounding slack for "runs past", and the margin the fit keeps before a bound (FIT_JS's PAD): a label that ends
// inside that margin is one the fit cuts by design, so it counts as needing the cut.
const PAD = 0.5;
const FIT_MARGIN = 2;
function problems(r) {
  const out = [];
  if (r.holds !== null && r.end > r.holds + PAD) out.push(`runs past its box by ${(r.end - r.holds).toFixed(1)}px`);
  if (r.holds === null && r.after !== null && r.end > r.after + PAD) out.push(`runs into the rect after it by ${(r.end - r.after).toFixed(1)}px`);
  if (r.next !== null && r.end > r.next + PAD) out.push(`runs into the next label by ${(r.end - r.next).toFixed(1)}px`);
  if (r.box[2] > r.svgRight + PAD) out.push(`runs past its svg by ${(r.box[2] - r.svgRight).toFixed(1)}px`);
  if (r.loopLeft !== undefined && r.left < r.loopLeft - PAD) out.push(`runs past its loop on the left by ${(r.loopLeft - r.left).toFixed(1)}px`);
  return out;
}

function overlaps(rows) {
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      if (rows[i].parent === rows[j].parent) continue;
      const a = rows[i].box;
      const b = rows[j].box;
      const ox = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
      const oy = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
      if (ox > 1 && oy > 3) out.push(`${JSON.stringify(rows[i].text)} overlaps ${JSON.stringify(rows[j].text)} (${ox.toFixed(1)}x${oy.toFixed(1)}px)`);
    }
  }
  return out;
}

function findings(rows) {
  const out = [];
  for (const r of rows) for (const p of problems(r)) out.push(`${p}: ${JSON.stringify(r.text)}`);
  return [...out, ...overlaps(rows)];
}

// A cut the fit made although the text the builder drew fitted every bound the probe knows: a needless cut.
function needless(rows) {
  return rows.filter((r) => r.drawn !== null && r.drawnEnd !== null && problems({ ...r, end: r.drawnEnd + FIT_MARGIN }).length === 0)
    .map((r) => `cut although ${JSON.stringify(r.drawn)} fitted: ${JSON.stringify(r.text)}`);
}

// A label the fit changed that had nothing wrong with it on the same page without the fit.
function changedWhole(fittedRows, strippedRows) {
  if (fittedRows.length !== strippedRows.length) return [`${strippedRows.length} labels became ${fittedRows.length}`];
  return fittedRows.flatMap((r, i) => (r.text === strippedRows[i].text || problems({ ...strippedRows[i], end: strippedRows[i].end + FIT_MARGIN }).length > 0 ? [] : [`${JSON.stringify(strippedRows[i].text)} became ${JSON.stringify(r.text)}`]));
}

// A title missing from a cut label that shows no tooltip of its own, or present on one that does.
function titles(rows) {
  return rows.filter((r) => r.drawn !== null && r.text !== r.drawn && r.titled === r.tipped).map((r) => `${r.tipped ? "a title on a tipped label" : "no title on a cut label"}: ${JSON.stringify(r.text)}`);
}

// An ordinary deployment in plain ASCII: names as long as real ones get, a forge group with two repos, a common
// cron. Nothing on it should be cut that fitted, and the forge caveat must survive whatever is cut.
function realistic() {
  const names = ["summarize-meetings", "memory-maintenance", "monthly-summary", "weekly-mwm", "WWW-MIGRATION", "customer-website-deploy"];
  // Real cron shapes: weekday lists with hour and minute lists, each measured to fit a 160px chip's loop.
  const patterns = ["0 9 * * MON,TUE,WED,THU,FRI", "0 0,2,4,6,8,10,12,14,16,18,20,22 * * *", "*/10 9-17 * * MON,TUE,WED,THU,FRI", "0,30 8-18 * * MON,TUE,WED,THU,FRI", "0 0,6,12,18 * * MON,TUE,WED,THU,FRI", "0 3 * * *"];
  const folder = "/home/someone/projects/customer-website";
  return {
    triggers: {
      triggers: [
        ...names.map((n, i) => ({ type: "cron", index: i, id: n, pattern: patterns[i], folder, flow: n, model: null, packages: true, image: null, skillsDir: null, instructions: false, resume: false })),
        { type: "label", index: names.length, any: ["ai"], all: [], none: [], flow: "triage", packages: true, image: null, skillsDir: null, instructions: false, resume: false, replicas: null, forge: "github" },
        // A forge trigger that runs a command has no flow column: its group sits at the minimum width.
        { type: "label", index: names.length + 1, any: ["deploy"], all: [], none: [], command: "deploy", packages: true, image: null, skillsDir: null, instructions: false, resume: false, replicas: null, forge: "forgejo" },
      ],
    },
    schedulers: names.map((n, i) => ({ key: n, name: n, pattern: patterns[i], every: null, next: "2026-08-12T03:00:00.000Z", overdueMs: null })),
    folderSkills: { [folder]: { head: "abc1234def", truncated: false, unreachable: null, skills: names.map((n) => ({ name: n, isSub: false, group: null, aiTrigger: true, meta: null, mentions: [], unread: false, loops: [] })) } },
    injectedSkills: {},
    overlaySkills: { skills: [], truncated: false, unreachable: null },
    stagedSkills: { skills: [], unenumerable: [], truncated: false },
    forgeRepos: { github: ["acme-corp/customer-website", "acme-corp/billing-service"] },
    cronStats: { byId: {} },
    runJoin: { byIndex: {}, unattributed: 0 },
    chainEdges: { edges: [], refusals: {}, truncated: false },
    caps: { chainDepthMax: 1, chainMaxPerJob: 2, windowDays: 30 },
    nowMs: NOW,
  };
}

const ascii = Object.fromEntries(NAMES.map((k) => [k, "x"]));
const corpusGraph = buildGraphModel(model(CORPUS, LONG_FOLDER, LONG_CRON));
const plainGraph = buildGraphModel(model(ascii, "/srv/site", "0 3 * * *"));
const realGraph = buildGraphModel(realistic());
// One browser at a time: six at once on a busy machine left a page unrendered inside Chrome's own time budget.
const fitted = await measure(page(corpusGraph, fold(CORPUS), true));
const stripped = await measure(page(corpusGraph, fold(CORPUS), false));
const plainFitted = await measure(page(plainGraph, fold(ascii), true));
const plainStripped = await measure(page(plainGraph, fold(ascii), false));
const realFitted = await measure(page(realGraph, fold(ascii), true));
const realStripped = await measure(page(realGraph, fold(ascii), false));

const report = (name, list) => {
  console.log(`${name}: ${list.length}`);
  for (const line of list) console.log(`  ${line}`);
  return list.length;
};
console.log(`labels measured: ${fitted.length} (corpus), ${plainFitted.length} (plain ascii), ${realFitted.length} (realistic ascii)`);
console.log(`corpus overflows with the fit stripped: ${findings(stripped).length} (for comparison)`);
let bad = 0;
bad += report("corpus overflows with the fit", findings(fitted));
bad += report("corpus needless cuts", needless(fitted));
bad += report("corpus titles wrong", titles(fitted));
// The corpus cron pattern runs past its loop without the fit, and the fit cuts it and gives it a title.
const cronCut = fitted.filter((r) => r.loopLeft !== undefined && r.drawn !== null && r.titled);
const cronOver = stripped.filter((r) => r.loopLeft !== undefined && problems(r).length > 0);
if (cronOver.length === 0) { console.log("the corpus cron pattern did not run past its loop without the fit, so the cron fit was not exercised"); bad++; }
if (cronCut.length === 0) { console.log("the fit cut no cron pattern with a title on the corpus page"); bad++; }
bad += report("plain ascii labels changed", changedWhole(plainFitted, plainStripped));
bad += report("plain ascii overflows either way", [...findings(plainStripped), ...findings(plainFitted)]);
bad += report("realistic ascii labels changed that fitted", changedWhole(realFitted, realStripped));
bad += report("realistic ascii overflows with the fit", findings(realFitted));
bad += report("realistic ascii needless cuts", needless(realFitted));
// Both forge groups, the github one with repos and the command-only forgejo one at the minimum width, keep the caveat.
for (const forge of ["github", "forgejo"]) {
  if (!realFitted.some((r) => r.text.startsWith(`${forge} · forge · unverifiable from this host`))) { console.log(`the ${forge} group's caveat is gone from the realistic page`); bad++; }
}
bad += report("realistic ascii cron patterns cut", realFitted.filter((r) => r.loopLeft !== undefined && r.drawn !== null).map((r) => JSON.stringify(r.drawn)));
if (findings(stripped).length === 0) { console.log("NOTE: the corpus overflowed nothing without the fit, so this run proves nothing"); bad++; }
process.exitCode = bad === 0 ? 0 : 1;
