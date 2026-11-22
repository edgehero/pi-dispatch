/**
 * Offline proof of the `subscriptionAllowance` capability (issue #1008) against the image's own runner code: the runner
 * reads PI_SUBSCRIPTION_ALLOWANCE_MICROS (parseRunnerEnv), a subscription call that would take the settled list price
 * past it is refused and stops the job as `subscription-allowance` through the real runtime wrapper and meter, an
 * API-key call is never judged by it, and an allowance the runner cannot apply refuses as `cost-cap-unenforceable`. No
 * network, no provider and no credential: the runtime is a fake that answers each call with a priced usage block.
 */
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { parseRunnerEnv } from "../../src/config.mjs";
import { COST_CAP_UNENFORCEABLE, decideExit, SUBSCRIPTION_ALLOWANCE } from "../../src/outcome.mjs";
import { assertPoliciesEnforceable, createAllowanceGuard, createPolicyGuard, createUsageMeter, makeHardStopStream, STOP_MESSAGES, wrapModelRuntime } from "../../src/usage-meter.mjs";

export async function verifySubscriptionAllowance() {
	const cfg = parseRunnerEnv({ PI_PROVIDER: "anthropic", PI_MODEL: "claude-fixture", PI_MAX_TURNS: "1", PI_SUBSCRIPTION_ALLOWANCE_MICROS: "2000000" });
	assert.equal(cfg.subscriptionAllowanceMicros, 2_000_000, "the runner reads the allowance");
	const subscription = { provider: "anthropic", id: "claude-fixture", api: "anthropic-messages" };
	const billed = { provider: "openrouter", id: "vendor/fixture", api: "openai-completions" };
	const allowedModels = [subscription, billed].map(({ provider, id }) => ({ provider, model: id }));
	const notional = new Set(["anthropic"]);
	const meter = createUsageMeter({ maxTokens: null, allowedModels, notionalProviders: notional });
	// The policy guard run-job builds installs the allowance whenever one is set, so the runner can enforce it.
	const policy = createPolicyGuard({ allowanceMicros: cfg.subscriptionAllowanceMicros, settledNotional: () => meter.notionalMicros(), notional });
	assert.deepEqual(policy.enforces, [SUBSCRIPTION_ALLOWANCE]);
	assert.doesNotThrow(() => assertPoliciesEnforceable({ allowanceMicros: cfg.subscriptionAllowanceMicros, meterOk: true, brake: true, enforces: policy.enforces }));
	assert.throws(() => assertPoliciesEnforceable({ allowanceMicros: cfg.subscriptionAllowanceMicros, meterOk: true, brake: false, enforces: policy.enforces }), (error) => error.piDispatchReason === COST_CAP_UNENFORCEABLE);
	// The allowance part itself, handed the set the model half and the admission prove in a real job.
	const guard = createAllowanceGuard({ allowanceMicros: cfg.subscriptionAllowanceMicros, notional, settled: () => meter.notionalMicros() });
	const sent = [];
	class FakeRuntime {
		streamSimple(model) {
			sent.push(model.provider);
			return { result: () => Promise.resolve({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "ok" }], usage: { input: 1, output: 1, totalTokens: 2, cost: { total: model.provider === "anthropic" ? 1.5 : 0.25 } } }) };
		}
	}
	const hardStop = makeHardStopStream({ createStream: () => ({ push() {}, end(message) { this.message = message; }, result() { return Promise.resolve(this.message); } }) });
	const layer = wrapModelRuntime({ ModelRuntime: FakeRuntime, meter, hardStop, guard });
	try {
		const runtime = new FakeRuntime();
		const settle = () => new Promise((resolve) => setImmediate(resolve));
		await runtime.streamSimple(billed, {}, {}).result();
		await settle();
		assert.equal(meter.notionalMicros(), 0, "an API-key call is never notional");
		for (let i = 0; i < 2; i++) {
			await runtime.streamSimple(subscription, {}, {}).result();
			await settle();
		}
		assert.equal(meter.notionalMicros(), 3_000_000, "$3.00 of list price settled, past the $2.00 allowance");
		const refused = await runtime.streamSimple(subscription, {}, {}).result();
		assert.equal(refused.errorMessage, STOP_MESSAGES[SUBSCRIPTION_ALLOWANCE]);
		assert.deepEqual(sent, ["openrouter", "anthropic", "anthropic"], "the refused call never reached a provider");
		assert.deepEqual(decideExit({ budgetAborted: false, meterStop: meter.state.stopReason }), { code: 2, reason: "subscription-allowance" });
	} finally {
		layer.restore();
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	await verifySubscriptionAllowance();
	console.log("subscription allowance capability holds");
}
