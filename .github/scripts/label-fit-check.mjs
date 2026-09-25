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
};
const NAMES = Object.keys(CORPUS);
const LONG_FOLDER = "/srv/" + "a-very-long-deployment-folder-name".repeat(3);
const LONG_CRON = "0 0,5,10,15,20,25,30,35,40,45,50,55 * * *";

const usd = (n, cls, over = {}) => ({ usd: n, class: cls, floor: false, ...over });

function model(corpus, folder, cron) {
  const skills = NAMES.map((k, i) => ({
    name: `${k}-${corpus[k]}`, isSub: false, group: null, aiTrigger: i % 2 === 0, meta: null, mentions: [],
    loops: i === 0 ? [{ hint: `until ${corpus.malayalam}${corpus.wide}` }] : [], unread: false,
  }));
  skills.push({ name: `grp${corpus.wide}`, isSub: false, group: null, aiTrigger: false, meta: null, mentions: [], unread: false });
  skills.push({ name: `grp${corpus.wide}/${corpus.tamil}`, isSub: true, group: `grp${corpus.wide}`, aiTrigger: false, meta: null, mentions: [], unread: false });
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
    cost: i % 3 === 0 ? usd(0, "plan", { planId: `plan-${corpus[k]}` }) : usd(0.25 * (i + 1), "metered"), apiEquiv: null,
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

// The probe measures what the page drew, against boxes defined independently of the fit: the rect in the same
// group that holds the label's start, the root svg's own width, and every other label's box (a collision).
const PROBE = `<script>
(function () {
  function report() {
    var out = [];
    var parents = [];
    var texts = document.getElementsByTagName("text");
    for (var i = 0; i < texts.length; i++) {
      var t = texts[i];
      var a = t.getAttribute("text-anchor");
      if (a !== null && a !== "start") continue;
      var len = t.getComputedTextLength();
      if (!(len > 0)) continue;
      var x = parseFloat(t.getAttribute("x")) || 0;
      var y = parseFloat(t.getAttribute("y")) || 0;
      var edge = null;
      var kids = t.parentNode.children;
      for (var j = 0; j < kids.length; j++) {
        var k = kids[j];
        if (k.localName !== "rect") continue;
        var rx = parseFloat(k.getAttribute("x")) || 0, ry = parseFloat(k.getAttribute("y")) || 0;
        var rw = parseFloat(k.getAttribute("width")) || 0, rh = parseFloat(k.getAttribute("height")) || 0;
        if (rx <= x && x < rx + rw && ry <= y && y <= ry + rh && rw > 20) { if (edge === null || rx + rw < edge) edge = rx + rw; }
      }
      var node = t.firstChild ? t.firstChild.nodeValue : "";
      var pi = parents.indexOf(t.parentNode);
      if (pi < 0) { parents.push(t.parentNode); pi = parents.length - 1; }
      out.push({ text: node, x: x, y: y, end: x + len, edge: edge, parent: pi });
    }
    document.getElementById("fitout").textContent = JSON.stringify(out);
  }
  setTimeout(report, 400);
})();
</script>`;

function page(corpus, withFit, folder = LONG_FOLDER, cron = LONG_CRON) {
  let html = buildInsightsHtml({ graph: buildGraphModel(model(corpus, folder, cron)), fold: fold(corpus), costsUnreachable: null, window: "30d", costByTrigger: {}, budget: null }, { now: NOW });
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

function overflows(rows) {
  const bad = [];
  for (const r of rows) {
    if (r.edge !== null && r.end > r.edge + 0.5) bad.push(`past its box by ${(r.end - r.edge).toFixed(1)}px: ${JSON.stringify(r.text)}`);
  }
  const byLine = new Map();
  for (const r of rows) {
    const key = `${r.parent}|${r.y}`;
    if (!byLine.has(key)) byLine.set(key, []);
    byLine.get(key).push(r);
  }
  for (const line of byLine.values()) {
    line.sort((a, b) => a.x - b.x);
    for (let i = 1; i < line.length; i++) {
      if (line[i - 1].end > line[i].x + 0.5) bad.push(`runs into the next label by ${(line[i - 1].end - line[i].x).toFixed(1)}px: ${JSON.stringify(line[i - 1].text)}`);
    }
  }
  return bad;
}

const ascii = Object.fromEntries(NAMES.map((k) => [k, "x"]));
const [fitted, unfitted, asciiFitted, asciiUnfitted] = await Promise.all([
  measure(page(CORPUS, true)),
  measure(page(CORPUS, false)),
  measure(page(ascii, true, "/srv/site", "0 3 * * *")),
  measure(page(ascii, false, "/srv/site", "0 3 * * *")),
]);

const withFit = overflows(fitted);
const withoutFit = overflows(unfitted);
// A plain ASCII page, the page nearly every deployment draws: nothing on it overflows, so the fit must leave every
// label exactly as the builder wrote it.
const asciiChanged = asciiFitted.length !== asciiUnfitted.length
  ? [`${asciiUnfitted.length} labels became ${asciiFitted.length}`]
  : asciiFitted.flatMap((r, i) => (r.text === asciiUnfitted[i].text ? [] : [`${JSON.stringify(asciiUnfitted[i].text)} became ${JSON.stringify(r.text)}`]));
const asciiOverflows = overflows(asciiUnfitted);

console.log(`labels measured: ${fitted.length} (corpus), ${asciiFitted.length} (ascii)`);
console.log(`overflows with the fit stripped: ${withoutFit.length}`);
console.log(`overflows with the fit: ${withFit.length}`);
for (const line of withFit) console.log(`  ${line}`);
console.log(`ascii labels the fit changed: ${asciiChanged.length} (the plain page overflows ${asciiOverflows.length} without it)`);
for (const line of asciiChanged) console.log(`  ${line}`);
if (withoutFit.length === 0) console.log("NOTE: the corpus overflowed nothing without the fit, so this run proves nothing");
process.exitCode = withFit.length === 0 && asciiChanged.length === 0 && asciiOverflows.length === 0 && withoutFit.length > 0 ? 0 : 1;
