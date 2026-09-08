/**
 * One stated rule for the question `CONST-RETRY-INFRA-ONLY` asks at every failure site: would the same
 * job, with the same inputs, refuse identically an hour from now with nobody touching anything?
 *
 * Absence, a bad credential, a malformed file, a URL that will always redirect, a certificate the host
 * will always distrust: yes, determinate, and the operator has to fix it. A rate limit, a busy or
 * unreachable filesystem, a network timeout, a forge that answered 502: no.
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
 * `InfraRetry`. So the rule is a set of predicates over a status, an errno and a rejection, and each
 * caller pairs it with the throw its own layer can afford: `InfraRetry` where the processor will retry, an
 * UNTAGGED throw at boot, where `entryExitCode` maps untagged to 1 (the supervisor restarts) and tagged to
 * `EXIT_POLICY` (2), which `RestartPreventExitStatus=2` and `AppExit 2 Exit` deliberately leave stopped.
 */

/**
 * Filesystem and spawn errnos that mean the thing is not there, or can never be reached by that name.
 *
 * An ALLOW-LIST, not a deny-list, which is the shape `env-allowlist.mjs`'s `credentialFromPiAuth` already
 * argues for and the reason the two agree: the expensive direction is the false determinate, so a code
 * nobody has thought about lands on the retryable side. `EACCES` is transient on purpose and it is the
 * case that motivates the whole set: a not-yet-mounted autofs path, a directory whose permissions a
 * deploy is mid-way through changing, and a genuinely wrong chmod are indistinguishable from one stat,
 * and only the last one is the operator's to fix.
 *
 * `ENOTDIR` joins `ENOENT` because a path component that is a file is the same answer as absence. `ELOOP`
 * and `ENAMETOOLONG` are properties of the PATH rather than of the filesystem's mood: a symlink cycle and
 * an over-long name resolve identically forever, and retrying either is paying to be told so twice.
 */
export const DETERMINATE_FS_CODES = new Set(["ENOENT", "ENOTDIR", "ELOOP", "ENAMETOOLONG"]);

/** True when this errno means the thing is absent or unreachable by that name, rather than out of reach now. */
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
 * The two 5xx that are NOT about load. "This server does not implement that method" and "it does not
 * speak that HTTP version" answer identically forever, and both are what a misconfigured reverse proxy in
 * front of a self-hosted forge actually returns.
 */
export const DETERMINATE_5XX = new Set([501, 505]);

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
 * usually sends `retry-after`. The old code tested `retry-after` alone, so the primary limit -- the one an
 * ordinary busy deployment actually hits, and which clears within the hour -- fell through to the
 * catch-all and was reported to the issue author as a misconfiguration.
 *
 * **A SECONDARY limit can arrive with NEITHER header**, which is why GitHub's own guidance is a three-rung
 * ladder ending in "otherwise wait at least a minute", and why octokit's throttling plugin detects it by
 * matching the response BODY rather than the headers. Headers alone are therefore not enough, and the
 * callers that hold a message pass it here; see `saysRateLimited`.
 *
 * A status that is absent or is not a positive integer is INDETERMINATE and therefore transient. That is
 * not hypothetical: `@octokit/request-error` sets `status = 0` when the status will not parse, and `0` is
 * a number, so the old `status !== undefined` catch-all turned "we could not tell what happened" into a
 * permanent refusal. The same split `makeImagePreflight` draws with `docker info`: a determinate negative
 * is a policy answer, an unanswered probe is not.
 */
export function isTransientStatus(status, getHeader = () => undefined, message = undefined) {
	if (!Number.isInteger(status) || status <= 0) return true;
	if (DETERMINATE_5XX.has(status)) return false;
	if (status >= 500) return true;
	if (TRANSIENT_STATUSES.has(status)) return true;
	if (status === 403) {
		// Secondary rate limit by header, then primary by quota, then the secondary limit that announces
		// itself only in its body. Anything else answering 403 is a scope or credential problem, which is
		// determinate.
		const retryAfter = getHeader("retry-after");
		if (retryAfter !== undefined && retryAfter !== null) return true;
		if (String(getHeader("x-ratelimit-remaining") ?? "") === "0") return true;
		if (saysRateLimited(message)) return true;
		// A 403 whose body is not JSON did not come from the forge's API at all: it is a WAF or proxy
		// interstitial in front of it, which is indeterminate rather than a refusal we can read.
		if (getHeader("content-type") !== undefined && !isJsonContentType(getHeader)) return true;
	}
	return false;
}

/**
 * Whether a response claims to carry JSON.
 *
 * The discriminator for an unparseable body, which is otherwise ambiguous in the expensive direction. A
 * TRUNCATED JSON body is transient. An HTML page is not: it is a Cloudflare Access or OIDC portal
 * answering instead of the forge, or Azure DevOps answering an expired PAT with **203 and a sign-in
 * page** -- 203 is `ok`, so it reaches the parse rather than the status check, and an expired PAT is
 * about as determinate as a fault gets.
 */
export function isJsonContentType(getHeader) {
	const type = String(getHeader("content-type") ?? "").toLowerCase();
	return type.includes("application/json") || type.includes("+json");
}

/**
 * Whether an error body says it is a rate limit, for the 403s where the headers do not.
 *
 * The vocabulary is GitHub's own and matches what octokit's throttling plugin looks for. Kept as a
 * message test rather than a status rule because that is the only channel this case has.
 */
export function saysRateLimited(message) {
	return typeof message === "string" && /secondary rate limit|abuse detection|rate limit exceeded/i.test(message);
}

/**
 * TLS and protocol faults that are determinate, and therefore the one family of connection failure that
 * stays tagged.
 *
 * A CONNECTION is transient by default: refused, reset, timed out, DNS that did not answer. A TRUST
 * failure is not. An instance behind a private CA fails the handshake identically forever until the
 * operator sets `NODE_EXTRA_CA_CERTS`, which is the single commonest self-hosted GitLab misconfiguration
 * and the reason `fetchFailureReason` unwraps the cause chain at all: the whole point of that unwrapping
 * is to put "unable to verify the first certificate" in front of an operator so they can act on it, and
 * reclassifying it as transient would answer that with a restart loop instead.
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
	// `ERR_SSL_*` is matched by PREFIX beside this set (see `isDeterminateFetchFailure`); this one is
	// named as the worked example of why, and because it is the commonest of them.
	"ERR_SSL_WRONG_VERSION_NUMBER",
]);

/**
 * True when a rejection names a fault an operator has to fix, rather than one that may clear on its own.
 *
 * Walks the cause chain the way `fetchFailureReason` does, and `AggregateError.errors` beside it, because
 * `fetch` reports a multi-address connect failure as an aggregate and a cause walk alone would step past
 * the only frame carrying a code.
 *
 * TWO SIGNALS, and the second is deliberately narrow. The CODE is the real one, and every TLS failure
 * Node actually produces carries it. The message is only consulted when a frame has NO code at all, for
 * two cases where Node gives nothing else: a cause that lost its code on the way through a wrapper, and
 * `redirect: "error"`, which every client here passes and which rejects with the bare string "unexpected
 * redirect". A redirect is a URL-shaped fault wearing a connection failure's clothes: an `http://` URL for
 * an https instance, or a host that 302s to an SSO portal, redirects identically forever.
 *
 * The code guard on the message test is not decoration. Node's DNS errors embed the HOSTNAME
 * (`getaddrinfo ENOTFOUND certificates.corp`), so an unguarded `/certificate/i` over the whole chain makes
 * every DNS failure at a host whose name contains that word look like a trust problem, which is the
 * expensive direction.
 *
 * Deliberately NOT determinate: `ENOTFOUND` and `ECONNREFUSED`. A typo'd hostname and a wrong port are
 * permanent, and are indistinguishable from a DNS outage or a forge that is down. They stay on the
 * retryable side under this module's own allow-list rule, and that residual is named here rather than
 * hidden.
 */
export function isDeterminateFetchFailure(err) {
	const seen = new Set();
	const walk = (e, depth) => {
		if (!e || depth > 6 || seen.has(e)) return false;
		seen.add(e);
		if (DETERMINATE_TLS_CODES.has(e.code)) return true;
		// Every OpenSSL protocol alert, not just the two spelled out above. An appliance that only speaks
		// TLS 1.0 answers `ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION`, which is as determinate as a distrusted
		// certificate and was missed by a name list; the prefix is the derivable version of that list.
		if (typeof e.code === "string" && e.code.startsWith("ERR_SSL_")) return true;
		if (e.code === undefined && typeof e.message === "string") {
			if (/certificate/i.test(e.message)) return true;
			if (e.message === "unexpected redirect") return true;
		}
		if (Array.isArray(e.errors) && e.errors.some((inner) => walk(inner, depth + 1))) return true;
		return walk(e.cause, depth + 1);
	};
	return walk(err, 0);
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

/**
 * Read one header out of whatever shape the caller happens to hold.
 *
 * Both readers accept a plain object, a `Headers` and a `Map`, and the reason is that failing to read a
 * header falls to the DETERMINATE side, which is the expensive one: a genuine rate limit read through the
 * wrong accessor becomes a public accusation. `@octokit/request` v7 builds a plain object today, and
 * `fetch` gives a `Headers`, but neither is guaranteed by anything in this repo, and a silent `undefined`
 * is not a failure mode worth keeping for the sake of two fewer branches.
 *
 * `Object.hasOwn` matters: a bare `headers[name]` reads through `Object.prototype`, so a lookup for a
 * header called `constructor` would answer with a function.
 */
function headerReaderFor(headers) {
	if (!headers) return () => undefined;
	if (typeof headers.get === "function") return (name) => headers.get(name) ?? undefined;
	if (typeof headers === "object") return (name) => (Object.hasOwn(headers, name) ? headers[name] : undefined);
	return () => undefined;
}

/** Read a header off an octokit rejection's `error.response.headers` bag. */
export function octokitHeaderReader(error) {
	return headerReaderFor(error?.response?.headers);
}

/** Read a header off a WHATWG `Response`. `redirect: "error"` responses still carry one. */
export function responseHeaderReader(res) {
	return headerReaderFor(res?.headers);
}
