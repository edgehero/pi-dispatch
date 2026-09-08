import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveForgejoSelfId } from "../src/forgejo-identity.mjs";

const ok = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const never = () => {
	throw new Error("fetch must not be called");
};

test("FORGEJO_BOT_ID short-circuits the call entirely -- it is the answer for a token that cannot ask", async () => {
	// A repository-scoped Forgejo token carries only read/write:repository and read/write:issue. `read:user`
	// is not among them, so the very token the docs tell an operator to mint cannot call GET /user. This is
	// the second mechanism that exists so the scoping advice and the bot-loop guard are not in conflict.
	assert.equal(await resolveForgejoSelfId({ apiUrl: "https://fj", token: "t", botId: "42", fetchFn: never }), 42);
	assert.equal(await resolveForgejoSelfId({ apiUrl: "https://fj", token: "t", botId: 42, fetchFn: never }), 42);
});

test("a bad FORGEJO_BOT_ID refuses -- it must never degrade to an unresolved identity", async () => {
	// THE failure this module exists to prevent. `filter-forgejo.mjs` compares `sender.id === selfId`, and
	// `undefined` never equals a number: an unresolved id does not disable the bot-loop guard loudly, it
	// disables it SILENTLY, and the harness's own status comment becomes another paid job, whose comment
	// becomes another. So every path here either returns a positive integer or throws.
	for (const botId of ["0", 0, -1, 1.5, "abc", "12x", {}, []]) {
		await assert.rejects(
			() => resolveForgejoSelfId({ apiUrl: "https://fj", token: "t", botId, fetchFn: never }),
			(e) => e.piDispatchConfig === true,
			`botId ${JSON.stringify(botId)} must refuse rather than resolve to something that is not an id`,
		);
	}
});

test("with no botId, GET /user answers, and the token rides an Authorization header", async () => {
	let seen = null;
	const id = await resolveForgejoSelfId({
		apiUrl: "https://fj.example.com/",
		token: "tok",
		fetchFn: async (url, init) => ((seen = { url, init }), ok({ id: 7, login: "pi-bot" })),
	});
	assert.equal(id, 7);
	assert.equal(seen.url, "https://fj.example.com/api/v1/user");
	assert.equal(seen.init.headers.Authorization, "token tok");
	assert.equal(seen.init.redirect, "error", "a 30x must not be followed -- the request carries the token");
});

test("a 401/403 names FORGEJO_BOT_ID, because that is the actual repair", async () => {
	// A 403 here has one likely cause -- the operator followed the token-scoping advice -- and telling them
	// beats making them find it.
	for (const status of [401, 403]) {
		await assert.rejects(
			() => resolveForgejoSelfId({ apiUrl: "https://fj", token: "t", fetchFn: async () => ok({}, status) }),
			(e) => e.piDispatchConfig === true && e.message.includes("FORGEJO_BOT_ID"),
			`${status} must point at the fix`,
		);
	}
});

test("every other failure refuses too, and the error carries the status but never the body", async () => {
	// A Forgejo error body can echo the request, and the request carried the token.
	const secret = "token-echoed-back-in-the-error-body";
	await assert.rejects(
		() => resolveForgejoSelfId({ apiUrl: "https://fj", token: "t", fetchFn: async () => ({ ok: false, status: 500, json: async () => ({ message: secret }) }) }),
		// Untagged since issue #316: a self-hosted instance answering 500 mid-restart is not a
		// misconfiguration, and tagging it left the receiver stopped with the supervisor declining to
		// bring it back. The property this test actually guards, that the body never reaches the
		// message, is unchanged and still asserted.
		(e) => e.piDispatchConfig === undefined && e.message.includes("500") && !e.message.includes(secret),
	);
	await assert.rejects(
		() =>
			resolveForgejoSelfId({
				apiUrl: "https://fj",
				token: "t",
				fetchFn: async () => {
					throw new Error("ECONNREFUSED");
				},
			}),
		(e) => e.piDispatchConfig === undefined,
	);
	for (const body of [{}, { id: "7" }, { id: null }, { id: 1.5 }]) {
		await assert.rejects(
			() => resolveForgejoSelfId({ apiUrl: "https://fj", token: "t", fetchFn: async () => ok(body) }),
			(e) => e.piDispatchConfig === true,
			`GET /user returning ${JSON.stringify(body)} must refuse, never resolve`,
		);
	}
	await assert.rejects(
		() =>
			resolveForgejoSelfId({
				apiUrl: "https://fj",
				token: "t",
				fetchFn: async () => ({
					ok: true,
					status: 200,
					json: async () => {
						throw new Error("not json");
					},
				}),
			}),
		// Untagged since #316: a truncated body or a proxy interstitial is not a deployment an operator
		// can fix, and forgejo-host.mjs has classified the identical condition as retryable all along.
		(e) => e.piDispatchConfig === undefined,
	);
});

test("no reachable path returns a non-integer -- the guard's input is a number or the boot fails", async () => {
	// The invariant restated as a sweep, because "returns undefined" is the one outcome that is worse than
	// any throw: it boots a receiver whose bot-loop guard can never match.
	const cases = [
		{ botId: 9 },
		{ fetchFn: async () => ok({ id: 3 }) },
	];
	for (const c of cases) {
		const id = await resolveForgejoSelfId({ apiUrl: "https://fj", token: "t", fetchFn: never, ...c });
		assert.equal(Number.isInteger(id) && id > 0, true, `${JSON.stringify(c)} must yield a positive integer`);
	}
});
