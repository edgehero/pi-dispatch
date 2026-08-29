import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import {
	SCOPED_LIMITS_VERSION,
	parseScopedLimits,
	loadScopedLimits,
	canonicalScope,
	limitFor,
	budgetCapsFor,
	concurrencyFor,
	scopeKeyPrefix,
	makeInFlight,
} from "../src/scoped-limits.mjs";

const wrap = (limits, version = 1) => JSON.stringify({ version, limits });
const parse = (limits) => parseScopedLimits(wrap(limits), "sl.json");
const localJob = (folder) => ({ kind: "local", folder });
const ghJob = (repo) => ({ kind: "github", repo });

// ── validator ───────────────────────────────────────────────────────────────────────────────────────────

test("parseScopedLimits normalizes a full row and nulls absent fields", () => {
	const [row] = parse([{ scope: "acme/web", day: 10, week: 40, month: 100, concurrent: 2 }]);
	assert.deepEqual(row, { scope: "acme/web", day: 10, week: 40, month: 100, concurrent: 2 });
	const [partial] = parse([{ scope: "acme/web", week: 40 }]);
	assert.deepEqual(partial, { scope: "acme/web", day: null, week: 40, month: null, concurrent: null });
});

test("parseScopedLimits drops unknown fields (operator-file policy)", () => {
	const [row] = parse([{ scope: "acme/web", day: 1, softHoldPct: 80, note: "x" }]);
	assert.deepEqual(Object.keys(row).sort(), ["concurrent", "day", "month", "scope", "week"]);
});

test("parseScopedLimits round-trips its own output (null is absent, the subscriptions rule)", () => {
	// The admin's read-modify-write goes through this parser on both edges, so the normalizer's own
	// nulls must parse back clean or every partial edit refuses its own current state.
	const first = parse([{ scope: "acme/web", week: 40 }, { scope: "/srv/site", concurrent: 1 }]);
	const again = parseScopedLimits(JSON.stringify({ version: 1, limits: first }), "sl.json");
	assert.deepEqual(again, first);
	// An explicit null in a hand-written file counts as absent, so an all-null row still refuses.
	assert.throws(() => parse([{ scope: "acme/web", day: null }]), /at least one of day, week, month, concurrent/);
});

test("parseScopedLimits rejects malformed files fail-loud", () => {
	assert.throws(() => parseScopedLimits("{ not json", "sl.json"), /not valid JSON/);
	assert.throws(() => parseScopedLimits(JSON.stringify([]), "sl.json"), /must be an object with "version" and "limits"/);
	assert.throws(() => parseScopedLimits(JSON.stringify({ limits: [] }), "sl.json"), /must have "version": 1 \(an integer >= 1\)/);
	assert.throws(() => parseScopedLimits(JSON.stringify({ version: 0, limits: [] }), "sl.json"), /must have "version": 1/);
	assert.throws(() => parseScopedLimits(JSON.stringify({ version: "1", limits: [] }), "sl.json"), /must have "version": 1/);
	assert.throws(() => parseScopedLimits(JSON.stringify({ version: 1 }), "sl.json"), /must have a "limits" array/);
	assert.throws(() => parse(["nope"]), /must be an object/);
	assert.throws(() => parse([null]), /must be an object/);
	assert.throws(() => parse([{ day: 1 }]), /scope must be a non-empty string/);
	assert.throws(() => parse([{ scope: "  ", day: 1 }]), /scope must be a non-empty string/);
	assert.throws(() => parse([{ scope: "acme/web", day: 0 }]), /day must be an integer >= 1/);
	assert.throws(() => parse([{ scope: "acme/web", week: -1 }]), /week must be an integer >= 1/);
	assert.throws(() => parse([{ scope: "acme/web", month: 1.5 }]), /month must be an integer >= 1/);
	assert.throws(() => parse([{ scope: "acme/web", concurrent: "2" }]), /concurrent must be an integer >= 1/);
	// 2^53 passes Number.isInteger but cannot count; a bound indistinguishable from unlimited is refused.
	assert.throws(() => parse([{ scope: "acme/web", day: 2 ** 53 }]), /day must be an integer >= 1/);
	assert.equal(parse([{ scope: "acme/web", day: 1e3 }])[0].day, 1000);
	assert.throws(() => parse([{ scope: "acme/web" }]), /at least one of day, week, month, concurrent is required/);
});

test("parseScopedLimits refuses a newer version loudly, naming both", () => {
	assert.throws(
		() => parseScopedLimits(wrap([], 2), "sl.json"),
		/written by a newer pi-dispatch \(version 2; this build understands 1\)/,
	);
	assert.equal(SCOPED_LIMITS_VERSION, 1);
});

test('parseScopedLimits refuses "*" with the per-scope-default reversal note', () => {
	assert.throws(() => parse([{ scope: "*", day: 1 }]), /"\*" is not supported -- add one row per scope/);
	assert.throws(() => parse([{ scope: "  *  ", day: 1 }]), /"\*" is not supported/);
});

test("parseScopedLimits refuses any scope containing * (an exact matcher makes globs silently inert)", () => {
	assert.throws(() => parse([{ scope: "acme/*", day: 1 }]), /scopes match exactly; a scope containing "\*" is refused/);
	assert.throws(() => parse([{ scope: "*/web", day: 1 }]), /scopes match exactly/);
	assert.throws(() => parse([{ scope: "/srv/*", day: 1 }]), /scopes match exactly/);
});

test("parseScopedLimits trims a padded row scope and drops unknown TOP-LEVEL keys", () => {
	const rows = parseScopedLimits(JSON.stringify({ version: 1, limits: [{ scope: "  acme/web  ", day: 1 }], future: true }), "sl.json");
	assert.equal(rows[0].scope, "acme/web");
	assert.equal(rows.length, 1);
});

test("parseScopedLimits refuses duplicate scopes, including across path spellings", () => {
	assert.throws(() => parse([{ scope: "acme/web", day: 1 }, { scope: "acme/web", week: 2 }]), /duplicate scope "acme\/web" \(first at index 0\)/);
	// Both spellings resolve to /srv/site, so the duplicate check must see one scope, not two.
	assert.throws(() => parse([{ scope: "/srv/site", day: 1 }, { scope: "/srv/site/", week: 2 }]), /duplicate scope "\/srv\/site"/);
});

test("parseScopedLimits stores absolute row scopes resolved; relative rows stay as written", () => {
	const rows = parse([
		{ scope: "/srv/site/", day: 1 },
		{ scope: "/srv/x/../other", day: 1 },
		{ scope: "./site", day: 1 },
	]);
	assert.equal(rows[0].scope, "/srv/site");
	assert.equal(rows[1].scope, "/srv/other");
	// A relative row is inert config (the job side always resolves); kept as written. The doctor
	// advisory that flags it lands later in this issue -- until then the contract says: absolute paths.
	assert.equal(rows[2].scope, "./site");
});

test("Unicode scopes NFC-normalize on both sides, so NFD and NFC spellings share one row and one key", () => {
	const nfc = "acme/wéb"; // é as one codepoint
	const nfd = "acme/wéb"; // e + combining acute
	assert.notEqual(nfc, nfd); // distinct strings, one name
	const limits = parse([{ scope: nfd, concurrent: 1 }]);
	assert.equal(limits[0].scope, nfc);
	assert.equal(canonicalScope(ghJob(nfd)), canonicalScope(ghJob(nfc)));
	assert.equal(concurrencyFor(ghJob(nfd), limits), 1);
	assert.equal(canonicalScope(localJob(`/srv/${nfd}`)), canonicalScope(localJob(`/srv/${nfc}`)));
	assert.equal(scopeKeyPrefix(canonicalScope(ghJob(nfd))), scopeKeyPrefix(canonicalScope(ghJob(nfc))));
});

// ── loader ──────────────────────────────────────────────────────────────────────────────────────────────

test("loadScopedLimits returns [] when the file is unset (no scoped limits; the mutex holds regardless)", () => {
	assert.deepEqual(loadScopedLimits({ scopedLimitsFile: null }), []);
	assert.deepEqual(loadScopedLimits({}), []);
});

test("the committed scoped-limits.example.json parses through the real loader (subscriptions' pin)", () => {
	const limits = loadScopedLimits({ scopedLimitsFile: new URL("../../scoped-limits.example.json", import.meta.url).pathname });
	assert.equal(limits.length, 2);
	assert.equal(limits[0].scope, "acme/web");
	assert.equal(limits[1].scope, "/srv/site");
});

test("loadScopedLimits throws when the configured file is missing, else parses it", () => {
	const cfg = { scopedLimitsFile: "/x/sl.json" };
	assert.throws(() => loadScopedLimits(cfg, { existsSync: () => false, readFileSync: () => "" }), /does not exist/);
	const limits = loadScopedLimits(cfg, { existsSync: () => true, readFileSync: () => wrap([{ scope: "acme/web", day: 3 }]) });
	assert.equal(limits.length, 1);
	assert.equal(limits[0].day, 3);
});

// ── canonicalScope ──────────────────────────────────────────────────────────────────────────────────────

test("canonicalScope collapses every spelling of one directory onto one key", () => {
	const variants = ["/srv/site", "/srv/site/", "/srv//site", "/srv/x/../site", "  /srv/site  ", "/srv/site/.", "/srv/site//"];
	const keys = new Set(variants.map((folder) => canonicalScope(localJob(folder))));
	assert.deepEqual([...keys], ["/srv/site"]);
});

test("canonicalScope resolves a relative folder against the cwd (stated, not accidental)", () => {
	assert.equal(canonicalScope(localJob("site")), resolve("site"));
});

test("canonicalScope passes a forge repo through untouched, so folder a/b and repo a/b cannot collide", () => {
	assert.equal(canonicalScope(ghJob("acme/web")), "acme/web");
	assert.equal(canonicalScope(ghJob("a/b")), "a/b");
	assert.notEqual(canonicalScope(localJob("a/b")), "a/b"); // resolved to an absolute path
});

test("canonicalScope returns null when the job has no scope", () => {
	assert.equal(canonicalScope({ kind: "local" }), null);
	assert.equal(canonicalScope({ kind: "github" }), null);
	assert.equal(canonicalScope(undefined), null);
});

// ── limitFor / budgetCapsFor / concurrencyFor ───────────────────────────────────────────────────────────

test("limitFor is exact-match only", () => {
	const limits = parse([{ scope: "acme/web", day: 10 }]);
	assert.equal(limitFor(limits, "acme/web").day, 10);
	assert.equal(limitFor(limits, "acme/other"), null);
	assert.equal(limitFor(limits, "acme"), null);
	assert.equal(limitFor([], "acme/web"), null);
	assert.equal(limitFor(limits, null), null);
});

test("budgetCapsFor returns null for a concurrency-only row and for an unmatched scope", () => {
	const limits = parse([{ scope: "acme/web", concurrent: 2 }]);
	assert.equal(budgetCapsFor(ghJob("acme/web"), limits), null);
	assert.equal(budgetCapsFor(ghJob("acme/other"), parse([{ scope: "acme/web", day: 1 }])), null);
});

test("budgetCapsFor shapes the caps like the global object, canonical scope included", () => {
	const limits = parse([{ scope: "/srv/site", week: 40 }]);
	const scoped = budgetCapsFor(localJob("/srv/site/"), limits);
	assert.deepEqual(scoped, { scope: "/srv/site", caps: { day: null, week: 40, month: null } });
});

test("budgetCapsFor never leaks concurrent into the money caps (a mixed row keeps them apart)", () => {
	const limits = parse([{ scope: "acme/web", week: 40, concurrent: 2 }]);
	const scoped = budgetCapsFor(ghJob("acme/web"), limits);
	assert.deepEqual(scoped, { scope: "acme/web", caps: { day: null, week: 40, month: null } });
});

test("canonicalScope leaves a forge scope's padding alone (passthrough means passthrough)", () => {
	assert.equal(canonicalScope(ghJob(" acme/web ")), " acme/web ");
});

test("concurrencyFor: the folder mutex is the structural 1 and config cannot raise it", () => {
	assert.equal(concurrencyFor(localJob("/srv/site"), []), 1);
	assert.equal(concurrencyFor(localJob("/srv/site"), parse([{ scope: "/srv/site", concurrent: 5 }])), 1);
	assert.equal(concurrencyFor(ghJob("acme/web"), []), Infinity);
	assert.equal(concurrencyFor(ghJob("acme/web"), parse([{ scope: "acme/web", concurrent: 2 }])), 2);
	assert.equal(concurrencyFor({ kind: "github" }, []), Infinity); // scopeless: no gate
});

// ── scopeKeyPrefix ──────────────────────────────────────────────────────────────────────────────────────

test("scopeKeyPrefix is budget:s: plus 16 hex, pinned literally so the key shape cannot drift", () => {
	// Literal vectors, never derived in the test: a changed hash or slice silently remaps every
	// deployment's scoped counters to fresh keys (a cap reset nobody asked for).
	assert.equal(scopeKeyPrefix("acme/web"), "budget:s:86f279ce9c29f106");
	assert.equal(scopeKeyPrefix("/srv/site"), "budget:s:3cd3201de5fe686c");
	assert.match(scopeKeyPrefix("anything at all"), /^budget:s:[0-9a-f]{16}$/);
});

test("scopeKeyPrefix keeps colon/slash rearrangements distinct (the reason it hashes)", () => {
	assert.equal(scopeKeyPrefix("a:b/c"), "budget:s:fb7456513927a447");
	assert.equal(scopeKeyPrefix("a/b:c"), "budget:s:3b07f80ca173745a");
	assert.notEqual(scopeKeyPrefix("a:b/c"), scopeKeyPrefix("a/b:c"));
	assert.notEqual(scopeKeyPrefix("a b/c"), scopeKeyPrefix("a/b c"));
});

// ── makeInFlight ────────────────────────────────────────────────────────────────────────────────────────

test("makeInFlight admits under the limit and refuses at it, without counting the refusal", () => {
	const m = makeInFlight();
	assert.equal(m.tryAcquire("s", 2), true);
	assert.equal(m.tryAcquire("s", 2), true);
	assert.equal(m.tryAcquire("s", 2), false);
	assert.equal(m.count("s"), 2); // the refused attempt did not increment
	m.release("s");
	assert.equal(m.tryAcquire("s", 2), true);
});

test("makeInFlight releases exactly ONE slot per release (a delete-all regression over-admits)", () => {
	const m = makeInFlight();
	assert.equal(m.tryAcquire("s", 3), true);
	assert.equal(m.tryAcquire("s", 3), true);
	assert.equal(m.tryAcquire("s", 3), true);
	m.release("s");
	assert.equal(m.count("s"), 2); // one release frees one slot, never the whole scope
	assert.equal(m.tryAcquire("s", 3), true);
	assert.equal(m.tryAcquire("s", 3), false);
});

test("makeInFlight release clamps at zero and deletes the key", () => {
	const m = makeInFlight();
	m.release("s"); // release with no acquire: no-op, never a throw
	assert.equal(m.count("s"), 0);
	assert.equal(m.tryAcquire("s", 1), true);
	m.release("s");
	m.release("s"); // double release must not open a second slot
	assert.equal(m.tryAcquire("s", 1), true);
	assert.equal(m.tryAcquire("s", 1), false);
});

test("makeInFlight: Infinity always admits and scopes are independent", () => {
	const m = makeInFlight();
	for (let i = 0; i < 20; i++) assert.equal(m.tryAcquire("a", Infinity), true);
	assert.equal(m.tryAcquire("b", 1), true);
	assert.equal(m.tryAcquire("b", 1), false);
	assert.equal(m.count("a"), 20);
	assert.equal(m.count("b"), 1);
});
