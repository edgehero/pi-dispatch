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
} from "../src/scoped-limits.mjs";
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
	assert.equal(limitFor(limits, "model:openai/gpt-x"), null);
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
	assert.ok(!gpt.keyPrefix.startsWith("budget:usd:p:") && !scopeDollarKeyPrefix("x").startsWith("budget:usd:p:"), "budget:usd:p: stays reserved for #499");
});

test("scopedLimitsVersionFor: 1 unless a row carries a dollar field or is a model row", () => {
	assert.equal(scopedLimitsVersionFor([]), 1);
	assert.equal(scopedLimitsVersionFor([{ scope: "a/b", day: 1, dayUsd: null }]), 1);
	assert.equal(scopedLimitsVersionFor([{ scope: "a/b", day: 1 }, { scope: "c/d", weekUsd: "1" }]), 2);
	assert.equal(scopedLimitsVersionFor([{ scope: "model:a/b", dayUsd: "1" }]), 2);
});

test("a NEAR MISS of a model row is refused, never read as an inert repo row; project: is reserved in both versions (PR #549's review)", () => {
	for (const scope of ["Model:openai/gpt-x", "MODEL:openai/gpt-x", "models:openai/gpt-x", "model :openai/gpt-x", "Models  :x/y"]) {
		assert.throws(() => parse2([{ scope, dayUsd: "1" }]), /written exactly model:<provider>\/<model>/, scope);
		assert.throws(() => parse([{ scope, day: 1 }]), /written exactly model:<provider>\/<model>/, `${scope} (v1)`);
	}
	for (const scope of ["project:abc", "Project:abc", "projects :abc"]) {
		assert.throws(() => parse2([{ scope, dayUsd: "1" }]), /reserved for project windows \(#499\)/, scope);
		assert.throws(() => parse([{ scope, day: 1 }]), /reserved for project windows \(#499\)/, `${scope} (v1)`);
	}
	// Not near misses: a repo or folder whose name merely starts with the word.
	assert.equal(parse([{ scope: "modelsco/web", day: 1 }])[0].scope, "modelsco/web");
	assert.equal(parse([{ scope: "projectx/web", day: 1 }])[0].scope, "projectx/web");
});

test("a case-colliding duplicate model row names the FIRST row's index (PR #549's review)", () => {
	assert.throws(() => parse2([{ scope: "acme/web", day: 1 }, { scope: "model:openai/gpt-x", dayUsd: "1" }, { scope: "model:OpenAI/gpt-x", weekUsd: "1" }]), /\(first at index 1\)/);
});
