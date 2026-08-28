import assert from "node:assert/strict";
import { test } from "node:test";
import { assertResumeAllowedOnGhSource, makeGitHubAuth } from "../src/get-token.mjs";

/**
 * All collaborators are injected. Fakes are hand-rolled (no mocking library), matching the
 * budget/identity test convention.
 */

/** Fake @octokit/rest: `new Octokit(opts)` ignores auth; `request(route)` returns canned `{ data }`. */
function FakeOctokit(routes) {
	return class {
		constructor(options) {
			this.options = options;
		}
		async request(route) {
			if (!(route in routes)) throw new Error(`unexpected route: ${route}`);
			const canned = routes[route];
			if (canned instanceof Error) throw canned;
			return { data: canned };
		}
	};
}

/**
 * Fake @octokit/auth-app. `createAppAuth(auth)` returns an async `appAuth(params)` that records its
 * params in `calls` and either yields `result` (e.g. `{ token }`) or throws `error`.
 */
function fakeCreateAppAuth({ result, error, calls }) {
	return () => async (params) => {
		calls.push(params);
		if (error) throw error;
		return result;
	};
}

/** Callback-style execFile so `promisify` resolves `{ stdout, stderr }` (or rejects with `error`). */
function fakeExecFile({ stdout = "", stderr = "", error = null } = {}) {
	return (_file, _args, cb) => {
		if (error) return cb(error);
		cb(null, { stdout, stderr });
	};
}

/** An Error tagged like an octokit RequestError. */
function httpError(status, extra = {}) {
	const e = new Error(`HTTP ${status}`);
	e.status = status;
	return Object.assign(e, extra);
}

const USER_ROUTES = { "GET /user": { id: 4242, login: "octo" } };
const APP_ROUTES = {
	"GET /app": { slug: "pi-dispatch", id: 9001 },
	"GET /users/{username}": { id: 555123, login: "pi-dispatch[bot]" },
};

// -- pat -----------------------------------------------------------------------------------------

test("pat happy: mintToken returns the non-empty token, selfId is the /user integer id", async () => {
	const auth = await makeGitHubAuth(
		{ source: "pat" },
		{ Octokit: FakeOctokit(USER_ROUTES), env: { GITHUB_PAT: "ghp_realtoken" } },
	);
	assert.equal(auth.source, "pat");
	assert.equal(auth.selfId, 4242);
	assert.ok(Number.isInteger(auth.selfId));
	const token = await auth.mintToken("owner/repo");
	assert.equal(token, "ghp_realtoken");
	assert.ok(token.length > 0);
});

test("pat honours a custom patVar", async () => {
	const auth = await makeGitHubAuth(
		{ source: "pat", patVar: "MY_PAT" },
		{ Octokit: FakeOctokit(USER_ROUTES), env: { MY_PAT: "ghp_custom" } },
	);
	assert.equal(await auth.mintToken({ kind: "github", repo: "o/r" }), "ghp_custom");
});

test("pat empty env var is a config error (money hole: absent GITHUB_TOKEN runs anonymously)", async () => {
	await assert.rejects(
		() => makeGitHubAuth({ source: "pat" }, { Octokit: FakeOctokit(USER_ROUTES), env: { GITHUB_PAT: "" } }),
		(e) => e.piDispatchConfig === true,
	);
});

test("pat whitespace-only env var is a config error", async () => {
	await assert.rejects(
		() => makeGitHubAuth({ source: "pat" }, { Octokit: FakeOctokit(USER_ROUTES), env: { GITHUB_PAT: "   \t\n" } }),
		(e) => e.piDispatchConfig === true,
	);
});

// -- gh ------------------------------------------------------------------------------------------

test("gh happy: mintToken returns the trimmed `gh auth token` stdout, selfId resolves", async () => {
	const auth = await makeGitHubAuth(
		{ source: "gh" },
		{ Octokit: FakeOctokit(USER_ROUTES), execFile: fakeExecFile({ stdout: "ghs_ghtoken\n" }) },
	);
	assert.equal(auth.source, "gh");
	assert.equal(auth.selfId, 4242);
	assert.equal(await auth.mintToken("owner/repo"), "ghs_ghtoken");
});

test("gh mintToken(undefined) still resolves -- a local run.github job has no repo and gh ignores it", async () => {
	const auth = await makeGitHubAuth(
		{ source: "gh" },
		{ Octokit: FakeOctokit(USER_ROUTES), execFile: fakeExecFile({ stdout: "ghs_ghtoken\n" }) },
	);
	assert.equal(await auth.mintToken(undefined), "ghs_ghtoken");
});

test("gh logged-out (exit 0, empty stdout) is a config error", async () => {
	await assert.rejects(
		() => makeGitHubAuth({ source: "gh" }, { Octokit: FakeOctokit(USER_ROUTES), execFile: fakeExecFile({ stdout: "" }) }),
		(e) => e.piDispatchConfig === true,
	);
});

test("gh ENOENT (binary absent) is a config error", async () => {
	const enoent = Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" });
	await assert.rejects(
		() => makeGitHubAuth({ source: "gh" }, { Octokit: FakeOctokit(USER_ROUTES), execFile: fakeExecFile({ error: enoent }) }),
		(e) => e.piDispatchConfig === true,
	);
});

// -- app -----------------------------------------------------------------------------------------

test("app happy: installation token minted, selfId is the bot-user id via the two-step", async () => {
	const calls = [];
	const auth = await makeGitHubAuth(
		{ source: "app", appId: "123", installationId: "456", privateKeyPath: "/keys/app.pem" },
		{
			Octokit: FakeOctokit(APP_ROUTES),
			createAppAuth: fakeCreateAppAuth({ result: { token: "ghs_installtoken" }, calls }),
			readFile: async () => "-----BEGIN RSA PRIVATE KEY-----\nx\n-----END RSA PRIVATE KEY-----\n",
		},
	);
	assert.equal(auth.source, "app");
	assert.equal(auth.selfId, 555123); // bot USER id, not the App id
	assert.ok(Number.isInteger(auth.selfId));
	assert.equal(await auth.mintToken({ kind: "github", repo: "some-owner/some-repo" }), "ghs_installtoken");
});

test("app happy with an inline key: mints without ever touching the filesystem (issue #208)", async () => {
	const calls = [];
	const pem = "-----BEGIN RSA PRIVATE KEY-----\ninline\n-----END RSA PRIVATE KEY-----\n";
	let readFileCalls = 0;
	const auth = await makeGitHubAuth(
		// The shape loadGitHubAuth produces for a secrets-manager deployment: key in hand, no path at all.
		{ source: "app", appId: "123", installationId: "456", privateKeyPath: undefined, privateKey: pem },
		{
			Octokit: FakeOctokit(APP_ROUTES),
			createAppAuth: fakeCreateAppAuth({ result: { token: "ghs_installtoken" }, calls }),
			readFile: async () => {
				readFileCalls++;
				throw new Error("a deployment with no key file must never reach the filesystem");
			},
		},
	);
	assert.equal(await auth.mintToken({ kind: "github", repo: "some-owner/some-repo" }), "ghs_installtoken");
	assert.equal(readFileCalls, 0, "the inline key is used directly -- no read, no path, nothing to stat");
});

test("app mint strips the owner: repositoryNames gets the bare repo name", async () => {
	const calls = [];
	const auth = await makeGitHubAuth(
		{ source: "app", appId: "123", installationId: "456", privateKeyPath: "/keys/app.pem" },
		{
			Octokit: FakeOctokit(APP_ROUTES),
			createAppAuth: fakeCreateAppAuth({ result: { token: "ghs_x" }, calls }),
			readFile: async () => "PEM",
		},
	);
	await auth.mintToken({ kind: "github", repo: "acme-corp/widgets" });
	assert.deepEqual(calls[0].repositoryNames, ["widgets"]);
	assert.equal(calls[0].type, "installation");
	assert.equal("permissions" in calls[0], false, "a job mint passes NO narrowing -- the installation's full grant is the job token's contract");
});

test("app mint passes a caller's permissions narrowing through to the installation token (issue #231)", async () => {
	// The receiver's closer-permission lookup mints with { metadata: "read" }, so the token it holds
	// for that one question cannot write anything even if leaked. The narrowing is the CALLER's
	// statement; absent means the full grant (the job path above pins that half).
	const calls = [];
	const auth = await makeGitHubAuth(
		{ source: "app", appId: "123", installationId: "456", privateKeyPath: "/keys/app.pem" },
		{
			Octokit: FakeOctokit(APP_ROUTES),
			createAppAuth: fakeCreateAppAuth({ result: { token: "ghs_x" }, calls }),
			readFile: async () => "PEM",
		},
	);
	await auth.mintToken({ repo: "acme-corp/widgets", permissions: { metadata: "read" } });
	assert.deepEqual(calls[0].permissions, { metadata: "read" }, "the narrowing reaches GitHub, not just our own bookkeeping");
	assert.deepEqual(calls[0].repositoryNames, ["widgets"], "narrowing never loosens the repo scope");
});

test("app mintToken with no repo (local run.github job) is a config error steering to gh/pat", async () => {
	const calls = [];
	const auth = await makeGitHubAuth(
		{ source: "app", appId: "123", installationId: "456", privateKeyPath: "/keys/app.pem" },
		{
			Octokit: FakeOctokit(APP_ROUTES),
			createAppAuth: fakeCreateAppAuth({ result: { token: "ghs_x" }, calls }),
			readFile: async () => "PEM",
		},
	);
	for (const repo of [undefined, ""]) {
		await assert.rejects(
			() => auth.mintToken({ kind: "github", repo }),
			(e) => e.piDispatchConfig === true && /run\.github/.test(e.message),
			`repo=${JSON.stringify(repo)}`,
		);
	}
	assert.equal(calls.length, 0, "the refusal happens before any mint attempt");
});

test("app missing config (no installationId) is a config error before any network call", async () => {
	await assert.rejects(
		() =>
			makeGitHubAuth(
				{ source: "app", appId: "123", privateKeyPath: "/keys/app.pem" },
				{ Octokit: FakeOctokit(APP_ROUTES), createAppAuth: fakeCreateAppAuth({ result: {}, calls: [] }), readFile: async () => "PEM" },
			),
		(e) => e.piDispatchConfig === true,
	);
});

test("app unreadable PEM is a config error", async () => {
	const enoent = Object.assign(new Error("no such file"), { code: "ENOENT" });
	await assert.rejects(
		() =>
			makeGitHubAuth(
				{ source: "app", appId: "123", installationId: "456", privateKeyPath: "/nope.pem" },
				{
					Octokit: FakeOctokit(APP_ROUTES),
					createAppAuth: fakeCreateAppAuth({ result: {}, calls: [] }),
					readFile: async () => {
						throw enoent;
					},
				},
			),
		(e) => e.piDispatchConfig === true,
	);
});

test("app mint 503 is a retryable InfraRetry", async () => {
	const auth = await appAuthThrowing(httpError(503));
	await assert.rejects(() => auth.mintToken({ kind: "github", repo: "o/r" }), (e) => e.piDispatchRetry === true);
});

test("app mint 429 is a retryable InfraRetry", async () => {
	const auth = await appAuthThrowing(httpError(429));
	await assert.rejects(() => auth.mintToken({ kind: "github", repo: "o/r" }), (e) => e.piDispatchRetry === true);
});

test("app mint 403 + retry-after (secondary rate limit) is a retryable InfraRetry", async () => {
	const auth = await appAuthThrowing(httpError(403, { response: { headers: { "retry-after": "60" } } }));
	await assert.rejects(() => auth.mintToken({ kind: "github", repo: "o/r" }), (e) => e.piDispatchRetry === true);
});

test("app mint network fault (ENOTFOUND, no status) is a retryable InfraRetry", async () => {
	const auth = await appAuthThrowing(Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }));
	await assert.rejects(() => auth.mintToken({ kind: "github", repo: "o/r" }), (e) => e.piDispatchRetry === true);
});

test("app mint 401 (bad credentials) is a deterministic config error", async () => {
	const auth = await appAuthThrowing(httpError(401));
	await assert.rejects(() => auth.mintToken({ kind: "github", repo: "o/r" }), (e) => e.piDispatchConfig === true);
});

test("app mint 404 (unknown installation) is a deterministic config error", async () => {
	const auth = await appAuthThrowing(httpError(404));
	await assert.rejects(() => auth.mintToken({ kind: "github", repo: "o/r" }), (e) => e.piDispatchConfig === true);
});

/** Build an app auth whose mint call throws `error` (construction still succeeds via canned routes). */
async function appAuthThrowing(error) {
	return makeGitHubAuth(
		{ source: "app", appId: "123", installationId: "456", privateKeyPath: "/keys/app.pem" },
		{
			Octokit: FakeOctokit(APP_ROUTES),
			createAppAuth: fakeCreateAppAuth({ error, calls: [] }),
			readFile: async () => "PEM",
		},
	);
}

// -- source validation ---------------------------------------------------------------------------

test("unknown source is a config error", async () => {
	await assert.rejects(
		() => makeGitHubAuth({ source: "oauth" }, {}),
		(e) => e.piDispatchConfig === true,
	);
});

test("missing source is a config error", async () => {
	await assert.rejects(
		() => makeGitHubAuth({}, {}),
		(e) => e.piDispatchConfig === true,
	);
});

test("the gh source refuses to mint for a run.resume job, and the escape hatch is explicit", () => {
	// CONST-TOKEN-SCOPED-PER-JOB assumes the credential is an ENV VALUE that dies with the container. A
	// transcript is a FILE: any command that echoed an auth header persists the token to host disk, replayed
	// into the next job on that key. This source is the operator's whole gh login -- full-scope and
	// NON-EXPIRING -- so the one bound that would contain that is absent exactly where it lasts longest.
	assert.throws(
		() => assertResumeAllowedOnGhSource({ kind: "github", repo: "o/r", resume: true }, false),
		(e) => e.piDispatchConfig === true && /non-expiring/.test(e.message),
		"refused at MINT time, so it costs no budget slot and no clone -- the app-source refusal's shape",
	);

	// This must NOT become a general gh-source refusal: only an armed job is affected.
	for (const job of [{ kind: "github", repo: "o/r" }, { kind: "github", repo: "o/r", resume: false }, { kind: "local" }, undefined, null]) {
		assert.doesNotThrow(() => assertResumeAllowedOnGhSource(job, false), `job ${JSON.stringify(job)} is unarmed and must mint exactly as before`);
	}

	// The escape hatch is strictly `=== true`, so a hand-set string cannot arm it by accident.
	assert.doesNotThrow(() => assertResumeAllowedOnGhSource({ resume: true }, true), "PI_SESSIONS_ALLOW_GH_SOURCE=1 lets an operator take the trade explicitly");
	for (const weak of ["1", "true", 1, {}]) {
		assert.throws(() => assertResumeAllowedOnGhSource({ resume: true }, weak), (e) => e.piDispatchConfig === true, `allowGhResume ${JSON.stringify(weak)} must not open the hatch`);
	}
});
