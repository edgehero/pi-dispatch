import assert from "node:assert/strict";
import { test } from "node:test";
import { makeResolveGitHubAuthority } from "../src/github-members.mjs";

const okResponse = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

/** The default minter: records nothing, answers a token. Tests that care about the mint build their own. */
const mintOk = async () => "ghs_minted";

test("admin and write authorize; read and none do not", async () => {
	const at = (permission) => makeResolveGitHubAuthority({ mintToken: mintOk, fetchFn: async () => okResponse({ permission }) });
	// `maintain` is NOT in this list and needs no arm of its own: GitHub folds maintain into `write` (and
	// triage into `read`) in the legacy `permission` field this module reads, so a maintainer REPORTS as
	// write and passes through the same two-member set.
	for (const p of ["admin", "write"]) {
		assert.deepEqual(await at(p)("acme/widgets", "alice"), { authorized: true }, `${p} can push, which is the property the constitution requires`);
	}
	for (const p of ["read", "none"]) {
		assert.deepEqual(await at(p)("acme/widgets", "alice"), { authorized: false }, `${p} cannot push a branch`);
	}
	// An EMPTY permission is not a determinate "read" -- it is a shape this code does not recognise, and it
	// must go to the indeterminate arm rather than be rounded down to a refusal.
	assert.ok((await at("")("acme/widgets", "alice")).indeterminate, "an empty permission is unrecognised, not a denial");
});

test("a 200 with permission 'none' is THE normal non-collaborator answer, and it refuses determinately", async () => {
	// Named on its own because it is the case an implementer reaches for 404 to cover: GitHub answers the
	// permission question for any visible user rather than 404ing strangers, so most unauthorized closers
	// are refused HERE, on a 200, and treating only 404 as the refusal would leave them indeterminate --
	// a 503 loop for every stranger's close.
	const resolve = makeResolveGitHubAuthority({ mintToken: mintOk, fetchFn: async () => okResponse({ permission: "none" }) });
	assert.deepEqual(await resolve("acme/widgets", "stranger-login"), { authorized: false });
});

test("the lookup asks the collaborator-permission endpoint with the minted token, GitHub's media headers, and no redirect", async () => {
	let seen = null;
	const resolve = makeResolveGitHubAuthority({
		mintToken: mintOk,
		fetchFn: async (url, init) => ((seen = { url, init }), okResponse({ permission: "write" })),
	});
	await resolve("acme/widgets", "alice[bot]");
	// encodeURIComponent pinned via a login that needs it: `[` and `]` must not reach the path raw.
	assert.equal(seen.url, "https://api.github.com/repos/acme/widgets/collaborators/alice%5Bbot%5D/permission");
	assert.equal(seen.init.headers.accept, "application/vnd.github+json");
	assert.equal(seen.init.headers["x-github-api-version"], "2022-11-28");
	assert.equal(seen.init.headers.authorization, "Bearer ghs_minted");
	assert.equal(seen.init.redirect, "error", "a 30x must not be followed -- the request carries the token");
});

test("the token is minted per call with a job-shaped { repo } -- the auth object's own contract", async () => {
	const mints = [];
	const resolve = makeResolveGitHubAuthority({
		mintToken: async (job) => (mints.push(job), "ghs_minted"),
		fetchFn: async () => okResponse({ permission: "write" }),
	});
	await resolve("acme/widgets", "alice");
	await resolve("acme/widgets", "bob");
	assert.deepEqual(mints, [{ repo: "acme/widgets" }, { repo: "acme/widgets" }], "one mint per lookup, scoped to the one repo being asked about");
});

test("404 is a determinate unknown user/repo; every other failure status is indeterminate as status-<n>", async () => {
	const at = (status) => makeResolveGitHubAuthority({ mintToken: mintOk, fetchFn: async () => okResponse({}, status) });
	assert.deepEqual(await at(404)("acme/widgets", "alice"), { authorized: false });
	for (const status of [401, 403, 429, 500, 502]) {
		assert.deepEqual(await at(status)("acme/widgets", "alice"), { indeterminate: `status-${status}` }, `${status} must not read as "not a collaborator"`);
	}
	assert.deepEqual(await at(500)("acme/widgets", "alice"), { indeterminate: "status-500" });
});

test("a network throw is indeterminate with the unwrapped fetch reason", async () => {
	const resolve = makeResolveGitHubAuthority({
		mintToken: mintOk,
		fetchFn: async () => {
			// Node's fetch shape: a bare "fetch failed" with the actionable cause underneath.
			throw Object.assign(new Error("fetch failed"), { cause: new Error("ECONNREFUSED") });
		},
	});
	assert.deepEqual(await resolve("acme/widgets", "alice"), { indeterminate: "fetch failed: ECONNREFUSED" }, "fetchFailureReason unwraps the cause chain, so the reason names the fix");
});

test("a 200 with unparseable JSON is indeterminate, and the reason carries NO body bytes", async () => {
	// V8's JSON.parse error message QUOTES the offending input, and the input here is the response body --
	// so unlike the Forgejo resolver, the parse error's message must not ride the reason.
	const resolve = makeResolveGitHubAuthority({
		mintToken: mintOk,
		fetchFn: async () => ({
			ok: true,
			status: 200,
			json: async () => {
				throw new SyntaxError(`Unexpected token 'b', "body-text-marker" is not valid JSON`);
			},
		}),
	});
	const verdict = await resolve("acme/widgets", "alice");
	assert.ok(verdict.indeterminate, "unparseable is not a refusal");
	assert.equal(JSON.stringify(verdict).includes("body-text-marker"), false, "the parse error quotes body bytes and must be dropped");
});

test("a 200 with no permission string is indeterminate, never a refusal", async () => {
	// Answering false would turn an upstream schema change into a silent, permanent refusal of every
	// close trigger.
	for (const permission of [40, null, undefined, {}, ["write"]]) {
		const resolve = makeResolveGitHubAuthority({ mintToken: mintOk, fetchFn: async () => okResponse({ permission }) });
		assert.ok((await resolve("acme/widgets", "alice")).indeterminate, `permission ${JSON.stringify(permission)} is not a string this code understands`);
	}
});

test("a malformed repo or login refuses WITHOUT a mint or a fetch -- neither becomes a path segment unchecked", async () => {
	// A slash or a `..` in either half would reach a different endpoint than this function believes it is
	// asking, and the answer would be attributed to the wrong repository or the wrong person. Whitespace
	// never appears in a real GitHub login, so it reads as a malformed payload, not a user.
	let fetched = false;
	let minted = false;
	const resolve = makeResolveGitHubAuthority({
		mintToken: async () => ((minted = true), "ghs_minted"),
		fetchFn: async () => ((fetched = true), okResponse({ permission: "admin" })),
	});
	for (const [repo, login] of [
		["acme", "alice"],
		["a/b/c", "alice"],
		["/widgets", "alice"],
		["acme/", "alice"],
		["acme/widgets", "../admin"],
		["acme/widgets", "a/b"],
		["acme/widgets", "x?y"],
		["acme/widgets", "x#y"],
		["acme/widgets", "a b"],
		["acme/widgets", " "],
		["acme/widgets", ""],
		[undefined, "alice"],
		[42, "alice"],
		["acme/widgets", undefined],
		["acme/widgets", 7],
		// Pure dot segments URL-normalize onto a DIFFERENT endpoint than the one asked; a dot INSIDE a
		// name is a real repo ("next.js") and must keep passing -- the positive case below pins that.
		["octo/..", "alice"],
		["./widgets", "alice"],
		["octo/.", "alice"],
	]) {
		assert.deepEqual(await resolve(repo, login), { authorized: false }, `${JSON.stringify([repo, login])} must refuse`);
	}
	assert.equal(fetched, false, "there is nothing to ask about -- determinate, not a failure");
	assert.equal(minted, false, "and nothing was spent asking: the mint follows the shape check, never precedes it");
});

test("a mint failure is indeterminate with a FIXED reason -- never the thrown message, and zero fetches", async () => {
	let fetched = false;
	const resolve = makeResolveGitHubAuthority({
		// A config-flavoured message, the kind mintToken really throws: it must never reach the verdict.
		mintToken: async () => {
			throw new Error("GITHUB_PAT missing from /etc/pi-dispatch/secret.env");
		},
		fetchFn: async () => ((fetched = true), okResponse({ permission: "admin" })),
	});
	assert.deepEqual(await resolve("acme/widgets", "alice"), { indeterminate: "token-mint-failed" });
	assert.equal(fetched, false, "no token, no request -- the lookup never left the process");
});

test("no verdict ever carries the login or response-body text, whatever the outcome", async () => {
	// The sweep behind no-pii-in-logs: every returned string is destined for a log line, so every arm is
	// checked against a login and a body marker that must not survive into it.
	const login = "leaky-login-marker";
	const behaviours = [
		async () => okResponse({ permission: "write" }),
		async () => okResponse({ permission: "none" }),
		async () => okResponse({ permission: undefined }),
		async () => okResponse({ echo: `error about ${login} body-text-marker` }, 404),
		async () => okResponse({ echo: `error about ${login} body-text-marker` }, 502),
		async () => ({
			ok: true,
			status: 200,
			json: async () => {
				throw new SyntaxError(`"${login} body-text-marker" is not valid JSON`);
			},
		}),
		async () => {
			throw new Error("ECONNREFUSED");
		},
	];
	for (const fetchFn of behaviours) {
		const resolve = makeResolveGitHubAuthority({ mintToken: mintOk, fetchFn });
		const verdict = await resolve("acme/widgets", login);
		const text = JSON.stringify(verdict);
		assert.equal(text.includes(login), false, `the login must not appear in ${text}`);
		assert.equal(text.includes("body-text-marker"), false, `body text must not appear in ${text}`);
	}
	// The mint arm too, since its throw is the one place config text could enter.
	const mintFail = makeResolveGitHubAuthority({
		mintToken: async () => {
			throw new Error(`no token for ${login}`);
		},
		fetchFn: async () => okResponse({ permission: "write" }),
	});
	assert.equal(JSON.stringify(await mintFail("acme/widgets", login)).includes(login), false);
});
