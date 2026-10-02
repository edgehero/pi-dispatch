import { test } from "node:test";
import assert from "node:assert/strict";
import { getAllBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { readFileSync } from "node:fs";
import { configError } from "../src/config.mjs";
import { MODEL_REF_PATTERN, PROVIDER_REF_PATTERN, validateModelRef } from "../src/model-ref.mjs";
import { parseExitUsage } from "../src/run-history.mjs";
import { parseTriggers, validateModelRef as reexported } from "../src/triggers.mjs";

const isRecordableModelId = (id) => typeof id === "string" && MODEL_REF_PATTERN.test(id);

/**
 * The record's model-id allowlist (issues #501, #502). The ledger used to refuse 55 builtin catalog ids, and
 * one refused row nulls the whole `usage` block, so a job on one of those models recorded no ledger. These
 * pin both halves: everything the pinned catalog can name passes, and the shapes the first-character rule
 * exists for still fail.
 */

test("every builtin provider and model id at the pin is recordable (the catalog is the oracle, not a sample)", () => {
	const refused = [];
	let ids = 0;
	for (const provider of getBuiltinProviders()) {
		if (!isRecordableModelId(provider.toLowerCase())) refused.push(provider);
		for (const model of getAllBuiltinModels(provider)) {
			ids += 1;
			if (!isRecordableModelId(model.id.toLowerCase())) refused.push(`${provider}/${model.id}`);
		}
	}
	assert.ok(ids > 1000, `the catalog walk found ${ids} ids: the enumeration is reading nothing`);
	assert.deepEqual(refused, [], "a builtin id the ledger refuses nulls the whole usage block of every job on it");
});

test("the shapes the widening was for: @cf, ~alias, @ inside, underscore tags", () => {
	for (const id of ["@cf/meta/llama-3.3-70b-instruct-fp8-fast", "workers-ai/@cf/openai/gpt-oss-20b", "~anthropic/claude-sonnet-latest", "qwen2.5:0.5b-instruct-q4_k_m", "a".repeat(64), "~".concat("a".repeat(63))]) {
		assert.ok(isRecordableModelId(id), id);
	}
});

test("still refused: path shapes at character one, a doubled prefix, foreign characters, over 64", () => {
	for (const id of ["", ".hidden", "../etc", "/abs", ":x", "~~x", "@@x", "~@x", "~.x", "@/x", "bad provider!", "a\\b", "a\"b", "a\nb", "A", "a".repeat(65), `~${"a".repeat(64)}`, 7, null]) {
		assert.equal(isRecordableModelId(id), false, JSON.stringify(id));
	}
	assert.equal(MODEL_REF_PATTERN.flags, "", "applied to lowercased ids: no i flag, so uppercase is refused, never folded here");
});

// Issue #502 part 1: run.provider, run.model and run.maxTurns on every trigger kind, validated at load.

const PATH = "/triggers.json";
const parse = (triggers) => parseTriggers(JSON.stringify({ triggers }), PATH);
const isConfigError = (e) => e.piDispatchConfig === true;

// One entry per normalizer, and the three non-github forges for the kinds they have. Every one loads clean
// as written, so a refusal below is the field under test and nothing else.
const KINDS = {
	cron: { on: { type: "cron", id: "nightly", pattern: "0 3 * * *" }, run: { kind: "local", folder: "/proj", flow: "tidy", task: "t" } },
	label: { on: { type: "label", any: ["pi:go"] }, run: { kind: "github", flow: "fix" } },
	comment: { on: { type: "comment", phrase: "@pi" }, run: { kind: "github", flow: "fix" } },
	issue: { on: { type: "issue", action: ["closed"] }, run: { kind: "github", flow: "fix" } },
	pull_request: { on: { type: "pull_request", action: ["opened"] }, run: { kind: "github", flow: "review" } },
	"gitlab label": { on: { type: "label", any: ["pi:go"] }, run: { kind: "gitlab", flow: "fix" } },
	"forgejo pull_request": { on: { type: "pull_request", action: ["opened"] }, run: { kind: "forgejo", flow: "review" } },
	"azure comment": { on: { type: "comment", phrase: "@pi" }, run: { kind: "azure", flow: "fix", repository: "repo" } },
};
const withRun = (entry, extra) => ({ on: entry.on, run: { ...entry.run, ...extra } });
const refused = (entry, pattern) => assert.throws(() => parse([entry]), (e) => isConfigError(e) && pattern.test(e.message));

test("the trigger loader and the run-history ledger use the SAME model-id rule, not two copies (#502)", () => {
	// One constant, imported by both: run-history.mjs reads MODEL_REF_PATTERN from this module, and the
	// trigger validator lives in it. Asserted from the source so a second literal cannot creep back in.
	const historySrc = readFileSync(new URL("../src/run-history.mjs", import.meta.url), "utf8");
	assert.match(historySrc, /import \{ MODEL_REF_PATTERN as USAGE_ID_PATTERN \} from "\.\/model-ref\.mjs";/);
	assert.equal(/\[a-z0-9\]\[a-z0-9\._:/.test(historySrc), false, "run-history.mjs must not carry its own id regex");
	assert.equal(reexported, validateModelRef, "the console reaches the loader's validator, not a copy");

	// And behaviourally: over every ASCII id shape both tests use, a trigger accepts a model exactly when
	// the ledger keeps a usage row for it. Non-ASCII is left out on purpose: the trigger refuses it before
	// lowercasing (the Kelvin sign lowercases to `k`), which makes the trigger STRICTER, never looser.
	const ledgerKeeps = (id) => parseExitUsage(JSON.stringify({ event: "exit", usage: { v: 1, models: [{ provider: "openai", model: id }] } })) !== null;
	const triggerTakes = (id) => {
		try {
			validateModelRef({ model: id }, "at", PATH);
			return true;
		} catch {
			return false;
		}
	};
	const ids = ["@cf/meta/llama-3.3-70b-instruct-fp8-fast", "workers-ai/@cf/openai/gpt-oss-20b", "~anthropic/claude-sonnet-latest", "qwen2.5:0.5b-instruct-q4_K_M", "Qwen/Qwen3-Coder:free", "GPT-5.4", "a".repeat(64), "a".repeat(65), "~".concat("a".repeat(63)), "", ".hidden", "../etc", "/abs", ":x", "~~x", "@@x", "~@x", "~.x", "@/x", "bad provider!", "a\\b", "a\"b", "gpt*", "-gpt"];
	for (const id of ids) assert.equal(triggerTakes(id), ledgerKeeps(id), JSON.stringify(id));
});

test("every builtin provider id at the pin passes the trigger's provider rule (#502)", () => {
	const refused = getBuiltinProviders().filter((p) => !PROVIDER_REF_PATTERN.test(p.toLowerCase()));
	assert.ok(getBuiltinProviders().length > 10);
	assert.deepEqual(refused, [], "a provider a trigger cannot name is a provider no trigger can choose");
});

test("validateModelRef's refusal has configError's shape, built without importing config.mjs", () => {
	assert.throws(() => validateModelRef({ model: "gpt 5" }, "at", PATH), (e) => e instanceof Error && e.piDispatchConfig === true && Object.keys(e).join() === Object.keys(configError("x")).join());
});

test("provider, model and maxTurns are accepted on every kind and carried in the normalized run", () => {
	for (const [name, entry] of Object.entries(KINDS)) {
		const [t] = parse([withRun(entry, { provider: "openai", model: "gpt-5.4", maxTurns: 7 })]);
		assert.equal(t.run.provider, "openai", name);
		assert.equal(t.run.model, "gpt-5.4", name);
		assert.equal(t.run.maxTurns, 7, name);
	}
});

test("null is absent on every kind: it loads, and means the deployment default as it did before #502", () => {
	// A hand-written cron entry's `"model": null` loaded before #502 and resolved to the default, because the
	// worker fills job fields with `??`. Refusing it now would break a file that worked, so null is absent.
	for (const [name, entry] of Object.entries(KINDS)) {
		for (const key of ["provider", "model", "maxTurns"]) {
			const [t] = parse([withRun(entry, { [key]: null })]);
			if (name === "cron") {
				// Cron keeps its long-standing present-but-undefined shape, which JSON drops.
				assert.equal(t.run[key], undefined, `${name}: ${key}`);
			} else {
				assert.equal(key in t.run, false, `${name}: a null ${key} must emit no key`);
			}
		}
		const [all] = parse([withRun(entry, { provider: null, model: null, maxTurns: null })]);
		assert.equal(JSON.stringify(all.run).includes("null"), false, `${name}: no null reaches the job`);
	}
	assert.deepEqual(validateModelRef({ provider: null, model: null, maxTurns: null }, "at", PATH), {});
});

test("absent stays absent on the forge kinds: no key, not a present-and-undefined one", () => {
	for (const [name, entry] of Object.entries(KINDS)) {
		if (name === "cron") continue; // cron's own shape carries the three present-and-undefined, unchanged
		const [t] = parse([entry]);
		for (const key of ["provider", "model", "maxTurns"]) assert.equal(key in t.run, false, `${name}: ${key}`);
	}
	// One field set adds exactly that field.
	const [t] = parse([withRun(KINDS.label, { model: "claude-sonnet-4-5" })]);
	assert.equal("provider" in t.run, false);
	assert.equal(t.run.model, "claude-sonnet-4-5");
});

test("the original case of a model id is kept; only the CHECK lowercases", () => {
	const [t] = parse([withRun(KINDS.label, { provider: "OpenRouter", model: "Qwen/Qwen3-Coder:free" })]);
	assert.equal(t.run.provider, "OpenRouter");
	assert.equal(t.run.model, "Qwen/Qwen3-Coder:free");
});

test("model ids the ledger accepts load: @cf ids and gateway paths, openrouter ~ routes, Ollama name:tag with underscore", () => {
	for (const model of ["@cf/meta/llama-3.3-70b-instruct-fp8-fast", "workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast", "~anthropic/claude-sonnet-latest", "qwen2.5_coder:0.5b", "a".repeat(64)]) {
		const [t] = parse([withRun(KINDS.label, { model })]);
		assert.equal(t.run.model, model);
	}
	assert.equal(parse([withRun(KINDS.label, { provider: "a".repeat(64) })])[0].run.provider.length, 64);
});

test("a malformed provider refuses on every kind, cron included (it loaded before #502)", () => {
	const bad = [7, "", " openai", "open ai", "openai/x", "x:y", "@cf", "~x", "-x", "a".repeat(65), "open\nai", "\u212Aimi", ["openai"], { id: "openai" }];
	for (const [name, entry] of Object.entries(KINDS)) {
		for (const provider of bad) refused(withRun(entry, { provider }), /run\.provider must be a provider id/);
		assert.ok(name);
	}
});

test("a malformed model refuses on every kind: wrong type, empty, whitespace, 65 characters, a homoglyph", () => {
	// "\u212A" is the Kelvin sign, which lowercases to an ASCII `k`: a lowercase-then-match check alone
	// would pass it through to the job verbatim.
	const bad = [7, "", "gpt 5", "gpt-5\t", "a".repeat(65), "-gpt", "~~gpt", "@@cf", "~@cf", "@~x", "@", "~", "gpt*", "\u212Aimi-k2", "gpt\u0000", false, ["gpt-5"]];
	for (const entry of Object.values(KINDS)) {
		for (const model of bad) refused(withRun(entry, { model }), /run\.model must be a model id/);
	}
});

test("maxTurns must be a positive safe integer on every kind", () => {
	for (const entry of Object.values(KINDS)) {
		for (const maxTurns of [0, -1, 1.5, "5", Number.MAX_SAFE_INTEGER + 1, true]) {
			refused(withRun(entry, { maxTurns }), /run\.maxTurns must be a positive integer/);
		}
	}
});

test("errors name the trigger index and the key, never the value", () => {
	const secretish = "sk-ant-not-a-model id";
	assert.throws(
		() => parse([KINDS.cron, withRun(KINDS.label, { model: secretish })]),
		(e) => /trigger at index 1: run\.model/.test(e.message) && !e.message.includes(secretish) && e.message.includes(PATH),
	);
	assert.throws(() => parse([withRun(KINDS.cron, { provider: 7 })]), (e) => /cron trigger "nightly": run\.provider/.test(e.message));
});

test("near misses of the model keys refuse under run, on every kind", () => {
	const misses = ["providerId", "provider_id", "Provider", "PROVIDER", "modelId", "model_id", "Model", "model-id", "allowedModels", "allowed_models", "Models", "max_turns", "maxturns", "MaxTurns", "max-cost-usd", "maxCostUSD", "m\u043Edel", "maxTurn", "max_turn", "providers", "providerIds", "model_name", "modelName", "modelNames", "allowedModel", "maxCost"];
	for (const [name, entry] of Object.entries(KINDS)) {
		for (const key of misses) {
			refused(withRun(entry, { [key]: "x" }), new RegExp(`run\\.${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} is not a field -- did you mean run\\.`));
		}
		assert.ok(name);
	}
	// And the suggestion names the right field.
	refused(withRun(KINDS.label, { providerId: "x" }), /did you mean run\.provider\?/);
	refused(withRun(KINDS.label, { modelId: "x" }), /did you mean run\.model\?/);
	refused(withRun(KINDS.label, { allowedModels: ["x"] }), /did you mean run\.models\?/);
	refused(withRun(KINDS.label, { max_turns: 3 }), /did you mean run\.maxTurns\?/);
	refused(withRun(KINDS.label, { max_cost_usd: 3 }), /did you mean run\.maxCostUsd\?/);
	refused(withRun(KINDS.label, { maxTurn: 3 }), /did you mean run\.maxTurns\?/);
	refused(withRun(KINDS.label, { providers: "x" }), /did you mean run\.provider\?/);
	refused(withRun(KINDS.label, { modelName: "x" }), /did you mean run\.model\?/);
	refused(withRun(KINDS.label, { modelNames: ["x"] }), /did you mean run\.models\?/);
});

test("a homoglyph key is pointed at the field its surviving letters actually spell", () => {
	// Cyrillic o and Cyrillic a: the suggestion names the target that matched, not a prefix guess.
	refused(withRun(KINDS.label, { "m\u043Edels": ["x"] }), /did you mean run\.models\?/);
	refused(withRun(KINDS.label, { "m\u043Edel": "x" }), /did you mean run\.model\?/);
	refused(withRun(KINDS.label, { "pr\u043Evider": "x" }), /did you mean run\.provider\?/);
	refused(withRun(KINDS.label, { "m\u0430xTurns": 3 }), /did you mean run\.maxTurns\?/);
	refused(withRun(KINDS.label, { "m\u0430xCostUsd": 3 }), /did you mean run\.maxCostUsd\?/);
});

test("the model keys refuse under on in EVERY spelling, the correct one included", () => {
	for (const entry of Object.values(KINDS)) {
		for (const key of ["provider", "model", "models", "maxTurns", "maxCostUsd", "modelId"]) {
			refused({ on: { ...entry.on, [key]: "x" }, run: entry.run }, new RegExp(`on\\.${key} is not a field`));
		}
	}
});

test("run.models and run.maxCostUsd are tolerated as unknown keys until the release that enforces them", () => {
	// The forward-compatibility posture every unknown run key gets: a file written for the later release
	// still loads here. They are NOT carried into the normalized run, so nothing downstream acts on them.
	const [t] = parse([withRun(KINDS.label, { models: ["openai/gpt-5.4"], maxCostUsd: 2 })]);
	assert.equal("models" in t.run, false);
	assert.equal("maxCostUsd" in t.run, false);
	// An unrelated unknown key, ASCII or not, still loads.
	parse([withRun(KINDS.label, { modelNotes: "x", fl\u00F6w: "x", temperature: 1 })]);
});

test("validateModelRef returns only the present fields and leaves the input alone", () => {
	assert.deepEqual(validateModelRef({}, "at", PATH), {});
	assert.deepEqual(validateModelRef(undefined, "at", PATH), {});
	const run = { provider: "anthropic", flow: "x" };
	assert.deepEqual(validateModelRef(run, "at", PATH), { provider: "anthropic" });
	assert.deepEqual(run, { provider: "anthropic", flow: "x" });
});
