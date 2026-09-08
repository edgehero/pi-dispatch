import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveSelfId } from "../src/identity.mjs";

/**
 * Hand-rolled fake @octokit/rest: `request(route, params)` returns a canned `{ data }` keyed on the
 * route string. `calls` records every (route, params) so tests can assert the two-step app path.
 */
function fakeOctokit(routes) {
	const calls = [];
	return {
		calls,
		async request(route, params) {
			calls.push({ route, params });
			if (!(route in routes)) throw new Error(`unexpected route: ${route}`);
			const canned = routes[route];
			if (canned instanceof Error) throw canned;
			return { data: canned };
		},
	};
}

test("pat: GET /user id is returned", async () => {
	const octokit = fakeOctokit({ "GET /user": { id: 4242, login: "octo" } });
	const id = await resolveSelfId({ source: "pat", octokit });
	assert.equal(id, 4242);
	assert.deepEqual(
		octokit.calls.map((c) => c.route),
		["GET /user"],
	);
});

test("gh: GET /user id is returned", async () => {
	const octokit = fakeOctokit({ "GET /user": { id: 77, login: "runner" } });
	assert.equal(await resolveSelfId({ source: "gh", octokit }), 77);
});

test("app: resolves slug[bot] user id via GET /app then GET /users/{username}", async () => {
	const octokit = fakeOctokit({
		"GET /app": { slug: "pi-dispatch", id: 9001 },
		"GET /users/{username}": { id: 555123, login: "pi-dispatch[bot]" },
	});
	const id = await resolveSelfId({ source: "app", octokit });
	// The BOT USER id (sender.id), not the App id.
	assert.equal(id, 555123);
	assert.deepEqual(
		octokit.calls.map((c) => c.route),
		["GET /app", "GET /users/{username}"],
	);
	assert.equal(octokit.calls[1].params.username, "pi-dispatch[bot]");
});

/** An octokit rejection as octokit actually builds one: a `status` property, not a status in the prose. */
const httpError = (status, headers = {}) => Object.assign(new Error(`HttpError (${status})`), { status, response: { headers } });

test("octokit rejection (401) is rethrown as a tagged config error", async () => {
	// The fixture carries `status` because the classifier reads it, and because octokit always sets it.
	// It used to put "401" in the message only, which meant this test passed while exercising the
	// STATUS-LESS branch rather than the 401 one (issue #316).
	const octokit = fakeOctokit({ "GET /user": httpError(401) });
	await assert.rejects(
		() => resolveSelfId({ source: "pat", octokit }),
		(e) => {
			assert.equal(e.piDispatchConfig, true);
			assert.match(e.message, /could not resolve self identity/);
			return true;
		},
	);
});

test("a transient octokit rejection is NOT a config error -- it must not stop the service", async () => {
	// Issue #316. `cli.mjs` maps the tag to EXIT_POLICY (2), which RestartPreventExitStatus=2 and nssm's
	// `AppExit 2 Exit` leave STOPPED, and the worker's best-effort boot catch leaves the forge
	// credential-less for the process lifetime. Neither is the right answer to "GitHub was busy for a
	// moment", and since #310 the second one publicly tells the issue author the deployment is
	// misconfigured on every job that follows.
	const cases = [
		["500", httpError(500)],
		["429", httpError(429)],
		["408", httpError(408)],
		["primary rate limit (403 + x-ratelimit-remaining: 0)", httpError(403, { "x-ratelimit-remaining": "0" })],
		["secondary rate limit (403 + retry-after)", httpError(403, { "retry-after": "60" })],
		["an unparseable status, which octokit reports as 0", httpError(0)],
		["a rejection with no status at all", new Error("socket hang up")],
	];
	for (const [name, error] of cases) {
		await assert.rejects(
			() => resolveSelfId({ source: "pat", octokit: fakeOctokit({ "GET /user": error }) }),
			(e) => e.piDispatchConfig === undefined,
			`${name} must throw untagged, so entryExitCode gives 1 and the supervisor restarts`,
		);
	}
});

test("a plain 403 stays determinate -- a scope problem is the operator's to fix", async () => {
	await assert.rejects(
		() => resolveSelfId({ source: "pat", octokit: fakeOctokit({ "GET /user": httpError(403) }) }),
		(e) => e.piDispatchConfig === true,
	);
});

test("unknown source is a config error", async () => {
	const octokit = fakeOctokit({});
	await assert.rejects(
		() => resolveSelfId({ source: "oauth", octokit }),
		(e) => e.piDispatchConfig === true && /unknown auth source/.test(e.message),
	);
});

test("missing source is a config error", async () => {
	const octokit = fakeOctokit({});
	await assert.rejects(
		() => resolveSelfId({ octokit }),
		(e) => e.piDispatchConfig === true && /unknown auth source/.test(e.message),
	);
});

test("non-integer id is a config error", async () => {
	const octokit = fakeOctokit({ "GET /user": { id: "4242", login: "octo" } });
	await assert.rejects(
		() => resolveSelfId({ source: "pat", octokit }),
		(e) => e.piDispatchConfig === true && /not an integer/.test(e.message),
	);
});

test("undefined id is a config error", async () => {
	const octokit = fakeOctokit({ "GET /user": { login: "octo" } });
	await assert.rejects(
		() => resolveSelfId({ source: "pat", octokit }),
		(e) => e.piDispatchConfig === true && /not an integer/.test(e.message),
	);
});

test("missing octokit is a config error", async () => {
	await assert.rejects(
		() => resolveSelfId({ source: "pat" }),
		(e) => e.piDispatchConfig === true && /missing octokit/.test(e.message),
	);
});
