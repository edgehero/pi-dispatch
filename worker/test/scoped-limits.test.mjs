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
	dollarCapsFor,
	modelDollarRows,
	scopeDollarKeyPrefix,
	modelDollarKeyPrefix,
	dollarKeyPrefixFor,
	scopedLimitsVersionFor,
	rowScopeFor,
	scopedLedgers,
	projectRowFor,
	projectDollarCapsFor,
	danglingProjectRows,
	checkProjectRows,
	dollarRowsWithoutCap,
	isProjectScope,
	projectScope,
} from "../src/scoped-limits.mjs";
import { FORGE_KINDS } from "../src/forges.mjs";
import { createHash } from "node:crypto";

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
	assert.throws(() => parseScopedLimits(JSON.stringify({ limits: [] }), "sl.json"), /must have "version": 1 or 2 \(an integer >= 1\)/);
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
		() => parseScopedLimits(wrap([], 3), "sl.json"),
		/written by a newer pi-dispatch \(version 3; this build understands 2\)/,
	);
	assert.equal(SCOPED_LIMITS_VERSION, 2);
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
	assert.equal(limitFor(limits, ghJob("acme/web")).day, 10);
	assert.equal(limitFor(limits, ghJob("acme/other")), null);
	assert.equal(limitFor(limits, ghJob("acme")), null);
	assert.equal(limitFor([], ghJob("acme/web")), null);
	assert.equal(limitFor(limits, null), null);
	assert.equal(limitFor(limits, { kind: "github" }), null);
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

// ── version 2: dollar windows on repo and folder rows (#501 part 5) and model rows (#502 part 6) ─────────────────

const parse2 = (limits) => parseScopedLimits(wrap(limits, 2), "sl.json");
const sha16 = (v) => createHash("sha256").update(v).digest("hex").slice(0, 16);

test("v2: a repo row carries dayUsd/weekUsd/monthUsd as canonical decimals, beside its counts; the literal has eight keys", () => {
	const [row] = parse2([{ scope: "acme/web", day: 3, dayUsd: "2.5", weekUsd: 10, monthUsd: "0.000001" }]);
	assert.deepEqual(row, { scope: "acme/web", day: 3, week: null, month: null, concurrent: null, dayUsd: "2.50", weekUsd: "10.00", monthUsd: "0.000001" });
	// A dollar-only row is a row: it limits something.
	assert.equal(parse2([{ scope: "acme/web", weekUsd: "1" }])[0].weekUsd, "1.00");
	// The overlay's number rules: no exponent in a string, at most 6 decimals, above 0.
	assert.throws(() => parse2([{ scope: "acme/web", dayUsd: "1e3" }]), /index 0: dayUsd must be a dollar amount above 0/);
	assert.throws(() => parse2([{ scope: "acme/web", dayUsd: "0.1234567" }]), /dayUsd must be a dollar amount/);
	assert.throws(() => parse2([{ scope: "acme/web", monthUsd: 0 }]), /monthUsd must be a dollar amount above 0/);
	assert.throws(() => parse2([{ scope: "acme/web" }]), /at least one of day, week, month, concurrent, dayUsd, weekUsd, monthUsd is required/);
	// The parser accepts its own output back (the admin's read-modify-write).
	const again = parse2(parse2([{ scope: "acme/web", dayUsd: "2.5" }]));
	assert.equal(again[0].dayUsd, "2.50");
});

test("v1 stays v1: read unchanged (the five-key literal), and a v1 file using dollar fields or a model row is REFUSED naming version 2", () => {
	assert.deepEqual(parse([{ scope: "acme/web", day: 3 }]), [{ scope: "acme/web", day: 3, week: null, month: null, concurrent: null }]);
	assert.throws(() => parse([{ scope: "acme/web", day: 3, dayUsd: "5" }]), /index 0: dayUsd needs "version": 2 \(this file says 1\)/);
	assert.throws(() => parse([{ scope: "acme/web", monthUsd: 5 }]), /monthUsd needs "version": 2/);
	assert.throws(() => parse([{ scope: "model:openai/gpt-x", dayUsd: "5" }]), /a "model:" row needs "version": 2 \(this file says 1\)/);
	// A null dollar field is absent, in v1 as in v2 (the subscriptions rule).
	assert.equal(parse([{ scope: "acme/web", day: 3, dayUsd: null }])[0].day, 3);
});

test("v2 model rows: model:<provider>/<model> with *Usd fields only; counts and concurrency refused; ids checked; duplicates by case refused", () => {
	const [m] = parse2([{ scope: " model:OpenAI/gpt-X ", monthUsd: "40" }]);
	assert.deepEqual(m, { scope: "model:OpenAI/gpt-X", day: null, week: null, month: null, concurrent: null, dayUsd: null, weekUsd: null, monthUsd: "40.00" });
	for (const field of ["day", "week", "month", "concurrent"]) {
		assert.throws(() => parse2([{ scope: "model:openai/gpt-x", dayUsd: "1", [field]: 1 }]), new RegExp(`carries dayUsd, weekUsd and monthUsd only \\(${field} is refused\\)`));
	}
	assert.throws(() => parse2([{ scope: "model:openai/gpt-x" }]), /a model row needs at least one of dayUsd, weekUsd, monthUsd/);
	assert.throws(() => parse2([{ scope: "model:gpt-x", dayUsd: "1" }]), /model:<provider>\/<model>/);
	assert.throws(() => parse2([{ scope: "model:open ai/x", dayUsd: "1" }]), /model:<provider>\/<model>/);
	assert.throws(() => parse2([{ scope: "model:other/other", dayUsd: "1" }]), /fold row/);
	// A model id may carry a slash (openrouter vendor/model): split at the FIRST slash, as the allowed list does.
	assert.equal(parse2([{ scope: "model:openrouter/anthropic/claude-x", dayUsd: "1" }])[0].scope, "model:openrouter/anthropic/claude-x");
	assert.throws(() => parse2([{ scope: "model:openai/gpt-x", dayUsd: "1" }, { scope: "model:OpenAI/GPT-x", weekUsd: "1" }]), /duplicate scope/);
});

test("model rows are never a job's scope: limitFor, budgetCapsFor and concurrencyFor ignore them", () => {
	const limits = parse2([{ scope: "model:openai/gpt-x", dayUsd: "1" }]);
	assert.equal(limitFor(limits, ghJob("model:openai/gpt-x")), null);
	assert.equal(budgetCapsFor(ghJob("model:openai/gpt-x"), limits), null);
	assert.equal(concurrencyFor(ghJob("model:openai/gpt-x"), limits), Infinity);
});

test("dollarCapsFor: the scope row's dollar windows in integer micro-dollars under budget:usd:s:<hash16 of the canonical scope>", () => {
	const limits = parse2([
		{ scope: "acme/web", day: 3, dayUsd: "2.5", monthUsd: "100" },
		{ scope: "/srv/site/", weekUsd: "1.25" },
		{ scope: "acme/count", day: 3 },
	]);
	assert.deepEqual(dollarCapsFor(ghJob("acme/web"), limits), { scope: "acme/web", keyPrefix: `budget:usd:s:${sha16("acme/web")}`, caps: { day: 2_500_000, week: null, month: 100_000_000 } });
	const local = dollarCapsFor(localJob("/srv//site"), limits);
	assert.deepEqual(local.caps, { day: null, week: 1_250_000, month: null });
	assert.equal(local.keyPrefix, `budget:usd:s:${sha16(resolve("/srv/site"))}`, "the same canonical scope the job-count windows hash");
	assert.equal(local.keyPrefix.slice("budget:usd:s:".length), scopeKeyPrefix(resolve("/srv/site")).slice("budget:s:".length), "the SAME hash as the job-count key");
	assert.equal(dollarCapsFor(ghJob("acme/count"), limits), null, "a count-only row has no dollar window");
	assert.equal(dollarCapsFor(ghJob("acme/other"), limits), null);
	assert.deepEqual(budgetCapsFor(ghJob("acme/web"), limits), { scope: "acme/web", caps: { day: 3, week: null, month: null } }, "budgetCapsFor unchanged");
});

test("modelDollarRows: a list reserves in its listed rows (ignoring case); NO list reserves in EVERY row; key = hash16 of the LOWERCASED ref", () => {
	const limits = parse2([
		{ scope: "acme/web", dayUsd: "1" },
		{ scope: "model:OpenAI/GPT-x", dayUsd: "1" },
		{ scope: "model:ollama/qwen3:0.6b", weekUsd: "0.05" },
	]);
	const gpt = { ref: "openai/gpt-x", keyPrefix: `budget:usd:mdl:${sha16("openai/gpt-x")}`, caps: { day: 1_000_000, week: null, month: null } };
	const qwen = { ref: "ollama/qwen3:0.6b", keyPrefix: `budget:usd:mdl:${sha16("ollama/qwen3:0.6b")}`, caps: { day: null, week: 50_000, month: null } };
	assert.deepEqual(modelDollarRows(limits, ["openai/gpt-x"]), [gpt]);
	assert.deepEqual(modelDollarRows(limits, ["ollama/qwen3:0.6b", "anthropic/claude-x"]), [qwen]);
	assert.deepEqual(modelDollarRows(limits, null), [gpt, qwen], "unrestricted: every model row (fail closed)");
	assert.deepEqual(modelDollarRows(limits, undefined), [gpt, qwen]);
	assert.deepEqual(modelDollarRows([], null), []);
	// One model is one counter whatever case it is spelled in, and the ledger's lowercased ids meet it.
	assert.equal(modelDollarKeyPrefix("OpenAI/GPT-x"), modelDollarKeyPrefix("openai/gpt-x"));
	assert.equal(modelDollarKeyPrefix("OpenAI/GPT-x"), `budget:usd:mdl:${sha16("openai/gpt-x")}`);
	assert.equal(dollarKeyPrefixFor(limits[1]), gpt.keyPrefix);
	assert.equal(dollarKeyPrefixFor(limits[0]), scopeDollarKeyPrefix("acme/web"));
	assert.ok(!gpt.keyPrefix.startsWith("budget:usd:p:") && !scopeDollarKeyPrefix("x").startsWith("budget:usd:p:"), "no key under the withdrawn budget:usd:p: prefix (issue #499 part B)");
});

test("scopedLimitsVersionFor: 1 unless a row carries a dollar field or is a model row", () => {
	assert.equal(scopedLimitsVersionFor([]), 1);
	assert.equal(scopedLimitsVersionFor([{ scope: "a/b", day: 1, dayUsd: null }]), 1);
	assert.equal(scopedLimitsVersionFor([{ scope: "a/b", day: 1 }, { scope: "c/d", weekUsd: "1" }]), 2);
	assert.equal(scopedLimitsVersionFor([{ scope: "model:a/b", dayUsd: "1" }]), 2);
});

test("a NEAR MISS of a model or project row is refused, never read as an inert repo row (PR #549's review, issue #499 part B)", () => {
	for (const scope of ["Model:openai/gpt-x", "MODEL:openai/gpt-x", "models:openai/gpt-x", "model :openai/gpt-x", "Models  :x/y"]) {
		assert.throws(() => parse2([{ scope, dayUsd: "1" }]), /written exactly model:<provider>\/<model>/, scope);
		assert.throws(() => parse([{ scope, day: 1 }]), /written exactly model:<provider>\/<model>/, `${scope} (v1)`);
	}
	for (const scope of ["Project:abc", "PROJECT:abc", "projects:abc", "project :abc", "Projects  :abc"]) {
		assert.throws(() => parse2([{ scope, dayUsd: "1" }]), /written exactly project:<id>/, scope);
		assert.throws(() => parse([{ scope, day: 1 }]), /written exactly project:<id>/, `${scope} (v1)`);
	}
	// The exact prefix with an id the projects file could never hold.
	for (const scope of ["project:", "project:Shop", "project:a:b", "project:a/b", "project: shop", `project:${"a".repeat(33)}`, "project:-shop"]) {
		assert.throws(() => parse([{ scope, day: 1 }]), /a project row's id must match/, scope);
	}
	// Not near misses: a repo or folder whose name merely starts with the word.
	assert.equal(parse([{ scope: "modelsco/web", day: 1 }])[0].scope, "modelsco/web");
	assert.equal(parse([{ scope: "projectx/web", day: 1 }])[0].scope, "projectx/web");
});

test("a case-colliding duplicate model row names the FIRST row's index (PR #549's review)", () => {
	assert.throws(() => parse2([{ scope: "acme/web", day: 1 }, { scope: "model:openai/gpt-x", dayUsd: "1" }, { scope: "model:OpenAI/gpt-x", weekUsd: "1" }]), /\(first at index 1\)/);
});

// ── forge-qualified scopes (issue #498) ─────────────────────────────────────────────────────────────────

const fjJob = (repo) => ({ kind: "forgejo", repo });

test("a qualified row parses for every forge kind (derived from FORGE_KINDS) and stores <kind>:<repo>", () => {
	const limits = parse2(FORGE_KINDS.map((kind) => ({ scope: ` ${kind}:acme/web `, day: 1 })));
	assert.deepEqual(limits.map((l) => l.scope), FORGE_KINDS.map((kind) => `${kind}:acme/web`));
	// Two forges' qualified rows for one repo are two rows, not a duplicate.
	assert.equal(limits.length, FORGE_KINDS.length);
});

test("an unknown forge prefix is refused naming the known kinds; a drive letter keeps today's handling", () => {
	assert.throws(() => parse2([{ scope: "gitub:acme/web", day: 1 }]), (e) => /index 0/.test(e.message) && /unknown prefix "gitub:"/.test(e.message) && FORGE_KINDS.every((k) => e.message.includes(k)));
	assert.throws(() => parse2([{ scope: "GitHub:acme/web", day: 1 }]), /unknown prefix "GitHub:"/);
	assert.throws(() => parse2([{ scope: "github:", day: 1 }]), /names a forge and no repo/);
	// A one-letter drive prefix is a folder, stored verbatim on a POSIX worker exactly as before.
	assert.equal(parse([{ scope: "C:\\srv\\site", day: 1 }])[0].scope, "C:\\srv\\site");
});

test("a bare row and a qualified row for one repo refuse the file, naming both indexes (count rows)", () => {
	assert.throws(() => parse2([{ scope: "acme/web", day: 5 }, { scope: "github:acme/web", concurrent: 1 }]), (e) => /index 1/.test(e.message) && /at index 0/.test(e.message) && /same repo/.test(e.message));
	// Order does not matter: the qualified row first is refused the same way.
	assert.throws(() => parse2([{ scope: "forgejo:acme/web", week: 2 }, { scope: "acme/web", month: 9 }]), (e) => /index 0/.test(e.message) && /at index 1/.test(e.message));
	// Two forges' qualified rows, or a bare row for ANOTHER repo, are fine.
	assert.equal(parse2([{ scope: "github:acme/web", day: 1 }, { scope: "forgejo:acme/web", day: 1 }, { scope: "acme/api", day: 1 }]).length, 3);
});

test("a bare row and a qualified row for one repo refuse the file when both carry dollar windows only", () => {
	assert.throws(() => parse2([{ scope: "acme/web", dayUsd: "5" }, { scope: "gitlab:acme/web", monthUsd: "50" }]), (e) => /index 1/.test(e.message) && /at index 0/.test(e.message) && /same repo/.test(e.message));
});

test("limitFor matches the qualified row first, then the bare row; the other forge falls through", () => {
	const qualified = parse2([{ scope: "github:acme/web", day: 3 }]);
	assert.equal(limitFor(qualified, ghJob("acme/web")).scope, "github:acme/web");
	assert.equal(limitFor(qualified, fjJob("acme/web")), null);
	const bare = parse([{ scope: "acme/web", day: 3 }]);
	assert.equal(limitFor(bare, ghJob("acme/web")).scope, "acme/web");
	assert.equal(limitFor(bare, fjJob("acme/web")).scope, "acme/web");
	// A job with no kind matches only the bare row.
	assert.equal(limitFor(qualified, { repo: "acme/web" }), null);
	assert.equal(limitFor(bare, { repo: "acme/web" }).scope, "acme/web");
});

test("every key comes from the MATCHED ROW: budgetCapsFor, dollarCapsFor and rowScopeFor return the row's scope", () => {
	const limits = parse2([{ scope: "forgejo:acme/web", day: 1, dayUsd: "2" }, { scope: "acme/api", concurrent: 1, weekUsd: "3" }]);
	assert.deepEqual(budgetCapsFor(fjJob("acme/web"), limits), { scope: "forgejo:acme/web", caps: { day: 1, week: null, month: null } });
	assert.equal(budgetCapsFor(ghJob("acme/web"), limits), null, "the GitHub job has no row");
	assert.equal(dollarCapsFor(fjJob("acme/web"), limits).keyPrefix, scopeDollarKeyPrefix("forgejo:acme/web"));
	assert.equal(dollarCapsFor(ghJob("acme/api"), limits).keyPrefix, scopeDollarKeyPrefix("acme/api"));
	assert.equal(rowScopeFor(fjJob("acme/web"), limits), "forgejo:acme/web");
	assert.equal(rowScopeFor(ghJob("acme/api"), limits), "acme/api");
	assert.equal(rowScopeFor(fjJob("acme/api"), limits), "acme/api", "a bare row is one key for every forge");
	// No row: the job's canonical scope, so the folder mutex keeps its key.
	assert.equal(rowScopeFor(ghJob("acme/other"), limits), "acme/other");
	assert.equal(rowScopeFor(localJob("/srv//site/"), limits), "/srv/site");
	assert.equal(concurrencyFor(ghJob("acme/api"), limits), 1);
	assert.equal(concurrencyFor(fjJob("acme/api"), limits), 1);
});

test("the migration pin: a bare row keeps the exact key it had before qualified scopes (literal, not recomputed)", () => {
	// Written out by hand on purpose: `printf %s acme/web | shasum -a 256 | cut -c1-16`. Any change to how a key is
	// derived (a prefix in the hash, a qualified scope for a bare row) moves every live counter and fails here first.
	assert.equal(scopeKeyPrefix("acme/web"), "budget:s:86f279ce9c29f106");
	assert.equal(scopeDollarKeyPrefix("acme/web"), "budget:usd:s:86f279ce9c29f106");
	const limits = parse([{ scope: "acme/web", day: 5 }]);
	for (const job of [ghJob("acme/web"), fjJob("acme/web")]) assert.equal(scopeKeyPrefix(budgetCapsFor(job, limits).scope), "budget:s:86f279ce9c29f106");
	assert.equal(scopeKeyPrefix(budgetCapsFor(ghJob("acme/web"), parse2([{ scope: "github:acme/web", day: 5 }])).scope), "budget:s:ae5b3b31a94b074d");
});

test("a forge-qualified row needs version 2, and the admin's version stamp says 2 for one (released builds refuse, never ignore)", () => {
	// Every released build reads `github:acme/web` as a plain repo string no job has: in a version 1 file it would be a
	// cap and a lease one build enforces and another silently drops. Version 2 makes the older build refuse instead.
	assert.throws(() => parse([{ scope: "github:acme/web", day: 1 }]), (e) => /index 0/.test(e.message) && /needs "version": 2/.test(e.message));
	assert.equal(scopedLimitsVersionFor([{ scope: "github:acme/web", day: 1 }]), 2);
	assert.equal(scopedLimitsVersionFor([{ scope: " forgejo:acme/web ", concurrent: 1 }]), 2, "as the admin builds it, untrimmed");
	assert.equal(scopedLimitsVersionFor([{ scope: "acme/web", day: 1 }, { scope: "/srv/site", concurrent: 1 }]), 1, "bare and folder rows stay version 1");
	assert.equal(scopedLimitsVersionFor([{ scope: "gitub:acme/web", day: 1 }]), 1, "a refused scope is the parser's to name, not the stamp's");
});

test("a qualified row must have a forge repo's shape: each refused shape is named, the good ones parse", () => {
	const refused = [
		"github:/acme/web", // leading slash
		"github:acme/web/", // trailing slash
		"github:acme//web", // empty segment
		"github:acme /web", // whitespace at a segment's end
		"github:acme/ web", // whitespace at a segment's start
		"github:acme/web\tx", // control character
		"github:acme/web\u0000", // NUL
		"github:acme/web#12", // a pasted run target
		"github:github:acme/web", // a second prefix
		"github:acme", // one segment: no forge repo has no "/"
	];
	for (const scope of refused) assert.throws(() => parse2([{ scope, day: 1 }]), (e) => /index 0/.test(e.message) && /is not a forge repo/.test(e.message), scope);
	for (const scope of ["github:acme/web", "gitlab:group/sub/proj", "azure:proj/repo", "forgejo:a.b-c/d_e"]) assert.equal(parse2([{ scope, day: 1 }])[0].scope, scope);
	// Azure DevOps project and repository names may hold spaces, and the receiver copies them verbatim: inside a
	// segment, whitespace is allowed for every forge (the simplest rule), and such a row caps that Azure job.
	const azure = parse2([{ scope: "azure:Fabrikam Fiber/Web App", day: 1 }]);
	assert.equal(azure[0].scope, "azure:Fabrikam Fiber/Web App");
	assert.equal(limitFor(azure, { kind: "azure", repo: "Fabrikam Fiber/Web App" }).scope, "azure:Fabrikam Fiber/Web App");
});

// ── project rows (issue #499 part B) ─────────────────────────────────────────────────────────────────────

test("a project:<id> row parses in version 2 only, in every field, and stamps version 2 (issue #499 part B)", () => {
	const v2 = parse2([{ scope: " project:shop ", day: 2, week: 5, concurrent: 1 }]);
	assert.deepEqual(v2, [{ scope: "project:shop", day: 2, week: 5, month: null, concurrent: 1, dayUsd: null, weekUsd: null, monthUsd: null }]);
	assert.equal(isProjectScope(v2[0].scope), true);
	assert.equal(scopedLimitsVersionFor(v2), 2, "a count-only project row needs version 2 too");
	assert.equal(scopedLimitsVersionFor([{ scope: " project:shop ", concurrent: 1 }]), 2, "as the admin builds it, untrimmed");
	// The released 2.1.0 reads `project:shop` as an inert repo row, so a version 1 file holding one is refused here and
	// a version 2 file is refused there as newer.
	for (const row of [{ scope: "project:shop", day: 2 }, { scope: "project:shop", concurrent: 1 }, { scope: "project:shop", dayUsd: "5" }]) {
		assert.throws(() => parse([row]), (e) => /index 0/.test(e.message) && /a project row needs "version": 2/.test(e.message), JSON.stringify(row));
	}
	const usd = parse2([{ scope: "project:shop", dayUsd: "5", monthUsd: "40" }]);
	assert.deepEqual(usd, [{ scope: "project:shop", day: null, week: null, month: null, concurrent: null, dayUsd: "5.00", weekUsd: null, monthUsd: "40.00" }]);
	assert.throws(() => parse2([{ scope: "project:shop", day: 1 }, { scope: "project:shop", week: 1 }]), /duplicate scope "project:shop"/);
	assert.throws(() => parse2([{ scope: "project:shop" }]), /at least one of day, week, month, concurrent/);
	assert.equal(projectScope("shop"), "project:shop");
});

test("a project row is never a job's own scope: limitFor and rowScopeFor ignore it, and it sits beside a bare row", () => {
	const limits = parse2([{ scope: "acme/web", day: 1 }, { scope: "project:shop", day: 2 }]);
	// A forge never puts `:` in a repo name, so no real job has this repo; even a hand-built one never matches the row.
	assert.equal(limitFor(limits, ghJob("project:shop")), null);
	assert.equal(rowScopeFor(ghJob("project:shop"), limits), "project:shop", "no row matched: the job's own canonical scope, as before");
	assert.equal(budgetCapsFor(ghJob("project:shop"), limits), null);
	assert.equal(concurrencyFor(ghJob("project:shop"), parse2([{ scope: "project:shop", concurrent: 1 }])), Infinity);
});

test("scopedLedgers orders the repo or folder row BEFORE the project row, each keyed by its own row scope", () => {
	const limits = parse2([{ scope: "project:shop", day: 2 }, { scope: "acme/web", week: 7 }]);
	const ledgers = scopedLedgers(ghJob("acme/web"), limits, "shop");
	assert.deepEqual(ledgers, [
		{ scope: "acme/web", keyPrefix: scopeKeyPrefix("acme/web"), caps: { day: null, week: 7, month: null }, reason: "scope-cap" },
		{ scope: "project:shop", keyPrefix: scopeKeyPrefix("project:shop"), caps: { day: 2, week: null, month: null }, reason: "project-cap" },
	]);
	// The literal key, pinned: `budget:s:<hash16("project:shop")>`, the row-keyed rule and no keyspace of its own.
	assert.equal(ledgers[1].keyPrefix, `budget:s:${createHash("sha256").update("project:shop").digest("hex").slice(0, 16)}`);
	// A job with no repo row reserves in the project row alone; one with no project in its repo row alone.
	assert.deepEqual(scopedLedgers(ghJob("acme/other"), limits, "shop").map((l) => l.reason), ["project-cap"]);
	assert.deepEqual(scopedLedgers(ghJob("acme/web"), limits, null).map((l) => l.reason), ["scope-cap"]);
	assert.deepEqual(scopedLedgers(ghJob("acme/web"), limits, "other").map((l) => l.reason), ["scope-cap"], "a project with no row is no ledger");
	// A concurrency-only or dollar-only project row is no job-count ledger.
	assert.deepEqual(scopedLedgers(ghJob("acme/x"), parse2([{ scope: "project:shop", concurrent: 1 }, { scope: "project:two", dayUsd: "1" }]), "shop"), []);
	assert.deepEqual(scopedLedgers(ghJob("acme/x"), parse2([{ scope: "project:two", dayUsd: "1" }]), "two"), []);
	assert.equal(projectRowFor(limits, "shop").scope, "project:shop");
	assert.equal(projectRowFor(limits, "Not An Id"), null);
	assert.equal(projectRowFor(limits, null), null);
});

test("projectDollarCapsFor: the project row's dollar windows under scopeDollarKeyPrefix(project:<id>), never budget:usd:p:", () => {
	const limits = parse2([{ scope: "project:shop", day: 2, weekUsd: "12.5" }]);
	const caps = projectDollarCapsFor(limits, "shop");
	assert.deepEqual(caps, { scope: "project:shop", keyPrefix: scopeDollarKeyPrefix("project:shop"), caps: { day: null, week: 12_500_000, month: null } });
	assert.equal(caps.keyPrefix, `budget:usd:s:${createHash("sha256").update("project:shop").digest("hex").slice(0, 16)}`);
	assert.equal(dollarKeyPrefixFor(limits[0]), caps.keyPrefix, "the admin reads the counters under the same prefix");
	assert.equal(projectDollarCapsFor(limits, null), null);
	assert.equal(projectDollarCapsFor(parse2([{ scope: "project:shop", day: 1 }]), "shop"), null, "no dollar field, no dollar ledger");
	assert.deepEqual(dollarRowsWithoutCap(limits, null), [{ index: 0, kind: "project" }]);
});

test("a project row whose id is not a project is named by index and id (danglingProjectRows / checkProjectRows)", () => {
	const limits = parse2([{ scope: "acme/web", day: 1 }, { scope: "project:shop", day: 2 }, { scope: "project:gone", week: 1 }]);
	const projects = [{ id: "shop", name: "Private Name", members: ["github:acme/web"] }];
	assert.deepEqual(danglingProjectRows(limits, projects), [{ index: 2, id: "gone" }]);
	assert.deepEqual(danglingProjectRows(limits, []), [{ index: 1, id: "shop" }, { index: 2, id: "gone" }], "no projects file: every project row dangles");
	assert.throws(
		() => checkProjectRows(limits, projects, "sl.json"),
		(e) => e.piDispatchConfig === true && /index 2 \("project:gone"\)/.test(e.message) && !/index 1/.test(e.message) && !/Private Name/.test(e.message),
	);
	assert.doesNotThrow(() => checkProjectRows(limits, [...projects, { id: "gone", members: ["/srv/x"] }], "sl.json"));
	assert.doesNotThrow(() => checkProjectRows([], [], "sl.json"));
});
