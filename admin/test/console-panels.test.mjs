import assert from "node:assert/strict";
import { test } from "node:test";
import { PAGES, pagePanels, parsePageQuery, renderPage } from "../src/console/pages.mjs";
import { BEAT_FRESH_MS, COUNT_WINDOWS_UTC_TEXT, NO_WORKER_TEXT, STALE_BEATS_TEXT, ageText, insightsBody, moneyHtml, runCost, shownPath, timeHtml, usdText, utcText, workersOnline } from "../src/console/panels.mjs";
import { LEGACY_CSS } from "../src/console/compat-css.mjs";
import { CONSOLE_CSS } from "../src/console/style.mjs";

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

test("the secret profiles list PI_SECRET_PROFILES' names beside the overlay's, and never says none while the env holds some (#712)", async () => {
  const profilesOf = async (extra) => {
    const html = (await pagePanels("config", ctxOf("operator", { snapshot: { ...snapshot(), ...extra } }))).map((p) => p.html).join("");
    return html.slice(html.indexOf("<h2>Secret profiles</h2>"), html.indexOf("<h2>Secret bundles</h2>"));
  };
  const noOverlay = { settings: { overlay: {} } };
  const envOnly = await profilesOf({ ...noOverlay, secretProfilesEnv: { names: ["prod"], malformed: false, seen: true } });
  assert.match(envOnly, /<li class="mono">prod \(PI_SECRET_PROFILES\)<\/li>/);
  assert.ok(!envOnly.includes("No secret profile is declared"), envOnly);
  assert.match(await profilesOf({ ...noOverlay, secretProfilesEnv: { names: [], malformed: false, seen: true } }), /No secret profile is declared\./, "both sources seen and empty");
  assert.match(await profilesOf({ ...noOverlay, secretProfilesEnv: { names: [], malformed: false, seen: false } }), /No secret profile is declared in the settings overlay\./, "the env not visible: says which source it read");
  assert.match(await profilesOf({ ...noOverlay, secretProfilesEnv: { names: [], malformed: true, seen: true } }), /PI_SECRET_PROFILES does not parse/);
  const both = await profilesOf({ settings: { overlay: { secretProfiles: { prod: "/opt/secret/p" } } }, secretProfilesEnv: { names: ["prod"], malformed: false, seen: true } });
  assert.match(both, /prod \(AMBIGUOUS: also in PI_SECRET_PROFILES, so the worker refuses every secrets job\)/);
  assert.ok(!both.includes("/opt/secret"), "names only");
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
  // The shell's Parked count (`p-nav-parked`) is a panel too; with no snapshot it is drawn empty, never "could not be read".
  const none = (await pagePanels("overview", ctxOf("viewer", { snapshot: null }))).filter((p) => p.id !== "p-nav-parked").map((p) => p.html);
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

test("the stylesheet draws the old panels on the Pulse tokens, inside .legacy, with the charts' colours re-pointed", () => {
  // The whole stylesheet is console-stylesheet.test.mjs's and the legacy layer's ratchet console-compat.test.mjs's; this
  // holds what the panels drawn here rely on.
  assert.ok(!/<|@import|url\(/.test(CONSOLE_CSS), "plain rules, nothing fetched");
  assert.ok(CONSOLE_CSS.endsWith(LEGACY_CSS), "the old panels' rules come last");
  assert.match(CONSOLE_CSS, /@media \(prefers-color-scheme: dark\)\{:root:not\(\[data-theme="light"\]\)\{color-scheme:dark;--canvas:/, "the system's dark preference, unless the page forces light");
  assert.match(CONSOLE_CSS, /\nbody \{ margin: 0; background: var\(--canvas\);/, "the body background is explicit");
  // The old palette is a set of properties defined from the tokens, so it follows the theme; no literal is left in a rule.
  assert.match(LEGACY_CSS, /\.legacy\{--pd-canvas:var\(--canvas\);--pd-panel:var\(--surface\);/);
  assert.match(LEGACY_CSS, /\.legacy svg \[fill="#58a6ff"\]\{fill:var\(--pd-accent\)\}/, "a chart's presentation attribute follows the theme");
  assert.match(LEGACY_CSS, /\.legacy>section\[data-panel\],\.legacy>section\.transcript-section\{[^}]*border-radius:var\(--radius-lg\);background:var\(--surface\)\}/, "each old panel is a card");
  const declarations = LEGACY_CSS.replace(/\[[^\]]*\]/g, "");
  assert.ok(!/#[0-9a-f]{3,8}\b/i.test(declarations), "no colour literal outside an attribute selector");
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
  assert.match(String(runProgress(view("viewer", { run: { missing: true }, progress: { absent: true }, transcript: { exists: true } }))), /No live progress: not published \(PI_RUN_PROGRESS=0\)/);
  // Issue #710: no record and nothing running (a queued job, or no run at all): the outcome banner says it, this draws nothing.
  assert.equal(String(runProgress(view("viewer", { run: { missing: true }, progress: { absent: true } }))), "");
});

test("the Progress panel of an attempt whose run continues as a recovery (issue #662): its own record's progress and a link, never the recovery's live key", async () => {
  const { runProgress } = await import("../src/console/panels.mjs");
  const ended = NOW - 120_000;
  const record = { jobId: "gh-1", outcome: "failed", reason: "recovery-enqueued", startedAt: new Date(ended - 900_000).toISOString(), endedAt: new Date(ended).toISOString(), progress: { turns: 5, steps: 7 } };
  const recoveryKey = { v: 1, turn: 2, steps: 3, failed: 0, interrupted: 0, running: [{ tool: "bash", since: NOW - 20_000 }], recent: [], phase: null, phases: ["RECOVERY-PHASE"], note: null, prior: { turns: 5, steps: 7 }, startedAt: ended + 30_000, updatedAt: NOW - 1_000, ended: false, outcome: null };
  const view = (data) => ({ page: "run", role: "operator", readOnly: false, query: { id: "gh-1" }, env: {}, now: NOW, data: { now: NOW, ...data } });
  const base = String(runProgress(view({ run: { record }, progress: recoveryKey, progressContinues: { as: "gh-1.r1" } })));
  assert.match(base, /This run continues as <a class="mono" href="\/run\?id=gh-1\.r1"/);
  assert.match(base, /<dt>Turns<\/dt><dd>5<\/dd>/, "the attempt's own record");
  assert.doesNotMatch(base, /RECOVERY-PHASE|An earlier attempt|running 20s/, "the recovery's live key is not this attempt's");
  // The queue no longer holds the recovery job: still the record, with no link.
  const gone = String(runProgress(view({ run: { record: { ...record, progress: undefined } }, progress: { absent: true }, progressContinues: { as: null } })));
  assert.match(gone, /This run continues as a recovery job\./);
  assert.match(gone, /This attempt's record holds no progress\./);
  // A hostile id is never linked.
  for (const as of ["x\"><script>", "", 7, { id: "gh-1.r1" }]) {
    const out = String(runProgress(view({ run: { record }, progress: recoveryKey, progressContinues: { as } })));
    assert.doesNotMatch(out, /<script>|href=/, JSON.stringify(as));
    assert.match(out, /This run continues as a recovery job\./, JSON.stringify(as));
  }
  // A recovery's own page (no record yet) shows its run's key live, as any running job.
  const own = String(runProgress({ ...view({ run: { missing: true }, progress: recoveryKey }), query: { id: "gh-1.r1" } }));
  assert.match(own, /<dt>Turn<\/dt><dd>2<\/dd>/);
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
  // In the console's words (#710 round 2): a refused run's progress never says the record's "policy".
  const endedRefused = String(runProgress(view("operator", { run: { record }, progress: { ...attempt2, running: [], ended: true, outcome: "policy" } })));
  assert.match(endedRefused, /The run has ended \(refused\)\./);
  assert.doesNotMatch(endedRefused, /\(policy\)/);
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
  assert.match(skipped, /<dt>Recovery<\/dt><dd>recovery skipped \(local\): A folder job is never recovered, so it ran as it would without run\.recover\.<\/dd>/, "the token and the catalog's sentence (issue #710)");
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
  assert.match(op, new RegExp(`<td class="mono">${q}</td><td>steer</td><td>console</td><td>queued</td><td><time datetime="2026-10-08T15:38:38.000Z">2026-10-08 15:38 UTC</time></td><td class="num">18</td>`));
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

// ---- the spend screen (the insights move to the console) -------------------------------------------------------------

const { buildGraphModel } = await import("../src/graph-model.mjs");
const { insightsPanel, insightsRange, insightsWhatIf, graphNodesHtml, WHATIF_FLOW_RE } = await import("../src/console/panels.mjs");
const { CONSOLE_SCRIPT } = await import("../src/console/script.mjs");
const { SECURITY_HEADERS } = await import("../src/console/headers.mjs");
const W = await import("../src/console/whatif.mjs");

/** A one-folder deployment for the topology: the folder's full path is the canary the paths rule is about. */
const SECRET_FOLDER = "/srv/secret-site";
const GRAPH_INPUTS = () => ({
  triggers: { triggers: [{ type: "cron", index: 0, id: "nightly", pattern: "0 3 * * *", folder: SECRET_FOLDER, flow: "tidy", model: null, packages: true, image: null, skillsDir: null, instructions: false, resume: false }] },
  schedulers: [],
  folderSkills: { [SECRET_FOLDER]: { head: "abc123", truncated: false, unreachable: null, skills: [{ name: "tidy", isSub: false, group: null, aiTrigger: true, meta: null, mentions: [], unread: false }, { name: "notify", isSub: false, group: null, aiTrigger: true, meta: null, mentions: [], unread: false }] } },
  injectedSkills: {},
  overlaySkills: { skills: [], truncated: false, unreachable: null },
  stagedSkills: { skills: [], unenumerable: [], truncated: false },
  forgeRepos: {},
  cronStats: { byId: { nightly: { runs: 3, lastOutcome: "completed", lastEndedAt: "2026-10-08T03:05:00.000Z" } } },
  runJoin: { byIndex: {}, unattributed: 0 },
  chainEdges: { edges: [], refusals: {}, truncated: false },
  caps: { chainDepthMax: 1, chainMaxPerJob: 2, windowDays: 30 },
  nowMs: NOW,
});
const usd = (n, cls = "metered") => ({ usd: n, class: cls, floor: false });
const FOLD = () => ({
  window: { fromMs: NOW - 30 * 86_400_000, toMs: NOW, days: 30, firstRunMs: NOW - 86_400_000 },
  daily: [{ day: "2026-10-08", cost: usd(1.5), runs: 2 }],
  byFlow: [{ flow: "tidy", flowKey: "tidy", runs: 2, tokens: 10, cost: usd(1.5), apiEquiv: null }, { flow: "Not A Flow", flowKey: "x", runs: 1, tokens: 1, cost: usd(0) }],
  byModel: [],
  byTrigger: [{ key: "trigger:0", index: 0, type: "cron", label: "nightly 0 3 * * *", runs: 2, tokens: 10, cost: usd(1.5), outcomes: { completed: 2, policy: 0, failed: 0 }, failedCost: null }],
  byRepo: [],
  plans: [],
  provenance: { total: usd(1.5), runsTotal: 2, runsUnmetered: 0, runsUnledgered: 0, runsLedgerTruncated: 0, ratesDrifted: 0, piAiPin: "1.2.3" },
});
const PAYLOAD = () => ({ graph: buildGraphModel(GRAPH_INPUTS()), fold: FOLD(), window: "30d", costsUnreachable: null, costByTrigger: { "trigger:0": { cost: usd(1.5), runs: 2 } } });

test("the spend screen opens on 30d, states both windows, and draws the topology's chip data for its script", async () => {
  const q = parsePageQuery("insights", "").query;
  assert.equal(q.range, "30d", "a bare /insights is the last 30 days");
  const range = String(insightsRange({ query: q, role: "viewer" }));
  assert.match(range, /<a href="\/insights\?range=30d" aria-current="page">last 30d<\/a>/);
  const page = String((await renderPage("insights", ctxOf("viewer", { insights: PAYLOAD(), pricedModels: [] }, q))).html);
  assert.match(page, /<h2>Spend, last 30d<\/h2>/);
  assert.ok(page.includes('<p id="windows" class="note">spend window: last 30d · topology: fixed 30d record window · series bounded by retention (PI_LOG_RETENTION_DAYS) and the 92-day scan cap</p>'), "the two-window line, with the retention and scan-cap note");
  assert.match(page, /<ol id="graph-nodes" class="hidden-tips" hidden><li data-id="n0" data-nb="[nw\d ]*" data-w="[nw\d ]*">/, "the chips' data, as a hidden list");
  assert.match(page, /data-node="n\d+"/, "a breakdown row names its chip by minted id");
  assert.ok(!page.includes('"trigger:0"'), "no original trigger id reaches the page");
  const mtd = String((await renderPage("insights", ctxOf("viewer", { insights: { ...PAYLOAD(), window: "mtd" } }, parsePageQuery("insights", "range=mtd").query))).html);
  assert.ok(mtd.includes("spend window: month to date · topology: fixed 30d record window"));
  // The topology's window is the scene's own, not a constant that happens to equal the default.
  const fortnight = { ...PAYLOAD(), graph: buildGraphModel({ ...GRAPH_INPUTS(), caps: { ...GRAPH_INPUTS().caps, windowDays: 14 } }) };
  const fourteen = String((await renderPage("insights", ctxOf("viewer", { insights: fortnight }, q))).html);
  assert.ok(fourteen.includes("topology: fixed 14d record window"), "a 14-day scene says 14d");
});

test("the chips' hidden list carries minted ids only, by the same two rules the script reads it with", () => {
  const scene = { graphData: { nodes: {
    n2: { tip: "two\nlines", nb: ["n0", "w1", "constructor", "n1\" onclick=\"x", 7, "n9999999"], w: ["w1", "n0", "w2 w3", "__proto__", "w12"] },
    n0: { tip: "zero", nb: ["n2"], w: "w1" },
    w5: { tip: "a wire is no chip", nb: [], w: [] },
    constructor: { tip: "PROTO", nb: [], w: [] },
  } } };
  assert.equal(String(graphNodesHtml(scene)), '<ol id="graph-nodes" class="hidden-tips" hidden><li data-id="n0" data-nb="n2" data-w="">zero</li><li data-id="n2" data-nb="n0" data-w="w1 w12">two\nlines</li></ol>', "a chip id for the item and its neighbours, a wire id for its wires, in id order");
  // The script's reader applies the same rules, so the two cannot drift apart unnoticed.
  for (const rule of ["/^n\\d{1,6}$/", "/^w\\d{1,6}$/"]) assert.ok(CONSOLE_SCRIPT.includes(rule), `the script checks ${rule}`);
  assert.ok(!CONSOLE_SCRIPT.includes("[nw]"), "and no looser rule that takes either for either");
});

test("full local paths are an operator's opt-in (?paths=full); a viewer always gets folder names, and is told why", async () => {
  const full = parsePageQuery("insights", "paths=full").query;
  const plain = parsePageQuery("insights", "").query;
  const draw = (role, q) => String(insightsPanel({ data: { insights: PAYLOAD() }, query: q, role, now: NOW }));
  assert.ok(draw("operator", full).includes(SECRET_FOLDER), "an operator asking sees the full path");
  for (const [role, q] of [["operator", plain], ["viewer", plain], ["viewer", full], [null, full]]) {
    const out = draw(role, q);
    assert.ok(!out.includes(SECRET_FOLDER), `${role} ${q.paths}: no full path`);
    assert.ok(out.includes("secret-site"), `${role} ${q.paths}: the folder's name`);
  }
  assert.match(String(insightsRange({ query: plain, role: "operator" })), /<a href="\/insights\?range=30d&amp;paths=full">Show full local paths<\/a>/);
  assert.match(String(insightsRange({ query: full, role: "operator" })), /<a href="\/insights\?range=30d">Show folder names only<\/a>/);
  assert.match(String(insightsRange({ query: full, role: "operator" })), /<a href="\/insights\?range=7d&amp;paths=full">last 7d<\/a>/, "a range link keeps an operator's full paths");
  assert.match(String(insightsRange({ query: full, role: "viewer" })), /Full local paths are shown to operators only/);
  assert.doesNotMatch(String(insightsRange({ query: plain, role: "viewer" })), /paths/i, "a viewer is offered no toggle");
  // The read: only an operator's request asks the assembly for full paths, so a viewer's page data never holds them.
  const { loadPageData } = await import("../src/console/pages.mjs");
  for (const [role, want] of [["operator", true], ["viewer", false], [undefined, false]]) {
    const asked = [];
    await loadPageData("insights", full, { insights: async (w, o) => (asked.push([w, o]), {}), now: NOW }, { role });
    assert.deepEqual(asked, [["30d", { fullPaths: want }]], String(role));
  }
  const asked = [];
  await loadPageData("insights", plain, { insights: async (w, o) => (asked.push(o), {}), now: NOW }, { role: "operator" });
  assert.deepEqual(asked, [{ fullPaths: false }], "an operator who did not ask gets names too");
});

test("the what-if panel: a GET form for every role with the priced ids and the window's flows, and each kind of answer", async () => {
  const q = parsePageQuery("insights", "range=7d&paths=full").query;
  for (const role of ["viewer", "operator"]) {
    const out = String(insightsWhatIf({ data: { insights: PAYLOAD(), pricedModels: ["acme/m-1", "acme/m-2"] }, query: q, role, now: NOW }));
    assert.match(out, /<form class="filters" method="get" action="\/insights"><input type="hidden" name="range" value="7d"><input type="hidden" name="paths" value="full">/, `${role}: a plain GET back to the page, keeping its range and paths`);
    assert.ok(!out.includes("data-action"), `${role}: a read, never an action`);
    assert.ok(out.includes('<datalist id="whatif-models"><option value="acme/m-1"><option value="acme/m-2"></datalist>'));
    assert.ok(out.includes('<datalist id="whatif-flows"><option value="tidy"></datalist>'), "the window's flows, in the flow charset");
  }
  const view = (whatIf, query) => String(insightsWhatIf({ data: { insights: PAYLOAD(), pricedModels: [], whatIf }, query: { ...parsePageQuery("insights", "").query, ...query }, role: "viewer", now: NOW }));
  const known = view({ model: "acme/m-1", flow: "tidy", result: { class: "estimated", usd: 4, perRun: 2, coverage: 0.5, excluded: 1, ratesVersion: "1.2.3" } }, { whatif: "acme/m-1", flow: "tidy" });
  assert.ok(known.includes('value="acme/m-1"') && known.includes('value="tidy"'), "the form shows what was asked");
  assert.match(known, /<pre class="answer">What-if tidy @ acme\/m-1:\n  estimate ~\$4\.00 est\. total · ~\$2\.00 est\. per run\n  coverage 50% of observed runs ledgered · excluded 1 \(no ledger\)\n  rates pi-ai 1\.2\.3<\/pre>/, "the old command's words");
  const seeded = view({ model: "acme/m-1", flow: "tidy", result: { class: "seeded", low: 0.5, high: 5, note: "unmeasured (OQ-002)" } }, { whatif: "acme/m-1", flow: "tidy" });
  assert.match(seeded, /no ledgered run to measure from/);
  assert.match(seeded, /unmeasured \(OQ-002\)/);
  const unknown = view({ model: "acme/nope", flow: "tidy", unknown: true, near: ["acme/nope-2", "other/nope"] }, { whatif: "acme/nope", flow: "tidy" });
  assert.match(unknown, /Unknown model: <span class="mono">acme\/nope<\/span>/);
  assert.match(unknown, /<a class="mono" href="\/insights\?range=30d&amp;whatif=acme%2Fnope-2&amp;flow=tidy">acme\/nope-2<\/a>/, "each closest id asks again");
  assert.match(view({ model: "acme/nope", flow: "tidy", unknown: true, near: [] }, {}), /No priced id resembles it/);
  const down = view({ model: "acme/m-1", flow: "tidy", unreachable: "logs dir unreadable (EACCES)" }, {});
  assert.match(down, /The run records could not be read/);
  assert.ok(!down.includes("EACCES"), "the reader's reason stays in the log");
  assert.ok(!view(null, {}).includes("<pre"), "no question, no answer");
  // The datalist's flow rule is the worker's skill charset.
  const { SKILL_NAME_RE } = await import("@edgehero/pi-dispatch/flow-gate");
  assert.equal(WHATIF_FLOW_RE.source, SKILL_NAME_RE.source);
});

test("loadPageData asks the what-if reader only for a whatif query, and a reader that throws is a stated failure", async () => {
  const { loadPageData } = await import("../src/console/pages.mjs");
  const asked = [];
  const deps = { insights: async () => ({}), whatIf: async (a) => (asked.push(a), { ...a, result: { class: "seeded", low: 0.5, high: 5, note: "n" } }), pricedModels: () => ["a/b"], now: NOW };
  const none = await loadPageData("insights", parsePageQuery("insights", "").query, deps);
  assert.deepEqual([asked, none.whatIf, none.pricedModels], [[], undefined, ["a/b"]]);
  const one = await loadPageData("insights", parsePageQuery("insights", "whatif=a%2Fb&flow=tidy").query, deps);
  assert.deepEqual(asked, [{ model: "a/b", flow: "tidy" }]);
  assert.equal(one.whatIf.result.class, "seeded");
  const broken = await loadPageData("insights", parsePageQuery("insights", "whatif=a%2Fb&flow=tidy").query, { ...deps, whatIf: async () => { throw new Error("x"); }, pricedModels: () => { throw new Error("y"); } });
  assert.deepEqual(broken.whatIf, { model: "a/b", flow: "tidy", unreachable: "the what-if estimate failed" });
  assert.deepEqual(broken.pricedModels, []);
  // A console built without the reader says so instead of drawing a form that silently never answers.
  const { whatIf: _w, ...unwired } = deps;
  const lonely = await loadPageData("insights", parsePageQuery("insights", "whatif=a%2Fb&flow=tidy").query, unwired);
  assert.deepEqual(lonely.whatIf, { model: "a/b", flow: "tidy", unreachable: "the what-if reader is not wired" });
});

test("the what-if reader: an unknown model never scans, one bounded scan serves every key per TTL, answers are capped, a failed scan is not kept", async () => {
  const priced = new Set(["acme/m-1", "acme/m-2", "acme/m-3"]);
  const pricing = {
    getPricedModel: (p, id) => (priced.has(`${p}/${id}`) ? { provider: p, id } : null),
    listPricedModels: () => [...priced].map((t) => ({ provider: t.split("/")[0], id: t.split("/")[1] })).concat([{ provider: "evil", id: "<b>" }]),
    reprice: (quad) => (reprices++, { usd: (quad.input + quad.output) / 1_000_000, ratesVersion: "9.9.9" }),
  };
  let reprices = 0;
  const run = (flow, input) => ({ flow, outcome: "completed", usage: { models: [{ provider: "x", model: "y", input, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 }] } });
  let t = NOW;
  let scans = 0;
  let records = [run("tidy", 1_000_000), run("tidy", 3_000_000), run("tidy", 2_000_000), run("fix", 9)];
  const read = W.makeWhatIfReader({ pricing, scan: () => (scans++, records), now: () => t, max: 2 });
  const unknown = await read({ model: "acme/m-1x", flow: "tidy" });
  assert.deepEqual(unknown, { model: "acme/m-1x", flow: "tidy", unknown: true, near: ["acme/m-1"] }, "the closest priced ids, from the catalog alone");
  assert.equal(scans, 0, "an unknown model never walks the logs");
  const a = await read({ model: "acme/m-1", flow: "tidy" });
  assert.deepEqual(a.result, { class: "estimated", usd: 6, perRun: 2, coverage: 1, excluded: 0, ratesVersion: "9.9.9" }, "the median run re-priced, times the runs");
  await read({ model: "acme/m-2", flow: "tidy" });
  await read({ model: "acme/m-3", flow: "fix" });
  assert.equal(scans, 1, "one scan within the TTL, whatever the key");
  assert.equal(reprices, 3);
  assert.equal((await read({ model: "acme/m-3", flow: "fix" })).result.perRun, 9 / 1_000_000, "a cached answer within the TTL");
  await read({ model: "acme/m-2", flow: "tidy" });
  assert.equal(reprices, 3, "both held answers served from the cache");
  await read({ model: "acme/m-1", flow: "tidy" });
  assert.equal(reprices, 4, "the oldest answer was dropped past the cap of 2, so it is worked out again");
  assert.equal(scans, 1, "over the same held scan");
  records = [];
  t += W.WHATIF_LIMITS.ttlMs;
  scans = 0;
  await read({ model: "acme/m-2", flow: "tidy" });
  assert.equal(scans, 1, "a new scan once the TTL is past");
  const failing = W.makeWhatIfReader({ pricing, scan: () => (scans++, { unreachable: "logs dir unreadable (EACCES)" }), now: () => t });
  scans = 0;
  assert.equal((await failing({ model: "acme/m-1", flow: "tidy" })).unreachable, "logs dir unreadable (EACCES)");
  await failing({ model: "acme/m-1", flow: "tidy" });
  assert.equal(scans, 2, "a failed scan is not kept, and neither is its answer");
  // The flow is part of the key: one model, two flows, two answers.
  records = [run("tidy", 1_000_000), run("fix", 9)];
  const both = W.makeWhatIfReader({ pricing, scan: () => records, now: () => t });
  assert.deepEqual([(await both({ model: "acme/m-1", flow: "tidy" })).result.perRun, (await both({ model: "acme/m-1", flow: "fix" })).result.perRun], [1, 9 / 1_000_000]);
  // A re-asked expired key is the NEWEST entry, so the cap drops the one that really is oldest.
  const t0 = t;
  reprices = 0;
  const lru = W.makeWhatIfReader({ pricing, scan: () => records, now: () => t, max: 2 });
  await lru({ model: "acme/m-1", flow: "tidy" });
  t = t0 + 20_000;
  await lru({ model: "acme/m-2", flow: "tidy" });
  t = t0 + W.WHATIF_LIMITS.ttlMs + 1_000;
  await lru({ model: "acme/m-1", flow: "tidy" });
  await lru({ model: "acme/m-3", flow: "tidy" });
  assert.equal(reprices, 4);
  await lru({ model: "acme/m-1", flow: "tidy" });
  assert.equal(reprices, 4, "m-1, re-asked after it expired, outlived m-2 under the cap");
  await lru({ model: "acme/m-2", flow: "tidy" });
  assert.equal(reprices, 5, "m-2 was the one dropped");
  // The closest ids: at most three, and never an id outside the form's own rule.
  const wide = { listPricedModels: () => ["m-1", "m-2", "m-3", "m-4"].map((id) => ({ provider: "acme", id })).concat([{ provider: "evil", id: "<m>" }]) };
  assert.deepEqual(W.closestPricedIds(wide, "m"), ["acme/m-1", "acme/m-2", "acme/m-3"], "the first three that resemble it");
  assert.deepEqual(W.closestPricedIds(wide, "<m>"), [], "a catalog id the form would refuse is never offered");
  assert.deepEqual(W.pricedModelIds(pricing), ["acme/m-1", "acme/m-2", "acme/m-3"], "the catalog for the datalist, an id outside the form's rule dropped");
  assert.deepEqual(W.splitTarget("openrouter/anthropic/claude-x"), { provider: "openrouter", id: "anthropic/claude-x" }, "split on the first slash");
  assert.equal(W.splitTarget("nope"), null);
});

test("every id the pinned catalog prices passes the what-if rule, reaches the datalist and the closest ids; hostile ones still do not", async () => {
  const real = await import("@edgehero/pi-dispatch/pricing");
  const ids = [...new Set(real.listPricedModels().map((m) => `${m.provider}/${m.id}`))];
  assert.ok(ids.length > 500, `the real catalog (${ids.length} ids)`);
  assert.deepEqual(ids.filter((t) => !W.WHATIF_MODEL_RE.test(t)), [], "no priced id is refused");
  assert.ok(ids.some((t) => t.includes("/@")) && ids.some((t) => t.includes("/~")), "the catalog still holds the @ and ~ ids this rule admits");
  const pricing = { listPricedModels: real.listPricedModels };
  assert.deepEqual(W.pricedModelIds(pricing), [...ids].sort().slice(0, W.WHATIF_LIMITS.models), "the datalist offers every one");
  const at = ids.find((t) => t.includes("/@"));
  const tilde = ids.find((t) => t.includes("/~"));
  assert.ok(W.closestPricedIds(pricing, W.splitTarget(at).id).includes(at), `${at} is a closest id`);
  assert.ok(W.closestPricedIds(pricing, W.splitTarget(tilde).id).includes(tilde), `${tilde} is a closest id`);
  for (const t of ["a/b~c", "a/@b~", "@a/b", "~a/b", "a/<b>", "a/b c", "a/b\"", "a/'b", "a/b&c", "a/b;c", "a/b?c", "a/b#c", "a/b%2F", "a/b\nc", "a/" + "m".repeat(129), "a/@", "a/~", "a/@.x", "a/~/x"]) {
    assert.equal(W.WHATIF_MODEL_RE.test(t), false, `${JSON.stringify(t)}: a leading @ or ~ only, never anywhere else`);
  }
});

/**
 * A DOM just large enough for the spend screen's part of console.js: elements by id with attributes, classes and
 * listeners, the topology's svg with a live viewBox, the chips, and the hidden lists the page carries. `items` is the
 * `#graph-nodes` list as `[id, nb, w, tip]`. The viewBox takes 32-bit floats as a browser's does, so a value past that
 * range throws on assignment (`vbThrows` makes every assignment throw); `rect` is the svg's client box, which by
 * default has the viewBox's own ratio.
 */
function spendDom({ items, tips = [], hash = "", rect = { left: 0, top: 0, width: 600, height: 300 }, vbThrows = false }) {
  const listeners = new Map();
  const on = (target) => (type, fn) => listeners.set(`${target}:${type}`, fn);
  const classList = () => {
    const set = new Set();
    return { add: (c) => set.add(c), remove: (c) => set.delete(c), contains: (c) => set.has(c), set };
  };
  const els = {};
  const el = (id, extra = {}) => (els[id] = { id, textContent: "", style: {}, classList: classList(), attrs: {}, getAttribute(n) { return this.attrs[n] ?? null; }, getBoundingClientRect: () => ({ left: 0, top: 0, width: 600, height: 300 }), addEventListener: on(id), getElementsByTagName: () => [], ...extra });
  el("tip");
  el("wrap");
  const held = { x: 0, y: 0, width: 600, height: 300 };
  const vb = {};
  for (const k of Object.keys(held)) {
    Object.defineProperty(vb, k, {
      enumerable: true,
      get: () => held[k],
      set: (v) => {
        if (vbThrows || !Number.isFinite(Math.fround(v))) throw new TypeError("The provided float value is non-finite.");
        held[k] = v;
      },
    });
  }
  el("graph", { viewBox: { baseVal: vb }, getBoundingClientRect: () => rect, setPointerCapture() {}, hasPointerCapture: () => false, releasePointerCapture() {} });
  el("root", { querySelectorAll: (sel) => (sel === ".hi" ? Object.values(els).filter((e) => e.classList.contains("hi")) : []) });
  const dispatched = [];
  for (const [id] of items) el(id, { dispatchEvent: (ev) => dispatched.push([id, ev.type]) });
  for (const [, nb, w] of items) for (const x of `${nb} ${w}`.split(" ").filter(Boolean)) if (!els[x]) el(x);
  const li = (attrs, text) => ({ textContent: text, getAttribute: (n) => attrs[n] ?? null });
  el("graph-nodes", { getElementsByTagName: (t) => (t === "li" ? items.map(([id, nb, w, tip]) => li({ "data-id": id, "data-nb": nb, "data-w": w }, tip)) : []) });
  el("insights-tips", { getElementsByTagName: (t) => (t === "li" ? tips.map((x) => li({}, x)) : []) });
  const history = [];
  const timers = [];
  const document = {
    body: { getAttribute: (n) => (n === "data-page" ? "insights" : null) },
    getElementById: (id) => els[id] ?? null,
    getElementsByTagName: () => [],
    querySelector: () => null,
    addEventListener: on("document"),
  };
  const location = { hash, pathname: "/insights", search: "?range=30d" };
  function MouseEvent(type) {
    this.type = type;
  }
  new Function("document", "location", "history", "setTimeout", "MouseEvent", "EventSource", CONSOLE_SCRIPT)(document, location, { replaceState: (_s, _t, url) => history.push(url) }, (fn) => timers.push(fn), MouseEvent, undefined);
  const flush = () => {
    while (timers.length) timers.shift()();
  };
  const fire = (key, ev) => listeners.get(key)?.(ev);
  // An event whose target finds `found` for `sel` with closest().
  const at = (map) => ({ target: { closest: (sel) => map[sel] ?? null }, clientX: 100, clientY: 50, button: 0, pointerId: 1, deltaY: -100, preventDefault() {}, key: "x" });
  return { els, vb, history, flush, fire, at, dispatched, listeners };
}

test("the spend screen's script under a DOM stub: chip tooltips, selection with neighbours, Escape, the row replay, zoom and the hash", () => {
  const items = [["n0", "n1", "w0", "cron nightly\nnext 03:00"], ["n1", "n0", "w0", "skill tidy"], ["constructor", "n0", "w0", "PROTO"]];
  const d = spendDom({ items, tips: ["2026-10-08 · $1.50 · 2 runs"] });
  for (const k of ["graph:pointerdown", "graph:pointermove", "graph:pointerup", "graph:wheel", "graph:click", "document:click", "document:keydown", "document:pointermove"]) assert.equal(typeof d.listeners.get(k), "function", `${k} is wired`);
  // A chip's tooltip, as text, its lines kept.
  d.fire("graph:pointermove", d.at({ ".gnode": d.els.n0 }));
  assert.equal(d.els.tip.textContent, "cron nightly\nnext 03:00");
  assert.equal(d.els.tip.style.display, "block");
  // A chart bar's tooltip, by its index into #insights-tips; a bad index shows nothing.
  d.fire("document:pointermove", d.at({ "[data-tip]": { getAttribute: () => "0" } }));
  assert.equal(d.els.tip.textContent, "2026-10-08 · $1.50 · 2 runs");
  d.fire("document:pointermove", d.at({ "[data-tip]": { getAttribute: () => "7" } }));
  assert.equal(d.els.tip.style.display, "none");
  // Selecting a chip dims the rest and marks it, its neighbours and its wires; a second click clears.
  d.fire("graph:click", d.at({ ".gnode": d.els.n0 }));
  assert.ok(d.els.root.classList.contains("dim"));
  assert.deepEqual(["n0", "n1", "w0"].filter((id) => d.els[id].classList.contains("hi")), ["n0", "n1", "w0"]);
  d.flush();
  assert.equal(d.history.at(-1), "/insights?range=30d#vb=0_0_600_300&sel=n0", "the view and the selection ride the fragment, the query kept");
  d.fire("document:keydown", { key: "Escape" });
  assert.ok(!d.els.root.classList.contains("dim"), "Escape clears");
  assert.ok(!d.els.n1.classList.contains("hi"));
  // A chip whose id is not a minted ordinal is no node: hovering or clicking it does nothing.
  d.fire("graph:click", d.at({ ".gnode": d.els.constructor }));
  assert.ok(!d.els.root.classList.contains("dim"), "a prototype-chain id never selects");
  // A breakdown row replays a click at its chip; a row naming anything but a minted chip is ignored.
  d.fire("document:click", d.at({ "[data-node]": { getAttribute: () => "n1" } }));
  d.fire("document:click", d.at({ "[data-node]": { getAttribute: () => "constructor" } }));
  assert.deepEqual(d.dispatched, [["n1", "click"]]);
  // The wheel zooms about the pointer, within bounds.
  d.fire("graph:wheel", d.at({}));
  assert.ok(d.vb.width < 600 && d.vb.height < 300, "zoomed in");
  // A drag pans and swallows the click after it, so a pan never clears a selection.
  d.fire("graph:click", d.at({ ".gnode": d.els.n1 }));
  d.fire("graph:pointerdown", { ...d.at({}), clientX: 10, clientY: 10 });
  d.fire("graph:pointermove", { ...d.at({}), clientX: 60, clientY: 10 });
  d.fire("graph:pointerup", d.at({}));
  d.fire("graph:click", d.at({}));
  assert.ok(d.els.root.classList.contains("dim"), "the click after a drag is swallowed");
});

test("the spend screen's script restores the view from the fragment, and ignores a fragment it cannot read", () => {
  const items = [["n0", "n1", "w0", "a"], ["n1", "n0", "w0", "b"]];
  const ok = spendDom({ items, hash: "#vb=10_20_300_150&sel=n1" });
  assert.deepEqual([ok.vb.x, ok.vb.y, ok.vb.width, ok.vb.height], [10, 20, 300, 150]);
  assert.ok(ok.els.n1.classList.contains("hi") && ok.els.root.classList.contains("dim"));
  const bad = spendDom({ items, hash: "#vb=1_2_-3_4&sel=constructor&sel=__proto__" });
  assert.deepEqual([bad.vb.x, bad.vb.width], [0, 600], "a negative size is not a view");
  assert.ok(!bad.els.root.classList.contains("dim"), "and no prototype-chain id selects");
  // A fragment past a 32-bit float is clamped to the zoom bounds and a far origin instead of throwing (vb=1e39 threw in
  // Chromium and stopped the rest of console.js).
  const huge = spendDom({ items, hash: "#vb=1e39_-1e39_1_1e30&sel=n0" });
  assert.deepEqual([huge.vb.x, huge.vb.y, huge.vb.width, huge.vb.height], [60_000, -60_000, 150, 2000], "x and y within 100 drawn widths, the size within the wheel's bounds");
  assert.ok(huge.els.n0.classList.contains("hi"), "the rest of the fragment still applies");
  // And a viewBox that refuses every write cannot take the script down: the handlers after the spend screen's are wired.
  const refusing = spendDom({ items, hash: "#vb=10_20_300_150", vbThrows: true });
  assert.deepEqual([refusing.vb.x, refusing.vb.width], [0, 600], "the view stays as drawn");
  assert.equal(typeof refusing.listeners.get("document:submit"), "function", "the action forms' handler still runs");
});

test("the spend screen's script: a mouse click on a chip selects it although pointer capture retargets the click, and a second clears it", () => {
  const items = [["n0", "n1", "w0", "a"], ["n1", "n0", "w0", "b"]];
  const d = spendDom({ items });
  // Chromium: the press lands on the chip, setPointerCapture sends the click to the svg itself.
  const press = () => {
    d.fire("graph:pointerdown", d.at({ ".gnode": d.els.n0 }));
    d.fire("graph:pointerup", d.at({}));
    d.fire("graph:click", d.at({}));
  };
  press();
  assert.ok(d.els.root.classList.contains("dim") && d.els.n0.classList.contains("hi"), "the pressed chip is selected");
  press();
  assert.ok(!d.els.root.classList.contains("dim") && !d.els.n0.classList.contains("hi"), "a second click on the selected chip clears it");
  // The press is used once: a later background click with no press of its own does not reselect the chip.
  press();
  d.fire("document:keydown", { key: "Escape" });
  d.fire("graph:click", d.at({}));
  assert.ok(!d.els.root.classList.contains("dim"), "a background click after the chip's selects nothing");
  // A drag that starts on a chip pans and selects nothing.
  d.fire("graph:pointerdown", d.at({ ".gnode": d.els.n1 }));
  d.fire("graph:pointermove", { ...d.at({}), clientX: 160 });
  d.fire("graph:pointerup", d.at({}));
  d.fire("graph:click", d.at({}));
  assert.ok(!d.els.n1.classList.contains("hi"), "a drag from a chip is a pan");
  // Only Escape clears from the keyboard.
  press();
  d.fire("document:keydown", { key: "Enter" });
  assert.ok(d.els.root.classList.contains("dim"), "another key keeps the selection");
});

test("the spend screen's script: pan and zoom use the svg's uniform scale, the zoom stops at its bounds, and the two tooltips do not fight", () => {
  const items = [["n0", "n1", "w0", "chip zero"], ["n1", "n0", "w0", "b"]];
  // A client box of 1200x900 over a 600x300 view: ratios 2 and 3, so meet scales by 2 (the smaller) and centres 150px.
  const d = spendDom({ items, tips: ["bar zero"], rect: { left: 0, top: 0, width: 1200, height: 900 } });
  d.fire("graph:pointerdown", { ...d.at({}), clientX: 0, clientY: 0 });
  d.fire("graph:pointermove", { ...d.at({}), clientX: 60, clientY: 40 });
  d.fire("graph:pointerup", d.at({}));
  assert.deepEqual([d.vb.x, d.vb.y], [-30, -20], "a 60x40px drag moves the view 30x20 units at scale 2");
  d.fire("graph:wheel", { ...d.at({}), clientX: 600, clientY: 450 });
  const k = Math.exp(0.15);
  // The pointer sits at the centre of the drawn view, (270, 130) in view units, and stays there.
  assert.ok(Math.abs(d.vb.x - (270 - 300 / k)) < 1e-9 && Math.abs(d.vb.y - (130 - 150 / k)) < 1e-9, `zoomed about the pointer (${d.vb.x}, ${d.vb.y})`);
  for (let i = 0; i < 60; i++) d.fire("graph:wheel", { ...d.at({}), deltaY: -100 });
  const most = 600 / d.vb.width;
  assert.ok(most <= 4 && most > 4 / k, `zoom in stops at 4x (${most})`);
  for (let i = 0; i < 120; i++) d.fire("graph:wheel", { ...d.at({}), deltaY: 100 });
  const least = 600 / d.vb.width;
  assert.ok(least >= 0.15 && least < 0.15 * k, `zoom out stops at 0.15x (${least})`);
  // A chart bar's tooltip, then a chip's: the same pointer move bubbles to the document, which is over no bar, and must
  // not blank the chip's text the topology just showed.
  d.fire("document:pointermove", d.at({ "[data-tip]": { getAttribute: () => "0" } }));
  assert.equal(d.els.tip.textContent, "bar zero");
  d.fire("graph:pointermove", d.at({ ".gnode": d.els.n0 }));
  d.fire("document:pointermove", d.at({ ".gnode": d.els.n0 }));
  assert.deepEqual([d.els.tip.textContent, d.els.tip.style.display], ["chip zero", "block"], "the chip's tooltip stays");
  d.fire("document:pointermove", d.at({}));
  assert.equal(d.els.tip.style.display, "block", "a move off both leaves the chip's box to the topology");
});

test("the spend screen makes zero external requests: every reference is this console's or the page's own, the CSP allows only self", async () => {
  const q = parsePageQuery("insights", "whatif=acme%2Fm-1&flow=tidy").query;
  const data = { insights: PAYLOAD(), pricedModels: ["acme/m-1"], whatIf: { model: "acme/m-1", flow: "tidy", unknown: true, near: ["acme/m-2"] } };
  for (const role of ["viewer", "operator"]) {
    const page = String((await renderPage("insights", ctxOf(role, data, q))).html);
    // A reference is a path on this console, or an element of this very page (the skip link's `#main`, a sprite icon's
    // `#i-name`, a pattern's `url(#hatch)`) whose id the page holds: nothing another origin or document could answer.
    const refs = [
      ...[...page.matchAll(/\s(?:src|href|action|formaction|xlink:href)\s*=\s*"([^"]*)"/g)].map((m) => m[1]),
      ...[...page.matchAll(/url\(\s*([^)]*?)\s*\)/g)].map((m) => m[1].replace(/^["']|["']$/g, "")),
    ];
    const ids = new Set([...page.matchAll(/\sid="([^"]*)"/g)].map((m) => m[1]));
    assert.ok(refs.length > 5, "the check sees the page's references");
    for (const r of refs) {
      const own = /^#([a-z][a-z0-9-]*)$/.exec(r);
      if (own) assert.ok(ids.has(own[1]), `${role}: ${r} names an element this page holds`);
      else assert.match(r, /^\/(?!\/)/, `${role}: ${r} is a path on this console`);
    }
    for (const needle of ["@import", "<iframe", "<object", "<embed", "<img", "<link rel=\"preload", "http-equiv"]) assert.ok(!page.includes(needle), `${role}: no ${needle}`);
    assert.deepEqual(page.match(/<script[^>]*>/g), ['<script src="/static/console.js" defer>'], "the one script, by path");
    assert.deepEqual(page.match(/<link[^>]*>/g), ['<link rel="stylesheet" href="/static/console.css">'], "the one stylesheet, by path");
  }
  assert.ok(!/url\(|@import/.test(CONSOLE_CSS), "the stylesheet loads nothing");
  // The script's only absolute URL is the SVG namespace the label fitter creates a title in, which is never fetched.
  assert.deepEqual([...new Set(CONSOLE_SCRIPT.match(/https?:\/\/[^"'\s)]+/g))], ["http://www.w3.org/2000/svg"]);
  for (const m of CONSOLE_SCRIPT.matchAll(/(?:fetch|EventSource)\(\s*("[^"]*"|\w+)/g)) assert.ok(/^"\/|^path$/.test(m[1]), `the script asks this console only: ${m[0]}`);
  const csp = SECURITY_HEADERS["content-security-policy"];
  assert.match(csp, /default-src 'none'/);
  // `data:` (images only) is inline bytes, not a request; no directive names a host, a scheme to fetch from, or a wildcard.
  for (const d of csp.split(";").map((x) => x.trim())) assert.doesNotMatch(d, /https?:|wss?:|\*/, `${d} names no other origin`);
});

// ---- one vocabulary, reasons as sentences (issue #710, PR 2) -----------------------------------------------------------

test("the runs table: the outcome in the panel's words, its tone as a class, and the reason as a short sentence linked to its runs", async () => {
  const { REASONS } = await import("@edgehero/pi-dispatch/reason-catalog");
  const { shortSentence } = await import("../src/words.mjs");
  const base = { kind: "github", target: "acme/web#1", endedAt: "2026-10-08T15:00:00Z", tokens: { total: 5, cost: 0.1 } };
  const runs = [
    { ...base, jobId: "gh-c", outcome: "completed" },
    { ...base, jobId: "gh-a", outcome: "completed", reason: "awaiting-input" },
    { ...base, jobId: "gh-r", outcome: "policy", reason: "scope-cap" },
    { ...base, jobId: "gh-x", outcome: "policy", reason: "operator-cancel" },
    { ...base, jobId: "gh-f", outcome: "failed", reason: "container-never-started", failedReason: "FREE-TEXT <b>" },
    { ...base, jobId: "gh-n", outcome: "policy", reason: "brand-new-reason" },
    { ...base, jobId: "gh-h", outcome: "policy", reason: "<img src=x>" },
    { ...base, jobId: "gh-u", outcome: "vapour" },
    { ...base, jobId: "gh-l", outcome: "policy", reason: `LONG${"z".repeat(500)}` },
    { ...base, jobId: "gh-m", outcome: "policy", reason: "model-unknown" },
    { ...base, jobId: "gh-mv", outcome: "policy", reason: "model-unknown", why: "overlay-link" },
    { ...base, jobId: "gh-f2", outcome: "policy", reason: "model-not-allowed" },
    { ...base, jobId: "gh-f2v", outcome: "policy", reason: "model-not-allowed", why: "fallback-unlisted" },
  ];
  const out = (await pagePanels("runs", ctxOf("viewer", { runsPage: { runs, next: null, mirror: "ok" } }, parsePageQuery("runs", "").query))).map((p) => p.html).join("");
  const rowOf = (id) => out.match(new RegExp(`<tr><td>(?:<time datetime="[^"]*">[^<]*</time>|[^<]*)</td><td><a class="mono" href="/run\\?id=${id}">.*?</tr>`))?.[0] ?? "";
  const cellOf = (id) => rowOf(id).split("</td>")[6] ?? "";
  // The words and the tones: no class for completed, warn for refused, awaiting input and cancelled, bad for failed.
  assert.equal(cellOf("gh-c"), "<td>completed");
  assert.equal(cellOf("gh-a"), '<td class="warn">awaiting input', "the word says it all: no reason part");
  assert.equal(cellOf("gh-x"), '<td class="warn">cancelled');
  const scope = shortSentence(REASONS["scope-cap"].sentence);
  assert.equal(cellOf("gh-r"), `<td class="warn">refused · <a href="/runs?outcome=policy&amp;reason=scope-cap" title="scope-cap">${scope.replace(/'/g, "&#39;")}</a>`);
  assert.match(cellOf("gh-f"), /^<td class="bad">failed · <a href="\/runs\?outcome=failed&amp;reason=container-never-started" title="container-never-started">/);
  // REQ-CONSOLE-SECURITY (l): a job's free text never reaches a list row, only the closed enum.
  assert.ok(!out.includes("FREE-TEXT"), "no failedReason in a list row");
  // An unknown token: shown raw, with no explanation, still linked when the filter accepts it.
  assert.equal(cellOf("gh-n"), '<td class="warn">refused · <a href="/runs?outcome=policy&amp;reason=brand-new-reason" title="brand-new-reason">brand-new-reason, no explanation yet</a>');
  // A token the filter refuses: escaped text, once, no link (its /runs would answer with a refusal) and no title copy.
  assert.equal(cellOf("gh-h"), '<td class="warn">refused · &lt;img src=x&gt;, no explanation yet');
  // And bounded: a very long one is cut to 64 characters, printed once (#710 round 1).
  assert.equal(cellOf("gh-l"), `<td class="warn">refused · LONG${"z".repeat(60)}…, no explanation yet`);
  assert.equal(out.split("LONGzz").length - 1, 1, "the long token appears once in the page");
  // The why variant changes the row's sentence, as the catalog's variant does.
  const { explainReason } = await import("@edgehero/pi-dispatch/reason-catalog");
  for (const [plainId, variantId, reason, why] of [["gh-m", "gh-mv", "model-unknown", "overlay-link"], ["gh-f2", "gh-f2v", "model-not-allowed", "fallback-unlisted"]]) {
    const shortOf = (w) => shortSentence(explainReason(reason, { why: w }).sentence).replace(/'/g, "&#39;");
    assert.notEqual(shortOf(why), shortOf(null), `${reason}/${why} has its own short sentence`);
    assert.ok(cellOf(variantId).includes(`>${shortOf(why)}</a>`), cellOf(variantId));
    assert.ok(cellOf(plainId).includes(`>${shortOf(null)}</a>`), cellOf(plainId));
  }
  // An outcome this release does not know: shown as itself, as a failure.
  assert.equal(cellOf("gh-u"), '<td class="bad">vapour');
  // Every link in the column is one the runs filter accepts.
  for (const m of out.matchAll(/href="\/runs\?([^"]*)"/g)) assert.equal(parsePageQuery("runs", new URLSearchParams(m[1].replace(/&amp;/g, "&"))).refusal, undefined, m[1]);
  assert.ok(!/style=/.test(out), "no inline style (the CSP forbids it)");
  assert.match(out, /<th scope="col">Venue<\/th>/);
});

test("the run summary and the chain say the panel's words; the nav, the spend page and the held panel use its titles", async () => {
  const record = { jobId: "gh-1", kind: "github", target: "acme/web#1", outcome: "policy", reason: "operator-cancel", backend: "local", startedAt: "2026-10-08T14:00:00Z", endedAt: "2026-10-08T15:00:00Z" };
  const data = { run: { record, source: "local" }, children: [{ jobId: "gh-2", outcome: "completed", reason: "awaiting-input" }], childrenSearched: 1 };
  const run = (await pagePanels("run", ctxOf("viewer", data, parsePageQuery("run", "id=gh-1").query))).map((p) => p.html).join("");
  assert.match(run, /<dt>Outcome<\/dt><dd>cancelled<\/dd><dt>Reason<\/dt><dd>operator-cancel<\/dd>/, "the word, then the token");
  assert.match(run, /<dt>Venue<\/dt><dd>local<\/dd>/);
  assert.match(run, /<a class="mono" href="\/run\?id=gh-2">gh-2<\/a> awaiting input<\/li>/);
  assert.equal(PAGES.insights.nav, "Spend");
  assert.equal(PAGES.insights.title, "Spend");
  const fleet = (await pagePanels("fleet", ctxOf("viewer", { snapshot: snapshot() }))).map((p) => p.html).join("");
  assert.match(fleet, /<h2>Held<\/h2>/);
  assert.ok(!fleet.includes("Held on a wait"));
});

test("the chain's children carry their reason through loadPageData, so a waiting or cancelled child says so (issue #710)", async () => {
  const { loadPageData } = await import("../src/console/pages.mjs");
  const record = { jobId: "gh-1", kind: "github", target: "acme/web#1", outcome: "completed", startedAt: "2026-10-08T14:00:00Z", endedAt: "2026-10-08T15:00:00Z" };
  const kid = (jobId, outcome, reason, startedAt) => ({ jobId, parentJobId: "gh-1", kind: "github", target: "acme/web#2", outcome, reason, startedAt, endedAt: startedAt });
  const runs = [
    kid("gh-2", "completed", "awaiting-input", "2026-10-08T14:10:00Z"),
    kid("gh-3", "policy", "operator-cancel", "2026-10-08T14:20:00Z"),
    kid("gh-4", "policy", "scope-cap", "2026-10-08T14:30:00Z"),
    { ...kid("gh-5", "failed", null, "2026-10-08T14:40:00Z"), reason: 7 },
  ];
  const fleet = { runById: async () => ({ record, source: "local" }), runsPage: async () => ({ runs, next: null }), inbox: async () => ({ found: false }) };
  const data = await loadPageData("run", { id: "gh-1" }, { fleet, now: NOW });
  assert.deepEqual(data.children.map((c) => c.reason), ["awaiting-input", "operator-cancel", "scope-cap", null], "the reason is kept, a non-string one is null");
  const run = (await pagePanels("run", ctxOf("viewer", data, parsePageQuery("run", "id=gh-1").query))).map((p) => p.html).join("");
  assert.match(run, /href="\/run\?id=gh-2">gh-2<\/a> awaiting input<\/li>/);
  assert.match(run, /href="\/run\?id=gh-3">gh-3<\/a> cancelled<\/li>/);
  assert.match(run, /href="\/run\?id=gh-4">gh-4<\/a> refused<\/li>/);
  assert.match(run, /href="\/run\?id=gh-5">gh-5<\/a> failed<\/li>/);
});

// ---- issue #710, PR 4: a truthful overview and readable numbers ----

const overviewOf = async (snap, role = "viewer") => (await pagePanels("overview", ctxOf(role, { snapshot: snap }))).map((p) => [p.id, p.html]);

test("the overview leads with what needs a person: Active, then Parked, then the fleet, spend, hosts and the day's problems (#710)", async () => {
  const ids = (await overviewOf(snapshot())).map(([id]) => id);
  assert.deepEqual(ids, ["p-active", "p-parked", "p-state", "p-spend", "p-hosts", "p-failures", "p-nav-parked"]);
});

test("Problems (24h): failed and refused runs, the top reasons linked by their short sentence, an unknown token raw and cut, cancels not counted (#710)", async () => {
  const { REASONS } = await import("@edgehero/pi-dispatch/reason-catalog");
  const { shortSentence } = await import("../src/words.mjs");
  const long = `zz${"q".repeat(80)}`;
  const snap = { ...snapshot(), failures24h: 2, failures24hFloor: false, refusals24h: { count: 9, top: [{ reason: "scope-cap", count: 5 }, { reason: "brand-new-reason", count: 3 }, { reason: long, count: 1 }] } };
  const html = new Map(await overviewOf(snap)).get("p-failures");
  assert.match(html, /^<h2>Problems \(24h\)<\/h2>/);
  assert.match(html, /<span class="big warn">2<\/span> failed runs\. <a href="\/runs\?outcome=failed">See failed runs<\/a>/);
  assert.match(html, /<span class="big warn">9<\/span> refused runs, not counting runs an operator cancelled\. <a href="\/runs\?outcome=policy">See refused runs<\/a>/);
  const scope = shortSentence(REASONS["scope-cap"].sentence).replace(/'/g, "&#39;");
  assert.ok(html.includes(`<li><a href="/runs?outcome=policy&amp;reason=scope-cap" title="scope-cap">${scope}</a> <span class="note">(5)</span></li>`), html);
  assert.ok(html.includes('<li><a href="/runs?outcome=policy&amp;reason=brand-new-reason" title="brand-new-reason">brand-new-reason, no explanation yet</a> <span class="note">(3)</span></li>'), "an unknown token: raw, linked, no explanation yet");
  // A token the runs filter refuses (past its 64 characters) is printed once, cut, and not linked.
  assert.ok(html.includes(`<li>${long.slice(0, 64)}…, no explanation yet <span class="note">(1)</span></li>`), html);
  assert.ok(!html.includes(long), "never the whole odd token");
  // Nothing refused: a zero without the warning class and no list; a floor says "at least" for both counts once.
  const calm = new Map(await overviewOf({ ...snap, failures24h: 0, failures24hFloor: true, refusals24h: { count: 0, top: [] } })).get("p-failures");
  assert.match(calm, /<span class="big">at least 0<\/span> failed runs/);
  assert.match(calm, /<span class="big">at least 0<\/span> refused runs/);
  assert.ok(!calm.includes("<ul"));
  assert.equal((calm.match(/there may be more/g) ?? []).length, 1);
  // The window unread: one warning, no zeros.
  const lost = new Map(await overviewOf({ ...snap, failures24h: null, refusals24h: null })).get("p-failures");
  assert.match(lost, /The run history could not be read/);
  assert.ok(!lost.includes("refused runs"));
});

test("no worker online: the overview warns first and the queue is never green, by the hosts' beats (#710)", async () => {
  const stateOfSnap = async (over) => new Map(await overviewOf({ ...snapshot(), ...over })).get("p-state");
  const queue = { pausedState: false, pausedPartial: false, counts: { waiting: 4 }, workers: 2, queues: 1 };
  const host = (name, staleMs) => ({ name, concurrency: "2", jobs: [], staleMs });
  // Every row's last beat older than a minute and no worker BullMQ can see: nothing drains the queue.
  const stale = await stateOfSnap({ queue: { ...queue, workers: "unknown" }, hostBudgets: [host("h1", BEAT_FRESH_MS + 1), host("h2", null)] });
  assert.ok(stale.startsWith(`<h2>Fleet</h2><p class="warn">${NO_WORKER_TEXT}</p>`), stale);
  assert.ok(!stale.includes('class="good"'), "never green");
  assert.match(stale, /<dt>Queue<\/dt><dd><span class="warn">not paused, but no worker is online<\/span><\/dd>/);
  assert.match(stale, /<dt>Workers<\/dt><dd>2 registered, 0 online \(a beat in the last minute\)<\/dd>/, "the registry's count, not BullMQ's");
  assert.ok(!stale.includes(STALE_BEATS_TEXT));
  assert.match(stale, /<dt>Failed jobs awaiting retry<\/dt>/);
  const fleetQueuesHtml = new Map((await pagePanels("fleet", ctxOf("viewer", { snapshot: { ...snapshot(), queue: { ...queue, workers: "unknown" }, hostBudgets: [host("h1", BEAT_FRESH_MS + 1)] } }))).map((p) => [p.id, p.html])).get("p-queues");
  assert.match(fleetQueuesHtml, /<dt>Fleet<\/dt><dd><span class="warn">not paused, but no worker is online<\/span>/, "the fleet page says the same");
  assert.ok(!stale.includes("kept by the queue"));
  // No registry row and no BullMQ worker either.
  const empty = await stateOfSnap({ queue: { ...queue, workers: "unknown" }, hostBudgets: [] });
  assert.ok(empty.includes(NO_WORKER_TEXT) && !empty.includes('class="good"'));
  assert.match(empty, /<dt>Workers<\/dt><dd>none online<\/dd>/, "never \"unknown registered\"");
  // A paused fleet with no worker stays red, and still warns.
  const paused = await stateOfSnap({ queue: { ...queue, workers: "unknown", pausedState: true }, hostBudgets: [host("h1", 5 * 60_000)] });
  assert.ok(paused.includes(NO_WORKER_TEXT) && paused.includes('<span class="bad">paused'));
  // One fresh beat: running, green, no warning; a fleet whose registry is unreadable is judged by nobody.
  const live = await stateOfSnap({ queue, hostBudgets: [host("h1", BEAT_FRESH_MS), host("h2", BEAT_FRESH_MS + 1)] });
  assert.ok(!live.includes(NO_WORKER_TEXT) && live.includes('<span class="good">running</span>'));
  assert.match(live, /<dt>Workers<\/dt><dd>2 registered, 1 online/);
  const blind = await stateOfSnap({ queue: { ...queue, fleetDegraded: "registry unreadable" }, hostBudgets: [host("h1", 10 * 60_000)] });
  assert.ok(!blind.includes(NO_WORKER_TEXT), "an unreadable registry is not an empty one");
  assert.match(blind, /fleet as it was last seen/);
  // A registry with no row: BullMQ's own count is the fallback (it cannot see beats).
  assert.deepEqual(workersOnline({ queue: { workers: 3 }, hostBudgets: [] }), { count: 3, online: 3, connected: 3, staleBeats: false, none: false });
  assert.deepEqual(workersOnline({ queue: { workers: "unknown" }, hostBudgets: [] }), { count: "unknown", online: 0, connected: 0, staleBeats: false, none: true });
  assert.deepEqual(workersOnline({ queue: { workers: 1 }, hostBudgets: [host("h1", 1000)] }), { count: 1, online: 1, connected: 1, staleBeats: false, none: false });
  assert.deepEqual(workersOnline({ queue: { workers: 3, fleetDegraded: "x" }, hostBudgets: [host("h1", 1000)] }), { count: 1, online: null, connected: 3, staleBeats: false, none: false });
  assert.equal(BEAT_FRESH_MS, 60_000);
});

test("clock skew: a host whose beats look stale while BullMQ sees its worker is not \"no worker online\" (#710, review round 1)", async () => {
  const stateOfSnap = async (over) => new Map(await overviewOf({ ...snapshot(), ...over })).get("p-state");
  const queue = { pausedState: false, pausedPartial: false, counts: { waiting: 4 }, queues: 1 };
  const host = (name, staleMs) => ({ name, concurrency: "2", jobs: [], staleMs });
  // The repro: a worker 50 s behind with a 15 s beat reads 61 s stale for part of every minute; BullMQ, clock-free, sees it.
  const skew = workersOnline({ queue: { workers: 1 }, hostBudgets: [{ staleMs: 61_000 }] });
  assert.deepEqual(skew, { count: 1, online: 0, connected: 1, staleBeats: true, none: false });
  const page = await stateOfSnap({ queue: { ...queue, workers: 1 }, hostBudgets: [host("h1", 61_000)] });
  assert.ok(!page.includes(NO_WORKER_TEXT), page);
  assert.ok(page.startsWith(`<h2>Fleet</h2><p class="note">${STALE_BEATS_TEXT}</p>`), "the softer note, not the warning");
  assert.match(page, /<dt>Queue<\/dt><dd><span class="good">running<\/span><\/dd>/, "green: the queue is being drained");
  assert.match(page, /<dt>Workers<\/dt><dd>1 registered, 0 online \(a beat in the last minute\), 1 connected to the queue<\/dd>/);
  const fleet = new Map((await pagePanels("fleet", ctxOf("viewer", { snapshot: { ...snapshot(), queue: { ...queue, workers: 1 }, hostBudgets: [host("h1", 61_000)] } }))).map((p) => [p.id, p.html])).get("p-queues");
  assert.match(fleet, /<dt>Fleet<\/dt><dd><span class="good">running<\/span>/, "the fleet page agrees");
  // A fresh registry with BullMQ blind (no CLIENT SETNAME): online, no note, no warning.
  const blind = await stateOfSnap({ queue: { ...queue, workers: "unknown" }, hostBudgets: [host("h1", 1000)] });
  assert.ok(!blind.includes(NO_WORKER_TEXT) && !blind.includes(STALE_BEATS_TEXT) && blind.includes('<span class="good">running</span>'));
  assert.deepEqual(workersOnline({ queue: { workers: "unknown" }, hostBudgets: [host("h1", 1000)] }), { count: 1, online: 1, connected: 0, staleBeats: false, none: false });
  // Both say nobody: the warning.
  const both = await stateOfSnap({ queue: { ...queue, workers: "unknown" }, hostBudgets: [host("h1", 61_000)] });
  assert.ok(both.includes(NO_WORKER_TEXT) && both.includes("not paused, but no worker is online"));
  // One fresh beat of two, BullMQ seeing the one: a host is down, not a clock; no note.
  const one = await stateOfSnap({ queue: { ...queue, workers: 1 }, hostBudgets: [host("h1", 1000), host("h2", 5 * 60_000)] });
  assert.ok(!one.includes(STALE_BEATS_TEXT) && !one.includes(NO_WORKER_TEXT));
  assert.match(one, /<dt>Workers<\/dt><dd>2 registered, 1 online \(a beat in the last minute\)<\/dd>/);
  assert.equal(BEAT_FRESH_MS, 60_000);
});

test("readable numbers: money in one fixed form with the exact amount on hover, jobs started against their caps, CPUs as cores (#710)", async () => {
  assert.equal(String(moneyHtml(1_234_567)), '<span title="$1.234567">$1.23</span>');
  assert.equal(String(moneyHtml(2_000_000)), '<span title="$2.00">$2.00</span>');
  assert.equal(String(moneyHtml(1_500_000_000)), '<span title="$1500.00">$1,500.00</span>', "one fixed form: never $1.5k beside $2.00");
  assert.equal(String(moneyHtml(99_999_000, { spent: true })), '<span title="$99.999">$99.99</span>', "spent rounds down");
  assert.equal(String(moneyHtml(99_999_000)), '<span title="$99.999">$100.00</span>');
  for (const bad of [-1, 1.5, null, "3"]) assert.equal(String(moneyHtml(bad)), "-");
  const snap = { ...snapshot(), dollars: { rows: [{ ledger: "deployment", name: "deployment", window: "day", counterMicros: 1_234_567, capMicros: 50_000_000, full: false }, { ledger: "deployment", name: "deployment", window: "month", counterMicros: 99_999_000, capMicros: 100_000_000, full: false }] } };
  const spend = new Map(await overviewOf(snap)).get("p-spend");
  assert.match(spend, /<th scope="col" class="num">Used<\/th><th scope="col" class="num">Cap<\/th>/);
  assert.match(spend, /<td>Jobs started today<\/td><td class="num">3<\/td><td class="num">10<\/td>/);
  assert.match(spend, /<td>Jobs started this week<\/td><td class="num">4<\/td><td class="num">no cap<\/td>/);
  assert.match(spend, /<td>Tokens used today<\/td>/);
  assert.ok(!spend.includes("Reserved") && !spend.includes("not set"));
  assert.match(spend, /<td class="num"><span title="\$1\.234567">\$1\.23<\/span><\/td><td class="num"><span title="\$50\.00">\$50\.00<\/span><\/td>/);
  assert.match(spend, /<td class="num"><span title="\$99\.999">\$99\.99<\/span><\/td><td class="num"><span title="\$100\.00">\$100\.00<\/span><\/td>/, "a window short of its cap never reads as the cap");
  assert.ok(spend.endsWith(`<p class="note">${COUNT_WINDOWS_UTC_TEXT}</p>`), "the windows are UTC, and say so");
  assert.match(COUNT_WINDOWS_UTC_TEXT, /UTC/);
  // The runs list's Job cap column.
  const runs = [{ jobId: "gh-1", kind: "github", target: "acme/web#1", outcome: "completed", endedAt: "2026-10-08T15:00:00Z", dollars: { reservedMicros: 2_500_001 } }];
  const list = (await pagePanels("runs", ctxOf("viewer", { runsPage: { runs, next: null, mirror: "ok" } }, parsePageQuery("runs", "").query))).map((p) => p.html).join("");
  assert.match(list, /<td class="num"><span title="\$2\.500001">\$2\.50<\/span><\/td><\/tr>/);
  // Fleet hosts: hundredths as cores; off and unknown as before; a value that is not hundredths shown as it is.
  const hosts = [
    { name: "h1", concurrency: "2", jobs: [], staleMs: 1000, budgetMemMiB: "8192", usedMemMiB: "2048", budgetCpuCenti: "800", usedCpuCenti: "150" },
    { name: "h2", concurrency: "1", jobs: [], staleMs: 1000, budgetCpuCenti: "100", usedCpuCenti: "" },
    { name: "h3", concurrency: "1", jobs: [], staleMs: 1000, budgetCpuCenti: "off" },
    { name: "h4", concurrency: "1", jobs: [], staleMs: 1000, budgetCpuCenti: "lots", usedCpuCenti: "1" },
  ];
  const fleet = new Map((await pagePanels("fleet", ctxOf("viewer", { snapshot: { ...snapshot(), hostBudgets: hosts } }))).map((p) => [p.id, p.html])).get("p-hosts");
  assert.match(fleet, /<th scope="col">CPU<\/th>/);
  assert.ok(!fleet.includes("centi"));
  assert.match(fleet, /<td>h1<\/td><td class="num">2<\/td><td>2048 \/ 8192 MiB<\/td><td>1\.5 \/ 8 cores<\/td>/);
  assert.match(fleet, /<td>h2<\/td><td class="num">1<\/td><td>-<\/td><td>- \/ 1 core<\/td>/);
  assert.match(fleet, /<td>h3<\/td><td class="num">1<\/td><td>-<\/td><td>off<\/td>/);
  assert.match(fleet, /<td>h4<\/td><td class="num">1<\/td><td>-<\/td><td>1 \/ lots<\/td>/);
  // The run page's Resources: the size in cores.
  const record = { jobId: "gh-1", kind: "github", target: "acme/web#1", outcome: "completed", size: { memMiB: 4096, cpuCenti: 250, source: "trigger" } };
  const run = (await pagePanels("run", ctxOf("viewer", { run: { record, source: "local" } }, parsePageQuery("run", "id=gh-1").query))).map((p) => p.html).join("");
  assert.match(run, /<dt>Size given<\/dt><dd>4,096 MiB, 2\.5 cores \(trigger\)<\/dd>/);
});

test("failed jobs: each id links to its run, with its record's reason and short sentence inline, and BullMQ's text stays the operator's (#710)", async () => {
  const { REASONS } = await import("@edgehero/pi-dispatch/reason-catalog");
  const { shortSentence } = await import("../src/words.mjs");
  const failed = {
    rows: [
      { jobId: "gh-f", attemptsMade: 3, failedReason: "REASON-TEXT <b>", queue: "pi-jobs", endedAt: NOW - 1000, reason: "container-never-started" },
      { jobId: "gh-n", attemptsMade: 1, failedReason: "x", queue: "pi-jobs", endedAt: NOW - 2000, reason: null },
      { jobId: "gh-u", attemptsMade: 1, failedReason: "y", queue: "pi-jobs", endedAt: NOW - 3000, reason: "brand-new-reason" },
      { jobId: "<bad id>", attemptsMade: 1, failedReason: "z", queue: "pi-jobs", endedAt: NOW - 4000 },
    ],
    more: 0,
  };
  for (const role of ["viewer", "operator"]) {
    const html = new Map((await pagePanels("fleet", ctxOf(role, { snapshot: { ...snapshot(), failed } }))).map((p) => [p.id, p.html])).get("p-failed");
    const sentence = shortSentence(REASONS["container-never-started"].sentence).replace(/'/g, "&#39;");
    assert.ok(html.includes(`<td class="keep"><a class="mono" href="/run?id=gh-f">gh-f</a></td>`), html);
    assert.ok(html.includes(`<td><span class="mono">container-never-started</span> · ${sentence}</td>`), html);
    assert.ok(html.includes('<td><span class="note">no record</span></td>'));
    assert.ok(html.includes('<td><span class="mono">brand-new-reason</span>, no explanation yet</td>'));
    assert.ok(html.includes('<td class="keep"><span class="mono">&lt;bad id&gt;</span></td>'), "an id outside the run-id charset is text, not a link");
    assert.ok(!/<td[^>]*>[^<]*REASON-TEXT/.test(html), "BullMQ's free text is never in a row (REQ-CONSOLE-SECURITY (l))");
    assert.equal(html.includes("REASON-TEXT"), role === "operator", "the operator's details only");
  }
});

test("times: the server draws UTC text inside <time datetime>, the same bytes for every reader; unknown stays text (#710)", () => {
  assert.equal(String(timeHtml(NOW)), '<time datetime="2026-10-08T15:39:08.000Z">2026-10-08 15:39 UTC</time>');
  assert.equal(String(timeHtml(Number.NaN)), "unknown");
  assert.equal(String(timeHtml(9e15)), "unknown");
});

/** Run the console script over a page holding `times` (`<time datetime>` stubs), in a zone `offsetMin` east of UTC. */
function timeDom(times, offsetMin, { live = false } = {}) {
  const RealDate = Date;
  // The script's only clock-zone reads are getTimezoneOffset and the local getters: this Date answers them for a fixed
  // zone, so the test does not depend on the machine's TZ.
  class ZoneDate {
    constructor(v) { this.ms = new RealDate(v).getTime(); this.l = new RealDate(this.ms + offsetMin * 60_000); }
    getTime() { return this.ms; }
    getTimezoneOffset() { return -offsetMin; }
    getFullYear() { return this.l.getUTCFullYear(); }
    getMonth() { return this.l.getUTCMonth(); }
    getDate() { return this.l.getUTCDate(); }
    getHours() { return this.l.getUTCHours(); }
    getMinutes() { return this.l.getUTCMinutes(); }
  }
  const timeEl = (iso, text) => {
    const attrs = { datetime: iso };
    return { textContent: text, getAttribute: (n) => attrs[n] ?? null, setAttribute: (n, v) => { attrs[n] = v; }, attrs };
  };
  const els = times.map(([iso, text]) => timeEl(iso, text));
  const swapped = [timeEl("2026-10-08T01:05:00.000Z", "2026-10-08 01:05 UTC")];
  const panel = { hasAttribute: (n) => n === "data-panel", innerHTML: "", querySelector: () => null, contains: () => false, querySelectorAll: (sel) => (sel === "time[datetime]" ? swapped : []) };
  const listeners = new Map();
  function EventSource() { this.readyState = 1; this.addEventListener = (k, fn) => listeners.set(k, fn); this.close = () => {}; }
  const document = {
    body: { getAttribute: (n) => (n === "data-page" ? "overview" : n === "data-live" && live ? "overview" : null) },
    getElementById: (id) => (id === "p-x" ? panel : null),
    querySelectorAll: (sel) => (sel === "time[datetime]" ? els : []),
    querySelector: () => null,
    addEventListener() {},
  };
  new Function("document", "location", "history", "EventSource", "Date", CONSOLE_SCRIPT)(document, { hash: "", pathname: "/" }, { replaceState() {} }, live ? EventSource : undefined, ZoneDate);
  return { els, swapped, panel, listeners };
}

test("the script shows each <time> in the reader's zone with the UTC text in its title, on load and after a live swap (#710)", () => {
  const at = ["2026-10-08T15:39:08.000Z", "2026-10-08 15:39 UTC"];
  const east = timeDom([at, ["2026-12-31T23:30:00.000Z", "2026-12-31 23:30 UTC"]], 120);
  assert.deepEqual(east.els.map((e) => [e.textContent, e.attrs.title]), [["2026-10-08 17:39 UTC+2", "2026-10-08 15:39 UTC"], ["2027-01-01 01:30 UTC+2", "2026-12-31 23:30 UTC"]]);
  assert.equal(timeDom([at], 330).els[0].textContent, "2026-10-08 21:09 UTC+5:30");
  assert.equal(timeDom([at], -300).els[0].textContent, "2026-10-08 10:39 UTC-5");
  assert.equal(timeDom([at], 0).els[0].textContent, "2026-10-08 15:39 UTC", "a reader in UTC reads what the server wrote");
  // Not an ISO instant (a hand-edited page, a newer server's shape): left exactly as drawn.
  const odd = timeDom([["2026-10-08", "kept"], ["<b>", "kept too"]], 120);
  assert.deepEqual(odd.els.map((e) => [e.textContent, e.attrs.title]), [["kept", undefined], ["kept too", undefined]]);
  // A live update: the swapped panel's own times are localised too.
  const live = timeDom([at], 60, { live: true });
  live.listeners.get("panel")({ data: JSON.stringify({ id: "p-x", html: "<time>" }) });
  assert.equal(live.panel.innerHTML, "<time>");
  assert.deepEqual([live.swapped[0].textContent, live.swapped[0].attrs.title], ["2026-10-08 02:05 UTC+1", "2026-10-08 01:05 UTC"]);
});
