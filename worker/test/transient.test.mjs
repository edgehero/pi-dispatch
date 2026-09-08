import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
	DETERMINATE_5XX,
	DETERMINATE_FS_CODES,
	DETERMINATE_TLS_CODES,
	TRANSIENT_STATUSES,
	isDeterminateFetchFailure,
	isDeterminateFsCode,
	isJsonContentType,
	isTransientStatus,
	octokitHeaderReader,
	responseHeaderReader,
	saysRateLimited,
	transientError,
} from "../src/transient.mjs";

// The rule itself (issue #316). Every one of these cases existed as a defect somewhere before this module
// did, and the point of pinning them here rather than only at the call sites is that four call sites used
// to answer them four different ways.

test("the three vocabularies are pinned as LITERALS, not derived from themselves", () => {
	// A test that builds its expectation from the same constant the code reads is correct at any value and
	// therefore blind to a change IN that value. These are the numbers and names, spelled out, so widening
	// or narrowing any of them is a deliberate edit to this line.
	assert.deepEqual([...DETERMINATE_FS_CODES].sort(), ["ELOOP", "ENAMETOOLONG", "ENOENT", "ENOTDIR"]);
	assert.deepEqual([...DETERMINATE_5XX].sort((a, b) => a - b), [501, 505]);
	assert.deepEqual([...TRANSIENT_STATUSES].sort((a, b) => a - b), [408, 425, 429]);
	assert.deepEqual(
		[...DETERMINATE_TLS_CODES].sort(),
		[
			"CERT_HAS_EXPIRED",
			"CERT_NOT_YET_VALID",
			"CERT_UNTRUSTED",
			"DEPTH_ZERO_SELF_SIGNED_CERT",
			"ERR_SSL_WRONG_VERSION_NUMBER",
			"ERR_TLS_CERT_ALTNAME_INVALID",
			"SELF_SIGNED_CERT_IN_CHAIN",
			"UNABLE_TO_GET_ISSUER_CERT",
			"UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
			"UNABLE_TO_VERIFY_LEAF_SIGNATURE",
		],
	);
});

test("absence, and a path that can never resolve, are determinate; a busy filesystem is not", () => {
	// ENOENT and ENOTDIR are absence. ELOOP and ENAMETOOLONG are properties of the PATH rather than of the
	// filesystem's mood: a symlink cycle and an over-long name resolve identically forever.
	for (const code of ["ENOENT", "ENOTDIR", "ELOOP", "ENAMETOOLONG"]) assert.equal(isDeterminateFsCode(code), true, code);
	// EACCES is the case the whole allow-list exists for: a not-yet-mounted autofs path, a deploy midway
	// through a chmod, and a genuinely wrong permission are indistinguishable from one stat.
	for (const code of ["EACCES", "EIO", "EAGAIN", "EMFILE", "ETIMEDOUT", "ESTALE", "EPERM", undefined, null, ""]) {
		assert.equal(isDeterminateFsCode(code), false, `${code} must land on the retryable side`);
	}
});

test("an unanswered probe is transient, which is what an unparseable status is", () => {
	// @octokit/request-error stores 0 when the status will not parse, and 0 is a number, so the old
	// `status !== undefined` catch-all read "we could not tell" as "the operator is wrong".
	for (const status of [undefined, null, 0, -1, NaN, "500", 1.5]) {
		assert.equal(isTransientStatus(status), true, `${String(status)} is indeterminate`);
	}
});

test("5xx and the timing statuses are transient; ordinary 4xx is not", () => {
	for (const status of [500, 502, 503, 504, 599, 408, 425, 429]) assert.equal(isTransientStatus(status), true, String(status));
	for (const status of [400, 401, 402, 404, 409, 410, 418, 422, 451]) assert.equal(isTransientStatus(status), false, String(status));
	// The two 5xx that are not about load. A proxy that does not implement a method, or does not speak the
	// version, answers identically forever, and both are what a misconfigured reverse proxy in front of a
	// self-hosted forge returns.
	for (const status of [501, 505]) assert.equal(isTransientStatus(status), false, String(status));
});

test("a 403 that announces a rate limit only in its BODY is still transient", () => {
	// GitHub's secondary limit can arrive with no retry-after and a non-zero quota, which is why their own
	// guidance ends in "otherwise wait at least a minute" and why octokit's throttling plugin reads the
	// body. Headers alone leave the busiest deployments getting the public misconfiguration comment.
	assert.equal(isTransientStatus(403, () => undefined, "You have exceeded a secondary rate limit"), true);
	assert.equal(isTransientStatus(403, () => undefined, "API rate limit exceeded for installation"), true);
	assert.equal(isTransientStatus(403, () => undefined, "Resource not accessible by integration"), false, "a scope refusal stays determinate");
	assert.equal(saysRateLimited(undefined), false);
	assert.equal(saysRateLimited(42), false, "a non-string must not throw");
});

test("a 403 whose body is not JSON did not come from the forge's API", () => {
	// A Cloudflare or WAF interstitial in front of a self-hosted forge. Nothing refused anything; something
	// in front of the API answered, which is indeterminate rather than a refusal we can read.
	const html = (n) => (n === "content-type" ? "text/html; charset=UTF-8" : undefined);
	const json = (n) => (n === "content-type" ? "application/json; charset=utf-8" : undefined);
	assert.equal(isTransientStatus(403, html), true);
	assert.equal(isTransientStatus(403, json), false, "a real refusal is JSON and stays determinate");
	// With no content-type at all the arm does not fire: absence of evidence is not the interstitial.
	assert.equal(isTransientStatus(403, () => undefined), false);
	assert.equal(isJsonContentType(json), true);
	assert.equal(isJsonContentType((n) => (n === "content-type" ? "application/vnd.github+json" : undefined)), true);
	assert.equal(isJsonContentType(() => undefined), false);
});

test("403 splits on the headers, and GitHub's primary rate limit is the case that was missed", () => {
	const none = () => undefined;
	assert.equal(isTransientStatus(403, none), false, "a bare 403 is a scope problem, and determinate");
	// Secondary limit: retry-after. This was the only arm the old code had.
	assert.equal(isTransientStatus(403, (n) => (n === "retry-after" ? "60" : undefined)), true);
	// Primary limit: x-ratelimit-remaining: 0 and x-ratelimit-reset, no retry-after. This is the one an
	// ordinary busy deployment hits, and it clears within the hour.
	assert.equal(isTransientStatus(403, (n) => (n === "x-ratelimit-remaining" ? "0" : undefined)), true);
	// Quota present is not a rate limit.
	assert.equal(isTransientStatus(403, (n) => (n === "x-ratelimit-remaining" ? "4999" : undefined)), false);
	// The header only widens 403. It must not rescue a 404.
	assert.equal(isTransientStatus(404, (n) => (n === "x-ratelimit-remaining" ? "0" : undefined)), false);
});

test("the two header readers cover the two shapes the callers actually hold", () => {
	// octokit: a lowercase-keyed plain object. fetch: a Headers instance behind .get().
	const fromOctokit = octokitHeaderReader({ response: { headers: { "retry-after": "30" } } });
	assert.equal(fromOctokit("retry-after"), "30");
	assert.equal(fromOctokit("x-ratelimit-remaining"), undefined);
	// A rejection with no response at all must not throw on the way to being classified.
	assert.equal(octokitHeaderReader(new Error("boom"))("retry-after"), undefined);
	assert.equal(octokitHeaderReader(undefined)("retry-after"), undefined);

	const fromResponse = responseHeaderReader({ headers: new Headers({ "retry-after": "30" }) });
	assert.equal(fromResponse("retry-after"), "30");
	assert.equal(fromResponse("x-ratelimit-remaining"), undefined);
	assert.equal(responseHeaderReader({})("retry-after"), undefined, "a fake response without headers must not throw");
});

test("a trust failure is determinate; a connection failure is not", () => {
	// The distinction the identity modules' own tests caught first. A private CA fails the handshake
	// identically forever until NODE_EXTRA_CA_CERTS is set, and reclassifying that as transient would
	// answer the commonest self-hosted misconfiguration with a supervisor restart loop.
	for (const code of DETERMINATE_TLS_CODES) {
		assert.equal(isDeterminateFetchFailure(new TypeError("fetch failed", { cause: Object.assign(new Error("x"), { code }) })), true, code);
	}
	// Every OpenSSL protocol alert, not only the two the set names. An appliance that speaks nothing newer
	// than TLS 1.0 answers ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION, which carries no listed code and no
	// "certificate" in its message, and is as determinate as a distrusted certificate. Asserted with codes
	// that are NOT in the set, or this pins the set rather than the prefix rule.
	for (const code of ["ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION", "ERR_SSL_PACKET_LENGTH_TOO_LONG", "ERR_SSL_UNSUPPORTED_PROTOCOL"]) {
		assert.equal(DETERMINATE_TLS_CODES.has(code), false, `${code} must not be in the set, or this test proves nothing`);
		assert.equal(isDeterminateFetchFailure(new TypeError("fetch failed", { cause: Object.assign(new Error("alert"), { code }) })), true, code);
	}

	// Node wraps the real cause one level down, which is why this walks the chain at all.
	assert.equal(
		isDeterminateFetchFailure(new TypeError("fetch failed", { cause: new Error("unable to verify the first certificate") })),
		true,
		"matched on the message too, because the chain is not guaranteed to carry a code",
	);
	for (const code of ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_SOCKET"]) {
		assert.equal(isDeterminateFetchFailure(new TypeError("fetch failed", { cause: Object.assign(new Error("x"), { code }) })), false, code);
	}
	assert.equal(isDeterminateFetchFailure(new Error("socket hang up")), false);
	assert.equal(isDeterminateFetchFailure(undefined), false, "a missing error must not throw");

	// The message test is guarded on the ABSENCE of a code, and this is why: Node's DNS errors embed the
	// hostname, so an unguarded /certificate/i makes every DNS failure at a host whose name contains that
	// word look like a trust problem -- and that is the direction where being wrong stops a service.
	const dns = new TypeError("fetch failed", {
		cause: Object.assign(new Error("getaddrinfo ENOTFOUND certificates.corp"), { code: "ENOTFOUND" }),
	});
	assert.equal(isDeterminateFetchFailure(dns), false, "a hostname containing 'certificate' is not a trust failure");
});

test("redirect: 'error' is a URL-shaped fault, and every client here passes it", () => {
	// An http:// URL for an https instance, or a host that 302s to an SSO portal, redirects identically
	// forever. Node gives no code for it, so the message is the only signal there is. Measured: the chain
	// is TypeError "fetch failed" -> Error "unexpected redirect".
	const redirect = new TypeError("fetch failed", { cause: new Error("unexpected redirect") });
	assert.equal(isDeterminateFetchFailure(redirect), true);
});

test("AggregateError.errors is walked, not just .cause", () => {
	// fetch reports a multi-address connect failure as an aggregate, and a cause-only walk steps straight
	// past the one frame carrying a code.
	const agg = new TypeError("fetch failed", {
		cause: new AggregateError([Object.assign(new Error("x"), { code: "SELF_SIGNED_CERT_IN_CHAIN" })], "all attempts failed"),
	});
	assert.equal(isDeterminateFetchFailure(agg), true);
});

test("both header readers accept every shape a caller might hold", () => {
	// Failing to read a header falls to the DETERMINATE side, which is the expensive one: a genuine rate
	// limit read through the wrong accessor becomes a public accusation. So neither reader is allowed to
	// care which shape it was handed.
	for (const make of [
		(v) => ({ response: { headers: { "retry-after": v } } }),
		(v) => ({ response: { headers: new Headers({ "retry-after": v }) } }),
		(v) => ({ response: { headers: new Map([["retry-after", v]]) } }),
	]) {
		assert.equal(octokitHeaderReader(make("60"))("retry-after"), "60");
		assert.equal(isTransientStatus(403, octokitHeaderReader(make("60"))), true);
	}
	for (const make of [
		(v) => ({ headers: { "retry-after": v } }),
		(v) => ({ headers: new Headers({ "retry-after": v }) }),
		(v) => ({ headers: new Map([["retry-after", v]]) }),
	]) {
		assert.equal(responseHeaderReader(make("60"))("retry-after"), "60");
	}
	// And a lookup never reads through Object.prototype: a header called `constructor` would otherwise
	// answer with a function, which is truthy.
	assert.equal(octokitHeaderReader({ response: { headers: {} } })("constructor"), undefined);
	assert.equal(responseHeaderReader({ headers: {} })("toString"), undefined);
	for (const hostile of [null, undefined, "a string", 42, { response: null }, { response: { headers: null } }]) {
		assert.doesNotThrow(() => octokitHeaderReader(hostile)("retry-after"));
		assert.doesNotThrow(() => responseHeaderReader(hostile)("retry-after"));
	}
});

test("the cause walk is bounded, and a cycle cannot hang it", () => {
	// `fetchFailureReason` bounds at four for the same reason; a self-referencing cause is not exotic.
	const a = new Error("a");
	const b = new Error("b");
	a.cause = b;
	b.cause = a;
	assert.equal(isDeterminateFetchFailure(a), false);
});

test("transientError produces an UNTAGGED error, which is the whole payload", () => {
	// `cli.mjs` and `receiver/src/cli.mjs` map a tagged throw to EXIT_POLICY (2), which
	// RestartPreventExitStatus=2 and nssm's `AppExit 2 Exit` deliberately leave STOPPED. Untagged is 1,
	// which restarts. The absence of the property is the contract.
	const cause = new Error("underneath");
	const e = transientError("could not reach the forge", cause);
	assert.equal(e.piDispatchConfig, undefined);
	assert.equal(e.piDispatchRetry, undefined, "it is not the processor's class either -- boot has no queue");
	assert.equal(e.message, "could not reach the forge");
	assert.equal(e.cause, cause);
	assert.equal(transientError("no cause given").cause, undefined);
});

test("this module imports nothing", () => {
	// It is reached from the identity modules, which the receiver imports through the worker package's
	// export map. An import here would eventually drag the processor, or node:fs, into a service that has
	// neither a queue nor a reason to read the disk. Same rule as reserved-env.mjs and provider-key.mjs.
	const src = readFileSync(new URL("../src/transient.mjs", import.meta.url), "utf8");
	assert.equal(/^\s*import\s/m.test(src), false, "transient.mjs must stay import-free");
});

test("the identity modules and the host modules now answer the SAME condition the same way", async () => {
	// Issue #316's acceptance, in its own words: "The identity and host modules classify the same condition
	// the same way, and a test pins the mapping rather than restating it." So this drives BOTH real modules
	// with one fault and compares their verdicts, rather than asserting a table that could drift from
	// either. The condition is the one that matters: a certificate the host will never trust.
	const { resolveGitLabSelfId } = await import("../src/gitlab-identity.mjs");
	const { makeGitLabHost } = await import("../src/gitlab-host.mjs");

	const trustFailure = () => {
		throw new TypeError("fetch failed", {
			cause: Object.assign(new Error("unable to verify the first certificate"), { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" }),
		});
	};
	const identityVerdict = await resolveGitLabSelfId({ apiUrl: "https://gl.internal", token: "t", fetchFn: trustFailure }).then(
		() => null,
		(e) => e.piDispatchConfig === true,
	);
	const host = makeGitLabHost({ apiUrl: "https://gl.internal", fetchFn: trustFailure });
	const hostVerdict = await host
		.isDefaultBranchProtected({ kind: "gitlab", repo: "group/proj", projectId: 42 }, "t")
		.then(() => null, (e) => e.piDispatchConfig === true);

	assert.equal(identityVerdict, true, "the identity module calls a trust failure determinate");
	assert.equal(hostVerdict, true, "and so does the host module, which used to retry it twice and say nothing");
	assert.equal(identityVerdict, hostVerdict, "the two precedents the issue named are now one rule");

	// And the bound: a refused connection is transient on BOTH sides. Agreeing on everything would mean the
	// host had simply stopped retrying, which is the opposite defect.
	const refused = () => {
		throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
	};
	const idRefused = await resolveGitLabSelfId({ apiUrl: "https://gl.internal", token: "t", fetchFn: refused }).then(() => null, (e) => e.piDispatchConfig === true);
	const hostRefused = await makeGitLabHost({ apiUrl: "https://gl.internal", fetchFn: refused })
		.isDefaultBranchProtected({ kind: "gitlab", repo: "group/proj", projectId: 42 }, "t")
		.then(() => null, (e) => e.piDispatchConfig === true);
	assert.equal(idRefused, false, "a refused connection stays retryable in the identity module");
	assert.equal(hostRefused, false, "and in the host module");
});
