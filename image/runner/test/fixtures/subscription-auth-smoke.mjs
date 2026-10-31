/** Offline image proof: real receipt rejection and final shaped-body cost enforcement, no provider dispatch. */
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { verifySubscriptionAuthEntries, validateSubscriptionRequest } from "../../src/community-auth-adapter.mjs";
import { createCostGuard } from "../../src/usage-meter.mjs";

export async function verifySubscriptionCapability(root) {
	const at = 1_800_000_000_000, now = () => at;
	const entry = { provider: "openai", adapter: "openai-chatgpt", connectionId: "proof", generation: 1, expiresAt: at + 3_600_000, deadlineAt: at + 1_800_000 };
	assert.equal(verifySubscriptionAuthEntries([entry], { now }).length, 1);
	assert.throws(() => verifySubscriptionAuthEntries([{ ...entry, expiresAt: at }], { now }), /auth-snapshot-expired/);
	assert.equal(validateSubscriptionRequest({ provider: "openai", api: "openai-responses", baseUrl: "https://different.invalid" }, [entry], { now }), false);
	// This uses the real receipt verifier. A token, a matching package name and a fabricated approval
	// receipt are not sufficient to enable an altered community transport.
	assert.throws(() => verifySubscriptionAuthEntries([{ ...entry, provider: "anthropic", adapter: "@gotgenes/pi-anthropic-auth@3.4.3", root, digest: "a".repeat(64) }], { now }), /auth-adapter-unpinned/);
	let wireCalls = 0;
	for (const oversized of [false, true]) {
		const guard = createCostGuard({ capMicros: 2000, env: {}, bound: (_method, _model, context) => context.finalPayload ? Buffer.byteLength(JSON.stringify(context.finalPayload)) : 10 });
		const model = { provider: "anthropic", id: "proof", api: "anthropic-messages" };
		const args = [{ messages: [] }, { onPayload: payload => ({ ...payload, system: "x".repeat(oversized ? 20_000 : 100) }) }];
		assert.equal(guard.admit({ method: "streamSimple", model, args }), null);
		let stopped = null;
		const prepared = guard.prepare({ method: "streamSimple", model, args, stop: reason => { stopped = reason; } });
		const send = async () => { const body = await prepared[1].onPayload({ model: "proof", max_tokens: 1, messages: [] }, model); wireCalls++; return body; };
		if (oversized) {
			await assert.rejects(send(), /cost cap reached/);
			assert.equal(stopped, "cost-cap");
			assert.equal(guard.refusedWhy(), "final-payload");
		} else {
			const sent = await send();
			assert.equal(sent.system.length, 100);
			assert.ok(guard.state.inflight > 10 && guard.state.inflight <= 2000, "shaping enlarges the same pending ticket before dispatch");
		}
	}
	assert.equal(wireCalls, 1, "only the bounded final payload reaches the fake wire");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	await verifySubscriptionCapability(process.argv[2] ?? "/job/community");
	console.log("subscription auth capability holds");
}
