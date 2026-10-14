import assert from "node:assert/strict";
import { test } from "node:test";
import { PAGES, pagePanels, parsePageQuery, renderPage } from "../src/console/pages.mjs";
import { ageText, insightsBody, navHtml, runCost, shownPath, usdText, utcText } from "../src/console/panels.mjs";
import { CONSOLE_CSS, DARK_THEME, LIGHT_THEME } from "../src/console/style.mjs";

// The console's panels (issue #641): the cost class per run, the formatting, the role rule and determinism, on small
// hand-built data. The pages over a real seeded deployment are console-pages.test.mjs's.

const NOW = Date.UTC(2026, 9, 8, 15, 39, 8);

test("runCost classifies a run by the cost fold's own rules", () => {
  const ledger = (rows) => ({ tokens: { total: 10, cost: 0.5 }, usage: { models: rows } });
  assert.deepEqual(runCost(ledger([{ provider: "anthropic", model: "claude-sonnet-5-5", cost: 0.5 }])), { usd: 0.5, class: "metered", floor: false, planId: null });
  assert.deepEqual(runCost(ledger([{ provider: "kimi-coding", model: "kimi-for-coding", cost: 0.3 }]), [{ id: "kimi", provider: "kimi-coding", models: ["*"] }]), { usd: 0, class: "plan", floor: false, planId: "kimi" });
  assert.equal(runCost(ledger([{ provider: "x", model: "y", cost: 0 }])).class, "zero-rated");
  const mixed = runCost(ledger([{ provider: "anthropic", model: "a", cost: 0.25 }, { provider: "x", model: "y", cost: 0 }]));
  assert.deepEqual([mixed.class, mixed.usd], ["estimated", 0.25], "mixed classes read as an estimate of the metered part");
  // No ledger: one row from the host-effective provider and model; a fallback meter is a floor.
  assert.deepEqual(runCost({ provider: "anthropic", model: "m", tokens: { cost: 1.25, metered: false } }), { usd: 1.25, class: "metered", floor: true, planId: null });
  assert.equal(runCost({ tokens: null }), null, "a run that measured nothing has no cost");
  assert.equal(runCost(null), null);
});

test("formatting: ages, UTC instants, dollars and paths, never the host's zone or locale", () => {
  assert.equal(ageText(45_000), "45s");
  assert.equal(ageText(12 * 60_000), "12m");
  assert.equal(ageText(3 * 3_600_000 + 5 * 60_000), "3h 5m");
  assert.equal(ageText(2 * 86_400_000 + 4 * 3_600_000), "2d 4h");
  for (const bad of [-1, Number.NaN, null, "5"]) assert.equal(ageText(bad), "unknown");
  assert.equal(utcText(NOW), "2026-10-08 15:39 UTC");
  assert.equal(utcText(Number.NaN), "unknown");
  assert.equal(usdText(2_000_000), "$2.00");
  assert.equal(usdText(-1), "-");
  assert.equal(usdText(1.5), "-");
  assert.equal(shownPath("/srv/work/site"), ".../site");
  assert.equal(shownPath("C:\\work\\site"), ".../site");
  assert.equal(shownPath("github:acme/web"), "github:acme/web");
});

test("the navigation marks the current screen and lists the audit log for the operator only", () => {
  const viewer = String(navHtml(PAGES, "run", "viewer"));
  assert.match(viewer, /<a href="\/runs" aria-current="page">Runs<\/a>/, "the run detail counts as Runs");
  assert.ok(!viewer.includes("/audit"));
  assert.equal((viewer.match(/aria-current/g) ?? []).length, 1);
  assert.match(String(navHtml(PAGES, "audit", "operator")), /<a href="\/audit" aria-current="page">Audit<\/a>/);
});

/** A snapshot with one of everything the panels draw, hostile where a value can be. */
function snapshot() {
  return {
    queue: { pausedState: false, pausedPartial: true, counts: { waiting: 1, active: 2, delayed: 0, failed: 1 }, workers: 2, queues: 2, fleetDegraded: "registry unreadable" },
    queueCounts: [{ queue: "pi-jobs", paused: true, counts: { waiting: 1 } }],
    hostBudgets: [{ name: "h1", concurrency: "2", jobs: [{ id: "gh-1", at: NOW - 60_000, o: false }], staleMs: 4000, budgetMemMiB: "off", budgetCpuCenti: "off" }],
    budget: { day: 3, week: 4, month: 5, tokensToday: 1000 },
    settings: { overlay: { dailyCap: 10, secretProfiles: { vault: { resolver: "/opt/secret" } } } },
    dollars: null,
    parked: [{ target: "acme/api#1", kind: "github", jobId: "gh-p", parkedAt: NOW - 600_000, ageMs: 600_000, chainCount: null }],
    failures24h: 7,
    failures24hFloor: true,
    active: [{ jobId: "gh-<x>", queue: "pi-jobs", startedAt: NOW - 120_000, host: null }],
    held: { rows: [], more: 0 },
    failed: { rows: [{ jobId: "gh-f", attemptsMade: 3, failedReason: "REASON-TEXT <b>", queue: "pi-jobs", endedAt: NOW - 1000 }], more: 0 },
    schedulers: [{ key: "nightly", name: "nightly", pattern: "0 3 * * *", next: NOW - 5000, overdueMs: 5000 }],
    schedulerStalls: { nightly: 1 },
    schedulerStallMax: 2,
    triggers: { triggers: [{ type: "cron", id: "nightly", pattern: "0 3 * * *", folder: "/srv/work/site", flow: "tidy", packages: false }] },
    pauseWindows: { missing: true },
    scopedLimits: { invalid: "scoped-limits file is not valid JSON: /srv/deploy/scoped-limits.json" },
    projects: { unset: true },
    envelopeSet: false,
    overlayMcp: { servers: [], refused: [], unreadable: null },
    stagedPackages: { stagedAt: null, packages: [] },
  };
}

const ctxOf = (role, data, query = {}) => ({ query, session: { name: role, role }, data: { now: NOW, env: {}, ...data }, readOnly: false });

test("the role rule: a failure reason is the operator's, in a details element, and never in a list row", async () => {
  const data = { snapshot: snapshot() };
  const viewer = (await pagePanels("fleet", ctxOf("viewer", data))).map((p) => p.html).join("");
  const operator = (await pagePanels("fleet", ctxOf("operator", data))).map((p) => p.html).join("");
  assert.ok(!viewer.includes("REASON-TEXT"), "a viewer sees no reason");
  assert.match(viewer, /shown to operators only/);
  assert.match(operator, /<details><summary class="mono">gh-f<\/summary><p class="mono">REASON-TEXT &lt;b&gt;<\/p><\/details>/);
  assert.ok(!/<td[^>]*>REASON-TEXT/.test(operator), "and the operator never in a cell");
  // The audit log: a viewer is refused it with no panel drawn.
  const audit = await renderPage("audit", ctxOf("viewer", { audit: { rows: [{ seq: 1, at: "2026-10-08T00:00:00Z", actor: { name: "ops", role: "operator" }, action: "login", outcome: "ok" }], next: null } }));
  assert.equal(audit.status, 403);
  assert.ok(!String(audit.html).includes("data-panel"));
  assert.ok(!String(audit.html).includes("login"), "no audit row reaches a viewer");
});

test("the configuration shows names and basenames, never a parser message or a resolver path", async () => {
  const html = (await pagePanels("config", ctxOf("operator", { snapshot: snapshot() }))).map((p) => p.html).join("");
  assert.ok(!html.includes("/srv/"), html);
  assert.match(html, /flow tidy in \.\.\.\/site/);
  assert.match(html, /The scoped-limits file does not load; run pi-dispatch doctor/);
  assert.match(html, /<li class="mono">vault<\/li>/, "a secret profile by name");
  assert.ok(!html.includes("/opt/secret"));
});

test("panels state degraded reads instead of drawing nothing: no snapshot, a floor, a partly paused fleet", async () => {
  const none = (await pagePanels("overview", ctxOf("viewer", { snapshot: null }))).map((p) => p.html);
  assert.equal(none.length, 6);
  for (const h of none) assert.match(h, /could not be read/);
  const some = (await pagePanels("overview", ctxOf("viewer", { snapshot: snapshot() }))).map((p) => p.html).join("");
  assert.match(some, /partly paused/);
  assert.match(some, /at least 7/);
  assert.match(some, /fleet as it was last seen/);
  assert.match(some, /gh-&lt;x&gt;/);
  // a parked fold that failed is said on both the overview and the inbox, never shown as zero or "Nothing is parked"
  const lost = { ...snapshot(), parked: [], parkedUnreachable: "the runs could not be read" };
  const overview = (await pagePanels("overview", ctxOf("viewer", { snapshot: lost }))).map((p) => p.html).join("");
  assert.match(overview, /parked runs could not be read .*unknown/);
  const inbox = (await pagePanels("parked", ctxOf("viewer", { snapshot: lost }))).map((p) => p.html).join("");
  assert.match(inbox, /this is not an empty inbox/);
  assert.doesNotMatch(inbox, /Nothing is parked/);
});

test("pages are a function of (data, now): no renderer reads the clock", async () => {
  const realNow = Date.now;
  const RealDate = globalThis.Date;
  class NoClock extends RealDate {
    constructor(...a) {
      if (a.length === 0) throw new Error("a renderer read the clock");
      super(...a);
    }
    static now() {
      throw new Error("a renderer read the clock");
    }
  }
  const data = {
    snapshot: snapshot(),
    runsPage: { runs: [{ jobId: "gh-1", kind: "github", target: "acme/web#1", endedAt: "2026-10-08T15:00:00Z", outcome: "completed", tokens: { total: 5, cost: 0.1 } }], next: 1, mirror: "ok" },
    run: { record: { jobId: "gh-1", kind: "github", target: "acme/web#1", startedAt: "2026-10-08T14:00:00Z", endedAt: "2026-10-08T15:00:00Z" }, source: "local" },
    children: [],
    childrenSearched: 1,
    insights: null,
    audit: { rows: [{ broken: true, file: "2026-10.jsonl", line: 3 }], next: null },
  };
  const out = [];
  globalThis.Date = NoClock;
  try {
    for (const name of Object.keys(PAGES)) {
      const q = parsePageQuery(name, name === "run" ? "id=gh-1" : "").query;
      out.push(String((await renderPage(name, ctxOf("operator", data, q))).html));
    }
  } finally {
    globalThis.Date = RealDate;
    Date.now = realNow;
  }
  assert.equal(out.length, Object.keys(PAGES).length);
  assert.match(out.at(-1), /Not an audit row: line 3 of 2026-10\.jsonl/);
});

test("a run id outside the run-id charset is shown as escaped text with no link (its /run?id= would answer 400)", async () => {
  const base = { kind: "github", target: "acme/web#1", endedAt: "2026-10-08T15:00:00Z", outcome: "completed", tokens: { total: 5, cost: 0.1 } };
  const odd = "gh 1<b>&x";
  const data = { runsPage: { runs: [{ ...base, jobId: "gh-ok.1:2" }, { ...base, jobId: odd }, { ...base, jobId: "x".repeat(201) }], next: null, mirror: "ok" } };
  const q = parsePageQuery("runs", "").query;
  const out = (await pagePanels("runs", ctxOf("viewer", data, q))).map((p) => p.html).join("");
  assert.match(out, /<a class="mono" href="\/run\?id=gh-ok.1%3A2">gh-ok.1:2<\/a>/, "a well-formed id is linked");
  const links = [...out.matchAll(/href="\/run\?id=([^"]*)"/g)].map((m) => decodeURIComponent(m[1]));
  for (const id of links) assert.equal(parsePageQuery("run", new URLSearchParams({ id })).refusal, undefined, `every run link is one /run accepts: ${id}`);
  assert.deepEqual(links, ["gh-ok.1:2"]);
  assert.match(out, /<span class="mono">gh 1&lt;b&gt;&amp;x<\/span>/, "the odd id is plain escaped text");
  assert.ok(out.includes(`<span class="mono">${"x".repeat(201)}</span>`), "an over-long id too");
});

test("the insights body renders an empty payload and lists no tips", () => {
  const html = String(insightsBody(null, NOW));
  assert.match(html, /no cost data|No cost data/);
  assert.match(html, /<ol id="insights-tips" class="hidden-tips" hidden><\/ol>$/);
});

test("the stylesheet is the insights CSS on tokens, with a light override and SVG attribute re-pointing", () => {
  assert.ok(!/<|@import|url\(/.test(CONSOLE_CSS), "plain rules, nothing fetched");
  for (const hex of Object.values(DARK_THEME)) assert.ok(!new RegExp(`:${hex}(?![0-9a-f])`, "i").test(CONSOLE_CSS.split("@media (prefers-color-scheme: light)")[0].replace(/:root\{[^}]*\}/, "").replace(/svg \[[^\]]*\]/g, "")), `${hex} is a token, not a literal`);
  assert.match(CONSOLE_CSS, /@media \(prefers-color-scheme: light\)\{html\{color-scheme:light\}:root\{--pd-canvas:#ffffff;/);
  assert.match(CONSOLE_CSS, /svg \[fill="#58a6ff"\]\{fill:var\(--pd-accent\)\}/);
  assert.deepEqual(Object.keys(LIGHT_THEME).sort(), Object.keys(DARK_THEME).sort(), "every dark role has a light value");
  assert.match(CONSOLE_CSS, /body\{background:var\(--pd-canvas\)/, "the body background is explicit");
});
