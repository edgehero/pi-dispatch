import assert from "node:assert/strict";
import { test } from "node:test";
import { subscriptionRefreshFetch } from "../src/subscription-refresh-fetch.mjs";

const original = { connectionId: "claude", generation: 6, token: "sk-ant-oat-original" };
const next = { connectionId: "claude", generation: 7, token: "sk-ant-oat-renewed" };
const endpoint = "https://api.anthropic.com/v1/messages";
const request = () => ({ method: "POST", body: '{"model":"opus","max_tokens":8}', headers: { authorization: `Bearer ${original.token}`, "x-trace": "keep" } });

test("a rejected stale request retries once with a strictly newer same-connection bearer and identical payload", async () => {
	let current = original;
	const calls = [];
	const fetch = subscriptionRefreshFetch({ credentials: { issued: (_provider, token) => token === original.token ? original : null, current: () => current }, sleep: async () => {}, fetch: async (url, init) => {
		calls.push({ url, body: init.body, headers: Object.fromEntries(new Headers(init.headers)) });
		current = next;
		return new Response("", { status: calls.length === 1 ? 401 : 200 });
	} });
	assert.equal((await fetch(endpoint, request())).status, 200);
	assert.equal(calls.length, 2);
	assert.equal(calls[0].body, calls[1].body); assert.equal(calls[0].url, calls[1].url);
	assert.equal(calls[1].headers.authorization, `Bearer ${next.token}`);
	assert.equal(calls[1].headers["x-trace"], "keep");
});

test("rotation after shaping but before fetch uses the current bearer without a failed attempt", async () => {
	let sent;
	const fetch = subscriptionRefreshFetch({ credentials: { issued: () => original, current: () => next }, fetch: async (_url, init) => { sent = new Headers(init.headers).get("authorization"); return new Response("", { status: 200 }); } });
	await fetch(endpoint, request());
	assert.equal(sent, `Bearer ${next.token}`);
});

test("current revocation, other status/connection, absent authority, expiry and nonreplayable requests never retry", async () => {
	for (const patch of [{ current: original }, { current: { ...next, connectionId: "other" } }, { current: { ...next, generation: 6 } }, { current: { ...next, token: original.token } }, { current: null }, { status: 403 }, { status: 429 }, { status: 500 }, { status: 200 }, { url: "https://elsewhere.invalid/v1/messages" }, { body: new Uint8Array([1]) }, { bearer: "unissued-token" }]) {
		let calls = 0;
		let at = original;
		const fetch = subscriptionRefreshFetch({ credentials: { issued: (_provider, token) => token === original.token ? original : null, current: () => at }, checks: 1, sleep: async () => {}, fetch: async () => { calls++; at = Object.hasOwn(patch, "current") ? patch.current : next; return new Response("", { status: patch.status ?? 401 }); } });
		const init = { ...request(), ...(Object.hasOwn(patch, "body") ? { body: patch.body } : {}), ...(patch.bearer ? { headers: { authorization: `Bearer ${patch.bearer}` } } : {}) };
		await fetch(patch.url ?? endpoint, init);
		assert.equal(calls, 1, JSON.stringify(patch));
	}
});

test("a second 401 and an aborted request cannot repeat the provider call", async () => {
	let current = original;
	let calls = 0;
	const fetch = subscriptionRefreshFetch({ credentials: { issued: () => original, current: () => current }, sleep: async () => {}, fetch: async () => { calls++; current = next; return new Response("", { status: 401 }); } });
	assert.equal((await fetch(endpoint, request())).status, 401); assert.equal(calls, 2);
	const abort = new AbortController(); abort.abort();
	await assert.rejects(fetch(endpoint, { ...request(), signal: abort.signal }), { name: "AbortError" });
	assert.equal(calls, 2);
});

test("an event-loop delay beyond the recovery deadline cannot turn a late generation into retry authority", async () => {
	let at = 0;
	let current = original;
	let calls = 0;
	const fetch = subscriptionRefreshFetch({ credentials: { issued: () => original, current: () => current }, now: () => at, sleep: async () => { at = 2000; current = next; }, fetch: async () => { calls++; return new Response("", { status: 401 }); } });
	assert.equal((await fetch(endpoint, request())).status, 401);
	assert.equal(calls, 1);
});
