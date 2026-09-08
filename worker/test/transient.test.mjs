import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
	DETERMINATE_FS_CODES,
	DETERMINATE_TLS_CODES,
	TRANSIENT_STATUSES,
	isDeterminateFetchFailure,
	isDeterminateFsCode,
	isTransientStatus,
	octokitHeaderReader,
	responseHeaderReader,
	transientError,
} from "../src/transient.mjs";

// The rule itself (issue #316). Every one of these cases existed as a defect somewhere before this module
// did, and the point of pinning them here rather than only at the call sites is that four call sites used
// to answer them four different ways.

test("the three vocabularies are pinned as LITERALS, not derived from themselves", () => {
	// A test that builds its expectation from the same constant the code reads is correct at any value and
	// therefore blind to a change IN that value. These are the numbers and names, spelled out, so widening
	// or narrowing any of them is a deliberate edit to this line.
	assert.deepEqual([...DETERMINATE_FS_CODES].sort(), ["ENOENT", "ENOTDIR"]);
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

test("only absence is determinate on the filesystem", () => {
	for (const code of ["ENOENT", "ENOTDIR"]) assert.equal(isDeterminateFsCode(code), true, code);
	// EACCES is the case the whole allow-list exists for: a not-yet-mounted autofs path, a deploy midway
	// through a chmod, and a genuinely wrong permission are indistinguishable from one stat.
	for (const code of ["EACCES", "EIO", "EAGAIN", "EMFILE", "ETIMEDOUT", "ESTALE", "ELOOP", "EPERM", undefined, null, ""]) {
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
