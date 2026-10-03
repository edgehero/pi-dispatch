import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePauseWindows, loadPauseWindows, parseScopeString, pauseUntilMs, qualifiedScopeOf, scopeOf, unqualifiedScope } from "../src/pause-windows.mjs";
import { FORGE_KINDS } from "../src/forges.mjs";

const wrap = (windows) => JSON.stringify({ windows });
const parse = (windows) => parsePauseWindows(wrap(windows), "pw.json");
const ghJob = (repo) => ({ kind: "github", repo });
const localJob = (folder) => ({ kind: "local", folder });
const UTC = (y, mo, d, h, mi = 0) => Date.UTC(y, mo - 1, d, h, mi);

// ── validator ───────────────────────────────────────────────────────────────────────────────────────────

test("parsePauseWindows normalizes a full window and precomputes minutes", () => {
	const [w] = parse([{ scope: "acme/web", from: "22:00", to: "06:00", tz: "Europe/Amsterdam", days: ["Mon", "fri"], dateFrom: "2026-08-01", dateTo: "2026-08-31" }]);
	assert.equal(w.scope, "acme/web");
	assert.equal(w.fromMin, 22 * 60);
	assert.equal(w.toMin, 6 * 60);
	assert.equal(w.tz, "Europe/Amsterdam");
	assert.deepEqual(w.days, ["mon", "fri"]);
	assert.equal(w.dateFrom, "2026-08-01");
	assert.equal(w.dateTo, "2026-08-31");
});

test("parsePauseWindows defaults tz to UTC and drops optional fields when absent", () => {
	const [w] = parse([{ scope: "/srv/site", from: "09:00", to: "17:00" }]);
	assert.equal(w.tz, "UTC");
	assert.ok(!("days" in w) && !("dateFrom" in w) && !("dateTo" in w));
});

test("parsePauseWindows rejects malformed files fail-loud", () => {
	assert.throws(() => parsePauseWindows("{ not json", "pw.json"), /not valid JSON/);
	assert.throws(() => parsePauseWindows(JSON.stringify({}), "pw.json"), /must have a "windows" array/);
	assert.throws(() => parse(["nope"]), /must be an object/);
	assert.throws(() => parse([{ from: "09:00", to: "17:00" }]), /scope must be a non-empty string/);
	assert.throws(() => parse([{ scope: "x", from: "25:00", to: "06:00" }]), /from out of range/);
	assert.throws(() => parse([{ scope: "x", from: "9", to: "06:00" }]), /from must be "HH:MM"/);
	assert.throws(() => parse([{ scope: "x", from: "09:00", to: "09:00" }]), /from and to must differ/);
	assert.throws(() => parse([{ scope: "x", from: "09:00", to: "17:00", tz: "Mars/Phobos" }]), /not a valid IANA timezone/);
	assert.throws(() => parse([{ scope: "x", from: "09:00", to: "17:00", days: ["funday"] }]), /unknown weekday/);
	assert.throws(() => parse([{ scope: "x", from: "09:00", to: "17:00", days: [] }]), /non-empty array/);
	assert.throws(() => parse([{ scope: "x", from: "09:00", to: "17:00", dateFrom: "2026-13-01" }]), /dateFrom must be "YYYY-MM-DD"/);
	assert.throws(() => parse([{ scope: "x", from: "09:00", to: "17:00", dateFrom: "2026-08-31", dateTo: "2026-08-01" }]), /dateFrom must be <= dateTo/);
});

// ── loader ──────────────────────────────────────────────────────────────────────────────────────────────

test("loadPauseWindows returns [] when the file is unset (feature disabled)", () => {
	assert.deepEqual(loadPauseWindows({ pauseWindowsFile: null }), []);
});

test("loadPauseWindows throws when the configured file is missing, else parses it", () => {
	const cfg = { pauseWindowsFile: "/x/pw.json" };
	assert.throws(() => loadPauseWindows(cfg, { existsSync: () => false, readFileSync: () => "" }), /does not exist/);
	const windows = loadPauseWindows(cfg, { existsSync: () => true, readFileSync: () => wrap([{ scope: "a", from: "22:00", to: "06:00" }]) });
	assert.equal(windows.length, 1);
	assert.equal(windows[0].scope, "a");
});

// ── predicate: same-day window (UTC) ────────────────────────────────────────────────────────────────────

test("same-day UTC window: inside returns today's end, boundaries and outside return null", () => {
	const w = parse([{ scope: "acme/web", from: "09:00", to: "17:00" }]);
	assert.equal(pauseUntilMs(w, ghJob("acme/web"), UTC(2026, 7, 23, 12)), UTC(2026, 7, 23, 17), "inside -> ends 17:00 today");
	assert.equal(pauseUntilMs(w, ghJob("acme/web"), UTC(2026, 7, 23, 8, 59)), null, "before from");
	assert.equal(pauseUntilMs(w, ghJob("acme/web"), UTC(2026, 7, 23, 17)), null, "at to is already resumed (exclusive)");
});

// ── predicate: overnight window (UTC) ───────────────────────────────────────────────────────────────────

test("overnight UTC window: covers the evening and the following early morning to the same end", () => {
	const w = parse([{ scope: "acme/web", from: "22:00", to: "06:00" }]);
	assert.equal(pauseUntilMs(w, ghJob("acme/web"), UTC(2026, 7, 23, 23)), UTC(2026, 7, 24, 6), "23:00 -> ends 06:00 next day");
	assert.equal(pauseUntilMs(w, ghJob("acme/web"), UTC(2026, 7, 24, 3)), UTC(2026, 7, 24, 6), "03:00 (started prev night) -> ends 06:00 today");
	assert.equal(pauseUntilMs(w, ghJob("acme/web"), UTC(2026, 7, 24, 6)), null, "06:00 exclusive -> resumed");
	assert.equal(pauseUntilMs(w, ghJob("acme/web"), UTC(2026, 7, 24, 12)), null, "midday -> not paused");
});

// ── predicate: weekday + date gating ────────────────────────────────────────────────────────────────────

test("days gate the window's START day (2026-07-24 is a Friday)", () => {
	const w = parse([{ scope: "acme/web", from: "22:00", to: "06:00", days: ["fri"] }]);
	assert.equal(pauseUntilMs(w, ghJob("acme/web"), UTC(2026, 7, 24, 23)), UTC(2026, 7, 25, 6), "Fri night -> paused into Sat morning");
	assert.equal(pauseUntilMs(w, ghJob("acme/web"), UTC(2026, 7, 25, 3)), UTC(2026, 7, 25, 6), "Sat early morning still covered (started Fri)");
	assert.equal(pauseUntilMs(w, ghJob("acme/web"), UTC(2026, 7, 25, 23)), null, "Sat night not a Friday start -> not paused");
});

test("dateFrom/dateTo bound which days the window applies", () => {
	const w = parse([{ scope: "acme/web", from: "09:00", to: "17:00", dateFrom: "2026-08-01", dateTo: "2026-08-31" }]);
	assert.equal(pauseUntilMs(w, ghJob("acme/web"), UTC(2026, 8, 15, 12)), UTC(2026, 8, 15, 17), "in range -> paused");
	assert.equal(pauseUntilMs(w, ghJob("acme/web"), UTC(2026, 7, 31, 12)), null, "before range");
	assert.equal(pauseUntilMs(w, ghJob("acme/web"), UTC(2026, 9, 1, 12)), null, "after range");
});

// ── predicate: scope matching ───────────────────────────────────────────────────────────────────────────

test("scope matches repo (github) or folder (local), and * matches all", () => {
	assert.equal(scopeOf(ghJob("acme/web")), "acme/web");
	assert.equal(scopeOf(localJob("/srv/site")), "/srv/site");
	const repoW = parse([{ scope: "acme/web", from: "00:00", to: "23:59" }]);
	assert.ok(pauseUntilMs(repoW, ghJob("acme/web"), UTC(2026, 7, 23, 12)) !== null, "repo scope matches its github job");
	assert.equal(pauseUntilMs(repoW, localJob("/srv/site"), UTC(2026, 7, 23, 12)), null, "repo scope does not match a local job");
	const anyW = parse([{ scope: "*", from: "00:00", to: "23:59" }]);
	assert.ok(pauseUntilMs(anyW, ghJob("acme/web"), UTC(2026, 7, 23, 12)) !== null, "* matches github");
	assert.ok(pauseUntilMs(anyW, localJob("/srv/site"), UTC(2026, 7, 23, 12)) !== null, "* matches local");
	assert.equal(pauseUntilMs(anyW, { kind: "local" }, UTC(2026, 7, 23, 12)), null, "a job with no scope is never paused");
});

// ── predicate: non-UTC timezone (DST-correct via Intl) ──────────────────────────────────────────────────

test("a non-UTC window resolves its end in that zone's wall clock", () => {
	// 2026-07-23 23:00 America/New_York (EDT, UTC-4) == 2026-07-24 03:00 UTC. Window 22:00-06:00 EDT ends at
	// 2026-07-24 06:00 EDT == 2026-07-24 10:00 UTC.
	const w = parse([{ scope: "acme/web", from: "22:00", to: "06:00", tz: "America/New_York" }]);
	assert.equal(pauseUntilMs(w, ghJob("acme/web"), UTC(2026, 7, 24, 3)), UTC(2026, 7, 24, 10), "ends 06:00 New York == 10:00 UTC");
	assert.equal(pauseUntilMs(w, ghJob("acme/web"), UTC(2026, 7, 24, 12)), null, "08:00 EDT is past the window");
});

test("the latest end wins when two windows overlap; empty windows -> null", () => {
	const w = parse([
		{ scope: "acme/web", from: "22:00", to: "02:00" },
		{ scope: "acme/web", from: "22:00", to: "06:00" },
	]);
	assert.equal(pauseUntilMs(w, ghJob("acme/web"), UTC(2026, 7, 23, 23)), UTC(2026, 7, 24, 6), "held until the later end");
	assert.equal(pauseUntilMs([], ghJob("acme/web"), UTC(2026, 7, 23, 23)), null);
});

// ── forge-qualified scopes (issue #498) ─────────────────────────────────────────────────────────────────

test("qualifiedScopeOf is <kind>:<repo> for every forge kind (derived from FORGE_KINDS), the folder for a local job", () => {
	for (const kind of FORGE_KINDS) assert.equal(qualifiedScopeOf({ kind, repo: "acme/web" }), `${kind}:acme/web`);
	assert.equal(qualifiedScopeOf(localJob("/srv/site/")), "/srv/site/", "a local job's folder, unchanged");
	assert.equal(qualifiedScopeOf({ repo: "acme/web" }), null, "a forge job without kind");
	assert.equal(qualifiedScopeOf({ kind: "github" }), null, "a forge job without repo");
	assert.equal(qualifiedScopeOf(undefined), null);
	// NFC, like canonicalScope: an NFD repo name and an NFC one are one scope.
	assert.equal(qualifiedScopeOf({ kind: "github", repo: "acme/we\u0301b" }), "github:acme/w\u00e9b");
});

test("parseScopeString classifies local, qualified and bare, and refuses an unknown prefix naming the known kinds", () => {
	assert.deepEqual(parseScopeString("/srv/site"), { type: "local", kind: null, repo: null });
	assert.deepEqual(parseScopeString("C:\\srv"), { type: "local", kind: null, repo: null }, "a drive letter keeps today's handling");
	assert.deepEqual(parseScopeString("acme/web"), { type: "bare", kind: null, repo: null });
	assert.deepEqual(parseScopeString("acme/we:b"), { type: "bare", kind: null, repo: null }, "a colon after a slash is no prefix");
	for (const kind of FORGE_KINDS) assert.deepEqual(parseScopeString(`${kind}:acme/web`), { type: "qualified", kind, repo: "acme/web" });
	// The split is at the FIRST colon. No forge allows ":" in a repo or project path (GitHub, GitLab and Forgejo names are
	// [A-Za-z0-9._-] segments; Azure DevOps refuses ":" in project and repository names), so this never cuts a real repo.
	assert.deepEqual(parseScopeString("azure:proj/repo"), { type: "qualified", kind: "azure", repo: "proj/repo" });
	assert.throws(() => parseScopeString("gitub:acme/web"), (e) => e.piDispatchConfig === true && /unknown prefix "gitub:"/.test(e.message) && FORGE_KINDS.every((k) => e.message.includes(k)));
	assert.throws(() => parseScopeString("local:site"), /unknown prefix "local:"/);
	assert.throws(() => parseScopeString("forgejo: "), /names a forge and no repo/);
	assert.equal(unqualifiedScope("github:acme/web"), "acme/web");
	assert.equal(unqualifiedScope("acme/web"), "acme/web");
	assert.equal(unqualifiedScope("/srv/site"), "/srv/site");
});

test("parsePauseWindows accepts a qualified scope and refuses a near miss, naming the window", () => {
	const [w] = parse([{ scope: " github:acme/web ", from: "09:00", to: "17:00" }]);
	assert.equal(w.scope, "github:acme/web");
	assert.throws(() => parse([{ scope: "*", from: "09:00", to: "17:00" }, { scope: "gitub:acme/web", from: "09:00", to: "17:00" }]), (e) => /pause window at index 1/.test(e.message) && /unknown prefix/.test(e.message) && /pw\.json/.test(e.message));
	assert.equal(parse([{ scope: "*", from: "09:00", to: "17:00" }])[0].scope, "*", "* stays legal");
});

test("a qualified window pauses only its forge's job; a bare window pauses every forge's, as before", () => {
	const now = UTC(2026, 7, 23, 12);
	const fjJob = (repo) => ({ kind: "forgejo", repo });
	const qualified = parse([{ scope: "github:acme/web", from: "09:00", to: "17:00" }]);
	assert.equal(pauseUntilMs(qualified, ghJob("acme/web"), now), UTC(2026, 7, 23, 17));
	assert.equal(pauseUntilMs(qualified, fjJob("acme/web"), now), null, "the Forgejo job is not paused");
	const bare = parse([{ scope: "acme/web", from: "09:00", to: "17:00" }]);
	assert.equal(pauseUntilMs(bare, ghJob("acme/web"), now), UTC(2026, 7, 23, 17));
	assert.equal(pauseUntilMs(bare, fjJob("acme/web"), now), UTC(2026, 7, 23, 17));
	// scopeOf is unchanged: still the bare repo.
	assert.equal(scopeOf(fjJob("acme/web")), "acme/web");
});
