import assert from "node:assert/strict";
import { test } from "node:test";
import { checkAppPermissions, GITHUB_APP_PERMISSIONS, resolveSelfId } from "../src/identity.mjs";

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
		["a network fault, which octokit reports as 500", Object.assign(httpError(500), { cause: Object.assign(new Error("getaddrinfo ENOTFOUND api.github.com"), { code: "ENOTFOUND" }) })],
	];
	for (const [name, error] of cases) {
		await assert.rejects(
			() => resolveSelfId({ source: "pat", octokit: fakeOctokit({ "GET /user": error }) }),
			(e) => e.piDispatchConfig === undefined,
			`${name} must throw untagged, so entryExitCode gives 1 and the supervisor restarts`,
		);
	}
});

test("a rejection with NO status never reached the network, and is determinate", async () => {
	// Octokit always sets one: measured, a network fault arrives as 500 with the errno underneath, for both
	// ENOTFOUND and ECONNREFUSED. So a status-less rejection came from local code, which on the app path
	// means signing the JWT with a key @octokit/auth-app cannot import -- an OpenSSH-format key, or base64
	// mangled by a paste. Retrying that is a restart loop against a fault no restart fixes.
	const badKey = Object.assign(new Error("error:1E08010C:DECODER routines::unsupported"), { code: "ERR_OSSL_UNSUPPORTED" });
	await assert.rejects(
		() => resolveSelfId({ source: "pat", octokit: fakeOctokit({ "GET /user": badKey }) }),
		(e) => e.piDispatchConfig === true,
	);
});

test("a TLS trust fault is determinate even though octokit dresses it as a 500", async () => {
	// The carve-out that does not exist unless it is checked BEFORE the status: octokit's fetch wrapper
	// turns a self-signed-certificate rejection into RequestError(message, 500) and keeps the cause, so the
	// status arm alone reads the commonest self-hosted misconfiguration as transient and restarts into it
	// forever instead of naming NODE_EXTRA_CA_CERTS.
	const tls = Object.assign(httpError(500), {
		cause: new TypeError("fetch failed", { cause: Object.assign(new Error("self-signed certificate"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" }) }),
	});
	await assert.rejects(
		() => resolveSelfId({ source: "pat", octokit: fakeOctokit({ "GET /user": tls }) }),
		(e) => e.piDispatchConfig === true,
	);
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

// -- checkAppPermissions: the boot line for an App installation's grant (issue #876) ---------------------------------

const INSTALLATION_ROUTE = "GET /app/installations/{installation_id}";
/** A recording `(event, fields)` logger. */
function recordingLog() {
	const lines = [];
	const log = (event, fields) => lines.push({ event, fields });
	log.lines = lines;
	return log;
}
/** A grant short of one permission the worker needs: the comments it posts would be refused. */
const SHORT_GRANT = { contents: "write", pull_requests: "write", metadata: "read" };

test("checkAppPermissions: an installation short of a permission gets one line naming it and the fix", async () => {
	const octokit = fakeOctokit({ [INSTALLATION_ROUTE]: { id: 456, permissions: SHORT_GRANT } });
	const log = recordingLog();
	assert.deepEqual(await checkAppPermissions({ octokit, installationId: "456", log }), { missing: ["issues:write"] });
	assert.deepEqual(octokit.calls, [{ route: INSTALLATION_ROUTE, params: { installation_id: "456" } }], "the INSTALLATION's grant, which tokens are minted from, read once");
	assert.equal(log.lines.length, 1, "one line");
	const [{ event, fields }] = log.lines;
	assert.equal(event, "github_app_permission_missing");
	assert.deepEqual(fields.missing, ["issues:write"]);
	assert.match(fields.fix, /write is Read and write/, "names the level as GitHub's settings page writes it");
	assert.match(fields.fix, /accept the change on the App's installation/, "an App's new permission reaches tokens only once the installation accepts it");
	assert.match(fields.fix, /docs\/github\.md#app-permissions/);
});

test("checkAppPermissions: the full grant, or a wider level, says nothing", async () => {
	for (const permissions of [{ ...GITHUB_APP_PERMISSIONS }, { ...GITHUB_APP_PERMISSIONS, administration: "write", metadata: "write", checks: "read" }]) {
		const log = recordingLog();
		assert.deepEqual(await checkAppPermissions({ octokit: fakeOctokit({ [INSTALLATION_ROUTE]: { permissions } }), installationId: "456", log }), { missing: [] });
		assert.deepEqual(log.lines, [], JSON.stringify(permissions));
	}
});

test("checkAppPermissions: a level below the one needed is named, and so is a level GitHub may add that this build does not know", async () => {
	const log = recordingLog();
	const permissions = { ...GITHUB_APP_PERMISSIONS, issues: "read", contents: "triage" };
	assert.deepEqual(await checkAppPermissions({ octokit: fakeOctokit({ [INSTALLATION_ROUTE]: { permissions } }), installationId: "456", log }), { missing: ["contents:write", "issues:write"] });
	assert.equal(log.lines[0].event, "github_app_permission_missing");
});

test("checkAppPermissions: a failed read says only that it failed, with GitHub's status and request id, and never throws", async () => {
	const refused = Object.assign(new Error("Bad credentials - https://docs.github.com/rest"), { name: "HttpError", status: 401, response: { headers: { "x-github-request-id": "ABCD:1234:5678" }, data: { message: "Bad credentials" } } });
	for (const [answer, expected] of [
		[refused, { status: 401, requestId: "ABCD:1234:5678" }],
		[httpError(500), {}],
		[new TypeError("fetch failed"), {}],
	]) {
		const log = recordingLog();
		assert.equal(await checkAppPermissions({ octokit: fakeOctokit({ [INSTALLATION_ROUTE]: answer }), installationId: "456", log }), null);
		assert.deepEqual(log.lines, [{ event: "github_app_permissions_unread", fields: expected }], "no message, no response body: GitHub's words can carry a URL");
	}
});

test("checkAppPermissions: an answer with no permissions object is unread, not a grant of nothing", async () => {
	for (const data of [{ id: 456 }, { permissions: null }, { permissions: ["administration"] }, null]) {
		const log = recordingLog();
		assert.equal(await checkAppPermissions({ octokit: fakeOctokit({ [INSTALLATION_ROUTE]: data }), installationId: "456", log }), null, JSON.stringify(data));
		assert.deepEqual(log.lines, [{ event: "github_app_permissions_unread", fields: { why: "no-permissions-object" } }]);
	}
});

test("checkAppPermissions: a client that throws synchronously is a failed read too", async () => {
	const log = recordingLog();
	const octokit = {
		request() {
			throw new Error("not a promise");
		},
	};
	assert.equal(await checkAppPermissions({ octokit, installationId: "456", log }), null);
	assert.equal(log.lines[0].event, "github_app_permissions_unread");
});

test("GITHUB_APP_PERMISSIONS is frozen, every level is one GitHub uses, and it holds no administration (issue #876)", () => {
	assert.ok(Object.isFrozen(GITHUB_APP_PERMISSIONS));
	assert.deepEqual(Object.keys(GITHUB_APP_PERMISSIONS).sort(), ["contents", "issues", "metadata", "pull_requests"]);
	assert.equal(Object.hasOwn(GITHUB_APP_PERMISSIONS, "administration"), false, "the protection check reads the branch's protected flag, which contents covers");
	for (const level of Object.values(GITHUB_APP_PERMISSIONS)) assert.ok(["read", "write"].includes(level), level);
});
