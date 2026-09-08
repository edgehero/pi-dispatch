import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveGitLabSelfId } from "../src/gitlab-identity.mjs";

const ok = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test("resolves the acting bot user's integer id from GET /user", async () => {
	let seen = null;
	const id = await resolveGitLabSelfId({
		apiUrl: "https://gl.internal/",
		token: "glpat-x",
		fetchFn: async (url, init) => ((seen = { url, init }), ok({ id: 4242, username: "pi-bot" })),
	});
	assert.equal(id, 4242);
	assert.equal(seen.url, "https://gl.internal/api/v4/user", "a trailing slash on the instance URL must not double up");
	assert.equal(seen.init.headers["PRIVATE-TOKEN"], "glpat-x");
});

test("EVERY failure throws -- an unresolved id would disarm the bot-loop guard", async () => {
	// The guard's only job is to refuse events that came from us. Returning null here would let the
	// receiver boot with the guard silently off, and one status comment becomes an unbounded paid loop.
	//
	// THAT is what this test is for, and it is unchanged. What issue #316 split is the CLASS each failure
	// throws, which was uniformly `configError` and should never have been: the tag decides whether the
	// receiver's supervisor restarts it (untagged, exit 1) or deliberately leaves it stopped
	// (tagged, EXIT_POLICY 2 against RestartPreventExitStatus=2). Both columns are asserted, because
	// "it throws" and "it throws the right class" are two different properties and only one of them was
	// ever pinned here.
	const cases = [
		["empty token", { token: "" }, true],
		["http 401", { fetchFn: async () => ok({}, 401) }, true],
		["no integer id", { fetchFn: async () => ok({ id: "4242" }) }, true],
		["http 500", { fetchFn: async () => ok({}, 500) }, false],
		["http 429", { fetchFn: async () => ok({}, 429) }, false],
		["unparseable body, JSON content type (truncated)", { fetchFn: async () => ({ ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => { throw new Error("bad json"); } }) }, false],
		["unparseable body, HTML content type (an SSO portal answered)", { fetchFn: async () => ({ ok: true, status: 200, headers: new Headers({ "content-type": "text/html" }), json: async () => { throw new Error("bad json"); } }) }, true],
		["network fault", { fetchFn: async () => { throw new Error("ECONNREFUSED"); } }, false],
	];
	for (const [name, over, determinate] of cases) {
		await assert.rejects(
			() => resolveGitLabSelfId({ apiUrl: "https://gl", token: "glpat-x", fetchFn: async () => ok({ id: 1 }), ...over }),
			(e) => e.piDispatchConfig === (determinate ? true : undefined),
			`${name} must fail closed, ${determinate ? "tagged as configuration" : "untagged so the supervisor restarts"}`,
		);
	}
});

test("an error body is never echoed -- only the status reaches the message", async () => {
	// A GitLab error body can quote the request, and the request carried the token.
	await assert.rejects(
		() => resolveGitLabSelfId({ apiUrl: "https://gl", token: "glpat-SECRET", fetchFn: async () => ok({ message: "401 Unauthorized for glpat-SECRET" }, 401) }),
		(e) => e.piDispatchConfig === true && !e.message.includes("glpat-SECRET"),
	);
});

test("fetchFailureReason unwraps the cause chain, so a private-CA failure names itself", async () => {
	const { fetchFailureReason } = await import("../src/gitlab-identity.mjs");
	// Node's fetch rejects with the bare string "fetch failed" and hides the real reason underneath. For a
	// self-hosted GitLab behind a private CA -- the commonest misconfiguration there is -- the unwrapped
	// message is the difference between a diagnosis and a shrug.
	const wrapped = new TypeError("fetch failed", { cause: new Error("self-signed certificate") });
	assert.equal(fetchFailureReason(wrapped), "fetch failed: self-signed certificate");

	// Deeper chains, duplicates, and a bare error all stay readable.
	assert.equal(fetchFailureReason(new Error("a", { cause: new Error("b", { cause: new Error("c") }) })), "a: b: c");
	assert.equal(fetchFailureReason(new Error("x", { cause: new Error("x") })), "x");
	assert.equal(fetchFailureReason(new Error("boom")), "boom");
	assert.equal(fetchFailureReason(undefined), "network error");
	// A cycle must not hang the caller.
	const a = new Error("loop"); a.cause = a;
	assert.equal(fetchFailureReason(a), "loop");
});

test("a private-CA instance reports the cert problem, not a bare 'fetch failed'", async () => {
	await assert.rejects(
		() => resolveGitLabSelfId({
			apiUrl: "https://gl.internal",
			token: "glpat-x",
			fetchFn: async () => { throw new TypeError("fetch failed", { cause: new Error("unable to verify the first certificate") }); },
		}),
		(e) => e.piDispatchConfig === true && e.message.includes("unable to verify the first certificate"),
	);
});
