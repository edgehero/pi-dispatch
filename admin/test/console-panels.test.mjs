import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { PAGES, pagePanels, parsePageQuery, renderPage } from "../src/console/pages.mjs";
import { BEAT_FRESH_MS, COUNT_WINDOWS_UTC_TEXT, NO_WORKER_TEXT, STALE_BEATS_TEXT, ageText, insightsBody, moneyHtml, runCost, shownPath, timeHtml, usdText, utcText, workersOnline } from "../src/console/panels.mjs";
import { SHELL_PANEL_IDS } from "../src/console/shell.mjs";
import { LEGACY_CSS } from "../src/console/compat-css.mjs";
import { CONSOLE_CSS } from "../src/console/style.mjs";
import { CONSOLE_AUDIT_ACTIONS, CONSOLE_AUDIT_OUTCOMES, CONSOLE_AUDIT_READ_MAX, makeConsoleAudit, readConsoleAudit, verifyConsoleAudit } from "@edgehero/pi-dispatch/console-audit";
import { AUDIT_EXAMINE_MAX, AUDIT_OUTCOME_WORDS, AUDIT_PARAMS, AUDIT_Q_MAX, AUDIT_ROW_STATES, AUDIT_SEEK_BY, AUDIT_WHO_RE, auditQueryString, auditRowState, parseAuditQuery, readAuditView } from "../src/console/audit-view.mjs";
import { AUDIT_BULK_KINDS, AUDIT_OPERATORS_ONLY, AUDIT_WAITING_KINDS, auditAbout, auditChain, auditFilter, auditLog } from "../src/console/panels/audit.mjs";
import { ACTIONS } from "../src/console/actions.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

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
  // Only an instant whose year has four digits: the year 9999's last is drawn, past it and before 1970 are unknown, never
  // a date cut from a six-digit year.
  assert.equal(utcText(253402300799999), "9999-12-31 23:59 UTC");
  for (const out of [253402300800000, 8e15, 8.64e15, -1, -1e15]) assert.equal(utcText(out), "unknown", String(out));
  assert.equal(utcText(0), "1970-01-01 00:00 UTC");
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
    schedulers: [{ key: "nightly", name: "local", pattern: "0 3 * * *", next: NOW - 5000, overdueMs: 5000 }],
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

test("the Schedules table names a scheduler by its key, the trigger's id, and reads its stalls under it (BullMQ's name is the job's)", async () => {
  const fleet = (await pagePanels("fleet", ctxOf("viewer", { snapshot: snapshot() }))).map((p) => p.html).join("");
  assert.match(fleet, /<tr><td class="mono">nightly<\/td><td class="mono">0 3 \* \* \*<\/td>/);
  assert.match(fleet, /<td class="num warn">1 \/ 2<\/td>/, "the stall count kept under the trigger's id");
  assert.ok(!fleet.includes('<td class="mono">local</td>'));
  // A scheduler whose key the reader refused has no stall count under it: "-", never a whole "0 / 2".
  const refused = { ...snapshot(), schedulers: [{ key: null, name: "local", pattern: "0 4 * * *", next: NOW + 5000, overdueMs: null }], schedulerStalls: { nightly: 1, null: 3 } };
  const row = (await pagePanels("fleet", ctxOf("viewer", { snapshot: refused }))).map((p) => p.html).join("");
  assert.match(row, /<tr><td class="mono">-<\/td><td class="mono">0 4 \* \* \*<\/td><td>.*?<\/td><td>no<\/td><td class="num">-<\/td><\/tr>/);
  assert.doesNotMatch(row, /\d \/ 2<\/td>/);
});

test("the role rule: a failure reason is the operator's, in a details element, and never in a list row", async () => {
  const data = { snapshot: snapshot() };
  const viewer = (await pagePanels("fleet", ctxOf("viewer", data))).map((p) => p.html).join("");
  const operator = (await pagePanels("fleet", ctxOf("operator", data))).map((p) => p.html).join("");
  assert.ok(!viewer.includes("REASON-TEXT"), "a viewer sees no reason");
  assert.match(viewer, /shown to operators only/);
  assert.match(operator, /<details><summary class="mono">gh-f<\/summary><p class="mono">REASON-TEXT &lt;b&gt;<\/p><\/details>/);
  assert.ok(!/<td[^>]*>REASON-TEXT/.test(operator), "and the operator never in a cell");
  // The audit log: a viewer is refused it with none of its panels drawn (the refusal is a card of its own).
  const row = { seq: 1, at: "2026-10-08T00:00:00Z", actor: { name: "ops", role: "operator" }, action: "login", outcome: "ok" };
  const audit = await renderPage("audit", ctxOf("viewer", { audit: { rows: [{ entry: row, pos: "2026-10:1", state: "ok" }], next: null, examined: 1, stopped: false, found: null, who: ["ops"], chain: { state: "ok", from: 1, through: 1, startsAt: null, broken: null, last: null }, unreadable: null } }));
  assert.equal(audit.status, 403);
  assert.ok(!/id="p-audit/.test(String(audit.html)), "no audit panel");
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
  // Issue #737: the overview's eight say so; the first run's three draw nothing (no snapshot is never a first run).
  const none = (await pagePanels("overview", ctxOf("viewer", { snapshot: null }))).filter((p) => !SHELL_PANEL_IDS.includes(p.id)).map((p) => p.html);
  assert.equal(none.length, 11);
  assert.equal(none.filter((h) => h === "").length, 3);
  for (const h of none.filter((x) => x !== "")) assert.match(h, /could not be read/);
  const some = (await pagePanels("overview", ctxOf("viewer", { snapshot: snapshot() }))).map((p) => p.html).join("");
  assert.match(some, /Partly paused/);
  assert.match(some, /at least 7 failed/);
  assert.match(some, /fleet as it was last seen/);
  assert.ok(!some.includes("gh-<x>"), "a hostile job id is text");
  // a parked fold that failed is said on both the overview and the inbox, never shown as zero or "Nothing is parked"
  const lost = { ...snapshot(), parked: [], parkedUnreachable: "the runs could not be read" };
  const overview = (await pagePanels("overview", ctxOf("viewer", { snapshot: lost }))).map((p) => p.html).join("");
  assert.match(overview, /The parked runs could not be read, so the questions are not counted\./);
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
    audit: { rows: [{ entry: { broken: true, file: "2026-10.jsonl", line: 3 }, pos: "2026-10:3", state: "damaged" }], next: null, examined: 1, stopped: false, found: null, who: [], chain: { state: "broken", why: null, from: null, through: null, startsAt: null, broken: { file: "2026-10.jsonl", line: 3, reason: "the line is not a JSON row", pos: "2026-10:3" }, last: null, checkedAt: null }, unreadable: null },
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
  assert.match(out, /<td class="id"><span class="code"><a href="\/run\?id=gh-ok.1%3A2">gh-ok.1:2<\/a><\/span><\/td>/, "a well-formed id is linked, in the id face that never breaks");
  const links = [...out.matchAll(/href="\/run\?id=([^"]*)"/g)].map((m) => decodeURIComponent(m[1]));
  for (const id of links) assert.equal(parsePageQuery("run", new URLSearchParams({ id })).refusal, undefined, `every run link is one /run accepts: ${id}`);
  assert.deepEqual(links, ["gh-ok.1:2"]);
  assert.match(out, /<td class="id"><span class="code">gh 1&lt;b&gt;&amp;x<\/span><\/td>/, "the odd id is plain escaped text");
  assert.ok(out.includes(`<span class="code">${"x".repeat(201)}</span>`), "an over-long id too");
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
  assert.match(LEGACY_CSS, /\.legacy>section\[data-panel\]\{[^}]*border-radius:var\(--radius-lg\);background:var\(--surface\)\}/, "each old panel is a card");
  const declarations = LEGACY_CSS.replace(/\[[^\]]*\]/g, "");
  assert.ok(!/#[0-9a-f]{3,8}\b/i.test(declarations), "no colour literal outside an attribute selector");
});

// ---- the audit screen (issue #737, the AuditScreen card; issue #711) ------------------------------------------------

const AT = (i) => new Date(NOW - (100 - i) * 60_000).toISOString();
const OPS = { name: "ops", role: "operator", session: "a1b2c3d4" };

/** An audit log in a temp dir, `n` rows through the worker's own writer; `lines()` reads it back, `write()` replaces it. */
function auditLogDir(n = 6, rowOf = (i) => ({ actor: OPS, action: "login", outcome: "ok" })) {
  const logsDir = tempDir("console-audit-view-");
  for (let i = 1; i <= n; i++) makeConsoleAudit({ logsDir, now: () => Date.parse(AT(i)), alive: () => true }).append(rowOf(i));
  const file = `${logsDir}/console-audit/2026-10.jsonl`;
  return {
    logsDir,
    read: (a) => readConsoleAudit({ logsDir, ...a, positions: true }),
    verify: () => verifyConsoleAudit({ logsDir, withLast: true }),
    lines: () => readFileSync(file, "utf8").split("\n").filter((l) => l !== ""),
    write: (ls) => writeFileSync(file, `${ls.join("\n")}\n`),
  };
}

/** The audit page's panels over a view, for an operator, as one string each. */
function auditPanels(audit, query = parseAuditQuery("").query, role = "operator") {
  const view = { page: "audit", role, readOnly: false, query, env: {}, now: NOW, data: { now: NOW, audit } };
  return { chain: String(auditChain(view)), filter: String(auditFilter(view)), log: String(auditLog(view)), about: String(auditAbout(view)) };
}

const label = (r) => `${r.entry.seq ?? `line${r.pos.split(":")[1]}`}:${r.state}`;

test("parseAuditQuery: each parameter by a closed list or a charset, a refusal naming the parameter, never its value", () => {
  assert.deepEqual(AUDIT_PARAMS, ["before", "who", "action", "outcome", "q", "seq"]);
  assert.deepEqual(parseAuditQuery("").query, { before: null, who: null, action: null, outcome: null, q: null, seq: null });
  assert.ok(Object.isFrozen(parseAuditQuery("").query));
  assert.deepEqual(parseAuditQuery("before=2026-10%3A12&who=ops&action=write&outcome=refused&q=pause-windows").query, { before: "2026-10:12", who: "ops", action: "write", outcome: "refused", q: "pause-windows", seq: null });
  assert.deepEqual(parseAuditQuery({ seq: "41" }).query.seq, 41);
  assert.deepEqual(parseAuditQuery(new URLSearchParams({ who: "", action: "", outcome: "", q: "" })).query, parseAuditQuery("").query, "a filter form's empty choice is the parameter left out");
  const SECRET = "SECRET-VALUE";
  const refused = [
    [`before=${SECRET}`, /^before must be an audit position \(YYYY-MM:line, as the Older rows link gives it\)$/],
    ["before=2026-10:0", /^before must be/],
    [`who=${SECRET}<b>`, /^who must be a token name/],
    [`who=${"a".repeat(65)}`, /^who must be/],
    [`action=${SECRET}`, new RegExp(`^action must be one of ${CONSOLE_AUDIT_ACTIONS.join(", ")}$`)],
    [`outcome=${SECRET}`, /^outcome must be one of ok, refused, failed$/],
    [`q=${"x".repeat(AUDIT_Q_MAX + 1)}`, /^q must be at most 64 printable characters$/],
    [`q=${encodeURIComponent(`a${String.fromCharCode(27)}b`)}`, /^q must be/],
    [`q=${encodeURIComponent(`a${String.fromCharCode(0x202e)}b`)}`, /^q must be/],
    [`seq=${SECRET}`, /^seq must be an audit row number/],
    ["seq=0", /^seq must be/],
    ["seq=01", /^seq must be/],
    [`seq=${"9".repeat(17)}`, /^seq must be/],
    ["seq=4&before=2026-10:3", /^seq and before do not go together/],
    ["seq=4&who=bob", /^seq must not be combined with who, action, outcome or q/],
    ["seq=4&action=login", /^seq must not be combined/],
    ["seq=4&outcome=ok", /^seq must not be combined/],
    ["seq=4&q=x", /^seq must not be combined/],
    [`${SECRET}=1`, /^the audit page takes only before, who, action, outcome, q, seq$/],
    ["who=a&who=b", /^who is given more than once$/],
  ];
  for (const [query, why] of refused) {
    const r = parseAuditQuery(query);
    assert.match(r.refusal, why, query);
    assert.ok(!r.refusal.includes(SECRET) && !r.refusal.includes("<b>"), `${query}: the value is never echoed`);
  }
  // The search counts characters, not UTF-16 units: 64 of them pass, whatever they are.
  assert.equal(parseAuditQuery({ q: String.fromCodePoint(0x1f600).repeat(AUDIT_Q_MAX) }).query.q.length, 128);
  for (const who of ["ops", "a.b_c@d-e", "x".repeat(64)]) assert.ok(AUDIT_WHO_RE.test(who) && parseAuditQuery({ who }).query.who === who, who);
});

test("auditQueryString writes a query back in one order, which parseAuditQuery takes again; over replaces or drops a parameter", () => {
  const q = parseAuditQuery("q=x%20y&outcome=ok&who=ops&before=2026-10:9").query;
  assert.equal(auditQueryString(q), "before=2026-10%3A9&who=ops&outcome=ok&q=x+y");
  assert.deepEqual(parseAuditQuery(auditQueryString(q)).query, q, "a round trip");
  assert.equal(auditQueryString(q, { before: null }), "who=ops&outcome=ok&q=x+y");
  assert.equal(auditQueryString(parseAuditQuery("seq=41").query), "seq=41");
  assert.equal(auditQueryString(null), "");
});

test("the outcome words: every outcome the worker writes, and a state for every row the chain cannot vouch for", () => {
  for (const o of CONSOLE_AUDIT_OUTCOMES) assert.equal(AUDIT_OUTCOME_WORDS[o].word, o, o);
  assert.deepEqual(Object.keys(AUDIT_OUTCOME_WORDS), [...CONSOLE_AUDIT_OUTCOMES, "damaged", "unverified", "suspect", "unchecked"]);
  assert.deepEqual({ damaged: AUDIT_OUTCOME_WORDS.damaged.status, unverified: [AUDIT_OUTCOME_WORDS.unverified.status, AUDIT_OUTCOME_WORDS.unverified.icon, AUDIT_OUTCOME_WORDS.unverified.word], unchecked: AUDIT_OUTCOME_WORDS.unchecked.status }, { damaged: "failed", unverified: ["idle", "hourglass", "not verified"], unchecked: "idle" });
  // The row before a broken prev is not verified either, under the card's same word (its sentence says why).
  assert.deepEqual(AUDIT_OUTCOME_WORDS.suspect, AUDIT_OUTCOME_WORDS.unverified);
  assert.deepEqual(AUDIT_ROW_STATES, ["ok", "damaged", "unverified", "suspect", "unchecked"]);
  assert.deepEqual(AUDIT_SEEK_BY, ["place", "newer", "unplaced", "misplaced", "gone"]);
});

test("readAuditView: an intact chain, every row ok by its place; a row written after the check is unchecked", async () => {
  const log = auditLogDir(6);
  const v = await readAuditView({ read: log.read, verify: log.verify, query: parseAuditQuery("").query });
  assert.deepEqual(v.rows.map(label), ["6:ok", "5:ok", "4:ok", "3:ok", "2:ok", "1:ok"]);
  assert.deepEqual(v.rows.map((r) => r.pos), ["2026-10:6", "2026-10:5", "2026-10:4", "2026-10:3", "2026-10:2", "2026-10:1"]);
  assert.deepEqual([v.next, v.examined, v.stopped, v.found, v.who, v.unreadable], [null, 6, false, null, ["ops"], null]);
  assert.deepEqual([v.chain.state, v.chain.from, v.chain.through, v.chain.last.pos, v.chain.broken], ["ok", 1, 6, "2026-10:6", null]);
  // The check is cached: a row written since sits after its last place.
  const cached = log.verify();
  makeConsoleAudit({ logsDir: log.logsDir, now: () => Date.parse(AT(7)), alive: () => true }).append({ actor: OPS, action: "logout", outcome: "ok" });
  const later = await readAuditView({ read: log.read, verify: () => cached, query: parseAuditQuery("").query });
  assert.deepEqual(later.rows.slice(0, 2).map(label), ["7:unchecked", "6:ok"]);
  // Paged: 50 a page by default, a page and one more read, `next` the last shown row's place.
  const p = await readAuditView({ read: log.read, verify: log.verify, query: parseAuditQuery("").query, perPage: 3 });
  assert.deepEqual([p.rows.map(label), p.next, p.examined], [["7:ok", "6:ok", "5:ok"], "2026-10:5", 4]);
  const p2 = await readAuditView({ read: log.read, verify: log.verify, query: parseAuditQuery(`before=${p.next}`).query, perPage: 3 });
  assert.deepEqual([p2.rows.map(label), p2.next], [["4:ok", "3:ok", "2:ok"], "2026-10:2"]);
});

test("readAuditView: a tampered row is damaged at the verifier's place, every row after it not verified, a junk line damaged wherever it is", async () => {
  const log = auditLogDir(6, (i) => ({ actor: OPS, action: "write", target: `t${i}`, outcome: "ok" }));
  log.write(log.lines().map((l, i) => (i === 3 ? l.replace('"t4"', '"tX"') : l)));
  // Row 4 changed: the link that breaks is row 5's (its prev no longer matches), so row 5 is the damaged place, and row
  // 4, the link's other end, is not vouched for either: the chain cannot tell which of the two changed.
  const v = await readAuditView({ read: log.read, verify: log.verify, query: parseAuditQuery("").query });
  assert.deepEqual(v.rows.map(label), ["6:unverified", "5:damaged", "4:suspect", "3:ok", "2:ok", "1:ok"]);
  assert.deepEqual([v.chain.state, v.chain.through, v.chain.broken.pos, v.chain.from, v.chain.suspect.pos, v.chain.suspect.seq], ["broken", 3, "2026-10:5", 1, "2026-10:4", 4]);
  assert.match(v.chain.broken.reason, /prev does not match/);
  // A junk line: damaged, and its place is the broken one. It shows no prev, so nothing vouches for the row before it.
  const junk = auditLogDir(4);
  const ls = junk.lines();
  junk.write([ls[0], ls[1], "this line is not an audit row", ls[2], ls[3]]);
  const j = await readAuditView({ read: junk.read, verify: junk.verify, query: parseAuditQuery("").query });
  assert.deepEqual(j.rows.map(label), ["4:unverified", "3:unverified", "line3:damaged", "2:suspect", "1:ok"]);
  // The place decides, never the seq: a row that repeats a verified seq is damaged at its place, while the row of that
  // seq at its own place stays ok (row 3, the end of the broken link before it, is not vouched for).
  const dup = auditLogDir(3);
  const d = dup.lines();
  dup.write([d[0], d[1], d[2], d[1]]);
  const r = await readAuditView({ read: dup.read, verify: dup.verify, query: parseAuditQuery("").query });
  assert.deepEqual(r.rows.map(label), ["2:damaged", "3:suspect", "2:ok", "1:ok"]);
  assert.equal(auditRowState({ seq: 2 }, "2026-10:9", { state: "broken", broken: { pos: "2026-10:4" } }), "unverified");
  assert.equal(auditRowState({ seq: 3 }, "2026-10:3", { state: "broken", broken: { pos: "2026-10:4" }, suspect: { pos: "2026-10:3" } }), "suspect");
  assert.equal(auditRowState({ seq: 2 }, "2026-10:2", { state: "broken", broken: { pos: "2026-10:4" }, suspect: { pos: "2026-10:3" } }), "ok", "only the link's own end");
  assert.equal(auditRowState({ seq: 3 }, "2026-10:3", { state: "broken", broken: { pos: "2026-10:4" }, suspect: null }), "ok", "a break that is the line itself leaves the row before it ok");
  assert.equal(auditRowState({ broken: true, file: "2026-10.jsonl", line: 1 }, "2026-10:1", { state: "ok", last: { pos: "2026-10:9" } }), "damaged", "a line that is no row is damaged even on an intact chain");
  assert.equal(auditRowState({ seq: 1 }, "2026-09:9", { state: "broken", broken: { pos: "2026-10:1" } }), "ok", "an older month is before any place in a newer one");
  assert.equal(auditRowState({ seq: 1 }, "nonsense", { state: "ok", last: { pos: "2026-10:9" } }), "unchecked");
});

test("readAuditView: no check, a failed check, an unreadable log, a reader with no places", async () => {
  const log = auditLogDir(2);
  const q = parseAuditQuery("").query;
  for (const [verify, why] of [[null, "missing"], [() => { throw new Error("boom"); }, "error"], [async () => "nonsense", "error"], [() => ({ ok: false, rows: 0, broken: { file: null, line: 0, reason: "the audit directory /home/x cannot be read (EACCES)" }, last: null }), "directory"]]) {
    const v = await readAuditView({ read: log.read, verify, query: q });
    assert.deepEqual([v.chain.state, v.chain.why], ["unreadable", why], String(verify));
    assert.deepEqual(v.rows.map(label), ["2:unchecked", "1:unchecked"], "no row is called verified");
    assert.ok(!JSON.stringify(v.chain).includes("/home/x"), "the verifier's directory sentence is not kept");
  }
  for (const [read, said] of [
    [() => { throw new Error("EIO"); }, "the audit log could not be read"],
    [async () => ({ rows: [], next: null, positions: [], unreadable: "the audit directory cannot be read (EACCES)" }), "the audit directory cannot be read (EACCES)"],
    [() => ({ rows: [{ seq: 1 }], next: null }), "the audit reader gave no place for its rows"],
    [() => null, "the audit log could not be read"],
  ]) {
    const v = await readAuditView({ read, verify: log.verify, query: q });
    assert.deepEqual([v.rows, v.next, v.unreadable], [[], null, said]);
  }
});

/**
 * A reader over `n` synthetic rows, newest first, each a login by `who(i)`, paged by place like the worker's, all in one
 * month file. `first` is the oldest row's seq (a reaped start when above 1); `shift` moves every row that many lines
 * down the file AFTER the check (as if lines had been put in above them), so the check's index no longer matches the
 * file; `index: false` is a verifier that gives no index. `entry(seq)` adds fields to a row.
 */
function syntheticReader(n, who = () => "ops", reason = () => null, { first = 1, shift = 0, index = true, entry = () => ({}) } = {}) {
  const all = Array.from({ length: n }, (_, k) => first + n - 1 - k).map((seq) => ({ entry: { seq, at: AT(1), actor: { name: who(seq), role: "operator" }, action: "login", outcome: "ok", reason: reason(seq), ...entry(seq) }, pos: `2026-10:${seq - first + 1 + shift}` }));
  const calls = [];
  const read = ({ limit, before }) => {
    calls.push({ limit, before });
    const from = before === null ? 0 : all.findIndex((r) => Number(r.pos.split(":")[1]) < Number(before.split(":")[1]));
    const page = from === -1 ? [] : all.slice(from, from + limit);
    const more = from !== -1 && from + limit < all.length;
    return { rows: page.map((r) => r.entry), positions: page.map((r) => r.pos), next: more ? page[page.length - 1].pos : null };
  };
  const startsAt = first > 1 ? { file: "2026-10.jsonl", seq: first } : null;
  const files = index ? { suspect: null, files: n === 0 ? [] : [{ file: "2026-10.jsonl", seq: first, rows: n }] } : {};
  return { read, calls, verify: () => ({ ok: true, rows: n, startsAt, last: { file: "2026-10.jsonl", line: n, seq: first + n - 1 }, ...files }) };
}

test("readAuditView: a filter reads 500 at a time until a page and one more match, or 2,000 rows, and says where it stopped", async () => {
  // One row in a hundred is bob's: 2,500 rows hold 25, the first 2,000 hold 20, fewer than a page.
  const r = syntheticReader(2500, (seq) => (seq % 100 === 0 ? "bob" : "ops"));
  const v = await readAuditView({ read: r.read, verify: r.verify, query: parseAuditQuery("who=bob").query });
  assert.equal(v.rows.length, 20);
  assert.ok(v.rows.every((x) => x.entry.actor.name === "bob"));
  assert.deepEqual([v.examined, v.stopped, v.next], [AUDIT_EXAMINE_MAX, true, "2026-10:501"], "the next search starts under the last row examined");
  // Four reads examine the 2,000: no fifth read is issued for rows the search would not look at.
  assert.deepEqual(r.calls.map((c) => c.limit), [CONSOLE_AUDIT_READ_MAX, CONSOLE_AUDIT_READ_MAX, CONSOLE_AUDIT_READ_MAX, CONSOLE_AUDIT_READ_MAX]);
  assert.deepEqual(v.who, ["bob", "ops"]);
  // A search that reaches the bound with nothing older left has read everything: it did not stop, and read no more.
  const exact = syntheticReader(AUDIT_EXAMINE_MAX, () => "ops");
  const e = await readAuditView({ read: exact.read, verify: exact.verify, query: parseAuditQuery("who=bob").query });
  assert.deepEqual([e.examined, e.stopped, e.next, exact.calls.length], [AUDIT_EXAMINE_MAX, false, null, 4]);
  // A reader that hands back more than it was asked for is still examined only to the bound.
  const greedy = syntheticReader(2500, () => "ops");
  const big = await readAuditView({ read: (a) => greedy.read({ ...a, limit: 2500 }), verify: greedy.verify, query: parseAuditQuery("who=bob").query });
  assert.deepEqual([big.examined, big.stopped, big.next, greedy.calls.length], [AUDIT_EXAMINE_MAX, true, "2026-10:501", 1]);
  // A filter that fills its page stops there, its next the page's last row.
  const all = syntheticReader(300);
  const page = await readAuditView({ read: all.read, verify: all.verify, query: parseAuditQuery("action=login").query });
  assert.deepEqual([page.rows.length, page.next, page.stopped, page.examined], [50, "2026-10:251", false, 51]);
  // A search that reads everything before the bound has not stopped; the search text's case does not matter, either side.
  const small = syntheticReader(120, () => "ops", (seq) => (seq % 7 === 0 ? "Pause-Windows changed" : null));
  for (const text of ["pause-windows", "PAUSE-windows", "Pause-Windows"]) {
    const found = await readAuditView({ read: small.read, verify: small.verify, query: parseAuditQuery({ q: text }).query });
    assert.deepEqual([found.rows.length, found.stopped, found.next, found.examined], [17, false, null, 120], text);
  }
  // A plain page reads a page and one row, no more.
  const plain = syntheticReader(300);
  await readAuditView({ read: plain.read, verify: plain.verify, query: parseAuditQuery("").query });
  assert.deepEqual(plain.calls, [{ limit: 51, before: null }]);
});

test("readAuditView: each filter keeps only the rows it names, and together they all must hold", async () => {
  const kinds = [
    { action: "login", outcome: "ok", actor: "ops" },
    { action: "login-failed", outcome: "refused", actor: "anonymous", target: "/login", reason: "no token matched" },
    { action: "write", outcome: "failed", actor: "ops", target: "settings.json", reason: "Disk Full" },
    { action: "write", outcome: "ok", actor: "bob", target: "triggers.json" },
  ];
  const r = syntheticReader(40, (seq) => kinds[seq % 4].actor, (seq) => kinds[seq % 4].reason ?? null, { entry: (seq) => ({ action: kinds[seq % 4].action, outcome: kinds[seq % 4].outcome, ...(kinds[seq % 4].target ? { target: kinds[seq % 4].target } : {}) }) });
  const view = async (qs) => (await readAuditView({ read: r.read, verify: r.verify, query: parseAuditQuery(qs).query })).rows.map((x) => x.entry);
  const seqsOf = (rows) => rows.map((e) => e.seq);
  const want = (fn) => Array.from({ length: 40 }, (_, k) => 40 - k).filter((seq) => fn(kinds[seq % 4]));
  assert.deepEqual(seqsOf(await view("outcome=refused")), want((k) => k.outcome === "refused"));
  assert.deepEqual(seqsOf(await view("outcome=failed")), want((k) => k.outcome === "failed"));
  assert.deepEqual(seqsOf(await view("action=write")), want((k) => k.action === "write"));
  assert.deepEqual(seqsOf(await view("action=login")), want((k) => k.action === "login"), "login is not login-failed");
  assert.deepEqual(seqsOf(await view("who=bob")), want((k) => k.actor === "bob"));
  assert.deepEqual(seqsOf(await view("who=ops&action=write")), want((k) => k.actor === "ops" && k.action === "write"), "both hold");
  assert.deepEqual(seqsOf(await view("who=bob&outcome=failed")), [], "neither row is both");
  // The search looks in the target and the reason, in any case on either side, and nowhere else.
  assert.deepEqual(seqsOf(await view("q=SETTINGS")), want((k) => k.target === "settings.json"));
  assert.deepEqual(seqsOf(await view("q=disk%20FULL")), want((k) => k.reason === "Disk Full"));
  assert.deepEqual(seqsOf(await view("q=login-failed")), [], "the action is not searched");
  assert.deepEqual(seqsOf(await view("q=anonymous")), [], "nor the name");
  // A name no examined row holds stays in the filter's list, so the select still shows what was chosen.
  const nobody = await readAuditView({ read: r.read, verify: r.verify, query: parseAuditQuery("who=carol").query });
  assert.deepEqual([nobody.rows.length, nobody.who], [0, ["anonymous", "bob", "carol", "ops"]]);
  const sel = auditPanels(nobody, parseAuditQuery("who=carol").query).filter;
  assert.ok(sel.includes('<option value="carol" selected>Who: carol</option>'), sel);
});

test("readAuditView: a damaged entry is shown under every filter, in its place, and is not counted as a match", async () => {
  // Rows 1 to 4, then a line that is no row, then rows 5 and 6: the junk line is the broken place, every row after it
  // not verified. A filter that matches none of the rows still shows the junk line, as evidence; one that matches some
  // shows it among them, in file order.
  const log = auditLogDir(6, (i) => (i % 2 ? { actor: OPS, action: "login", outcome: "ok" } : { actor: { name: "bob", role: "operator", session: null }, action: "write", target: `t${i}`, outcome: "failed" }));
  const ls = log.lines();
  log.write([...ls.slice(0, 4), "this line is not an audit row", ...ls.slice(4)]);
  const filtered = async (qs) => readAuditView({ read: log.read, verify: log.verify, query: parseAuditQuery(qs).query });
  const none = await filtered("action=token-added");
  assert.deepEqual(none.rows.map(label), ["line5:damaged"]);
  const bob = await filtered("who=bob&outcome=failed");
  assert.deepEqual(bob.rows.map(label), ["6:unverified", "line5:damaged", "4:suspect", "2:ok"]);
  // The panel counts the matches apart from the damage, and says why the damaged one is there; said once.
  const p = auditPanels(bob, parseAuditQuery("who=bob&outcome=failed").query);
  assert.ok(p.log.includes('<div class="tbl-foot">3 rows match among the 7 rows searched. The damaged one is shown whatever the filters say.<span class="pager">'), p.log);
  const p0 = auditPanels(none, parseAuditQuery("action=token-added").query);
  assert.ok(p0.log.includes('<div class="tbl-foot">No row matches among the 7 rows searched. The damaged one is shown whatever the filters say.<span class="pager">'), p0.log);
  // A changed row's damaged place shows under a filter its own fields do not meet, as a junk line does.
  const edited = auditLogDir(3, (i) => ({ actor: OPS, action: "login", outcome: i === 2 ? "refused" : "ok", target: `t${i}` }));
  edited.write(edited.lines().map((l, i) => (i === 1 ? l.replace('"outcome":"refused"', '"outcome":"ok"') : l)));
  const e = await readAuditView({ read: edited.read, verify: edited.verify, query: parseAuditQuery("outcome=refused").query });
  assert.deepEqual(e.rows.map(label), ["3:damaged"], "row 3's broken prev is shown; the edited row 2 now says ok, and outcome=refused no longer finds it");
});

test("readAuditView: seq opens the 50-row chunk that holds the row, found by its number however many rows came since", async () => {
  const r = syntheticReader(130);
  const v = await readAuditView({ read: r.read, verify: r.verify, query: parseAuditQuery("seq=61").query });
  assert.deepEqual([v.rows[0].entry.seq, v.rows.at(-1).entry.seq, v.rows.length, v.found, v.next], [100, 51, 50, true, "2026-10:51"]);
  // Read at the place the check's index gives (row 100 is line 100), one read of a chunk and one row.
  assert.deepEqual([v.seek, v.examined, r.calls.at(-1)], [{ by: "place", newest: null, first: 1 }, 51, { limit: 51, before: "2026-10:101" }]);
  // Row 129's chunk runs to row 150, past the 130 rows the check counted; row 129 is counted, so the chunk is read at
  // the place of the last one, not walked for.
  const top = await readAuditView({ read: r.read, verify: r.verify, query: parseAuditQuery("seq=129").query });
  assert.deepEqual([top.rows[0].entry.seq, top.rows.at(-1).entry.seq, top.found, top.next, top.seek, r.calls.at(-1)], [130, 101, true, "2026-10:101", { by: "place", newest: null, first: 1 }, { limit: 51, before: "2026-10:131" }]);
  const last = await readAuditView({ read: r.read, verify: r.verify, query: parseAuditQuery("seq=3").query });
  assert.deepEqual([last.rows[0].entry.seq, last.rows.at(-1).entry.seq, last.found, last.next], [50, 1, true, null]);
  const none = await readAuditView({ read: r.read, verify: r.verify, query: parseAuditQuery("seq=999").query });
  assert.deepEqual([none.found, none.rows.length, none.next, none.seek], [false, 0, null, { by: "newer", newest: 130, first: 1 }]);
  // 2,995 rows newer than row 5: found by its number with one read, where a walk stops at 2,000.
  const far = syntheticReader(3000);
  const deep = await readAuditView({ read: far.read, verify: far.verify, query: parseAuditQuery("seq=5").query });
  assert.deepEqual([deep.found, deep.stopped, deep.examined, deep.rows.length, deep.rows[0].entry.seq, deep.next, far.calls.length], [true, false, 50, 50, 50, null, 1]);
  assert.ok(deep.rows.some((x) => x.entry.seq === 5));
  const mid = await readAuditView({ read: far.read, verify: far.verify, query: parseAuditQuery("seq=741").query });
  assert.deepEqual([mid.rows[0].entry.seq, mid.rows.at(-1).entry.seq, mid.found, mid.next, mid.examined], [750, 701, true, "2026-10:701", 51]);
  // No index (no check, or a verifier without one): the bounded walk from the newest, as before, said as such.
  const blind = syntheticReader(3000, () => "ops", () => null, { index: false });
  const walked = await readAuditView({ read: blind.read, verify: blind.verify, query: parseAuditQuery("seq=5").query });
  assert.deepEqual([walked.found, walked.stopped, walked.examined, walked.rows.length, walked.seek.by, blind.calls.length], [false, true, AUDIT_EXAMINE_MAX, 0, "unplaced", 4]);
  // The files changed since the check (five lines put in above the rows): the place does not hold the row, so the walk
  // from the newest runs instead, and finds it within the bound.
  const moved = syntheticReader(130, () => "ops", () => null, { shift: 5 });
  const m = await readAuditView({ read: moved.read, verify: moved.verify, query: parseAuditQuery("seq=61").query });
  assert.deepEqual([m.found, m.rows[0].entry.seq, m.rows.at(-1).entry.seq, m.seek.by, moved.calls.map((c) => c.before)], [true, 100, 51, "misplaced", ["2026-10:101", null]]);
  // A reaped start: a row below the log's first is gone, and is not walked for; a chunk across the start holds what is left.
  const reaped = syntheticReader(100, () => "ops", () => null, { first: 1001 });
  const gone = await readAuditView({ read: reaped.read, verify: reaped.verify, query: parseAuditQuery("seq=41").query });
  assert.deepEqual([gone.found, gone.rows.length, gone.next, gone.seek, reaped.calls.length], [false, 0, null, { by: "gone", newest: null, first: 1001 }, 0]);
  const edge = await readAuditView({ read: reaped.read, verify: reaped.verify, query: parseAuditQuery("seq=1003").query });
  assert.deepEqual([edge.found, edge.rows[0].entry.seq, edge.rows.at(-1).entry.seq, edge.seek.by], [true, 1050, 1001, "place"]);
});

test("readAuditView over a real log: ?seq= past 2,000 newer rows lands on its chunk in one read, across a month; a file changed after the check is walked for, and said", async () => {
  // 2,150 rows a minute apart from the last minutes of September: 1,439 in 2026-09, 711 in 2026-10, written by the
  // worker's own writer, so 2,109 rows are newer than row 41 (a walk alone found it at 2,040 rows and lost it at 2,100).
  const logsDir = tempDir("console-audit-seq-");
  let at = Date.UTC(2026, 8, 30, 0, 0, 0);
  const writer = makeConsoleAudit({ logsDir, now: () => at, alive: () => true });
  for (let i = 1; i <= 2150; i++) {
    at += 60_000;
    writer.append({ actor: OPS, action: "login", outcome: "ok", target: `t${i}` });
  }
  const reads = [];
  const read = (a) => (reads.push(a.before), readConsoleAudit({ logsDir, ...a, positions: true }));
  const check = verifyConsoleAudit({ logsDir, withLast: true });
  assert.deepEqual(check.files, [{ file: "2026-09.jsonl", seq: 1, rows: 1439 }, { file: "2026-10.jsonl", seq: 1440, rows: 711 }]);
  const view = (qs) => readAuditView({ read, verify: () => check, query: parseAuditQuery(qs).query });
  const r41 = await view("seq=41");
  assert.deepEqual([r41.found, r41.rows.length, r41.rows[0].entry.seq, r41.rows.at(-1).entry.seq, r41.seek.by, reads], [true, 50, 50, 1, "place", ["2026-09:51"]]);
  assert.ok(String(auditLog({ role: "operator", query: parseAuditQuery("seq=41").query, data: { audit: r41 } })).includes('<tr id="seq-41">'));
  // A chunk across the month boundary: row 1,450 is line 11 of 2026-10, its chunk runs down into 2026-09.
  reads.length = 0;
  const r1450 = await view("seq=1450");
  assert.deepEqual([r1450.found, r1450.rows[0].pos, r1450.rows.at(-1).pos, r1450.rows.at(-1).entry.seq, r1450.next, reads], [true, "2026-10:11", "2026-09:1401", 1401, "2026-09:1401", ["2026-10:12"]]);
  // A line taken out of 2026-09 after the check: the place no longer holds the row, the walk from the newest runs, and
  // the 2,000-row bound stops it before row 41, which the page says rather than claiming the row is gone.
  const file = `${logsDir}/console-audit/2026-09.jsonl`;
  const lines = readFileSync(file, "utf8").split("\n").filter((l) => l !== "");
  writeFileSync(file, `${lines.filter((_, i) => i !== 2).join("\n")}\n`);
  reads.length = 0;
  const moved = await view("seq=41");
  assert.deepEqual([moved.found, moved.stopped, moved.seek.by, moved.examined, reads.length], [false, true, "misplaced", AUDIT_EXAMINE_MAX, 5]);
  const log = String(auditLog({ role: "operator", query: parseAuditQuery("seq=41").query, data: { audit: moved } }));
  assert.ok(log.includes("Row 41 is not where the chain check counted it (the files changed since it ran). Row 41 is not among the newest 2,000 rows; Older lists the rows below them.") && !log.includes("Nothing older"), log);
});

/**
 * A real log of `n` rows written by the worker's own writer, a minute apart: the first `older` of them in 2026-09, the
 * rest in 2026-10. `edit(month, fn)` rewrites a month file's lines; `view(qs, verify)` reads the page with the reader
 * asked for places (each read's `before` kept in `reads`) and a fresh check unless one is given; `log(view, qs)` is the
 * log's panel over it.
 */
function monthLog(n, older = 0) {
  const logsDir = tempDir("console-audit-place-");
  for (let i = 1; i <= n; i++) {
    const at = i <= older ? Date.UTC(2026, 8, 29, 0, i) : Date.UTC(2026, 9, 1, 0, i);
    makeConsoleAudit({ logsDir, now: () => at, alive: () => true }).append({ actor: OPS, action: "login", outcome: "ok", target: `t${i}` });
  }
  const path = (month) => `${logsDir}/console-audit/${month}.jsonl`;
  const reads = [];
  const verify = () => verifyConsoleAudit({ logsDir, withLast: true });
  return {
    reads,
    verify,
    edit: (month, fn) => writeFileSync(path(month), `${fn(readFileSync(path(month), "utf8").split("\n").filter((l) => l !== "")).join("\n")}\n`),
    view: (qs, check = verify) => readAuditView({ read: (a) => (reads.push(a.before), readConsoleAudit({ logsDir, ...a, positions: true })), verify: check, query: parseAuditQuery(qs).query }),
    log: (v, qs) => String(auditLog({ role: "operator", query: parseAuditQuery(qs).query, data: { audit: v } })),
  };
}

test("readAuditView: ?seq= is placed by the row asked for, never by its chunk's top; a row the check counted is read at its place", async () => {
  // A log of 2,200 rows whose line 46 is no row, so the check counts rows 1
  // to 45 and row 41's chunk runs to row 50, past them. Placed by the chunk's top, row 41 was called unplaceable, walked
  // for from the newest row and never reached, under "the chain check cannot count to row 41".
  const br = monthLog(2200);
  br.edit("2026-10", (ls) => ls.map((l, i) => (i === 45 ? "not json" : l)));
  const check = br.verify();
  assert.deepEqual([check.files, check.broken.line], [[{ file: "2026-10.jsonl", seq: 1, rows: 45 }], 46]);
  for (const s of [41, 40, 1]) {
    br.reads.length = 0;
    const v = await br.view(`seq=${s}`);
    // Read once, from the chunk's newest row the check counted (45), its place checked there; the rows of the chunk
    // past the check's count are not this read's.
    assert.deepEqual([v.found, v.seek.by, v.rows[0]?.entry.seq, v.rows.at(-1)?.entry.seq, v.rows.length, v.next, br.reads], [true, "place", 45, 1, 45, null, ["2026-10:46"]], `seq ${s}`);
    const log = br.log(v, `seq=${s}`);
    assert.ok(log.includes(`<div class="tbl-foot">The page that holds row ${s}.<span class="pager">`) && log.includes(`<tr id="seq-${s}">`) && !log.includes("cannot count"), log);
  }
  // A row past the break is past the check's count: walked for, bounded at 2,000, and the page says why.
  br.reads.length = 0;
  const past = await br.view("seq=60");
  assert.deepEqual([past.found, past.stopped, past.seek.by, past.examined, br.reads.length], [false, true, "unplaced", AUDIT_EXAMINE_MAX, 4]);
  assert.ok(br.log(past, "seq=60").includes("<b>Row 60 was not reached</b><span>The chain check stops at the damaged row, so it cannot count to row 60. Row 60 is not among the newest 2,000 rows; Older lists the rows below them.</span>"), br.log(past, "seq=60"));

  // A chunk across a month boundary whose top is the newer month's first row (2026-09 holds rows 1 to 49): placed at
  // line 1 of 2026-10, never one line past 2026-09's last (the index's boundary), and read down into 2026-09.
  const mb = monthLog(60, 49);
  assert.deepEqual(mb.verify().files, [{ file: "2026-09.jsonl", seq: 1, rows: 49 }, { file: "2026-10.jsonl", seq: 50, rows: 11 }]);
  const m = await mb.view("seq=41");
  assert.deepEqual([m.found, m.seek.by, m.rows[0].pos, m.rows[0].entry.seq, m.rows[1].pos, m.rows.at(-1).pos, m.rows.length, mb.reads], [true, "place", "2026-10:1", 50, "2026-09:49", "2026-09:1", 50, ["2026-10:2"]]);
  // The same boundary with the check stopped at 2026-10's first line: the chunk's top (50) is past the check's count,
  // its row is not, so the chunk is read from the last row the check counted, 2026-09's last.
  mb.edit("2026-10", (ls) => ["not json", ...ls.slice(1)]);
  mb.reads.length = 0;
  const cut = await mb.view("seq=41");
  assert.deepEqual([cut.found, cut.seek.by, cut.rows[0].pos, cut.rows[0].entry.seq, cut.rows.length, mb.reads], [true, "place", "2026-09:49", 49, 49, ["2026-09:50"]]);

  // A file that shrank since the check (a line taken out above the chunk): the place the check gave no longer holds the
  // chunk's top, which now sits a line higher with its own seq; the place must match as well as the seq, so the page
  // walks for the row and says why.
  const sh = monthLog(50);
  const cached = sh.verify();
  sh.edit("2026-10", (ls) => ls.filter((_, i) => i !== 2));
  const s = await sh.view("seq=41", () => cached);
  assert.deepEqual([s.found, s.seek.by, sh.reads], [true, "misplaced", ["2026-10:51", null]]);
  assert.ok(sh.log(s, "seq=41").includes('<div class="tbl-foot">The page that holds row 41, found by reading from the newest row: row 41 is not where the chain check counted it (the files changed since it ran).<span class="pager">'), sh.log(s, "seq=41"));
});

test("the audit panels: a seq page says how its row was found, one sentence for each way, found or not", async () => {
  const foot = async (r, qs, verify = r.verify) => {
    const q = parseAuditQuery(qs).query;
    const v = await readAuditView({ read: r.read, verify, query: q });
    const log = auditPanels(v, q).log;
    return [v.seek.by, v.found, /<div class="tbl-foot">([^<]*)</.exec(log)[1] || /<div class="empty">.*?<span>([^<]*)<\/span>/.exec(log)?.[1]];
  };
  const r = syntheticReader(130);
  assert.deepEqual(await foot(r, "seq=61"), ["place", true, "The page that holds row 61."], "read at its place: no walk to explain");
  // Written after the check (it counted rows 1 to 120).
  const counted = (n) => () => ({ ...r.verify(), rows: n, last: { file: "2026-10.jsonl", line: n, seq: n }, files: [{ file: "2026-10.jsonl", seq: 1, rows: n }] });
  assert.deepEqual(await foot(r, "seq=125", counted(120)), ["newer", true, "The page that holds row 125, found by reading from the newest row: the last chain check counted rows up to row 120."]);
  const far = syntheticReader(3000);
  assert.deepEqual(await foot(far, "seq=150", () => ({ ...far.verify(), rows: 100, last: { file: "2026-10.jsonl", line: 100, seq: 100 }, files: [{ file: "2026-10.jsonl", seq: 1, rows: 100 }] })), ["newer", false, "The last chain check counted rows up to row 100. Row 150 is not among the newest 2,000 rows; Older lists the rows below them."]);
  // Moved since the check.
  assert.deepEqual(await foot(syntheticReader(130, () => "ops", () => null, { shift: 5 }), "seq=61"), ["misplaced", true, "The page that holds row 61, found by reading from the newest row: row 61 is not where the chain check counted it (the files changed since it ran)."]);
  // Past a broken link, with no check, with no index: each its own reason, found and not found.
  const brokenVerify = () => ({ ok: false, rows: 60, broken: { file: "2026-10.jsonl", line: 61, reason: "the line is not a JSON row (damaged, or written by something else)" }, last: { file: "2026-10.jsonl", line: 60, seq: 60 }, suspect: null, files: [{ file: "2026-10.jsonl", seq: 1, rows: 60 }] });
  assert.deepEqual(await foot(r, "seq=95", brokenVerify), ["unplaced", true, "The page that holds row 95, found by reading from the newest row: the chain check stops at the damaged row, so it cannot count to row 95."]);
  assert.deepEqual(await foot(r, "seq=95", null), ["unplaced", true, "The page that holds row 95, found by reading from the newest row: the chain could not be checked, so row 95 cannot be found by its number."]);
  assert.deepEqual(await foot(syntheticReader(130, () => "ops", () => null, { index: false }), "seq=95"), ["unplaced", true, "The page that holds row 95, found by reading from the newest row: the chain check gave no place for row 95."]);
  const blind = syntheticReader(3000, () => "ops", () => null, { index: false });
  assert.deepEqual(await foot(blind, "seq=5", null), ["unplaced", false, "The chain could not be checked, so row 5 cannot be found by its number. Row 5 is not among the newest 2,000 rows; Older lists the rows below them."]);
  // A row the walk read past without finding: the log holds none of that number.
  const gap = syntheticReader(130, () => "ops", () => null, { index: false, entry: (seq) => (seq === 95 ? { seq: 9500 } : {}) });
  assert.deepEqual(await foot(gap, "seq=95"), ["unplaced", false, "The chain check gave no place for row 95. The log holds no row 95 now."]);
});

test("the audit panels: a seq page whose place holds the right row but not the one asked for walks for it, and never says the log holds no such row", async () => {
  // A real log of 130 rows checked, then line 99 replaced by a copy of row 10's line: the place the check gave row 60's
  // chunk (line 100) still holds row 100, but the read down from it meets row 10 before row 60. The read that does not
  // find its row at its place is a file changed since the check, so the walk from the newest runs and the page says so.
  const log = auditLogDir(130);
  const cached = log.verify();
  const ls = log.lines();
  log.write(ls.map((l, i) => (i === 98 ? ls[9] : l)));
  const q = parseAuditQuery("seq=60").query;
  const v = await readAuditView({ read: log.read, verify: () => cached, query: q });
  assert.deepEqual([v.seek.by, v.found], ["misplaced", false]);
  // The walk met row 100 at the top of row 60's chunk, then row 10 out of its place, and stopped there: that one row is
  // no page of row 60's, so the page draws no row, only the empty state, which says why under a title that does not
  // claim the row is gone. Older goes on below the place the walk got to.
  assert.deepEqual([v.rows, v.next], [[], "2026-10:100"]);
  const p = auditPanels(v, q);
  assert.ok(!p.log.includes("<tr"), p.log);
  assert.ok(p.log.includes("<b>Row 60 was not found</b><span>Row 60 is not where the chain check counted it (the files changed since it ran). Reading from the newest row did not find it either.</span>"), p.log);
  assert.ok(!p.log.includes("holds no row") && p.log.includes('href="/audit?before=2026-10%3A100">Older</a>'), p.log);
  // Every seq page whose row was not found is drawn so, whatever the walk met of the chunk: a row the log has no line
  // for, among rows it has (a walk that read the whole chunk), shows no row either.
  const gap = auditLogDir(130);
  gap.write(gap.lines().filter((_, i) => i !== 94));
  const g = await readAuditView({ read: gap.read, verify: () => null, query: parseAuditQuery("seq=95").query });
  assert.deepEqual([g.seek.by, g.found, g.rows.length], ["unplaced", false, 0]);
  // A row found keeps its whole chunk.
  const found = await readAuditView({ read: gap.read, verify: () => null, query: parseAuditQuery("seq=96").query });
  assert.deepEqual([found.found, found.rows.length, found.rows[0].entry.seq, found.rows.at(-1).entry.seq], [true, 49, 100, 51]);
});

test("the audit log says a row's count by its kind: one of a bulk write's rows, or the jobs a resume found waiting", async () => {
  // The kinds are the action table's: every bulk action's, and the two resumes, whose preview counts the jobs waiting.
  assert.deepEqual([...AUDIT_BULK_KINDS].sort(), ACTIONS.filter((a) => a.bulk).map((a) => a.kind).sort());
  for (const kind of AUDIT_WAITING_KINDS) assert.equal(ACTIONS.find((a) => a.kind === kind)?.bulk, false, kind);
  const rows = [
    { kind: "fleet-resume", count: 2 },
    { kind: "queue-resume", count: 1, reason: "ops asked" },
    { kind: "failed-retry-all", count: 3 },
    { kind: "held-cancel-all", count: 2, reason: "it was refused" },
    { kind: "setting-set", count: 4 },
  ];
  const log = auditLogDir(rows.length, (i) => ({ actor: OPS, action: "write", target: "t", outcome: "ok", ...rows[i - 1] }));
  const p = auditPanels(await readAuditView({ read: log.read, verify: log.verify, query: parseAuditQuery("").query }));
  const why = (seq) => new RegExp(`<tr id="seq-${seq}">.*?<span class="au-why">(.*?)</span></td></tr>`).exec(p.log)?.[1];
  assert.deepEqual([1, 2, 3, 4, 5].map(why), ["2 jobs were waiting", "ops asked (1 job was waiting)", "one of 3 in a bulk write", "it was refused (one of 2)", "count 4"]);
});

test("readAuditView: a reaped chain's verified range starts at its first surviving row, not at row 1", async () => {
  const reaped = syntheticReader(100, () => "ops", () => null, { first: 1001 });
  const v = await readAuditView({ read: reaped.read, verify: reaped.verify, query: parseAuditQuery("").query });
  assert.deepEqual([v.chain.state, v.chain.startsAt, v.chain.from, v.chain.through], ["ok", 1001, 1001, 1100]);
  const p = auditPanels(v);
  assert.ok(p.chain.includes('<p class="banner__t">Chain verified from row 1001 through row 1100</p>') && p.chain.includes("The log starts there: older rows were reaped by retention, or removed, and the two look alike."), p.chain);
  assert.ok(p.about.includes("<dt>Verified</dt><dd>rows 1001 to 1100</dd>"), p.about);
});

test("the audit panels: the chain banner, the filters, the log by state, the side card, all in Pulse markup", async () => {
  const log = auditLogDir(6, (i) => (i === 3 ? { actor: { name: "anonymous", role: "none", session: null }, action: "login-failed", target: "/login", outcome: "refused", reason: "no token matched" } : i === 4 ? { actor: OPS, action: "write", kind: "run-rerun", target: "gh-1", outcome: "ok", reserve: 2_500_000 } : i === 5 ? { actor: { name: "pi", role: "panel", session: null }, action: "write", kind: "failed-retry-all", target: "gh-2", outcome: "ok", count: 3 } : { actor: OPS, action: "login", outcome: "ok" }));
  const ok = auditPanels(await readAuditView({ read: log.read, verify: async () => ({ ...log.verify(), checkedAt: NOW }), query: parseAuditQuery("").query }));
  assert.ok(ok.chain.startsWith('<div class="banner tone-ok" role="status"><span class="tile"><svg class="ic" aria-hidden="true"><use href="#i-chain"></use></svg></span><div><p class="banner__t">Chain verified through row 6</p>'), ok.chain);
  // The log: a flush card, a row per entry with its id, the who cell name over role, the kind under the action.
  assert.ok(ok.log.startsWith('<div class="card card--flush"><div class="card__head"><h2>Audit log</h2><span class="card__sub">newest first; every write, sign-in and refusal</span></div><div class="tbl-wrap"><table class="tbl tbl--stack"><caption class="sr">Audit log</caption><thead><tr><th scope="col" class="num">Seq</th><th scope="col">At</th><th scope="col">Who</th><th scope="col">Action</th><th scope="col">Target</th><th scope="col">Outcome</th><th scope="col">Reason</th></tr></thead>'), ok.log);
  assert.ok(ok.log.includes(`<tr id="seq-3"><td class="num" data-l="Seq"><b>3</b></td><td class="when" data-l="At"><span class="au-at"><time datetime="${AT(3)}">`), ok.log);
  // Each cell beside the reason is bounded (a name, a write's kind, a target wrap in their own width: page-css.mjs
  // AUDIT_LAYOUT), and the reason's is never narrower than its minimum.
  assert.ok(ok.log.includes('<span class="au-who">anonymous<small>none</small></span></td><td data-l="Action"><span class="code">login-failed</span></td><td class="wide" data-l="Target"><span class="code au-tgt">/login</span></td><td data-l="Outcome"><span class="badge tone-refused"><svg class="ic" aria-hidden="true"><use href="#i-refused"></use></svg>refused</span></td><td class="wide" data-l="Reason"><span class="au-why">no token matched</span></td></tr>'), ok.log);
  assert.ok(ok.log.includes('<span class="code">write</span><span class="reason au-kind">run-rerun</span>') && ok.log.includes(">reserve $2.50</span></td>"), "a paid write's kind and reserve");
  assert.ok(ok.log.includes('<span class="au-who">pi<small>panel</small></span>') && ok.log.includes('<td class="wide" data-l="Reason"><span class="au-why">one of 3 in a bulk write</span></td>'), "a bulk row's size, as words of its own with no reason before it");
  assert.ok(ok.log.includes('<td class="wide" data-l="Reason"><span class="au-why">reserve $2.50</span></td>'), "a reason with no bulk size has no bracket");
  assert.ok(ok.log.includes('<td class="wide" data-l="Target"><span class="faint">-</span></td>'), "an absent value, faint");
  assert.equal(ok.log.split('<td class="wide" data-l="Reason"><span class="au-why">').length - 1, 6, "every row's reason, in its bounded block");
  // Both controls lead nowhere, and are drawn alike (quiet), so neither looks like the live one.
  assert.ok(ok.log.includes('<div class="tbl-foot">Showing 6 rows, row 6 down to row 1<span class="pager"><a class="btn btn--sm btn--ghost" aria-disabled="true">Newest</a><a class="btn btn--sm btn--ghost" aria-disabled="true">Older</a></span></div>'), ok.log);
  assert.ok(!/class="(?:[^"]* )?(?:mono|warn|note|legacy)(?: |")/.test(ok.log), "no old markup's classes");
  // The side card.
  assert.ok(ok.about.includes('<dt>Verified</dt><dd>rows 1 to 6</dd>') && ok.about.includes('<dt>Damaged</dt><dd>none</dd>') && ok.about.includes('<dt>Who sees it</dt><dd>operators only; viewers do not see this page</dd>'));
  assert.ok(ok.about.includes(`<dt>Checked at</dt><dd><time datetime="${new Date(NOW).toISOString()}">`), "when the cached check ran");
  // Damaged: the banner names the row and what to do, and Show opens the page at it; the rows say their state. Row 5
  // was changed, which breaks row 6's link: row 6 is the damaged place, and row 5, the link's other end, is not vouched
  // for, so the verified range ends at row 4.
  log.write(log.lines().map((l, i) => (i === 4 ? l.replace('"gh-2"', '"gh-X"') : l)));
  const bad = auditPanels(await readAuditView({ read: log.read, verify: log.verify, query: parseAuditQuery("").query }));
  assert.ok(bad.chain.includes('<p class="banner__t">Chain verified through row 4. Line 6 of 2026-10.jsonl is damaged.</p>'), bad.chain);
  assert.ok(bad.chain.includes("Line 6 of 2026-10.jsonl and every row after it cannot be trusted. Neither can row 5, the row before it: the link between the two does not hold, so the chain cannot tell whether row 5 changed. Keep the file as it is and compare it with your last backup; <span class=\"code\"><span>pi-dispatch-console</span> <span>audit</span> <span>verify</span></span> names the same line."), bad.chain);
  assert.ok(bad.chain.includes('<div class="banner__act"><a class="btn btn--sm btn--primary" href="/audit?before=2026-10%3A7#line-2026-10-6">Show the damaged line</a></div>'), bad.chain);
  assert.ok(bad.log.includes('<tr id="line-2026-10-6" class="row--failed"><td class="num" data-l="Seq"><b>6</b></td>'), "the damaged row tinted, by its place's id");
  assert.ok(bad.log.includes('<span class="badge tone-failed"><svg class="ic" aria-hidden="true"><use href="#i-failed"></use></svg>damaged</span></td><td class="wide" data-l="Reason"><span class="au-why"><span class="au-dmg"><b>The chain check says:</b> prev does not match the row before it (seq 5): a row was changed, removed or moved.</span></span></td>'), bad.log);
  assert.ok(bad.log.includes('<td class="wide" data-l="Target"><span class="muted">-</span></td>'), "an absent value on the damaged tint is muted, which holds 4.5:1 there");
  assert.ok(bad.log.includes('<tr id="seq-5"><td class="num" data-l="Seq"><b>5</b></td>') && bad.log.includes('<span class="badge tone-idle"><svg class="ic" aria-hidden="true"><use href="#i-hourglass"></use></svg>not verified</span></td><td class="wide" data-l="Reason"><span class="au-why">one of 3 in a bulk write<span class="reason">Not verified: the link to the row after it does not hold. Written as ok.</span></span></td>'), bad.log);
  assert.ok(bad.about.includes('<dt>Damaged</dt><dd><b class="tinted tone-failed">line 6 of 2026-10.jsonl</b></dd>') && bad.about.includes("<dt>Verified</dt><dd>rows 1 to 4</dd>"), bad.about);
  assert.ok(bad.about.includes("<dt>Not verified</dt><dd>row 5 (its link to the damaged row does not hold) and any row after the damaged one (none on this page)</dd>"), bad.about);
  // A junk line: its place in the target column, its sentence beside it, and the banner names the line.
  const junk = auditLogDir(2);
  junk.write([...junk.lines(), "this line is not an audit row"]);
  const j = auditPanels(await readAuditView({ read: junk.read, verify: junk.verify, query: parseAuditQuery("").query }));
  assert.ok(j.chain.includes("<p class=\"banner__t\">Chain verified through row 1. Line 3 of 2026-10.jsonl is damaged.</p>") && j.chain.includes(">Show the damaged line</a>"), j.chain);
  assert.ok(j.log.includes('<tr id="line-2026-10-3" class="row--failed"><td class="num" data-l="Seq"><span class="muted">-</span></td>') && j.log.includes('<span class="code au-tgt">2026-10.jsonl:3</span>') && j.log.includes('<span class="au-why"><span class="au-dmg"><b>Not an audit row: line 3 of 2026-10.jsonl.</b> Changed, or written by something else.</span></span>'), j.log);
  // Not verified, and unchecked: the state in the badge, the outcome as written under the reason.
  const nv = auditLogDir(3);
  const n3 = nv.lines();
  nv.write([n3[0], "junk", n3[1], n3[2]]);
  const after = auditPanels(await readAuditView({ read: nv.read, verify: nv.verify, query: parseAuditQuery("").query }));
  assert.ok(after.log.includes('<span class="badge tone-idle"><svg class="ic" aria-hidden="true"><use href="#i-hourglass"></use></svg>not verified</span></td><td class="wide" data-l="Reason"><span class="au-why"><span class="reason">Not verified: it follows the damaged row. Written as ok.</span></span></td>'), after.log);
  const fresh = auditPanels(await readAuditView({ read: log.read, verify: null, query: parseAuditQuery("").query }));
  assert.ok(fresh.chain.includes("The chain could not be checked") && fresh.log.includes(">unchecked</span>") && fresh.log.includes("Not checked: the chain could not be checked. Written as ok."));
  assert.ok(fresh.about.includes("<dt>Verified</dt><dd>not checked</dd>"));
  for (const panel of [ok, bad, j, after, fresh]) for (const text of Object.values(panel)) assert.ok(!/\/home\/|\/Users\/|\/private\/|\/tmp\//.test(text), "no host path on the page");
});

test("the audit panels: filters as a GET form, the pager keeps them, a seq page, an empty page, a reserved row id never written", async () => {
  const r = syntheticReader(130, (seq) => (seq % 2 ? "ops" : "bob"));
  const q = parseAuditQuery("who=bob&q=x%22%3E%3Cb%3E").query;
  const filtered = auditPanels(await readAuditView({ read: r.read, verify: r.verify, query: q }), q);
  assert.ok(filtered.filter.startsWith('<form class="filterbar" method="get" action="/audit" role="search" aria-label="Filter the audit log"><label class="search"><svg class="ic" aria-hidden="true"><use href="#i-search"></use></svg><input type="search" name="q" value="x&quot;&gt;&lt;b&gt;" maxlength="64"'), filtered.filter);
  assert.ok(filtered.filter.includes('<label class="sr" for="au-who">Who</label><select id="au-who" class="select" name="who"><option value="">Who: all</option><option value="bob" selected>Who: bob</option><option value="ops">Who: ops</option></select>'), filtered.filter);
  for (const a of CONSOLE_AUDIT_ACTIONS) assert.ok(filtered.filter.includes(`<option value="${a}">Action: ${a}</option>`), a);
  for (const o of CONSOLE_AUDIT_OUTCOMES) assert.ok(filtered.filter.includes(`<option value="${o}">Outcome: ${o}</option>`), o);
  assert.ok(filtered.filter.includes('<button class="btn" type="submit">Filter</button><a class="btn btn--ghost" href="/audit">Clear</a></form>'));
  assert.ok(!auditPanels(await readAuditView({ read: r.read, verify: r.verify, query: parseAuditQuery("").query })).filter.includes("Clear"), "nothing to clear");
  assert.ok(filtered.log.includes('<div class="au-empty"><div class="empty">') && filtered.log.includes("<b>No row matches</b><span>No row in the log matches these filters.</span>"), "the search text matched nothing");
  assert.ok(filtered.log.includes('<div class="tbl-foot"><span class="pager">'), "the empty state says it once: the foot has no sentence of its own");
  const bob = parseAuditQuery("who=bob").query;
  const page = auditPanels(await readAuditView({ read: r.read, verify: r.verify, query: bob }), bob);
  assert.ok(page.log.includes('<div class="tbl-foot">50 rows match among the 101 rows searched.<span class="pager"><a class="btn btn--sm btn--ghost" aria-disabled="true">Newest</a><a class="btn btn--sm" href="/audit?before=2026-10%3A32&amp;who=bob">Older</a></span></div>'), page.log);
  const deeper = parseAuditQuery("who=bob&before=2026-10:30").query;
  assert.ok(auditPanels(await readAuditView({ read: r.read, verify: r.verify, query: deeper }), deeper).log.includes('<a class="btn btn--sm btn--ghost" href="/audit?who=bob">Newest</a>'), "Newest keeps the filter, drops the place");
  const seq = parseAuditQuery("seq=61").query;
  const s61 = auditPanels(await readAuditView({ read: r.read, verify: r.verify, query: seq }), seq);
  assert.ok(s61.log.includes('<tr id="seq-61">') && s61.log.includes("The page that holds row 61.") && s61.log.includes('href="/audit?before=2026-10%3A51">Older</a>'), s61.log);
  // Past the newest row: it does not exist yet, and the page never says nothing older is in the log.
  const missing = parseAuditQuery("seq=999").query;
  const m999 = auditPanels(await readAuditView({ read: r.read, verify: r.verify, query: missing }), missing).log;
  assert.ok(m999.includes("<b>No row 999 yet</b><span>Row 999 does not exist yet: the newest row is 130.</span>") && !m999.includes("Nothing older"), m999);
  const empty = syntheticReader(0);
  const e = auditPanels(await readAuditView({ read: empty.read, verify: () => ({ ok: true, rows: 0, startsAt: null, last: null }), query: parseAuditQuery("").query }));
  assert.ok(e.log.includes("<b>The audit log is empty</b>") && e.chain.includes("<p class=\"banner__t\">The audit log is empty</p>"));
  // A tampered file can hold one seq twice: the second is drawn under its place's id, so every id is once.
  const dup = auditLogDir(2);
  const d = dup.lines();
  dup.write([d[0], d[1], d[0]]);
  const twice = auditPanels(await readAuditView({ read: dup.read, verify: () => ({ ok: true, rows: 3, startsAt: null, last: { file: "2026-10.jsonl", line: 3, seq: 1 } }), query: parseAuditQuery("").query })).log;
  const ids = [...twice.matchAll(/<tr id="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids, ["seq-1", "seq-2", "line-2026-10-1"]);
  // The reader is unreadable, or the page data has no view: the log says so, and nothing else is claimed.
  const blind = auditPanels({ rows: [], next: null, examined: 0, stopped: false, found: null, who: [], chain: { state: "unreadable", why: "directory", from: null, through: null, startsAt: null, broken: null, last: null, checkedAt: null }, unreadable: "the audit directory cannot be read (EACCES)" });
  assert.ok(blind.log.includes("<b>The audit log could not be read</b><span>The audit directory cannot be read (EACCES). The next load tries again.</span>") && blind.chain.includes("The audit directory could not be read, so no row is verified."));
  const none = auditPanels(null);
  assert.ok(none.log.includes("The audit log could not be read") && none.chain.includes("The chain could not be checked"));
  // The command is drawn a word a box in every banner that names it, so a line breaks between its words and never
  // after the dash of "pi-" (page-css.mjs AUDIT_CSS).
  const cmd = '<span class="code"><span>pi-dispatch-console</span> <span>audit</span> <span>verify</span></span>';
  for (const [what, chain] of [["unreadable", blind.chain], ["no view", none.chain]]) assert.ok(chain.includes(cmd) && !chain.includes("pi-dispatch-console audit verify"), `${what}: ${chain}`);
  // A viewer gets the role's sentence in the log's panel, and nothing in the others (the route refuses a viewer first).
  const viewer = auditPanels(await readAuditView({ read: r.read, verify: r.verify, query: bob }), bob, "viewer");
  assert.deepEqual(viewer, { chain: "", filter: "", log: `<p class="muted">${AUDIT_OPERATORS_ONLY}</p>`, about: "" });
});

test("the audit panels: an edited outcome is never shown as verified; the banner, the rows and About say what the chain vouches for", async () => {
  // A tamper on a real log: a refused sign-in's outcome edited
  // to ok. Its own line still parses and its seq still follows, so what breaks is the NEXT row's prev; the page must
  // not then put "ok" on the edited row under "verified through" it.
  const log = auditLogDir(5, (i) => (i === 3 ? { actor: { name: "anonymous", role: "none", session: null }, action: "login-failed", target: "/login", outcome: "refused", reason: "no token matched" } : { actor: OPS, action: "login", outcome: "ok" }));
  log.write(log.lines().map((l, i) => (i === 2 ? l.replace('"outcome":"refused"', '"outcome":"ok"') : l)));
  assert.match(log.lines()[2], /"action":"login-failed","target":"\/login","outcome":"ok"/, "the edit landed");
  const v = await readAuditView({ read: log.read, verify: async () => ({ ...log.verify(), checkedAt: NOW }), query: parseAuditQuery("").query });
  assert.deepEqual(v.rows.map(label), ["5:unverified", "4:damaged", "3:suspect", "2:ok", "1:ok"]);
  const p = auditPanels(v);
  assert.ok(p.chain.includes('<p class="banner__t">Chain verified through row 2. Line 4 of 2026-10.jsonl is damaged.</p>'), p.chain);
  assert.ok(p.chain.includes("Neither can row 3, the row before it: the link between the two does not hold, so the chain cannot tell whether row 3 changed."), p.chain);
  const row3 = /<tr id="seq-3">.*?<\/tr>/.exec(p.log)?.[0] ?? "";
  assert.ok(row3.includes(">not verified</span>") && row3.includes("Not verified: the link to the row after it does not hold. Written as ok."), row3);
  assert.ok(!row3.includes("tone-ok"), "the edited outcome is not drawn as an ok badge");
  assert.ok(p.about.includes("<dt>Verified</dt><dd>rows 1 to 2</dd>") && p.about.includes('<dt>Damaged</dt><dd><b class="tinted tone-failed">line 4 of 2026-10.jsonl</b></dd>') && p.about.includes("<dt>Not verified</dt><dd>row 3 (its link to the damaged row does not hold) and every row after the damaged one</dd>"), p.about);
  // A broken link whose other end is the first row: nothing is vouched for.
  const two = auditLogDir(2);
  two.write(two.lines().map((l, i) => (i === 0 ? l.replace('"action":"login"', '"action":"logout"') : l)));
  const t = auditPanels(await readAuditView({ read: two.read, verify: two.verify, query: parseAuditQuery("").query }));
  assert.ok(t.chain.includes('<p class="banner__t">No row could be verified. Line 2 of 2026-10.jsonl is damaged.</p>') && t.about.includes("<dt>Verified</dt><dd>none</dd>"), `${t.chain}\n${t.about}`);
  // A junk line shows no prev, so the row before it is not verified either. Only a line whose prev matched the row
  // before it and that fails another check (here a seq that does not follow) is damaged alone, with no second row named.
  const junk = auditLogDir(3);
  const ls = junk.lines();
  junk.write([ls[0], ls[1], "{not a row", ls[2]]);
  const j = auditPanels(await readAuditView({ read: junk.read, verify: junk.verify, query: parseAuditQuery("").query }));
  assert.ok(j.chain.includes('<p class="banner__t">Chain verified through row 1. Line 3 of 2026-10.jsonl is damaged.</p>') && j.chain.includes("Neither can row 2, the row before it"), j.chain);
  const skip = auditLogDir(3);
  const ks = skip.lines();
  skip.write([ks[0], ks[1], JSON.stringify({ ...JSON.parse(ks[2]), seq: 9 })]);
  const k = auditPanels(await readAuditView({ read: skip.read, verify: skip.verify, query: parseAuditQuery("").query }));
  assert.ok(k.chain.includes('<p class="banner__t">Chain verified through row 2. Line 3 of 2026-10.jsonl is damaged.</p>') && !k.chain.includes("Neither can"), k.chain);
});

test("the audit panels: an edited row followed by a garbled line, an unknown action or a prev that is not a hash is not shown as verified", async () => {
  // Row 3's outcome edited from refused to ok, then line 4 damaged so that it shows no prev matching row 3: whatever
  // else is wrong with line 4, nothing vouches for row 3, so the page must not draw its edited outcome as verified.
  const damages = {
    "a garbled line": [(l) => l.slice(0, 25), "line4"],
    "an unknown action": [(l) => l.replace('"action":"login"', '"action":"zz"'), "4"],
    "a prev that is not a hash": [(l) => JSON.stringify({ ...JSON.parse(l), prev: "x" }), "4"],
  };
  for (const [what, [damage, at]] of Object.entries(damages)) {
    const log = auditLogDir(5, (i) => ({ actor: OPS, action: "login", outcome: i === 3 ? "refused" : "ok" }));
    log.write(log.lines().map((l, i) => (i === 2 ? l.replace('"outcome":"refused"', '"outcome":"ok"') : i === 3 ? damage(l) : l)));
    const v = await readAuditView({ read: log.read, verify: log.verify, query: parseAuditQuery("").query });
    assert.deepEqual(v.rows.map(label), ["5:unverified", `${at}:damaged`, "3:suspect", "2:ok", "1:ok"], what);
    const p = auditPanels(v);
    assert.ok(p.chain.includes('<p class="banner__t">Chain verified through row 2. Line 4 of 2026-10.jsonl is damaged.</p>') && p.chain.includes("Neither can row 3, the row before it"), `${what}: ${p.chain}`);
    const row3 = /<tr id="seq-3">.*?<\/tr>/.exec(p.log)?.[0] ?? "";
    assert.ok(row3.includes(">not verified</span>") && row3.includes("Written as ok.") && !row3.includes("tone-ok"), `${what}: ${row3}`);
  }
});

test("the audit panels: the damaged place is named by the line the check names, the same on every page, in the banner and About", async () => {
  // Row 54's outcome edited: row 55's link breaks. The newest page holds line 55, row 5's page does not; one
  // place must never be said "Row 2201" on the one and "line 2201 of 2026-10.jsonl" on the other.
  const log = auditLogDir(60);
  log.write(log.lines().map((l, i) => (i === 53 ? l.replace('"action":"login"', '"action":"logout"') : l)));
  const named = async (qs) => {
    const q = parseAuditQuery(qs).query;
    const v = await readAuditView({ read: log.read, verify: log.verify, query: q });
    const p = auditPanels(v, q);
    return { holds: v.rows.some((r) => r.state === "damaged"), title: /<p class="banner__t">([^<]*)</.exec(p.chain)[1], show: />(Show [^<]*)</.exec(p.chain)[1], damaged: /<dt>Damaged<\/dt><dd>(.*?)<\/dd>/.exec(p.about)[1], body: /<p class="banner__s">(.*?) Neither/.exec(p.chain)[1] };
  };
  const newest = await named("");
  const older = await named("seq=5");
  assert.deepEqual([newest.holds, older.holds], [true, false]);
  assert.deepEqual(older, { ...newest, holds: false });
  assert.deepEqual(newest, { holds: true, title: "Chain verified through row 53. Line 55 of 2026-10.jsonl is damaged.", show: "Show the damaged line", damaged: '<b class="tinted tone-failed">line 55 of 2026-10.jsonl</b>', body: "The check says: prev does not match the row before it (seq 54): a row was changed, removed or moved. Line 55 of 2026-10.jsonl and every row after it cannot be trusted." });
});

test("the audit panels: what a seq page and a search say when they stop, said once, never contradicting the pager", async () => {
  // A filtered search that stops at 2,000 with rows found: its stop sentence in the foot, Older continuing it.
  const r = syntheticReader(2500, (seq) => (seq % 100 === 0 ? "bob" : "ops"));
  const bob = parseAuditQuery("who=bob").query;
  const stopped = auditPanels(await readAuditView({ read: r.read, verify: r.verify, query: bob }), bob).log;
  assert.ok(stopped.includes('<div class="tbl-foot">20 rows match among the 2,000 rows searched. The search stops at 2,000 rows; Older searches on from there.<span class="pager"><a class="btn btn--sm btn--ghost" aria-disabled="true">Newest</a><a class="btn btn--sm" href="/audit?before=2026-10%3A501&amp;who=bob">Older</a></span></div>'), stopped);
  // The same search with nothing found from the newest, and on an Older page, where it searched from here.
  const carol = parseAuditQuery("who=carol").query;
  const top = auditPanels(await readAuditView({ read: r.read, verify: r.verify, query: carol }), carol).log;
  assert.ok(top.includes("<b>No row matches</b><span>None of the 2,000 rows searched from the newest matches; Older searches on from there.</span>") && top.includes('<div class="tbl-foot"><span class="pager">'), top);
  const deeper = parseAuditQuery("who=carol&before=2026-10:1501").query;
  const here = auditPanels(await readAuditView({ read: r.read, verify: r.verify, query: deeper }), deeper).log;
  assert.ok(here.includes("<span>No row from here to the oldest matches these filters.</span>"), here);
  const mid = parseAuditQuery("who=carol&before=2026-10:2400").query;
  assert.ok(auditPanels(await readAuditView({ read: r.read, verify: r.verify, query: mid }), mid).log.includes("<span>None of the 2,000 rows searched from here matches; Older searches on from there.</span>"));
  const some = parseAuditQuery("who=bob&before=2026-10:1501").query;
  assert.ok(auditPanels(await readAuditView({ read: r.read, verify: r.verify, query: some }), some).log.includes('<div class="tbl-foot">15 rows match among the 1,500 rows searched from here.<span class="pager">'));
  // A seq the index cannot place, past 2,000 newer rows: the walk stopped, and the page says so once, with Older live.
  const blind = syntheticReader(3000, () => "ops", () => null, { index: false });
  const s5 = parseAuditQuery("seq=5").query;
  const walked = auditPanels(await readAuditView({ read: blind.read, verify: blind.verify, query: s5 }), s5).log;
  assert.ok(walked.includes("<b>Row 5 was not reached</b><span>The chain check gave no place for row 5. Row 5 is not among the newest 2,000 rows; Older lists the rows below them.</span>") && walked.includes('href="/audit?before=2026-10%3A1001">Older</a>') && !walked.includes("Nothing older"), walked);
  assert.ok(walked.includes('<div class="tbl-foot"><span class="pager">'), "said once");
  // The same seq with the index: found at its place, the chunk shown.
  const far = syntheticReader(3000);
  const placed = auditPanels(await readAuditView({ read: far.read, verify: far.verify, query: s5 }), s5).log;
  assert.ok(placed.includes('<tr id="seq-5">') && placed.includes('<div class="tbl-foot">The page that holds row 5.<span class="pager"><a class="btn btn--sm btn--ghost" href="/audit">Newest</a><a class="btn btn--sm btn--ghost" aria-disabled="true">Older</a></span></div>'), placed);
  // A place that no longer holds its row, and a log whose start was reaped.
  const moved = syntheticReader(3000, () => "ops", () => null, { shift: 5 });
  const mv = auditPanels(await readAuditView({ read: moved.read, verify: moved.verify, query: s5 }), s5).log;
  assert.ok(mv.includes("<span>Row 5 is not where the chain check counted it (the files changed since it ran). Row 5 is not among the newest 2,000 rows; Older lists the rows below them.</span>"), mv);
  const reaped = syntheticReader(100, () => "ops", () => null, { first: 1001 });
  const s41 = parseAuditQuery("seq=41").query;
  const gone = auditPanels(await readAuditView({ read: reaped.read, verify: reaped.verify, query: s41 }), s41).log;
  assert.ok(gone.includes("<b>No row 41 now</b><span>The log starts at row 1001: row 41 was reaped by retention, or removed.</span>") && gone.includes('<a class="btn btn--sm btn--ghost" href="/audit">Newest</a>'), gone);
  // Past a broken link the check cannot count: said, not hidden behind "no such row".
  const broken = syntheticReader(130);
  const brokenVerify = () => ({ ok: false, rows: 60, broken: { file: "2026-10.jsonl", line: 61, reason: "the line is not a JSON row (damaged, or written by something else)" }, last: { file: "2026-10.jsonl", line: 60, seq: 60 }, suspect: null, files: [{ file: "2026-10.jsonl", seq: 1, rows: 60 }] });
  const s200 = parseAuditQuery("seq=200").query;
  const past = auditPanels(await readAuditView({ read: broken.read, verify: brokenVerify, query: s200 }), s200).log;
  assert.ok(past.includes("<b>No row 200 yet</b><span>Row 200 does not exist yet: the newest row is 130.</span>"), past);
  const v = await readAuditView({ read: broken.read, verify: brokenVerify, query: parseAuditQuery("seq=95").query });
  assert.deepEqual([v.found, v.seek.by], [true, "unplaced"]);
  // A plain Older page past the end: nothing older, said only because Older leads nowhere.
  const end = parseAuditQuery("before=2026-10:1").query;
  const e = auditPanels(await readAuditView({ read: broken.read, verify: broken.verify, query: end }), end).log;
  assert.ok(e.includes("<b>No rows here</b><span>Nothing older is in the log. Newest goes back to the top.</span>") && e.includes('<a class="btn btn--sm btn--ghost" aria-disabled="true">Older</a>'), e);
});

test("the run page's Progress panel (issue #644): a finished run shows its record's progress by the worker's rule; the key's names only to an operator", async () => {
  const { runProgress } = await import("../src/console/panels.mjs");
  const progress = { turns: 9, steps: 14, failed: 2, toolMs: 61_000, longestStepMs: 2_500, phasesDeclared: 3, lastPhaseIndex: 2, tools: { bash: 6, read: 8, "<script>x</script>": 4, other: 1 }, note: "RECORD-TEXT" };
  const record = { jobId: "gh-1", outcome: "completed", startedAt: new Date(NOW - 120_000).toISOString(), endedAt: new Date(NOW).toISOString(), progress };
  const key = { v: 1, turn: 9, steps: 14, failed: 2, interrupted: 0, running: [], recent: [], phase: { index: 2, done: null, total: null }, phases: ["plan", "build", "KEY-PHASE-NAME"], note: "KEY-NOTE", prior: null, startedAt: NOW - 60_000, updatedAt: NOW, ended: true, outcome: "completed" };
  const view = (role, data) => ({ page: "run", role, readOnly: false, query: { id: "gh-1" }, env: {}, now: NOW, data: { now: NOW, ...data } });
  const op = String(runProgress(view("operator", { run: { record }, progress: key })));
  assert.match(op, /<dt>Turns<\/dt><dd>9<\/dd>/);
  assert.match(op, /<dt>Sum of step durations<\/dt><dd>1m<\/dd>(?:<\/div><div class="fact">)?<dt>Longest step<\/dt><dd>2\.5 s<\/dd>(?:<\/div><div class="fact">)?<dt>Phases declared<\/dt>/, "no interrupted step: no row for it");
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
  assert.match(op, /<span class="name">ATTEMPT-2-PHASE<\/span>/);
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
  assert.match(stale, /<p class="warn">Stale: no update for 5 min; the worker may be gone\. <a href="\/fleet">Open Fleet<\/a>\.<\/p>/);
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
  assert.match(op, new RegExp(`<td class="mono">${q}</td><td>steer</td><td>console</td><td><span class="chip"><svg class="ic" aria-hidden="true"><use href="#i-clock"></use></svg>queued</span></td><td><time datetime="2026-10-08T15:38:38.000Z">2026-10-08 15:38 UTC</time></td><td class="num">18</td>`));
  assert.match(op, new RegExp(`<td class="mono">${w}</td><td>follow-up</td><td>forge</td><td><span class="chip"><svg class="ic" aria-hidden="true"><use href="#i-clock"></use></svg>written</span></td>`));
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
  assert.match(op, new RegExp(`<td class="mono">${id}</td><td>steer</td><td>console</td><td><span class="chip"><svg class="ic" aria-hidden="true"><use href="#i-clock"></use></svg>queued</span></td><td>-</td>`), "a missing time is -");
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
  assert.match(String(page.html), /<section id="p-inbox" data-panel><div class="card"><div class="card__head"><h2>Inbox<\/h2>/);
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

test("the runs table: the outcome as the panel's word on a badge, quiet when completed, and the reason as a short sentence linked to its runs (#710, #737)", async () => {
  const { REASONS } = await import("@edgehero/pi-dispatch/reason-catalog");
  const { NO_EXPLANATION, shortSentence } = await import("../src/words.mjs");
  const { NO_REASON_SHORT } = await import("../src/console/panels/common.mjs");
  const base = { kind: "github", target: "acme/web#1", endedAt: "2026-10-08T15:00:00Z", tokens: { total: 5, cost: 0.1 } };
  const runs = [
    { ...base, jobId: "gh-c", outcome: "completed" },
    { ...base, jobId: "gh-a", outcome: "completed", reason: "awaiting-input" },
    { ...base, jobId: "gh-r", outcome: "policy", reason: "scope-cap" },
    { ...base, jobId: "gh-x", outcome: "policy", reason: "operator-cancel" },
    { ...base, jobId: "gh-f", outcome: "failed", reason: "container-never-started", failedReason: "FREE-TEXT <b>" },
    { ...base, jobId: "gh-k", outcome: "policy", reason: "recovery-cap" },
    { ...base, jobId: "gh-n", outcome: "policy", reason: "brand-new-reason" },
    { ...base, jobId: "gh-h", outcome: "policy", reason: "<img src=x>" },
    { ...base, jobId: "gh-u", outcome: "vapour" },
    { ...base, jobId: "gh-l", outcome: "policy", reason: `LONG${"z".repeat(500)}` },
    { ...base, jobId: "gh-i", outcome: "failed", reason: "infra failure, container exit 1" },
    { ...base, jobId: "gh-m", outcome: "policy", reason: "model-unknown" },
    { ...base, jobId: "gh-mv", outcome: "policy", reason: "model-unknown", why: "overlay-link" },
    { ...base, jobId: "gh-f2", outcome: "policy", reason: "model-not-allowed" },
    { ...base, jobId: "gh-f2v", outcome: "policy", reason: "model-not-allowed", why: "fallback-unlisted" },
  ];
  const out = (await pagePanels("runs", ctxOf("viewer", { runsPage: { runs, next: null, mirror: "ok" } }, parsePageQuery("runs", "").query))).map((p) => p.html).join("");
  const rowOf = (id) => out.match(new RegExp(`<tr><td class="when"[^>]*>(?:(?!</tr>).)*?<a href="/run\\?id=${id}">.*?</tr>`))?.[0] ?? "";
  const cellOf = (id) => (rowOf(id).match(/<td class="wide">(.*?)<\/td>/)?.[1] ?? "").replace(/<svg class="ic" aria-hidden="true"><use href="#i-[a-z-]+"><\/use><\/svg>/g, "");
  const badge = (tone, word) => `<span class="badge tone-${tone}">${word}</span>`;
  // Completed is quiet: the idle tone, nothing more. A word that says why stands alone.
  assert.equal(cellOf("gh-c"), badge("idle", "Completed"));
  assert.equal(cellOf("gh-a"), badge("parked", "Awaiting input"), "the word says it all: no reason part");
  assert.equal(cellOf("gh-x"), badge("idle", "Cancelled"));
  const scope = shortSentence(REASONS["scope-cap"].sentence);
  assert.equal(cellOf("gh-r"), `${badge("refused", "Refused")}<span class="reason"><a href="/runs?outcome=refused&amp;reason=scope-cap" title="scope-cap">${scope.replace(/'/g, "&#39;")}</a></span>`);
  assert.match(cellOf("gh-f"), /^<span class="badge tone-failed">Failed<\/span><span class="reason"><a href="\/runs\?outcome=failed&amp;reason=container-never-started" title="container-never-started">/);
  // A recovery end the worker records as policy reads failed, its link by the word, its sentence kept.
  assert.equal(cellOf("gh-k"), `${badge("failed", "Failed")}<span class="reason"><a href="/runs?outcome=failed&amp;reason=recovery-cap" title="recovery-cap">${shortSentence(REASONS["recovery-cap"].sentence).replace(/'/g, "&#39;")}</a></span>`);
  // REQ-CONSOLE-SECURITY (l): a job's free text never reaches a list row, only the closed enum.
  assert.ok(!out.includes("FREE-TEXT"), "no failedReason in a list row");
  // An unknown token: shown in the code face, with no explanation, still linked.
  assert.equal(cellOf("gh-n"), `${badge("refused", "Refused")}<span class="reason"><a href="/runs?outcome=refused&amp;reason=brand-new-reason" title="brand-new-reason"><span class="code">brand-new-reason</span>, ${NO_EXPLANATION}</a></span>`);
  // A reason that is no token is shown to nobody (issue #737): markup, an over-long string, an older worker's error text.
  for (const id of ["gh-h", "gh-l"]) assert.equal(cellOf(id), `${badge("refused", "Refused")}<span class="reason">${NO_REASON_SHORT}</span>`, id);
  assert.equal(cellOf("gh-i"), `${badge("failed", "Failed")}<span class="reason">${NO_REASON_SHORT}</span>`);
  for (const bad of ["img src", "LONGzz", "infra failure"]) assert.ok(!out.includes(bad), bad);
  // The why variant changes the row's sentence, as the catalog's variant does.
  const { explainReason } = await import("@edgehero/pi-dispatch/reason-catalog");
  for (const [plainId, variantId, reason, why] of [["gh-m", "gh-mv", "model-unknown", "overlay-link"], ["gh-f2", "gh-f2v", "model-not-allowed", "fallback-unlisted"]]) {
    const shortOf = (w) => shortSentence(explainReason(reason, { why: w }).sentence).replace(/'/g, "&#39;");
    assert.notEqual(shortOf(why), shortOf(null), `${reason}/${why} has its own short sentence`);
    assert.ok(cellOf(variantId).includes(`>${shortOf(why)}</a>`), cellOf(variantId));
    assert.ok(cellOf(plainId).includes(`>${shortOf(null)}</a>`), cellOf(plainId));
  }
  // An outcome this release does not know: shown as itself, as a failure.
  assert.equal(cellOf("gh-u"), `${badge("failed", "vapour")}<span class="reason">${NO_REASON_SHORT}</span>`);
  // Every link in the column is one the runs filter accepts.
  for (const m of out.matchAll(/href="\/runs\?([^"]*)"/g)) assert.equal(parsePageQuery("runs", new URLSearchParams(m[1].replace(/&amp;/g, "&"))).refusal, undefined, m[1]);
  assert.ok(!/style=/.test(out), "no inline style (the CSP forbids it)");
  assert.match(out, /<th scope="col" class="hide-phone">Venue<\/th>/);
});

test("the run summary and the chain say the panel's words; the nav, the spend page and the held panel use its titles", async () => {
  const record = { jobId: "gh-1", kind: "github", target: "acme/web#1", outcome: "policy", reason: "operator-cancel", backend: "local", startedAt: "2026-10-08T14:00:00Z", endedAt: "2026-10-08T15:00:00Z" };
  const data = { run: { record, source: "local" }, children: [{ jobId: "gh-2", outcome: "completed", reason: "awaiting-input" }], childrenSearched: 1 };
  const run = (await pagePanels("run", ctxOf("operator", data, parsePageQuery("run", "id=gh-1").query))).map((p) => p.html).join("");
  assert.match(run, /<dt>Outcome<\/dt><dd>cancelled<\/dd>(?:<\/div><div class="fact">)?<dt>Reason<\/dt><dd>operator-cancel<\/dd>/, "the word, then the token");
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
  const run = (await pagePanels("run", ctxOf("operator", data, parsePageQuery("run", "id=gh-1").query))).map((p) => p.html).join("");
  assert.match(run, /href="\/run\?id=gh-2">gh-2<\/a> awaiting input<\/li>/);
  assert.match(run, /href="\/run\?id=gh-3">gh-3<\/a> cancelled<\/li>/);
  assert.match(run, /href="\/run\?id=gh-4">gh-4<\/a> refused<\/li>/);
  assert.match(run, /href="\/run\?id=gh-5">gh-5<\/a> failed<\/li>/);
});

// ---- issue #710, PR 4: a truthful overview and readable numbers (the overview's Pulse panels since issue #737) ----

const overviewOf = async (snap, role = "viewer") => (await pagePanels("overview", ctxOf(role, { snapshot: snap }))).map((p) => [p.id, p.html]);

test("the overview: the first run's three, then what needs a person, what waits, what runs and spend, the timeline and caps, waitlists and hosts (#710, #737)", async () => {
  const ids = (await overviewOf(snapshot())).map(([id]) => id);
  assert.deepEqual(ids.filter((id) => !SHELL_PANEL_IDS.includes(id)), ["p-setup", "p-setup-pi", "p-setup-empty", "p-needs", "p-waiting", "p-active", "p-spend", "p-timeline", "p-caps", "p-waitlists", "p-hosts"]);
  assert.deepEqual(ids.filter((id) => SHELL_PANEL_IDS.includes(id)).sort(), [...SHELL_PANEL_IDS].sort(), "and the shell's Parked count and headline");
});

test("the day's failed and refused runs are Needs you's foot line, linked, a floor said once, cancels not counted (#710, #737)", async () => {
  const needs = async (over) => new Map(await overviewOf({ ...snapshot(), ...over })).get("p-needs");
  const html = await needs({ failures24h: 2, failures24hFloor: false, refusals24h: { count: 9, top: [{ reason: "scope-cap", count: 5 }] } });
  assert.match(html, /Last 24 hours: <a href="\/runs\?outcome=failed">2 failed<\/a> and <a href="\/runs\?outcome=refused">9 refused<\/a>, not counting runs an operator cancelled\./);
  const floor = await needs({ failures24h: 3, failures24hFloor: true, refusals24h: { count: 0, top: [] } });
  assert.match(floor, /Last 24 hours: <a href="\/runs\?outcome=failed">at least 3 failed<\/a>\./);
  assert.ok(!floor.includes("refused"));
  // The window unread: one sentence, no zeros.
  const lost = await needs({ failures24h: null, refusals24h: null });
  assert.match(lost, /The run history could not be read/);
  assert.ok(!lost.includes("Last 24 hours"));
});

test("no worker online: the hosts panel warns first, by the hosts' beats, and the fleet page says the same (#710, #737)", async () => {
  const hostsOf = async (over) => new Map(await overviewOf({ ...snapshot(), ...over })).get("p-hosts");
  const queue = { pausedState: false, pausedPartial: false, counts: { waiting: 4 }, workers: 2, queues: 1 };
  const host = (name, staleMs) => ({ name, concurrency: "2", jobs: [], staleMs });
  // Every row's last beat older than a minute and no worker BullMQ can see: nothing drains the queue.
  const stale = await hostsOf({ queue: { ...queue, workers: "unknown" }, hostBudgets: [host("h1", BEAT_FRESH_MS + 1), host("h2", null)] });
  assert.ok(stale.includes(NO_WORKER_TEXT) && stale.indexOf(NO_WORKER_TEXT) < stale.indexOf("hostrow"), stale);
  assert.ok(!stale.includes(STALE_BEATS_TEXT));
  assert.match(stale, /<span class="card__sub">2 registered, 0 beating<\/span>/);
  const fleetQueuesHtml = new Map((await pagePanels("fleet", ctxOf("viewer", { snapshot: { ...snapshot(), queue: { ...queue, workers: "unknown" }, hostBudgets: [host("h1", BEAT_FRESH_MS + 1)] } }))).map((p) => [p.id, p.html])).get("p-queues");
  assert.match(fleetQueuesHtml, /<dt>Fleet<\/dt><dd><span class="warn">not paused, but no worker is online<\/span>/, "the fleet page says the same");
  // No registry row and no BullMQ worker either.
  const empty = await hostsOf({ queue: { ...queue, workers: "unknown" }, hostBudgets: [] });
  assert.ok(empty.includes(NO_WORKER_TEXT));
  // A paused fleet with no worker still warns, and says it is paused.
  const paused = await hostsOf({ queue: { ...queue, workers: "unknown", pausedState: true }, hostBudgets: [host("h1", 5 * 60_000)] });
  assert.ok(paused.includes(NO_WORKER_TEXT) && paused.includes(">Paused</span>"));
  // One fresh beat: no warning; a fleet whose registry is unreadable is judged by nobody.
  const live = await hostsOf({ queue, hostBudgets: [host("h1", BEAT_FRESH_MS), host("h2", BEAT_FRESH_MS + 1)] });
  assert.ok(!live.includes(NO_WORKER_TEXT));
  assert.match(live, /<span class="card__sub">2 registered, 1 beating, 2 connected<\/span>/);
  const blind = await hostsOf({ queue: { ...queue, fleetDegraded: "registry unreadable" }, hostBudgets: [host("h1", 10 * 60_000)] });
  assert.ok(!blind.includes(NO_WORKER_TEXT), "an unreadable registry is not an empty one");
  assert.match(blind, /fleet as it was last seen/);
  // A registry with no row: BullMQ's own count is the fallback (it cannot see beats).
  assert.deepEqual(workersOnline({ queue: { workers: 3 }, hostBudgets: [] }), { count: 3, online: 3, connected: 3, staleBeats: false, none: false });
  // A beat's age is Valkey's where the reader had it: a host whose clock runs two minutes behind beats all the same.
  assert.equal(workersOnline({ queue: { workers: 0 }, hostBudgets: [{ name: "h1", staleMs: 120_000, ttlAgeMs: 5_000 }] }).online, 1);
  assert.equal(workersOnline({ queue: { workers: 0 }, hostBudgets: [{ name: "h1", staleMs: 5_000, ttlAgeMs: 75_000 }] }).online, 0, "and a row Valkey has not refreshed for over a minute is late, whatever its stamp");
  assert.deepEqual(workersOnline({ queue: { workers: "unknown" }, hostBudgets: [] }), { count: "unknown", online: 0, connected: 0, staleBeats: false, none: true });
  assert.deepEqual(workersOnline({ queue: { workers: 1 }, hostBudgets: [host("h1", 1000)] }), { count: 1, online: 1, connected: 1, staleBeats: false, none: false });
  assert.deepEqual(workersOnline({ queue: { workers: 3, fleetDegraded: "x" }, hostBudgets: [host("h1", 1000)] }), { count: 1, online: null, connected: 3, staleBeats: false, none: false });
  assert.equal(BEAT_FRESH_MS, 60_000);
});

test("clock skew: a host whose beats look stale while BullMQ sees its worker is not \"no worker online\" (#710, #737)", async () => {
  const hostsOf = async (over) => new Map(await overviewOf({ ...snapshot(), ...over })).get("p-hosts");
  const queue = { pausedState: false, pausedPartial: false, counts: { waiting: 4 }, queues: 1 };
  const host = (name, staleMs) => ({ name, concurrency: "2", jobs: [], staleMs });
  // The repro: a worker 50 s behind with a 15 s beat reads 61 s stale for part of every minute; BullMQ, clock-free, sees it.
  const skew = workersOnline({ queue: { workers: 1 }, hostBudgets: [{ staleMs: 61_000 }] });
  assert.deepEqual(skew, { count: 1, online: 0, connected: 1, staleBeats: true, none: false });
  const page = await hostsOf({ queue: { ...queue, workers: 1 }, hostBudgets: [host("h1", 61_000)] });
  assert.ok(!page.includes(NO_WORKER_TEXT), page);
  assert.ok(page.includes(STALE_BEATS_TEXT), "the softer note, not the warning");
  const fleet = new Map((await pagePanels("fleet", ctxOf("viewer", { snapshot: { ...snapshot(), queue: { ...queue, workers: 1 }, hostBudgets: [host("h1", 61_000)] } }))).map((p) => [p.id, p.html])).get("p-queues");
  assert.match(fleet, /<dt>Fleet<\/dt><dd><span class="good">running<\/span>/, "the fleet page agrees");
  // A fresh registry with BullMQ blind (no CLIENT SETNAME): online, no note, no warning.
  const blind = await hostsOf({ queue: { ...queue, workers: "unknown" }, hostBudgets: [host("h1", 1000)] });
  assert.ok(!blind.includes(NO_WORKER_TEXT) && !blind.includes(STALE_BEATS_TEXT));
  assert.deepEqual(workersOnline({ queue: { workers: "unknown" }, hostBudgets: [host("h1", 1000)] }), { count: 1, online: 1, connected: 0, staleBeats: false, none: false });
  // Both say nobody: the warning.
  const both = await hostsOf({ queue: { ...queue, workers: "unknown" }, hostBudgets: [host("h1", 61_000)] });
  assert.ok(both.includes(NO_WORKER_TEXT));
  // One fresh beat of two, BullMQ seeing the one: a host is down, not a clock; no note.
  const one = await hostsOf({ queue: { ...queue, workers: 1 }, hostBudgets: [host("h1", 1000), host("h2", 5 * 60_000)] });
  assert.ok(!one.includes(STALE_BEATS_TEXT) && !one.includes(NO_WORKER_TEXT));
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
  const panels = new Map(await overviewOf(snap));
  // Spend today: the day window's spent and held, rounded down, the exact amount on hover; the cap beside it.
  assert.match(panels.get("p-spend"), /<b><data value="1234567" title="\$1\.234567">\$1\.23<\/data><\/b><span>of <span title="\$50\.00">\$50\.00<\/span><\/span>/);
  // Caps: jobs started against their caps, a capsule per window with a cap; the windows are UTC, and say so.
  const caps = panels.get("p-caps");
  assert.match(caps, /title="Jobs today: 30%"/, "3 started of 10");
  assert.ok(!caps.includes("Jobs week"), "no cap, no capsule");
  assert.match(caps, /title="Deploy \$ month: 99%"/, "a window short of its cap never reads as the cap");
  assert.ok(caps.includes(COUNT_WINDOWS_UTC_TEXT), "the windows are UTC, and say so");
  assert.match(COUNT_WINDOWS_UTC_TEXT, /UTC/);
  // The runs list's Job cap column.
  const runs = [{ jobId: "gh-1", kind: "github", target: "acme/web#1", outcome: "completed", endedAt: "2026-10-08T15:00:00Z", dollars: { reservedMicros: 2_500_001 } }];
  const list = (await pagePanels("runs", ctxOf("viewer", { runsPage: { runs, next: null, mirror: "ok" } }, parsePageQuery("runs", "").query))).map((p) => p.html).join("");
  assert.match(list, /<td class="num hide-phone" data-l="Job cap"><span title="\$2\.500001">\$2\.50<\/span><\/td><\/tr>/);
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
  const run = (await pagePanels("run", ctxOf("operator", { run: { record, source: "local" } }, parsePageQuery("run", "id=gh-1").query))).map((p) => p.html).join("");
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
  const timeEl = (iso, text, more = {}) => {
    const attrs = { datetime: iso, ...more };
    return { textContent: text, getAttribute: (n) => attrs[n] ?? null, setAttribute: (n, v) => { attrs[n] = v; }, attrs };
  };
  const els = times.map(([iso, text, more]) => timeEl(iso, text, more));
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

test("only a time whose row names its day (data-day) stays alone, on the reader's day when it is the UTC day, gaining the reader's date when it is not; every other time carries the reader's date", () => {
  const alone = [["2026-10-08T15:39:08.000Z", "15:39 UTC", { "data-day": "" }], ["2026-10-08T23:30:00.000Z", "23:30 UTC", { "data-day": "" }], ["2026-10-08T00:30:00.000Z", "00:30 UTC", { "data-day": "" }]];
  const said = (offsetMin) => timeDom(alone, offsetMin).els.map((e) => [e.textContent, e.attrs.title]);
  assert.deepEqual(said(0), [["15:39 UTC", "2026-10-08 15:39 UTC"], ["23:30 UTC", "2026-10-08 23:30 UTC"], ["00:30 UTC", "2026-10-08 00:30 UTC"]], "a reader in UTC reads what the server wrote");
  assert.deepEqual(said(120), [["17:39 UTC+2", "2026-10-08 15:39 UTC"], ["2026-10-09 01:30 UTC+2", "2026-10-08 23:30 UTC"], ["02:30 UTC+2", "2026-10-08 00:30 UTC"]], "past the reader's midnight, the reader's date");
  assert.deepEqual(said(-300).map(([t]) => t), ["10:39 UTC-5", "18:30 UTC-5", "2026-10-07 19:30 UTC-5"], "before it too");
  // A second run over its own text keeps the first's form (the live swap and the slot run it again over what it wrote).
  for (const offsetMin of [120, -300]) {
    const first = timeDom(alone, offsetMin).els.map((e) => e.textContent);
    assert.deepEqual(timeDom(alone.map(([iso, , more], i) => [iso, first[i], more]), offsetMin).els.map((e) => e.textContent), first, `${offsetMin}: twice is once`);
  }
  // A time drawn with its date keeps it, on the reader's day or not.
  assert.deepEqual(timeDom([["2026-10-08T15:39:08.000Z", "2026-10-08 15:39 UTC"]], 120).els[0].textContent, "2026-10-08 17:39 UTC+2");
  // A time drawn alone that no row dates (a page's "Drawn at", a transcript entry's "HH:MM:SS UTC") carries the
  // reader's date on the reader's day too, in a reader's zone and in UTC, and after a second run.
  const undated = [["2026-10-08T15:39:08.000Z", "15:39 UTC"], ["2026-10-08T15:39:08.000Z", "15:39:08 UTC"], ["2026-10-08T23:30:00.000Z", "23:30 UTC"]];
  for (const [offsetMin, want] of [[0, ["2026-10-08 15:39 UTC", "2026-10-08 15:39 UTC", "2026-10-08 23:30 UTC"]], [120, ["2026-10-08 17:39 UTC+2", "2026-10-08 17:39 UTC+2", "2026-10-09 01:30 UTC+2"]], [-300, ["2026-10-08 10:39 UTC-5", "2026-10-08 10:39 UTC-5", "2026-10-08 18:30 UTC-5"]]]) {
    const first = timeDom(undated, offsetMin).els.map((e) => e.textContent);
    assert.deepEqual(first, want, `${offsetMin}: dated`);
    assert.deepEqual(timeDom(undated.map(([iso], i) => [iso, first[i]]), offsetMin).els.map((e) => e.textContent), first, `${offsetMin}: twice is once`);
  }
});

test("#739 run panels: running without stream, expired parked stream, cancelled before start and completed saved session", async () => {
  const at = NOW;
  const base = { jobId: "gh-739", kind: "github", target: "acme/web#739", outcome: "completed", startedAt: new Date(at - 60_000).toISOString(), endedAt: new Date(at).toISOString() };
  const cases = [
    { name: "running with no stream", data: { run: { missing: true }, chat: { state: "active", mode: "live", jobState: "active" }, transcript: { exists: false } }, expected: /Waiting for the run/, absent: /Reload to check again/ },
    { name: "parked with expired stream", data: { run: { record: { ...base, reason: "awaiting-input" } }, chat: { state: "parked", mode: "reply" }, transcript: { exists: false } }, expected: /Read the question on the forge thread/, absent: /question[^<]*below/ },
    { name: "cancelled before start", data: { run: { record: { ...base, outcome: "policy", reason: "operator-cancel", budgetReserved: false, tokens: null, dollars: null, exitCode: null } } }, expected: /Nothing ran/, absent: /data-action="parked-answer"/ },
    { name: "completed with saved session", data: { run: { record: { ...base, session: { resumed: false, reason: "absent", bytes: 4096 } } }, chat: { state: "finished", mode: "fork" } }, expected: /<span>pi-dispatch<\/span> <span>chat<\/span> <span>gh-739<\/span>/, absent: /no transcript to fork/ },
  ];
  for (const c of cases) {
    const panels = await pagePanels("run", { session: { role: "operator" }, query: { id: "gh-739" }, data: { now: at, ...c.data } });
    const text = panels.map((p) => p.html).join("");
    assert.match(text, c.expected, c.name);
    assert.doesNotMatch(text, c.absent, c.name);
  }
});

test("configuration shows the reviewed fallback list in order and escapes its text (#716)", async () => {
  const s = { ...snapshot(), triggers: { triggers: [{ type: "label", any: ["pi"], flow: "fix", fallbackModels: ["anthropic/first", "openai/second<"] }] } };
  const out = (await pagePanels("config", ctxOf("viewer", { snapshot: s }))).map((p) => p.html).join("");
  assert.match(out, /fallbacks anthropic\/first, openai\/second&lt;/);
});

test("the run summary shows selected model and closed provider failure facts (#716)", async () => {
  const { runSummary } = await import("../src/console/panels/run.mjs");
  const record = { jobId: "gh-model", kind: "github", target: "a/b#1", outcome: "failed", reason: "error", provider: "openai", model: "fallback", modelWhy: "fallback-cooldown", providerFailure: { kind: "quota-exhausted", resetAt: NOW + 60_000, message: "PRIVATE-ERROR-TEXT" } };
  const view = { role: "viewer", now: NOW, data: { run: { record } }, env: {} };
  const out = String(runSummary(view));
  for (const fact of ["openai / fallback", "Model choice", "fallback-cooldown", "Provider failure", "quota-exhausted", "Provider reset"]) assert.ok(out.includes(fact), fact);
  assert.equal(out.includes("PRIVATE-ERROR-TEXT"), false);
  record.modelWhy = "PRIVATE-ERROR-TEXT";
  record.providerFailure = { kind: "PRIVATE-ERROR-TEXT" };
  const bad = String(runSummary(view));
  assert.equal(bad.includes("PRIVATE-ERROR-TEXT"), false);
  assert.equal(bad.includes("Model choice"), false);
  assert.equal(bad.includes("Provider failure"), false);
});
