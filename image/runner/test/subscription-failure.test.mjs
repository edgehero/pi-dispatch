import assert from "node:assert/strict";
import { test } from "node:test";
import { subscriptionFailureFromResponse, classifyProviderFailure, resetFromHeaders } from "../src/provider-failure.mjs";
import { providerFailureOf } from "../../../worker/src/model-failover-protocol.mjs";

const at = 1_800_000_000_000;
const now = () => at;
test("only bounded typed quota codes create durable subscription evidence", async () => {
	for (const body of [{ error: { message: "quota exhausted", type: "rate_limit_error" } }, { error: { code: "invalid_api_key" } }, { error: { code: "usage_limit_reached", message: "x".repeat(66_000) } }]) assert.equal(await subscriptionFailureFromResponse(Response.json(body, { status: 429 }), { now }), null);
	assert.equal(await subscriptionFailureFromResponse(Response.json({ error: { code: "usage_limit_reached" } }, { status: 401 }), { now }), null);
	const evidence = await subscriptionFailureFromResponse(Response.json({ error: { code: "usage_limit_reached", resets_at: (at + 7 * 86_400_000) / 1000 } }, { status: 429 }), { now });
	assert.deepEqual(evidence, { subscriptionCode: "usage_limit_reached", resetAt: at + 7 * 86_400_000 });
	const classified = classifyProviderFailure({ stopReason: "error", errorMessage: "limit" }, { status: 429, ...evidence, subscriptionProvider: "openai" });
	assert.deepEqual(providerFailureOf(classified), { kind: "quota-exhausted", ...evidence, subscriptionProvider: "openai" });
	assert.equal(providerFailureOf({ ...classified, subscriptionProvider: "attacker-text" }), null);
});
test("subscription header resets retain a full week while API model cooldowns keep their six hour ceiling", () => {
	const headers = new Headers({ "retry-after": String(7 * 86_400) });
	assert.equal(resetFromHeaders(headers, at), at + 6 * 3_600_000);
	assert.equal(resetFromHeaders(headers, at, 32 * 86_400_000), at + 7 * 86_400_000);
});
