/**
 * One stated rule for the question `CONST-RETRY-INFRA-ONLY` asks at every failure site: would the same
 * job, with the same inputs, refuse identically an hour from now with nobody touching anything?
 *
 * Absence, a bad credential, a malformed file: yes, determinate, and the operator has to fix it.
 * A rate limit, a busy or unreachable filesystem, a network timeout, a forge that answered 502: no.
 *
 * WHY THIS EXISTS AS A MODULE (issue #316). The distinction was drawn twice, differently, one file apart:
 * `gitlab-host.mjs` and `forgejo-host.mjs` classify a fetch rejection, a non-ok status and an unparseable
 * body as `InfraRetry`, while `gitlab-identity.mjs`, `forgejo-identity.mjs`, `azure-identity.mjs` and
 * `identity.mjs` tagged those same three conditions `piDispatchConfig`. Two precedents and no rule, which
 * is how `classifyAppMintError` came to send a GitHub primary rate limit to the determinate side. #310
 * made that expensive: the tag now means never retried, budget refunded, and a PUBLIC comment telling the
 * issue author that the operator's deployment is misconfigured.
 *
 * IMPORT-FREE, and it has to stay that way. The identity modules are re-exported to the receiver through
 * `worker/package.json`'s export map, and the receiver has no business importing `processor.mjs` to reach
 * `InfraRetry`. So the rule is a pair of predicates over a status and an errno, and each caller pairs it
 * with the throw its own layer can afford: `InfraRetry` where the processor will retry, an UNTAGGED throw
 * at boot, where `entryExitCode` maps untagged to 1 (the supervisor restarts) and tagged to `EXIT_POLICY`
 * (2), which `RestartPreventExitStatus=2` and `AppExit 2 Exit` deliberately leave stopped.
 */

/**
 * Filesystem and spawn errnos that really do mean "it is not there", and only those.
 *
 * An ALLOW-LIST, not a deny-list, which is the shape `env-allowlist.mjs`'s `credentialFromPiAuth` already
 * argues for and the reason the two agree: the expensive direction is the false determinate, so a code
 * nobody has thought about lands on the retryable side. `EACCES` is transient on purpose and it is the
 * case that motivates the whole set: a not-yet-mounted autofs path, a directory whose permissions a
 * deploy is mid-way through changing, and a genuinely wrong chmod are indistinguishable from one stat,
 * and only the last one is the operator's to fix.
 *
 * `ENOTDIR` joins `ENOENT` because a path component that is a file is the same answer as absence: there
 * is nothing at that path and there never was.
 */
export const DETERMINATE_FS_CODES = new Set(["ENOENT", "ENOTDIR"]);

/** True when this errno means the thing is absent, rather than momentarily out of reach. */
export function isDeterminateFsCode(code) {
	return DETERMINATE_FS_CODES.has(code);
}

/**
 * HTTP statuses that are transient on their own, regardless of headers.
 *
 * 429 is the obvious one. 408 (request timeout) and 425 (too early) are the two the old catch-all in
 * `classifyAppMintError` swallowed alongside it, both of them by definition about timing.
 */
export const TRANSIENT_STATUSES = new Set([408, 425, 429]);

/**
 * Classify an HTTP status, with the headers available where they change the answer.
 *
 * `getHeader` is a FUNCTION rather than a headers object because the two callers hold two different
 * shapes: octokit exposes `error.response.headers` as a lowercase-keyed plain object, and `fetch` exposes
 * `res.headers.get(name)`. A shared helper that took one of them would make the other call site adapt at
 * the point where a mistake is silent.
 *
 * The 403 arm is the defect this module was written for. GitHub answers a PRIMARY rate limit with 403 and
 * `x-ratelimit-remaining: 0`, sending `x-ratelimit-reset` and NO `retry-after`; only the secondary limit
 * sends `retry-after`. The old code tested `retry-after` alone, so the primary limit -- the one an
 * ordinary busy deployment actually hits, and which clears within the hour -- fell through to the
 * catch-all and was reported to the issue author as a misconfiguration. `receiver/src/poller.mjs` has
 * modelled this correctly since it was written; this is that condition, one package over.
 *
 * A status that is absent or is not a positive integer is INDETERMINATE and therefore transient. That is
 * not hypothetical: `@octokit/request-error` sets `status = 0` when the status will not parse, and `0` is
 * a number, so the old `status !== undefined` catch-all turned "we could not tell what happened" into a
 * permanent refusal. The same split `makeImagePreflight` draws with `docker info`: a determinate negative
 * is a policy answer, an unanswered probe is not.
 */
export function isTransientStatus(status, getHeader = () => undefined) {
	if (!Number.isInteger(status) || status <= 0) return true;
	if (status >= 500) return true;
	if (TRANSIENT_STATUSES.has(status)) return true;
	if (status === 403) {
		// Secondary rate limit, then primary. Anything else answering 403 is a scope or credential
		// problem, which is determinate and stays on the config side.
		if (getHeader("retry-after") !== undefined && getHeader("retry-after") !== null) return true;
		if (String(getHeader("x-ratelimit-remaining") ?? "") === "0") return true;
	}
	return false;
}

/**
 * TLS and protocol faults that are determinate, and therefore the one family of fetch rejection that
 * stays tagged.
 *
 * A CONNECTION is transient by default: refused, reset, timed out, DNS that did not answer. A TRUST
 * failure is not. An instance behind a private CA fails the handshake identically forever until the
 * operator sets `NODE_EXTRA_CA_CERTS`, which is the single commonest self-hosted GitLab misconfiguration
 * and the reason `fetchFailureReason` unwraps the cause chain at all: the whole point of that unwrapping
 * is to put "unable to verify the first certificate" in front of an operator so they can act on it, and
 * reclassifying it as transient would answer that with a restart loop instead.
 *
 * Matched on the CODE, which is what Node actually sets, and additionally on the word "certificate"
 * anywhere in the cause chain's messages, because the chain is not guaranteed to carry a code and this is
 * the direction where being wrong is expensive: a determinate trust failure misread as transient becomes
 * a supervisor restarting a service that can never come up.
 */
export const DETERMINATE_TLS_CODES = new Set([
	"UNABLE_TO_GET_ISSUER_CERT",
	"UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
	"UNABLE_TO_VERIFY_LEAF_SIGNATURE",
	"SELF_SIGNED_CERT_IN_CHAIN",
	"DEPTH_ZERO_SELF_SIGNED_CERT",
	"CERT_UNTRUSTED",
	"CERT_HAS_EXPIRED",
	"CERT_NOT_YET_VALID",
	"ERR_TLS_CERT_ALTNAME_INVALID",
	"ERR_SSL_WRONG_VERSION_NUMBER",
]);

/**
 * True when a `fetch` rejection names a trust or protocol problem an operator has to fix.
 *
 * Walks the cause chain to the same depth `fetchFailureReason` does, and for the same reason: Node's
 * `fetch` rejects with the bare string "fetch failed" and puts everything that matters underneath.
 */
export function isDeterminateFetchFailure(err) {
	for (let e = err, depth = 0; e && depth < 4; e = e.cause, depth++) {
		if (DETERMINATE_TLS_CODES.has(e?.code)) return true;
		if (typeof e?.message === "string" && /certificate/i.test(e.message)) return true;
	}
	return false;
}

/**
 * A transient failure, reported UNTAGGED.
 *
 * The absence of the tag is the whole payload: `cli.mjs` and `receiver/src/cli.mjs` both map a tagged
 * throw to `EXIT_POLICY` (2), which `RestartPreventExitStatus=2` and nssm's `AppExit 2 Exit` deliberately
 * leave stopped, and map everything else to 1, which restarts. A boot-path caller therefore cannot use
 * `InfraRetry` (it lives in `processor.mjs`, which the receiver must not import) and does not need to:
 * plain is exactly right, and naming the constructor keeps that a decision rather than an omission.
 */
export function transientError(message, cause) {
	return new Error(message, cause ? { cause } : undefined);
}

/** Read a header off octokit's plain lowercase-keyed `error.response.headers` bag. */
export function octokitHeaderReader(error) {
	const headers = error?.response?.headers;
	return (name) => (headers && typeof headers === "object" ? headers[name] : undefined);
}

/** Read a header off a WHATWG `Response`. `redirect: "error"` responses still carry one. */
export function responseHeaderReader(res) {
	return (name) => res?.headers?.get?.(name) ?? undefined;
}
