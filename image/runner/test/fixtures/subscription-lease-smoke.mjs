/** Offline proof against the image's pinned runtime: near-expiry requests and a real credential-drop application. */
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { verifySubscriptionAuthEntries } from "../../src/community-auth-adapter.mjs";
import { installSubscriptionCredentials } from "../../src/subscription-credentials.mjs";
import { createCredentialRefresher, parseCredentialDrop } from "../../src/credential-refresh.mjs";

export async function verifySubscriptionLease() {
	const minute = 60_000;
	const issued = 1_800_000_000_000;
	let at = issued + 55 * minute;
	const now = () => at;
	const entries = [{ provider: "openai", connectionId: "lease-proof", adapter: "openai-chatgpt", generation: 1, expiresAt: issued + 60 * minute, deadlineAt: issued + 59 * minute - 1 }];
	verifySubscriptionAuthEntries(entries, { now });
	const env = { OPENAI_API_KEY: "synthetic.original.oauth.access" };
	const runtime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false, credentials: { async read() { return { type: "api_key", key: "unselected-api-key" }; }, async list() { return []; }, async modify() {}, async delete() {} } });
	const guard = installSubscriptionCredentials({ ModelRuntime, entries, env, now });
	try {
		const model = runtime.getModels("openai").find((row) => row.api === "openai-responses");
		assert.ok(model, "the pinned runtime must contain the admitted Responses route");
		assert.equal((await runtime.prepareRequest(model, {})).options.apiKey, env.OPENAI_API_KEY, "a valid lease is usable inside the former five-minute cutoff");
		const renewed = { provider: "openai", connectionId: "lease-proof", generation: 2, expiresAt: at + 60 * minute, deadlineAt: at + 30 * minute, token: "synthetic.replacement.oauth.access" };
		const drop = parseCredentialDrop(JSON.stringify({ v: 1, seq: 1, forge: null, subscriptions: [renewed] }));
		assert.ok(drop);
		const reader = createCredentialRefresher({ read: () => drop, env, subscriptions: guard });
		assert.equal(reader.apply(), true);
		at = issued + 65 * minute;
		assert.equal((await runtime.prepareRequest(model, {})).options.apiKey, renewed.token, "a request beyond the original expiry uses the applied replacement");
		assert.equal((await runtime.getAuth(model, {})).auth.apiKey, renewed.token);
		assert.equal(reader.apply(), false, "the same drop is applied once");
		at = renewed.deadlineAt;
		await assert.rejects(runtime.prepareRequest(model, {}), /auth-request-override/, "the renewed local deadline still bounds requests");
		return true;
	} finally {
		guard.uninstall();
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	await verifySubscriptionLease();
	console.log("SUBSCRIPTION-LEASE-VERIFIED");
}
