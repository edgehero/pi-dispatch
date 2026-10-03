import assert from "node:assert/strict";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { EMPTY_USD_FINGERPRINT, usdFingerprint, usdFingerprintInput } from "../src/dollar-fingerprint.mjs";
import {
	FIRST_CALL_MIN_CONTEXT_BYTES,
	FIRST_CALL_OVERHEAD_TOKENS,
	boundModelOf,
	costCapFitChecks,
	defaultDollarKeysExist,
	dollarKeysExistWith,
	deploymentSettingsOf,
	firstCallFloorMicros,
	fleetDollarChecks,
	listedProviderCredentialChecks,
	modelSubjects,
	overlayLoaderParityChecks,
	serviceTierMultiplier,
	unknownModelChecks,
} from "../src/doctor.mjs";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { builtinModel, checkModelsKnown } from "../src/model-catalog.mjs";
import { loadPiModelLoader } from "../src/pi-model-loader.mjs";
import { parseScopedLimits } from "../src/scoped-limits.mjs";
import { BOUND_OVERHEAD_TOKENS, PRICED_APIS, callCostBound } from "../../image/runner/src/usage-meter.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

/**
 * Issue #501 part 6 and the doctor recommendations of #501 and #502: the fleet's dollar fingerprint, and the four
 * doctor lines about the models a job may use (a cap that never fits one call, an unknown model, a listed provider
 * with no credential, pi's loader against the worker's catalog).
 */

const v2 = (limits) => parseScopedLimits(JSON.stringify({ version: 2, limits }), "sl.json");
const SETTINGS = { maxCostUsd: "2", dailyCostUsd: "10", weeklyCostUsd: "40", monthlyCostUsd: "100" };
const ROWS = [
	{ scope: "model:anthropic/claude-haiku-4-5", weekUsd: "4" },
	{ scope: "model:openai/gpt-4o-mini", monthUsd: "8" },
	{ scope: "acme/web", dayUsd: "5", weekUsd: "20", monthUsd: "60" },
	{ scope: "/srv/private-folder", weekUsd: "9" },
	{ scope: "model:openai/gpt-5.4", dayUsd: "3" },
	{ scope: "acme/count-only", day: 4 },
];

// ── the fingerprint ──────────────────────────────────────────────────────────────────────────────────────

test("fpUsd hashes numbers and counter hashes only: no scope string reaches its input", () => {
	const input = usdFingerprintInput(SETTINGS, v2(ROWS));
	const text = JSON.stringify(input);
	for (const scope of ["acme/web", "/srv/private-folder", "private-folder", "openai/gpt-5.4", "gpt-5.4", "acme"]) assert.ok(!text.includes(scope), `${scope} is not in the input`);
	assert.deepEqual(input.settings, { maxCostUsd: 2_000_000, dailyCostUsd: 10_000_000, weeklyCostUsd: 40_000_000, monthlyCostUsd: 100_000_000 });
	assert.equal(input.rows.length, 5, "only the dollar-carrying rows; a count-only row decides no dollar admission");
	for (const row of input.rows) {
		assert.match(row.counter, /^budget:usd:(s|mdl):[0-9a-f]{16}$/, "a row is named by the counter it reserves in");
		for (const field of ["dayUsd", "weekUsd", "monthUsd"]) assert.ok(row[field] === null || Number.isSafeInteger(row[field]), field);
	}
	assert.match(usdFingerprint(SETTINGS, v2(ROWS)), /^[0-9a-f]{16}$/);
});

test("fpUsd moves with every setting and every row window, and not with the row order", () => {
	const base = usdFingerprint(SETTINGS, v2(ROWS));
	for (const key of Object.keys(SETTINGS)) {
		assert.notEqual(usdFingerprint({ ...SETTINGS, [key]: "77" }, v2(ROWS)), base, `${key} changed`);
		assert.notEqual(usdFingerprint({ ...SETTINGS, [key]: undefined }, v2(ROWS)), base, `${key} unset`);
	}
	for (const field of ["dayUsd", "weekUsd", "monthUsd"]) {
		const rows = ROWS.map((r, i) => (i === 0 ? { ...r, [field]: "1.5" } : r));
		assert.notEqual(usdFingerprint(SETTINGS, v2(rows)), base, `a row's ${field} changed`);
	}
	assert.notEqual(usdFingerprint(SETTINGS, v2(ROWS.slice(1))), base, "a row removed");
	assert.notEqual(usdFingerprint(SETTINGS, v2(ROWS.map((r, i) => (i === 0 ? { ...r, scope: "acme/api" } : r)))), base, "a row moved to another counter");
	assert.equal(usdFingerprint(SETTINGS, v2([...ROWS].reverse())), base, "file order is not a cap, for scope rows and for the model rows a job without a list reserves in");
	assert.deepEqual(usdFingerprintInput(SETTINGS, v2([...ROWS].reverse())).untargeted, usdFingerprintInput(SETTINGS, v2(ROWS)).untargeted);
	assert.equal(usdFingerprint({ ...SETTINGS, maxCostUsd: 2 }, v2(ROWS)), base, "a number and its string are one amount");
	assert.equal(usdFingerprint({ ...SETTINGS, maxCostUsd: "2.000000" }, v2(ROWS)), base, "micro-dollars, not spelling");
});

test("fpUsd never throws: an amount that does not parse hashes as invalid, never as the value", () => {
	const input = usdFingerprintInput({ maxCostUsd: "1e3", dailyCostUsd: "secret-ish" }, [{ scope: "x", dayUsd: "-1" }]);
	assert.equal(input.settings.maxCostUsd, "invalid");
	assert.equal(input.settings.dailyCostUsd, "invalid");
	assert.equal(input.rows[0].dayUsd, "invalid");
	assert.ok(!JSON.stringify(input).includes("secret-ish"));
	assert.equal(usdFingerprint({}, []), EMPTY_USD_FINGERPRINT);
	assert.equal(usdFingerprint({ maxCostUsd: null }, [{ scope: "acme/count-only", day: 4 }]), EMPTY_USD_FINGERPRINT, "nothing dollar-shaped is the empty fingerprint");
});

// ── doctor: hosts that disagree ──────────────────────────────────────────────────────────────────────────

test("doctor warns when a peer's fpUsd differs, naming the host and never a cap", async () => {
	const mine = usdFingerprint(SETTINGS, []);
	const other = usdFingerprint({ ...SETTINGS, maxCostUsd: "5" }, []);
	const checks = await fleetDollarChecks(mine, [{ name: "mini2", fpUsd: other }, { name: "mini3", fpUsd: mine }]);
	assert.equal(checks.length, 1);
	assert.equal(checks[0].ok, false);
	assert.equal(checks[0].warn, true, "a WARN: doctor runs on one machine");
	assert.match(checks[0].label, /^Hosts disagree about the dollar caps: mini2 judges/);
	assert.match(checks[0].label, /PI_ALLOWED_MODELS/, "the env list is one of the things that can differ");
	assert.match(checks[0].fix, /PI_ALLOWED_MODELS/);
	assert.ok(!checks[0].label.includes("mini3"), "an agreeing host is not named");
	assert.ok(!/\$|5|2\b/.test(checks[0].label.replace(/mini2/, "")), "no amount is printed");
	assert.deepEqual(await fleetDollarChecks(mine, [{ name: "mini3", fpUsd: mine }]), [], "agreement is silent");
});

test("a peer that predates fpUsd is named only when dollar caps are in use somewhere", async () => {
	const inUse = usdFingerprint(SETTINGS, []);
	const old = [{ name: "old1" }, { name: "old2", fpUsd: "" }];
	let asked = 0;
	const named = await fleetDollarChecks(inUse, old, { dollarKeysExist: async () => (asked++, true) });
	assert.equal(asked, 0, "the counters are asked only when nothing else says dollars are in use");
	assert.equal(named.length, 1);
	assert.match(named[0].label, /^old1, old2 publish no fingerprint of their dollar caps/);
	assert.equal(named[0].warn, true);
	assert.deepEqual(await fleetDollarChecks(EMPTY_USD_FINGERPRINT, old, { dollarKeysExist: async () => false }), [], "no dollar setting anywhere: an upgrade says nothing new");
	assert.equal((await fleetDollarChecks(EMPTY_USD_FINGERPRINT, [...old, { name: "new1", fpUsd: inUse }])).length, 2, "a peer that uses dollars makes the silent ones worth naming (and it disagrees)");
	// PR #551's review: an old CAPPED host beside a new uncapped one. Its caps are invisible, its counters are not.
	const counters = await fleetDollarChecks(EMPTY_USD_FINGERPRINT, [{ name: "old1" }], { dollarKeysExist: async () => true });
	assert.equal(counters.length, 1);
	assert.match(counters[0].label, /^old1 publishes no fingerprint of its dollar caps.*dollar counters exist on this Valkey, so some host reserved dollars recently\)$/);
	assert.deepEqual(await fleetDollarChecks(EMPTY_USD_FINGERPRINT, [{ name: "old1" }], { dollarKeysExist: async () => Promise.reject(new Error("down")) }), [], "a scan that fails adds nothing");
});

// ── doctor: a cap below one full-output call ─────────────────────────────────────────────────────────────

test("the doctor floor keeps the runner's overhead, and stays a lower bound of the runner's own bound for every builtin chat model", () => {
	assert.equal(FIRST_CALL_OVERHEAD_TOKENS, BOUND_OVERHEAD_TOKENS, "the copy in doctor.mjs follows the runner's constant");
	// A request of exactly FIRST_CALL_MIN_CONTEXT_BYTES serialised: the floor may never exceed what the guard reserves for it.
	const context = { systemPrompt: "x".repeat(FIRST_CALL_MIN_CONTEXT_BYTES - JSON.stringify({ systemPrompt: "" }).length) };
	assert.equal(Buffer.byteLength(JSON.stringify(context)), FIRST_CALL_MIN_CONTEXT_BYTES);
	let judged = 0;
	for (const provider of getBuiltinProviders()) {
		for (const model of getBuiltinModels(provider)) {
			const floor = firstCallFloorMicros(model);
			if (floor === null) continue;
			const bound = callCostBound("streamSimple", model, context, {}, {});
			if (bound === Infinity) continue;
			judged += 1;
			assert.ok(floor <= bound, `${provider}/${model.id}: floor ${floor} <= bound ${bound}`);
		}
	}
	assert.ok(judged > 500, `judged ${judged} models`);
});

test("PR #542's lab case: a $1 cap on the default model cannot admit its first call, and the line says so", () => {
	const model = builtinModel("anthropic", "claude-sonnet-4-5-20250929");
	// (8192 + 4096) x $3.75 (cache write) + 64,000 x $15, per million.
	assert.equal(firstCallFloorMicros(model), 1_006_080);
	const subjects = modelSubjects({ deployment: { provider: "anthropic", model: "claude-sonnet-4-5-20250929", maxCostUsd: "1" } });
	const checks = costCapFitChecks(subjects, (ref) => boundModelOf(ref, { builtinModel }));
	assert.equal(checks.length, 1);
	assert.equal(checks[0].warn, true);
	assert.match(checks[0].label, /anthropic\/claude-sonnet-4-5-20250929 \(the main model, so such a job makes no call at all\) needs at least \$1\.00608 a call under a \$1\.00 cap \(the deployment default\)/);
});

test("the cap check's boundary: a cap equal to the floor fits, one micro-dollar less does not", () => {
	const model = { cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, maxTokens: 1000 };
	const floor = firstCallFloorMicros(model);
	assert.equal(floor, (8192 + 4096) * 1 + 1000 * 2);
	const at = (cap) => costCapFitChecks([{ label: "t", main: { provider: "p", id: "m" }, list: [], cap, secretNames: [], named: true }], () => model);
	assert.deepEqual(at(floor), [], "the guard admits a call whose bound equals the cap");
	assert.equal(at(floor - 1).length, 1);
	assert.deepEqual(at(null), [], "no cap, nothing to fit");
});

test("a listed model is judged too, a trigger's own smaller cap applies, and one model under one cap is one item", () => {
	const deployment = { provider: "anthropic", model: "claude-haiku-4-5", maxCostUsd: "50" };
	const runs = [
		{ label: 'cron "a"', models: ["anthropic/claude-haiku-4-5", "anthropic/claude-sonnet-4-5-20250929"], provider: "anthropic", model: "claude-haiku-4-5", maxCostUsd: "1", secretNames: [] },
		{ label: "label trigger #1", models: ["anthropic/claude-haiku-4-5", "anthropic/claude-sonnet-4-5-20250929"], provider: "anthropic", model: "claude-haiku-4-5", maxCostUsd: "1", secretNames: [] },
		{ label: "label trigger #2", secretNames: [] },
	];
	const checks = costCapFitChecks(modelSubjects({ runs, deployment }), (ref) => boundModelOf(ref, { builtinModel }));
	assert.equal(checks.length, 1);
	assert.match(checks[0].label, /anthropic\/claude-sonnet-4-5-20250929 needs at least \$1\.00608 a call under a \$1\.00 cap \(cron "a", label trigger #1\)/);
	assert.ok(!/the main model/.test(checks[0].label), "the main model fits; the listed one does not");
	assert.ok(!/label trigger #2/.test(checks[0].label), "the $50 deployment cap fits");
});

test("the floor's model: builtin, a custom overlay model, and nothing when the overlay redefines a builtin", () => {
	const custom = { id: "qwen2.5:0.5b", api: "openai-completions", maxTokens: 2048, cost: { input: 100, output: 200, cacheRead: 0, cacheWrite: 0 } };
	const overlay = { providers: { openai: { models: [custom, { id: "gpt-4o", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }], modelOverrides: { "gpt-4.1": { maxTokens: 1 } } } } };
	assert.equal(boundModelOf({ provider: "openai", id: "qwen2.5:0.5b" }, { builtinModel, overlay }), custom);
	assert.equal(boundModelOf({ provider: "openai", id: "gpt-4o" }, { builtinModel, overlay }), null, "a redefined builtin is pi's composition, not copied here");
	assert.equal(boundModelOf({ provider: "openai", id: "gpt-4.1" }, { builtinModel, overlay }), null, "an overridden builtin likewise");
	assert.equal(boundModelOf({ provider: "anthropic", id: "claude-haiku-4-5" }, { builtinModel, overlay })?.id, "claude-haiku-4-5");
	// #501's by-hand step 2: the expensive custom model under a $1 cap never fits (12,288 x $100 + 2,048 x $200 per million).
	assert.equal(firstCallFloorMicros(custom), 12_288 * 100 + 2048 * 200);
	assert.equal(firstCallFloorMicros({ cost: { input: 1, output: 1 }, maxTokens: 10 }), null, "an incomplete table says nothing");
	assert.equal(firstCallFloorMicros({ cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }), null, "no output limit says nothing");
});

// ── doctor: an unknown model in the triggers file ────────────────────────────────────────────────────────

const DEPLOY = { provider: "anthropic", model: "claude-sonnet-4-5-20250929", maxCostUsd: null };

test("an unknown model is named on every trigger kind, cron included, by the worker's own gate", () => {
	const runs = [
		{ label: 'cron "nightly"', provider: "openai", model: "gpt-9-turbo", secretNames: [] },
		{ label: "label trigger #1", models: ["anthropic/claude-sonnet-4-5-20250929", "openai/gpt-4o"], secretNames: [] },
		{ label: "issue trigger #2", model: "claude-sonnet-9", secretNames: [] },
		{ label: "comment trigger #3", secretNames: [] },
	];
	const checks = unknownModelChecks(modelSubjects({ runs, deployment: DEPLOY }), checkModelsKnown, () => null);
	assert.equal(checks.length, 1);
	assert.equal(checks[0].warn, true);
	assert.match(checks[0].label, /^2 trigger\(s\) name a model this deployment does not know, so every job of them is refused before it starts \(model-unknown\): cron "nightly": openai\/gpt-9-turbo \(not-in-catalog\); issue trigger #2: anthropic\/claude-sonnet-9 \(not-in-catalog\)$/);
});

test("a trigger that names nothing of its own is not this file's to fix, and an overlay model is known", () => {
	const deployment = { ...DEPLOY, model: "no-such-default" };
	const onlyDeployment = unknownModelChecks(modelSubjects({ runs: [{ label: "label trigger #0", secretNames: [] }], deployment }), checkModelsKnown, () => null);
	assert.equal(onlyDeployment.length, 1, "the deployment's own line, not the trigger's");
	assert.ok(!/label trigger #0/.test(onlyDeployment[0].label));
	const overlay = { providers: { ollama: { baseUrl: "http://gpu:11434/v1", api: "openai-completions", models: [{ id: "qwen" }] } } };
	assert.deepEqual(unknownModelChecks(modelSubjects({ runs: [{ label: 'cron "x"', provider: "ollama", model: "qwen", secretNames: [] }], deployment: DEPLOY }), checkModelsKnown, () => overlay), []);
	const refused = unknownModelChecks(modelSubjects({ runs: [{ label: 'cron "x"', provider: "ollama", model: "qwen", secretNames: [] }], deployment: DEPLOY }), checkModelsKnown, () => {
		throw Object.assign(new Error("schema"), { piDispatchConfig: true });
	});
	assert.ok(refused.some((c) => /cron "x": ollama\/qwen \(overlay-unparseable\)/.test(c.label)), "the file named as the problem");
	const transient = unknownModelChecks(modelSubjects({ runs: [{ label: 'cron "x"', provider: "ollama", model: "qwen", secretNames: [] }], deployment: DEPLOY }), checkModelsKnown, () => {
		throw Object.assign(new Error("io"), { code: "EIO" });
	});
	assert.deepEqual(transient, [], "a read that may succeed later is retried by the worker, not refused");
});

test("a listed model whose fallbacks are unlisted is named as the worker refuses it", () => {
	const runs = [{ label: "label trigger #0", provider: "anthropic", model: "claude-fable-5", models: ["anthropic/claude-fable-5"], secretNames: [] }];
	const checks = unknownModelChecks(modelSubjects({ runs, deployment: DEPLOY }), checkModelsKnown, () => null);
	assert.equal(checks.length, 1);
	assert.match(checks[0].label, /server-side fallbacks are not on the list.*\(model-not-allowed\): label trigger #0: anthropic\/claude-fable-5$/);
});

// ── doctor: a listed provider with no credential ─────────────────────────────────────────────────────────

const candidatesOf = (provider) => ({ openai: ["OPENAI_API_KEY"], anthropic: ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"] })[provider] ?? [];

test("a listed provider other than the main one needs run.secrets or a forwarded, set variable", () => {
	const run = (extra = {}) => ({ label: "label trigger #0", provider: "anthropic", model: "claude-haiku-4-5", models: ["anthropic/claude-haiku-4-5", "openai/gpt-4o"], secretNames: [], ...extra });
	const judge = (r, opts = {}) => listedProviderCredentialChecks(modelSubjects({ runs: [r], deployment: DEPLOY }), { candidatesOf, ...opts });
	const none = judge(run());
	assert.equal(none.length, 1);
	assert.equal(none[0].warn, true);
	assert.match(none[0].label, /: openai \(label trigger #0; looked for OPENAI_API_KEY\)$/);
	assert.deepEqual(judge(run({ secretNames: ["OPENAI_API_KEY"] })), [], "bound by run.secrets");
	assert.deepEqual(judge(run(), { forwarded: ["OPENAI_API_KEY"], env: { OPENAI_API_KEY: "k" } }), [], "forwarded and set");
	assert.equal(judge(run(), { forwarded: ["OPENAI_API_KEY"], env: {} }).length, 1, "forwarded but unset forwards nothing");
	assert.deepEqual(judge(run({ models: ["anthropic/claude-haiku-4-5", "anthropic/claude-sonnet-4-5-20250929"] })), [], "the main provider's key is the worker's to resolve");
	assert.deepEqual(judge(run({ models: ["anthropic/claude-haiku-4-5", "amazon-bedrock/x"] })), [], "a provider pi names no variable for is not judged");
	assert.deepEqual(listedProviderCredentialChecks(modelSubjects({ runs: [], deployment: DEPLOY }), { candidatesOf }), [], "no list, nothing listed");
});

test("the deployment's own list is judged, and an overlay apiKey reference replaces pi's names", () => {
	const subjects = modelSubjects({ runs: [], deployment: DEPLOY, envList: ["anthropic/claude-sonnet-4-5-20250929", "openai/gpt-4o", "ollama/qwen"] });
	const overlay = { providers: { openai: { apiKey: "$TEAM_OPENAI" }, ollama: { apiKey: "$PI_DISPATCH_KEYLESS" } } };
	const checks = listedProviderCredentialChecks(subjects, { candidatesOf, overlay });
	assert.equal(checks.length, 1);
	assert.match(checks[0].label, /openai \(the deployment default; looked for TEAM_OPENAI\)$/, "the keyless marker is #503's to judge");
	assert.deepEqual(listedProviderCredentialChecks(subjects, { candidatesOf, overlay, forwarded: ["TEAM_OPENAI"], env: { TEAM_OPENAI: "k" } }), []);
});

// ── doctor: pi's own loader against the worker's catalog ────────────────────────────────────────────────

const file = (doc) => {
	const path = join(tempDir("pi-parity-"), "models.json");
	writeFileSync(path, typeof doc === "string" ? doc : JSON.stringify(doc));
	return path;
};
const GOOD = { providers: { ollama: { baseUrl: "http://gpu:11434/v1", api: "openai-completions", models: [{ id: "qwen" }, { id: "llama" }] } } };

test("parity: agreement is one quiet line naming pi's version; a disagreement warns per model", async () => {
	const agree = await overlayLoaderParityChecks(file(GOOD), { pi: { version: "0.99.1", pinned: "0.99.1", read: async () => ({ loads: true, has: () => true }) }, checkModelsKnown });
	assert.deepEqual(agree, [{ ok: true, label: "Overlay models.json reads the same in pi 0.99.1's own loader as in the worker's model catalog (2 declared model(s))" }]);
	const lacks = await overlayLoaderParityChecks(file(GOOD), { pi: { version: "0.99.1", pinned: "0.99.1", read: async () => ({ loads: true, has: (p, id) => id !== "llama" }) }, checkModelsKnown });
	assert.equal(lacks.length, 1);
	assert.equal(lacks[0].warn, true);
	assert.match(lacks[0].label, /^pi 0\.99\.1's own loader and the worker's model catalog disagree about overlay models\.json: ollama\/llama: pi lacks it, the worker calls it known$/);
	const drops = await overlayLoaderParityChecks(file(GOOD), { pi: { version: "9.0.0", pinned: "9.0.0", read: async () => ({ loads: false, has: () => false }) }, checkModelsKnown });
	assert.match(drops[0].label, /pi drops the file and the worker reads it; ollama\/qwen: pi lacks it/);
	const notInstalled = await overlayLoaderParityChecks(file(GOOD), { pi: null, checkModelsKnown });
	assert.equal(notInstalled[0].ok, true);
	assert.match(notInstalled[0].label, /not compared with pi's own loader: pi-coding-agent is not installed beside the worker/);
	const thrown = await overlayLoaderParityChecks(file(GOOD), { pi: { version: "0.99.1", pinned: "0.99.1", read: async () => Promise.reject(Object.assign(new Error("x"), { code: "EACCES" })) }, checkModelsKnown });
	assert.match(thrown[0].label, /could not be compared .*\(EACCES\)/);
});

// Resolved synchronously, never with a top-level await: a file that awaits before declaring its tests lets the
// temp-dir helper's root after() hook run first, and every directory made after it stays in TMPDIR (measured).
let piResolvable = true;
try {
	import.meta.resolve("@earendil-works/pi-coding-agent");
} catch {
	piResolvable = false;
}
if (!piResolvable && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") throw new Error("pi-coding-agent must resolve from the worker in CI: doctor's parity line would never run there");

test("parity with the real pi beside the worker: a valid, an invalid and a non-composing file all agree, and nothing is left in TMPDIR", { skip: piResolvable ? false : "pi-coding-agent not installed at the workspace root" }, async () => {
	const realPi = await loadPiModelLoader();
	assert.ok(realPi, "the loader resolves where the package does");
	const before = new Set(readdirSync(tmpdir()).filter((n) => n.startsWith("pi-dispatch-doctor-models-")));
	const offline = process.env.PI_OFFLINE;
	for (const doc of [GOOD, '{ "providers": { "o": { "models": [ { "id": 7 } ] } } }', { providers: { ollama: { models: [{ id: "qwen" }] } } }, '﻿// a comment\n{ "providers": {} }']) {
		const checks = await overlayLoaderParityChecks(file(doc), { pi: realPi, checkModelsKnown });
		assert.equal(checks.length, 1);
		assert.equal(checks[0].ok, true, checks[0].label);
		assert.match(checks[0].label, /reads the same in pi \d+\.\d+\.\d+'s own loader/);
	}
	const after = readdirSync(tmpdir()).filter((n) => n.startsWith("pi-dispatch-doctor-models-") && !before.has(n));
	assert.deepEqual(after, [], "the auth directory is removed");
	assert.equal(process.env.PI_OFFLINE, offline, "PI_OFFLINE is restored");
});

// ── doctor: the deployment's settings, as a job resolves them ────────────────────────────────────────────

test("deploymentSettingsOf: the overlay over env, env when the overlay is invalid or breaks the dollar rule", () => {
	const dir = tempDir("pi-deploy-settings-");
	const settings = join(dir, "settings.json");
	const env = { PI_MAX_COST_USD: "2", PI_DAILY_COST_USD: "", PI_MODEL: "claude-haiku-4-5" };
	const exists = (p) => p === settings;
	assert.deepEqual(deploymentSettingsOf(env, settings, () => false), { provider: "anthropic", model: "claude-haiku-4-5", maxCostUsd: "2", dailyCostUsd: null, weeklyCostUsd: null, monthlyCostUsd: null });
	writeFileSync(settings, JSON.stringify({ maxCostUsd: "3", weeklyCostUsd: "30", provider: "openai" }));
	const merged = deploymentSettingsOf(env, settings, exists);
	assert.equal(merged.maxCostUsd, "3");
	assert.equal(merged.weeklyCostUsd, "30");
	assert.equal(merged.provider, "openai");
	writeFileSync(settings, "{ not json");
	assert.equal(deploymentSettingsOf(env, settings, exists).maxCostUsd, "2", "an invalid overlay: env, the worker's fallback");
	writeFileSync(settings, JSON.stringify({ dailyCostUsd: "5" }));
	assert.equal(deploymentSettingsOf({}, settings, exists).dailyCostUsd, null, "a window without a cap: env, the worker's fallback");
});

// ── PR #551's review ─────────────────────────────────────────────────────────────────────────────────────

test("the floor carries the runner's service-tier multiplier, derived from the runner's own bound on every priced api", () => {
	// A table that prices output only, with 1,000 output tokens: the runner's bound is then 1,000 x its multiplier.
	const flat = (api, id) => ({ id, api, provider: "x", baseUrl: "http://x", maxTokens: 1000, cost: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0 } });
	for (const api of PRICED_APIS) {
		for (const id of ["gpt-5.5", "some-model"]) {
			const runner = callCostBound("streamSimple", flat(api, id), { systemPrompt: "" }, {}, {}) / 1000;
			assert.equal(serviceTierMultiplier(flat(api, id)), runner, `${api} ${id}`);
		}
	}
	// The case the review found: openai/gpt-5.5 under $5 refuses every call, and doctor now says so.
	const model = builtinModel("openai", "gpt-5.5");
	assert.equal(serviceTierMultiplier(model), 2.5);
	const checks = costCapFitChecks(modelSubjects({ deployment: { provider: "openai", model: "gpt-5.5", maxCostUsd: "5" } }), (ref) => boundModelOf(ref, { builtinModel }));
	assert.equal(checks.length, 1);
	assert.match(checks[0].label, /openai\/gpt-5\.5 \(the main model/);
});

test("fpUsd covers PI_ALLOWED_MODELS through the model rows a job without its own list reserves in, as counters only", () => {
	const rows = v2([{ scope: "model:openai/gpt-4o", dayUsd: "3" }, { scope: "model:anthropic/claude-haiku-4-5", dayUsd: "3" }]);
	const none = usdFingerprint(SETTINGS, rows, null);
	const gpt = usdFingerprint(SETTINGS, rows, ["openai/gpt-4o"]);
	assert.notEqual(gpt, none, "a list that reserves in fewer rows admits differently");
	assert.notEqual(gpt, usdFingerprint(SETTINGS, rows, ["anthropic/claude-haiku-4-5"]));
	assert.equal(usdFingerprint(SETTINGS, rows, ["openai/gpt-4o", "openai/o3"]), gpt, "a listed model with no row reserves nothing more");
	assert.equal(usdFingerprint(SETTINGS, rows, ["openai/gpt-4o", "anthropic/claude-haiku-4-5"]), none, "listing every row reserves as no list does");
	assert.equal(usdFingerprint(SETTINGS, [], ["openai/gpt-4o"]), usdFingerprint(SETTINGS, [], null), "no model rows: a list changes no reservation");
	const input = usdFingerprintInput(SETTINGS, rows, ["openai/gpt-4o"]);
	assert.equal(input.untargeted.length, 1);
	assert.match(input.untargeted[0], /^budget:usd:mdl:[0-9a-f]{16}$/);
	assert.ok(!JSON.stringify(input).includes("gpt-4o"), "never a model id");
});

test("the loader holds pi offline while it asks, restores the variable, and reports the worker's pin", async () => {
	const root = tempDir("pi-fake-agent-");
	mkdirSync(join(root, "dist", "core"), { recursive: true });
	writeFileSync(join(root, "package.json"), JSON.stringify({ version: "0.42.0" }));
	writeFileSync(join(root, "dist", "index.js"), "export {};\n");
	writeFileSync(join(root, "dist", "core", "model-config.js"), "export class ModelConfig { static async load() { return { getError: () => undefined }; } }\n");
	writeFileSync(join(root, "dist", "core", "model-runtime.js"), "export const seen = []; export class ModelRuntime { static async create(o) { seen.push([process.env.PI_OFFLINE, o.authPath, o.credentials?.memory, o.modelsStore?.memory]); return { getModel: () => ({}) }; } }\n");
	writeFileSync(join(root, "dist", "core", "auth-storage.js"), "export class AuthStorage { static inMemory() { return { memory: true }; } }\n");
	writeFileSync(join(root, "dist", "core", "models-store.js"), "export class InMemoryCodingAgentModelsStore { memory = true; }\n");
	const pkg = join(root, "worker-package.json");
	writeFileSync(pkg, JSON.stringify({ dependencies: { "@earendil-works/pi-ai": "0.99.1" } }));
	const before = process.env.PI_OFFLINE;
	const pi = await loadPiModelLoader({ resolveEntry: () => pathToFileURL(join(root, "dist", "index.js")).href, workerPackage: pathToFileURL(pkg) });
	assert.equal(pi.version, "0.42.0");
	assert.equal(pi.pinned, "0.99.1");
	const answer = await pi.read(join(root, "models.json"));
	assert.equal(answer.loads, true);
	const { seen } = await import(pathToFileURL(join(root, "dist", "core", "model-runtime.js")).href);
	assert.deepEqual(seen, [["1", undefined, true, true]], "the runtime was created with PI_OFFLINE=1, in-memory stores and no auth path");
	assert.equal(process.env.PI_OFFLINE, before, "and the variable is restored");
	// PR #551's review: a pi that is not the pin is never compared.
	const other = await overlayLoaderParityChecks(file(GOOD), { pi, checkModelsKnown });
	assert.deepEqual(other, [{ ok: true, label: "Overlay models.json was not compared with pi's own loader: pi 0.42.0 beside the worker is not the worker's pinned pi-ai 0.99.1" }]);
});

test("the per-model comparison reads a JSONC overlay as pi does", async () => {
	const jsonc = `\uFEFF// models\n${JSON.stringify(GOOD, null, 2).replace("{", "{ // note\n")}\n`;
	const checks = await overlayLoaderParityChecks(file(jsonc), { pi: { version: "0.99.1", pinned: "0.99.1", read: async () => ({ loads: true, has: () => true }) }, checkModelsKnown });
	assert.match(checks[0].label, /\(2 declared model\(s\)\)$/);
});

test("the deployment's own default model and PI_ALLOWED_MODELS are judged, since a typo there refuses every job", () => {
	const typo = unknownModelChecks(modelSubjects({ deployment: { ...DEPLOY, model: "claude-sonet-4-5" } }), checkModelsKnown, () => null);
	assert.equal(typo.length, 1);
	assert.match(typo[0].label, /^The deployment's default model .*anthropic\/claude-sonet-4-5 \(not-in-catalog\)/);
	const listTypo = unknownModelChecks(modelSubjects({ deployment: DEPLOY, envList: ["anthropic/claude-sonnet-4-5-20250929", "openai/gpt-4oo"] }), checkModelsKnown, () => null);
	assert.match(listTypo[0].label, /openai\/gpt-4oo \(not-in-catalog\)/);
	assert.deepEqual(unknownModelChecks(modelSubjects({ deployment: DEPLOY }), checkModelsKnown, () => null), [], "the default deployment is known");
	// A broken overlay refuses the default model too, and the overlay lines say so: this line must not blame .env.
	const broken = () => {
		throw Object.assign(new Error("schema"), { piDispatchConfig: true });
	};
	assert.deepEqual(unknownModelChecks(modelSubjects({ deployment: DEPLOY }), checkModelsKnown, broken), [], "an overlay reason is not the deployment's line");
});

test("the counter scan finds a budget:usd key on a live Valkey, and answers false when it cannot ask", { skip: process.env.VALKEY_TEST_URL ? false : "needs VALKEY_TEST_URL" }, async () => {
	const { makeRedisClient } = await import("../src/connection.mjs");
	const client = makeRedisClient(process.env.VALKEY_TEST_URL, { failFast: true, lazyConnect: true });
	client.on("error", () => {});
	await client.connect();
	const key = `budget:usd:fleet-scan-test-${process.pid}-${Date.now()}`;
	try {
		await client.set(key, "1", "PX", 60_000);
		assert.equal(await defaultDollarKeysExist(process.env.VALKEY_TEST_URL), true);
	} finally {
		await client.del(key);
		client.disconnect();
	}
	assert.equal(await defaultDollarKeysExist("redis://127.0.0.1:1"), false, "an unreachable Valkey adds no warning");
});

test("the counter probe asks the deployment's current keys first, then scans, and stops at its deadline", async () => {
	const now = () => new Date("2026-10-07T12:00:00Z"); // a Wednesday
	const calls = [];
	const client = (existing, pages) => ({
		exists: async (...keys) => (calls.push(["exists", ...keys]), existing),
		scan: async (cursor) => {
			calls.push(["scan", cursor]);
			const page = pages[Number(cursor)];
			return [page.next, page.keys];
		},
	});
	assert.equal(await dollarKeysExistWith(client(1, []), { now }), true);
	assert.deepEqual(calls[0], ["exists", "budget:usd:2026-10-07", "budget:usd:w:2026-10-05", "budget:usd:m:2026-10"], "the deployment's own day, week and month keys");
	calls.length = 0;
	const third = [{ next: "1", keys: [] }, { next: "2", keys: [] }, { next: "0", keys: ["budget:usd:s:0123456789abcdef:2026-10-07"] }];
	assert.equal(await dollarKeysExistWith(client(0, third), { now }), true, "found on the third pass");
	assert.deepEqual(calls.filter((c) => c[0] === "scan").map((c) => c[1]), ["0", "1", "2"]);
	assert.equal(await dollarKeysExistWith(client(0, [{ next: "0", keys: [] }]), { now }), false, "a full scan with nothing");
	const hung = { exists: () => new Promise(() => {}), scan: () => new Promise(() => {}) };
	const started = Date.now();
	assert.equal(await dollarKeysExistWith(hung, { now, deadlineMs: 50 }), false, "a call that never answers is not seen");
	assert.ok(Date.now() - started < 2000);
	assert.equal(await dollarKeysExistWith({ exists: async () => Promise.reject(new Error("x")), scan: async () => ["0", []] }, { now }), false, "a fault is false");
});

test("the worker's pinned pi-ai is the runner's pi-coding-agent pin, which is the image's", async () => {
	const { readFileSync } = await import("node:fs");
	const worker = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
	const runner = JSON.parse(readFileSync(new URL("../../image/runner/package.json", import.meta.url), "utf8"));
	assert.equal(worker.dependencies["@earendil-works/pi-ai"], runner.dependencies["@earendil-works/pi-coding-agent"]);
});

test("the real loader writes nothing: no temporary directory, and nothing beside the overlay file", { skip: piResolvable ? false : "pi-coding-agent not installed at the workspace root" }, async () => {
	const pi = await loadPiModelLoader();
	const dir = tempDir("pi-loader-disk-");
	const path = join(dir, "models.json");
	writeFileSync(path, JSON.stringify(GOOD));
	const before = new Set(readdirSync(tmpdir()));
	for (let i = 0; i < 5; i++) await pi.read(path);
	await new Promise((resolve) => setTimeout(resolve, 300)); // a late write by work pi left running would land here
	assert.deepEqual(readdirSync(dir), ["models.json"], "no auth.json, no models-store.json beside the overlay");
	// Only the loader's own shapes: other test files run beside this one in the same TMPDIR (CI measured a
	// `pi-fix-auth-*` directory of another file here), so a broad pattern would name their directories.
	const added = readdirSync(tmpdir()).filter((n) => !before.has(n) && (n.startsWith("pi-dispatch-doctor-models-") || n === "auth.json" || n === "models-store.json"));
	assert.deepEqual(added, [], "nothing in TMPDIR");
});
