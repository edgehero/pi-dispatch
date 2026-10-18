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

test("the audit page names each write's kind, a paid action's reserve and a bulk row's size (issue #642)", async () => {
  const rows = [
    { seq: 2, at: "2026-10-08T00:00:01Z", actor: { name: "ops", role: "operator" }, action: "write", kind: "run-rerun", target: "gh-1", outcome: "ok", reserve: 2_500_000 },
    { seq: 3, at: "2026-10-08T00:00:02Z", actor: { name: "pi", role: "panel" }, action: "write", kind: "failed-retry-all", target: "gh-2", outcome: "ok", count: 3 },
  ];
  const html = (await pagePanels("audit", ctxOf("operator", { audit: { rows, next: null } }))).map((p) => p.html).join("");
  assert.match(html, /write <span class="mono">run-rerun<\/span>/);
  assert.match(html, /reserve \$2\.50/);
  assert.match(html, /write <span class="mono">failed-retry-all<\/span>/);
  assert.match(html, /\(one of 3\)/);
  assert.match(html, /pi \(panel\)/);
});

test("the run page's Progress panel (issue #644): a finished run shows its record's progress by the worker's rule; the key's names only to an operator", async () => {
  const { runProgress } = await import("../src/console/panels.mjs");
  const progress = { turns: 9, steps: 14, failed: 2, toolMs: 61_000, longestStepMs: 2_500, phasesDeclared: 3, lastPhaseIndex: 2, tools: { bash: 6, read: 8, "<script>x</script>": 4, other: 1 }, note: "RECORD-TEXT" };
  const record = { jobId: "gh-1", outcome: "completed", startedAt: new Date(NOW - 120_000).toISOString(), endedAt: new Date(NOW).toISOString(), progress };
  const key = { v: 1, turn: 9, steps: 14, failed: 2, interrupted: 0, running: [], recent: [], phase: { index: 2, done: null, total: null }, phases: ["plan", "build", "KEY-PHASE-NAME"], note: "KEY-NOTE", prior: null, startedAt: NOW - 60_000, updatedAt: NOW, ended: true, outcome: "completed" };
  const view = (role, data) => ({ page: "run", role, readOnly: false, query: { id: "gh-1" }, env: {}, now: NOW, data: { now: NOW, ...data } });
  const op = String(runProgress(view("operator", { run: { record }, progress: key })));
  assert.match(op, /<dt>Turns<\/dt><dd>9<\/dd>/);
  assert.match(op, /<dt>Sum of step durations<\/dt><dd>1m<\/dd><dt>Longest step<\/dt><dd>2\.5 s<\/dd><dt>Phases declared<\/dt>/, "no interrupted step: no row for it");
  assert.match(op, /<dt>Last phase<\/dt><dd>3 of 3<\/dd>/);
  assert.match(op, /<td class="mono">bash<\/td><td class="num">6<\/td>/);
  assert.ok(!op.includes("script") && !op.includes("RECORD-TEXT"), "a key outside the closed set, and a free string, never leave the record");
  assert.match(op, /KEY-PHASE-NAME/, "an operator also gets the phase names while the key is kept");
  const viewer = String(runProgress(view("viewer", { run: { record }, progress: key })));
  assert.match(viewer, /<dt>Steps<\/dt><dd>14<\/dd>/);
  assert.ok(!viewer.includes("KEY-PHASE-NAME") && !viewer.includes("KEY-NOTE"), "a viewer never gets the key's words");
  // The worker's longest interrupted step, when the record has one.
  const cut = String(runProgress(view("viewer", { run: { record: { ...record, progress: { ...progress, interrupted: 1, longestInterruptedMs: 95_000 } } }, progress: key })));
  assert.match(cut, /<dt>Longest interrupted step<\/dt><dd>1m<\/dd>/);
  // A key that has not ended is not this record's attempt's final word: no names beside the record.
  assert.doesNotMatch(String(runProgress(view("operator", { run: { record }, progress: { ...key, ended: false, outcome: null } }))), /KEY-PHASE-NAME/);
  // An older record without progress, and a running job's three absences, each say which.
  assert.match(String(runProgress(view("operator", { run: { record: { jobId: "gh-1" } }, progress: { absent: true } }))), /record holds no progress/);
  assert.match(String(runProgress(view("operator", { run: { missing: true }, progress: { unreachable: "x" } }))), /could not be read/);
  assert.match(String(runProgress(view("operator", { run: { missing: true }, progress: { invalid: "x" } }))), /not one this console reads/);
  assert.match(String(runProgress(view("viewer", { run: { missing: true }, progress: { absent: true } }))), /No live progress: not published \(PI_RUN_PROGRESS=0\)/);
});

// An infra retry keeps the job id: attempt 1 writes its record, then attempt 2 rewrites the progress key. The key
// belongs to a later attempt when it started after the record ended.
test("the Progress panel of a retried job (issue #644): a key newer than the record is the running attempt's, shown live; an older one is never mixed in", async () => {
  const { runProgress } = await import("../src/console/panels.mjs");
  const ended = NOW - 120_000;
  const record = { jobId: "gh-1", outcome: "failed", startedAt: new Date(ended - 900_000).toISOString(), endedAt: new Date(ended).toISOString(), progress: { turns: 5, steps: 7, phasesDeclared: 4, lastPhaseIndex: 3 } };
  const attempt2 = { v: 1, turn: 2, steps: 3, failed: 0, interrupted: 0, running: [{ tool: "bash", since: NOW - 20_000 }], recent: [], phase: { index: 0, done: null, total: null }, phases: ["ATTEMPT-2-PHASE"], note: null, prior: null, startedAt: ended + 30_000, updatedAt: NOW - 1_000, ended: false, outcome: null };
  const view = (role, data) => ({ page: "run", role, readOnly: false, query: { id: "gh-1" }, env: {}, now: NOW, data: { now: NOW, ...data } });
  const op = String(runProgress(view("operator", { run: { record }, progress: attempt2 })));
  assert.match(op, /An earlier attempt of this run ended \(failed\); this is the attempt after it\./);
  assert.match(op, /<dt>Turn<\/dt><dd>2<\/dd>/, "attempt 2's live counters");
  assert.match(op, /<span class="mono">bash<\/span> running 20s/);
  assert.match(op, /Current phase: <strong>ATTEMPT-2-PHASE<\/strong>/);
  assert.doesNotMatch(op, /Last phase/, "attempt 1's lastPhaseIndex is not set beside attempt 2's names");
  // The same key once attempt 2 has ended (its record not written yet) is still attempt 2's.
  const done = String(runProgress(view("operator", { run: { record }, progress: { ...attempt2, running: [], ended: true, outcome: "completed" } })));
  assert.match(done, /An earlier attempt of this run ended \(failed\)/);
  assert.match(done, /The run has ended \(completed\)\./);
  // A key of the record's own attempt: ended, started before the record ended. Its names join the record.
  const same = String(runProgress(view("operator", { run: { record }, progress: { ...attempt2, startedAt: ended - 600_000, updatedAt: ended, running: [], ended: true, outcome: "failed" } })));
  assert.match(same, /<dt>Last phase<\/dt><dd>4 of 4<\/dd>/);
  assert.match(same, /ATTEMPT-2-PHASE/);
  assert.doesNotMatch(same, /An earlier attempt/);
  // A key that started BEFORE the record's attempt did is an earlier attempt's (attempt 2 refused before its container
  // leaves attempt 1's ended key in place): its names never join this record, and an unreadable start pairs with none.
  const earlier = { ...attempt2, startedAt: ended - 1_200_000, updatedAt: ended - 1_000_000, running: [], ended: true, outcome: "failed" };
  const refused = String(runProgress(view("operator", { run: { record }, progress: earlier })));
  assert.match(refused, /<dt>Turns<\/dt><dd>5<\/dd>/);
  assert.doesNotMatch(refused, /ATTEMPT-2-PHASE|An earlier attempt/);
  for (const startedAt of [undefined, "not a date"]) {
    const noStart = String(runProgress(view("operator", { run: { record: { ...record, startedAt } }, progress: { ...attempt2, startedAt: ended - 600_000, updatedAt: ended, running: [], ended: true, outcome: "failed" } })));
    assert.doesNotMatch(noStart, /ATTEMPT-2-PHASE/, `startedAt ${startedAt}`);
  }
  // A record whose end cannot be read pairs with no key at all.
  const odd = String(runProgress(view("operator", { run: { record: { ...record, endedAt: null } }, progress: { ...attempt2, startedAt: ended - 600_000, ended: true } })));
  assert.match(odd, /<dt>Turns<\/dt><dd>5<\/dd>/);
  assert.doesNotMatch(odd, /ATTEMPT-2-PHASE|An earlier attempt/);
});

test("stale progress (issue #644): no write past three minutes says the worker may be gone, and a running step gets no live age", async () => {
  const { progressText, runProgress } = await import("../src/console/panels.mjs");
  const g = { v: 1, turn: 4, steps: 6, failed: 1, interrupted: 0, running: [{ tool: "bash", since: NOW - 600_000 }], recent: [], phase: null, phases: [], note: null, prior: { turns: 3, steps: 8 }, startedAt: NOW - 900_000, updatedAt: NOW - 300_000, ended: false, outcome: null };
  const view = (data, now = NOW) => ({ page: "run", role: "viewer", readOnly: false, query: { id: "gh-1" }, env: {}, now, data: { now, ...data } });
  const stale = String(runProgress(view({ run: { missing: true }, progress: g })));
  assert.match(stale, /<p class="warn">Stale: no update for 5 min; the worker may be gone\.<\/p>/);
  assert.match(stale, /<span class="mono">bash<\/span> open 5m at the last update/, "the age stops at the last write");
  assert.doesNotMatch(stale, /running 10m/);
  assert.match(stale, /<dt>Earlier runs of this session<\/dt><dd>3 turns, 8 steps before this run resumed the session<\/dd>/);
  // Within the heartbeat's window (here exactly three minutes): live, with no warning.
  const fresh = String(runProgress(view({ run: { missing: true }, progress: g }, g.updatedAt + 180_000)));
  assert.doesNotMatch(fresh, /Stale/);
  assert.match(fresh, /<span class="mono">bash<\/span> running 8m/);
  // The run page's other panels, which have no record to show, say so too.
  const pages = (await pagePanels("run", ctxOf("viewer", { run: { missing: true }, progress: g }, { id: "gh-1" }))).map((p) => p.html).join("");
  assert.match(pages, /This run has no record yet: a run&#39;s record is written when it ends\. Its progress has had no update for 5 min; the worker may be gone\./);
  // The active tables' cell: the same words, and no running age.
  const row = { turn: 4, steps: 6, failed: 1, running: { tool: "bash", since: NOW - 600_000 }, phase: { index: 1, count: 3, done: null, total: null }, ended: false, updatedAt: NOW - 300_000 };
  assert.equal(progressText(row, NOW), "turn 4, 6 steps (1 failed), bash running, phase 2/3, no update for 5 min; the worker may be gone");
  assert.equal(progressText({ ...row, updatedAt: NOW - 2_000 }, NOW), "turn 4, 6 steps (1 failed), bash running 10m, phase 2/3");
  // An ended key on an ACTIVE row is an earlier attempt's: the cell shows nothing of it.
  assert.equal(progressText({ ...row, ended: true }, NOW), "-");
});

test("the run page's recovery rows (issue #645): where a durable run came from, its base run linked, its checkpoints, for both roles; hostile values dropped", async () => {
  const record = {
    jobId: "gh-77.r1",
    outcome: "completed",
    startedAt: new Date(NOW - 60_000).toISOString(),
    endedAt: new Date(NOW).toISOString(),
    recoveryOf: "gh-77",
    recovered: { from: "live", n: 1, fromAttempt: 2, checkpointSeq: 4, orphans: 3, replayed: 2, interrupted: 1, notStarted: 0 },
    checkpoints: { written: 5, failed: 0, skipped: 1 },
  };
  const q = parsePageQuery("run", "id=gh-77.r1").query;
  const page = async (role, r) => (await pagePanels("run", ctxOf(role, { run: { record: r, source: "local" } }, q))).find((p) => p.id === "p-run").html;
  for (const role of ["viewer", "operator"]) {
    const html = String(await page(role, record));
    assert.match(html, /<dt>Recovery of<\/dt><dd><a class="mono" href="\/run\?id=gh-77">gh-77<\/a><\/dd>/, `${role}: the base run, by the run-link helper`);
    assert.match(html, /<dt>Recovery<\/dt><dd>recovered from a live checkpoint \(recovery 1, attempt 2, checkpoint 4\): 3 orphaned calls, 2 replayed, 1 interrupted<\/dd>/, role);
    assert.match(html, /<dt>Checkpoints<\/dt><dd>5 written, 0 failed, 1 skipped<\/dd>/, role);
  }
  const skipped = String(await page("viewer", { ...record, recoveryOf: undefined, recovered: undefined, checkpoints: undefined, recoverSkipped: "local" }));
  assert.match(skipped, /<dt>Recovery<\/dt><dd>recovery skipped: local<\/dd>/);
  assert.doesNotMatch(skipped, /Recovery of|Checkpoints/);
  assert.match(String(await page("viewer", { ...record, recovered: { from: "exit", n: 2, orphans: 0 } })), /<dd>recovered from an exit checkpoint \(recovery 2\): 0 orphaned calls<\/dd>/, "an attempt and a checkpoint the record lacks are left out");
  // A record of a job that never armed recovery, and one whose every recovery value is hostile, render the same bytes.
  const plain = { jobId: record.jobId, outcome: record.outcome, startedAt: record.startedAt, endedAt: record.endedAt };
  const hostile = {
    ...plain,
    recoveryOf: 'gh-1"><script>alert(1)</script>',
    recovered: { from: "<b>live</b>", n: 1, orphans: 3 },
    recoverSkipped: "FREE TEXT SKIP",
    checkpoints: { written: "5", failed: 0, skipped: 0 },
  };
  for (const role of ["viewer", "operator"]) assert.equal(String(await page(role, hostile)), String(await page(role, plain)), `${role}: every hostile value dropped`);
  const half = String(await page("operator", { ...plain, recovered: { from: "salvage", n: 3, fromAttempt: -1, checkpointSeq: 1.5, orphans: "x", replayed: 2 } }));
  assert.match(half, /<dd>recovered from a salvage checkpoint \(recovery 3\): 2 replayed<\/dd>/, "a count that is not one is dropped on its own");
});

test("the run page's Inbox panel (issue #646): the list for both roles without text; the message forms and withdraw buttons for an operator alone, only while the run takes messages", async () => {
  const { INBOX_NOT_OPEN, runInbox } = await import("../src/console/panels.mjs");
  const q = "0123456789abcdef0123456789abcdef";
  const w = "fedcba9876543210fedcba9876543210";
  const d = "aaaaaaaabbbbbbbbccccccccdddddddd";
  const entries = [
    { id: q, mode: "steer", source: "console", state: "queued", at: NOW - 30_000, bytes: 18 },
    { id: w, mode: "followUp", source: "forge", state: "written", at: NOW - 20_000, bytes: 2048 },
    { id: d, mode: "steer", source: "cli", state: "delivered", at: NOW - 10_000, bytes: 5 },
  ];
  // A hostile entry the reader would have rebuilt already: the panel escapes whatever it is handed anyway.
  const box = { found: true, steer: true, state: "active", open: true, entries: [...entries, { id: "<script>x</script>", mode: "steer", source: "panel", state: "queued", at: null, bytes: 0, text: "INBOX-TEXT-CANARY" }], closed: false };
  const view = (role, inbox, readOnly = false, id = "gh-1") => ({ page: "run", role, readOnly, query: { id }, env: {}, now: NOW, data: { now: NOW, inbox } });
  const op = String(runInbox(view("operator", box)));
  assert.match(op, /<h2>Inbox<\/h2>/);
  assert.match(op, new RegExp(`<td class="mono">${q}</td><td>steer</td><td>console</td><td>queued</td><td>2026-10-08 15:38 UTC</td><td class="num">18</td>`));
  assert.match(op, new RegExp(`<td class="mono">${w}</td><td>follow-up</td><td>forge</td><td>written</td>`));
  assert.match(op, /<td class="num">2,048<\/td>/);
  assert.equal((op.match(/data-action="steer-withdraw"/g) ?? []).length, 2, "a withdraw for the queued and the written message only, never the delivered one or an id outside the charset");
  assert.match(op, new RegExp(`name="id" value="${q}"`));
  assert.ok(!op.includes(`value="${d}"`));
  assert.equal((op.match(/data-action="steer"/g) ?? []).length, 2, "a steer form and a follow-up form");
  assert.match(op, /name="mode" value="steer"/);
  assert.match(op, /name="mode" value="followUp"/);
  assert.match(op, /name="jobId" value="gh-1"/);
  assert.match(op, /spends from the run&#39;s existing reservation/);
  assert.ok(!op.includes("<script>") && op.includes("&lt;script&gt;"), "escaped");
  for (const role of ["operator", "viewer"]) for (const html of [String(runInbox(view(role, box))), String(runInbox(view(role, box, true)))]) assert.ok(!html.includes("INBOX-TEXT-CANARY"), `${role}: no text anywhere in the list`);
  const viewer = String(runInbox(view("viewer", box)));
  assert.match(viewer, new RegExp(`<td class="mono">${q}</td>`), "a viewer sees the list");
  assert.ok(!viewer.includes("data-action") && !viewer.includes("<textarea"), "and no control");
  assert.ok(!String(runInbox(view("operator", box, true))).includes("data-action"), "none on a read-only console");
  // Active but not open: the list and the withdraw buttons, no message form, and the sentence naming every cause.
  const shut = String(runInbox(view("operator", { ...box, open: false })));
  assert.ok(shut.includes(INBOX_NOT_OPEN.replace(/'/g, "&#39;")) || shut.includes(INBOX_NOT_OPEN), "the not-open sentence");
  assert.ok(!shut.includes('data-action="steer"') && shut.includes('data-action="steer-withdraw"'));
  // Not running any more: no form; the kept list says so.
  const gone = String(runInbox(view("operator", { ...box, state: "completed", open: false })));
  assert.match(gone, /The job is completed, not running, so it takes no message/);
  assert.ok(!gone.includes('data-action="steer"'));
  // Nothing at all for a job that is not steer-armed, not found, or an id that is not one: other run pages read as before.
  for (const none of [null, { found: false }, { found: true, steer: false }, { invalid: true }]) assert.equal(String(runInbox(view("operator", none))), "");
  assert.match(String(runInbox(view("viewer", { unreachable: true }))), /inbox could not be read/);
  assert.match(String(runInbox(view("viewer", { ...box, entries: null }))), /messages could not be read this time/);
  assert.match(String(runInbox(view("viewer", { ...box, entries: [] }))), /No message has been sent to this run/);
});

test("the Inbox panel's edges (issue #646, review round 1): no form without a running job or a readable open, the query id's charset, an anchored message id, no Action column for a viewer, the textarea's bound, a missing time, and a run that continues as its recovery job", async () => {
  const { runInbox } = await import("../src/console/panels.mjs");
  const id = "0123456789abcdef0123456789abcdef";
  const entries = [{ id, mode: "steer", source: "console", state: "queued", at: null, bytes: 1 }, { id: `${id}0`, mode: "steer", source: "cli", state: "queued", at: NOW, bytes: 1 }, { id: `x${id.slice(1)}z`, mode: "steer", source: "cli", state: "written", at: NOW, bytes: 1 }];
  const base = { found: true, steer: true, state: "active", open: true, entries, closed: false };
  const view = (role, inbox, id2 = "gh-1") => ({ page: "run", role, readOnly: false, query: { id: id2 }, env: {}, now: NOW, data: { now: NOW, inbox } });
  const op = String(runInbox(view("operator", base)));
  assert.match(op, new RegExp(`<td class="mono">${id}</td><td>steer</td><td>console</td><td>queued</td><td>-</td>`), "a missing time is -");
  assert.equal((op.match(/>Withdraw<\/button>/g) ?? []).length, 1, "the Withdraw label, once: only the well-formed id; a 33-character or non-hex id gets none");
  assert.equal((op.match(/maxlength="8192"/g) ?? []).length, 2, "each textarea is bounded at the inbox's 8 KiB");
  assert.match(op, /<th scope="col">Action<\/th>/);
  assert.doesNotMatch(String(runInbox(view("viewer", base))), /Action/, "no Action column for a viewer");
  // Not active with open true (the open key outlives a job by its hold), and active with the open key unread: no form.
  const done = String(runInbox(view("operator", { ...base, state: "completed", open: true })));
  assert.ok(!done.includes('data-action="steer"'), "no form for a job that is not running, open or not");
  const unread = String(runInbox(view("operator", { ...base, open: null })));
  assert.match(unread, /Whether the run takes messages could not be read\./);
  assert.ok(!unread.includes('data-action="steer"'));
  // A page id outside the run-id charset gets no control at all.
  const odd = String(runInbox(view("operator", base, "gh <1>")));
  assert.ok(!odd.includes("data-action") && odd.includes(id), "the list, no control");
  // A run that continues as its recovery job (review F4): named with a link, and the forms stay.
  const cont = String(runInbox(view("operator", { ...base, state: "failed", continuesAs: "gh-1.r1" })));
  assert.match(cont, /This job is failed; its run continues as <a class="mono" href="\/run\?id=gh-1.r1">gh-1.r1<\/a>, and a message sent here goes to that job\./);
  assert.ok(cont.includes('data-action="steer"'), "the planner sends through the active recovery job");
  const hostile = String(runInbox(view("operator", { ...base, state: "failed", continuesAs: "<b>" })));
  assert.ok(!hostile.includes("continues as") && !hostile.includes('data-action="steer"'), "a continuation id outside the charset is ignored");
});

test("the run page reads the inbox end to end (issue #646): loadPageData asks the fleet for the page's id, a throw is unreachable, and the page draws the panel", async () => {
  const { loadPageData } = await import("../src/console/pages.mjs");
  const asked = [];
  const box = { found: true, steer: true, state: "active", open: true, entries: [{ id: "0123456789abcdef0123456789abcdef", mode: "steer", source: "panel", state: "written", at: NOW, bytes: 4 }], closed: false };
  const fleet = { runById: async () => ({ missing: true }), runsPage: async () => ({ runs: [], next: null }), inbox: async (id) => (asked.push(id), box) };
  const data = await loadPageData("run", { id: "gh-7" }, { fleet, now: NOW });
  assert.deepEqual(asked, ["gh-7"]);
  assert.deepEqual(data.inbox, box);
  const page = await renderPage("run", { query: { id: "gh-7" }, session: { name: "ops", role: "operator" }, data });
  assert.match(String(page.html), /<section id="p-inbox" data-panel><h2>Inbox<\/h2>/);
  const panels = await pagePanels("run", { query: { id: "gh-7" }, session: { name: "v", role: "viewer" }, data });
  assert.ok(panels.some((p) => p.id === "p-inbox" && p.html.includes("written") && !p.html.includes("data-action")));
  const broken = await loadPageData("run", { id: "gh-7" }, { fleet: { ...fleet, inbox: async () => { throw new Error("down"); } }, now: NOW });
  assert.deepEqual(broken.inbox, { unreachable: true });
  const other = await loadPageData("runs", {}, { fleet: { ...fleet, runsPage: async () => ({ runs: [] }), inbox: async (id) => (asked.push(`runs:${id}`), box) }, now: NOW });
  assert.equal("inbox" in other, false, "only the run page reads it");
  assert.deepEqual(asked, ["gh-7"]);
});
