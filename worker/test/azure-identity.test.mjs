import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveAzureSelfId } from "../src/azure-identity.mjs";

// This file did not exist until issue #316, and its absence was found by a mutation check rather than by
// reading: three separate reversions of azure-identity.mjs left the whole suite green. Azure is one of the
// three forges whose receiver identity resolution is HARD-FAIL, so it sits squarely inside the argument
// #316 turns on, and it was the only one of them with no test of its own.

const ORG = "https://dev.azure.com/acme";
const CONNECTION = {
	authenticatedUser: { id: "1f2e3d4c-0000-0000-0000-000000000001", properties: { Account: { $value: "Pi Bot <bot@acme.example>" } } },
};

/** A response with a JSON content type, which is what the real API answers with. */
const json = (body, status = 200) => ({
	ok: status < 400,
	status,
	headers: new Headers({ "content-type": "application/json" }),
	json: async () => body,
});

/** A response whose body will not parse, with a content type the caller chooses. */
const unparseable = (contentType, status = 200) => ({
	ok: status < 400,
	status,
	headers: new Headers(contentType ? { "content-type": contentType } : {}),
	json: async () => {
		throw new SyntaxError("Unexpected token '<'");
	},
});

const rejecting = (err) => async () => {
	throw err;
};

test("resolves both halves of the identity, and lowercases the address", async () => {
	// A pull-request delivery names an actor by GUID and a work item names them only by address, so the
	// guard needs both and the comparison has to be case-insensitive on one side.
	const self = await resolveAzureSelfId({ orgUrl: ORG, token: "pat", fetchFn: async () => json(CONNECTION) });
	assert.deepEqual(self, { id: "1f2e3d4c-0000-0000-0000-000000000001", email: "pi bot <bot@acme.example>" });
});

test("a display name is never used as the address -- it is attacker-settable", async () => {
	// providerDisplayName is deliberately ignored: comparing against one is how a stranger becomes the
	// harness. With no Account property there is no address, and the id alone still arms the guard.
	const body = { authenticatedUser: { id: "guid-1", providerDisplayName: "Pi Bot", properties: {} } };
	const self = await resolveAzureSelfId({ orgUrl: ORG, token: "pat", fetchFn: async () => json(body) });
	assert.deepEqual(self, { id: "guid-1", email: null });
});

test("neither an id nor an address is a determinate refusal -- the guard could never fire", async () => {
	await assert.rejects(
		() => resolveAzureSelfId({ orgUrl: ORG, token: "pat", fetchFn: async () => json({ authenticatedUser: {} }) }),
		(e) => e.piDispatchConfig === true && /neither an id nor an account address/.test(e.message),
	);
});

test("EVERY failure throws, and the CLASS is what decides whether the receiver comes back", async () => {
	// The invariant is unchanged: an unresolved id would disarm the bot-loop guard silently, so nothing may
	// return. What issue #316 added is the second column. `receiver/src/cli.mjs` maps a tagged throw to
	// EXIT_POLICY (2), which deploy/receiver.service's RestartPreventExitStatus=2 leaves STOPPED, and
	// everything else to 1, which is retried.
	const cases = [
		// Determinate: the operator has to do something.
		["a 401 from a revoked PAT", { fetchFn: async () => json({}, 401) }, true],
		["a 403 from a PAT without the scope", { fetchFn: async () => json({}, 403) }, true],
		["a 404 from a wrong organization URL", { fetchFn: async () => json({}, 404) }, true],
		["a 501 from something that is not Azure DevOps", { fetchFn: async () => json({}, 501) }, true],
		["a private CA the host does not trust", { fetchFn: rejecting(new TypeError("fetch failed", { cause: Object.assign(new Error("unable to verify the first certificate"), { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" }) })) }, true],
		["an http:// URL that redirects to https", { fetchFn: rejecting(new TypeError("fetch failed", { cause: new Error("unexpected redirect") })) }, true],
		["an expired PAT, which Azure answers 203 with a sign-in page", { fetchFn: async () => unparseable("text/html", 203) }, true],
		// Transient: it may work in a minute, and stopping the service helps nobody.
		["the service answering 500", { fetchFn: async () => json({}, 500) }, false],
		["the service answering 503 during a deploy", { fetchFn: async () => json({}, 503) }, false],
		["a rate limit", { fetchFn: async () => json({}, 429) }, false],
		["a refused connection", { fetchFn: rejecting(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })) }, false],
		["a timeout", { fetchFn: rejecting(Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" })) }, false],
		["a truncated JSON body", { fetchFn: async () => unparseable("application/json") }, false],
		["a body with no content type at all", { fetchFn: async () => unparseable(null) }, false],
	];
	for (const [name, over, determinate] of cases) {
		await assert.rejects(
			() => resolveAzureSelfId({ orgUrl: ORG, token: "pat", fetchFn: async () => json(CONNECTION), ...over }),
			(e) => e.piDispatchConfig === (determinate ? true : undefined),
			`${name} must fail closed, ${determinate ? "tagged so the receiver stays stopped" : "untagged so it is restarted"}`,
		);
	}
});

test("an error body never reaches the message -- the request carried the token", async () => {
	const secret = "the-pat-echoed-back-in-the-body";
	await assert.rejects(
		() => resolveAzureSelfId({ orgUrl: ORG, token: secret, fetchFn: async () => json({ message: `denied for ${secret}` }, 401) }),
		(e) => e.message.includes("401") && !e.message.includes(secret),
	);
});

test("the 203 refusal names what actually happened, because the status alone would mislead", async () => {
	// 203 is `ok`, so it never reaches the status arm. An operator told only "unparseable JSON" would go
	// looking for a broken API; the real answer is that their PAT expired.
	await assert.rejects(
		() => resolveAzureSelfId({ orgUrl: ORG, token: "pat", fetchFn: async () => unparseable("text/html", 203) }),
		(e) => /text\/html/.test(e.message) && /expired or invalid PAT/.test(e.message),
	);
});
