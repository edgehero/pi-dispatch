import assert from "node:assert/strict";
import { test } from "node:test";
import { estimateReserve, zeroRatedFor } from "../src/reserve-estimate.mjs";
import { effectiveJobOf } from "../src/index.mjs";
import { allowedModelsFrom } from "../src/config.mjs";
import { resolveSettings } from "../src/runtime-settings.mjs";

// Issue #642: the console's reserve figure is the worker's own rule. These pin the inputs the worker reads that the
// estimate must read the same way: the deployment's allowed-model list, overlay over env, and an empty env value.

const USD = 1_000_000;
const forge = { kind: "github", repo: "org/repo", target: { type: "issue", number: 7 }, flow: "fix" };
/** One declared endpoint serving `local-ollama/q` at zero cost: the only zero-rated model here. */
const modelEndpoints = { endpoints: [{ id: "mac-ollama", host: "host.docker.internal", port: 11434, slots: 2, keyless: true }], models: { providers: { "local-ollama": { api: "openai-completions", baseUrl: "http://host.docker.internal:11434/v1", apiKey: "$PI_DISPATCH_KEYLESS", models: [{ id: "q" }] } } } };
const local = { ...forge, provider: "local-ollama", model: "q" };

/** Whether the WORKER judges `data` zero-rated under `env`/`overlay`: its own effectiveJobOf, allowed list and check. */
function workerZero(data, { env = {}, overlay = {} } = {}) {
	const settings = resolveSettings({ provider: env.PI_PROVIDER ?? "anthropic", model: env.PI_MODEL ?? "claude-sonnet-5-5", maxTurns: 20, maxCostUsd: env.PI_MAX_COST_USD === "" ? null : (env.PI_MAX_COST_USD ?? null), dailyCostUsd: null, weeklyCostUsd: null, monthlyCostUsd: null }, { overlay });
	return zeroRatedFor(effectiveJobOf(data, settings, allowedModelsFrom(env)), { modelEndpoints }).zeroRated === true;
}

test("PI_ALLOWED_MODELS is respected: a job that may switch to a priced listed model is never shown as $0", () => {
	const env = { PI_MAX_COST_USD: "2", PI_ALLOWED_MODELS: "local-ollama/q,anthropic/claude-sonnet-5-5" };
	const est = estimateReserve(local, { env, modelEndpoints });
	assert.deepEqual(est, { slots: 1, dollarsMicros: 2 * USD, capMicros: 2 * USD, zeroRated: false }, "the cap, because the list holds a hosted model");
	assert.equal(workerZero(local, { env }), false, "and the worker holds the cap for the same job");
	// A list of zero-rated models only: $0, and the worker agrees.
	const onlyLocal = { PI_MAX_COST_USD: "2", PI_ALLOWED_MODELS: "local-ollama/q" };
	assert.equal(estimateReserve(local, { env: onlyLocal, modelEndpoints }).dollarsMicros, 0);
	assert.equal(workerZero(local, { env: onlyLocal }), true);
	// The trigger's own list outranks the deployment's, as in effectiveJobOf.
	assert.equal(estimateReserve({ ...local, models: ["local-ollama/q"] }, { env, modelEndpoints }).dollarsMicros, 0);
	assert.equal(workerZero({ ...local, models: ["local-ollama/q"] }, { env }), true);
});

test("an empty PI_ALLOWED_MODELS is unset, and a list the worker would refuse names the cap (never a smaller figure)", () => {
	assert.equal(estimateReserve(local, { env: { PI_MAX_COST_USD: "2", PI_ALLOWED_MODELS: "" }, modelEndpoints }).dollarsMicros, 0, "empty: no list, the main model alone");
	assert.deepEqual(estimateReserve(local, { env: { PI_MAX_COST_USD: "2", PI_ALLOWED_MODELS: "local-ollama/q, anthropic/x" }, modelEndpoints }), { slots: 1, dollarsMicros: 2 * USD, capMicros: 2 * USD, zeroRated: false });
});

test("overlay over env, per key: the overlay's maxCostUsd and model win over PI_MAX_COST_USD and PI_MODEL", () => {
	const env = { PI_MAX_COST_USD: "2", PI_PROVIDER: "anthropic", PI_MODEL: "claude-sonnet-5-5" };
	assert.equal(estimateReserve(forge, { overlay: { maxCostUsd: "0.75" }, env }).capMicros, 750_000, "the overlay's cap, not env's");
	// The overlay names the zero-rated model; env names a hosted one. The overlay's is the one the job runs, so $0.
	const overlay = { provider: "local-ollama", model: "q" };
	assert.equal(estimateReserve(forge, { overlay, env, modelEndpoints }).dollarsMicros, 0);
	assert.equal(workerZero(forge, { overlay, env }), true, "the worker runs the overlay's model too");
	// And the other way round: env's zero-rated model is outranked by the overlay's hosted one.
	const envLocal = { PI_MAX_COST_USD: "2", PI_PROVIDER: "local-ollama", PI_MODEL: "q" };
	const hosted = { provider: "anthropic", model: "claude-sonnet-5-5" };
	assert.equal(estimateReserve(forge, { overlay: hosted, env: envLocal, modelEndpoints }).dollarsMicros, 2 * USD);
	assert.equal(workerZero(forge, { overlay: hosted, env: envLocal }), false);
	// The job's own model outranks both.
	assert.equal(estimateReserve(local, { overlay: hosted, env, modelEndpoints }).dollarsMicros, 0);
});

test("an empty PI_MAX_COST_USD is unset: no cap and no throw, so the overlay's cap or none applies", () => {
	assert.deepEqual(estimateReserve(forge, { env: { PI_MAX_COST_USD: "" } }), { slots: 1, dollarsMicros: null, capMicros: null, zeroRated: false });
	assert.equal(estimateReserve(forge, { env: { PI_MAX_COST_USD: "" }, overlay: { maxCostUsd: "1" } }).capMicros, USD);
	assert.equal(estimateReserve({ ...forge, maxCostUsd: "0.5" }, { env: { PI_MAX_COST_USD: "" } }).capMicros, 500_000, "a trigger-only cap applies alone");
});
