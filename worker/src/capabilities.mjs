/**
 * What a host can serve, and which queue a job that needs one of those things belongs on (issue #57,
 * `OQ-032`).
 *
 * Two trigger fields bind a job to a MACHINE rather than to a repository: `run.secretsProfile` names a
 * resolver the operator declared in that host's `PI_SECRET_PROFILES`, and a `run.waitFor` condition names a
 * check script from its `PI_WAIT_PROFILES`. Both are refused pre-spend when the host popping the job has
 * not declared them, and both refusals are RETURNED rather than thrown, so they are never retried. The
 * same trigger therefore succeeds or fails depending on which worker happened to take the delivery, and it
 * reads like a configuration error rather than a placement one.
 *
 * #57's Gap 2 exempted forge jobs on the grounds that their workspace is a fresh clone that any host can
 * build. Issues #225 and #230 retracted that without saying so: a clone is portable, a resolver on one
 * machine's disk is not.
 *
 * WHY THIS IS DECIDED AT ENQUEUE. The obvious alternative is to let any host take the job and defer it if
 * it cannot serve it. That does not work here, and the reason is upstream rather than ours: BullMQ promotes
 * a delayed job on EACH WORKER'S OWN CLOCK (`scripts.js` passes the client clock as the cut-off), so the
 * host whose clock runs fastest wins every attempt, deterministically. If the host that cannot serve the
 * job is the fast one, the job never reaches the one that can. Jitter changes when the attempt happens, not
 * who wins it.
 *
 * THE ONE CAPABILITY DELIBERATELY NOT ROUTED is `run.resume`. A session key is `sha256(kind, repo, ref)`
 * and `session-store.mjs` records that it is "not random... anyone who knows the repository and the branch
 * can compute it", so publishing keys to route on them would disclose which repositories and branches a
 * deployment works on, recoverable by guessing a repo name. That is more disclosing than everything else in
 * the registry combined. A resume that lands on the wrong host cold-starts and says so in the record.
 */

/** Class letters. Open enum: `g:` is reserved for forge credentials, the highest-value follow-on. */
export const CAP_SECRET = "s";
export const CAP_WAIT = "w";

/**
 * The name charset, duplicated from `secret-profiles.mjs` and `wait-for.mjs` deliberately: this module
 * imports nothing, and the two it copies already copy it from `triggers.mjs` for the same reason. What
 * matters here is what the set EXCLUDES -- a comma, so the token list joins unambiguously, and a colon, so
 * `<class>:<name>` decomposes at the first one.
 */
const PROFILE_NAME = /^[A-Za-z0-9._-]+$/;

/**
 * How fresh a host's registry row must be before a job is ROUTED to it.
 *
 * Not the 90s TTL, and the difference is the point. The TTL is a crash backstop: it answers "has this host
 * definitely gone", and it is deliberately six missed beats so a blip cannot evict a working host from the
 * panel. A routing decision needs the opposite polarity -- evidence of LIFE, not absence of expiry --
 * because a job routed onto a dead host's queue sits there until that host comes back, and nothing else
 * will take it. Three beats is late enough to ride out a slow beat and early enough that a stopped host
 * stops attracting work long before its row expires.
 */
export const ROUTE_FRESH_MS = 45_000;

/** One token, or null when the name is not one this deployment would accept. */
function token(cls, name) {
	return typeof name === "string" && PROFILE_NAME.test(name) ? `${cls}:${name}` : null;
}

/**
 * What THIS host can serve, from its own config, as a sorted token list.
 *
 * Sorted so the published string is stable: an unstable one would make the row differ every beat and any
 * future fingerprint over it useless.
 */
export function capabilityTokens({ secretProfiles, waitProfiles } = {}) {
	const out = new Set();
	for (const name of Object.keys(secretProfiles ?? {})) {
		const t = token(CAP_SECRET, name);
		if (t) out.add(t);
	}
	for (const name of Object.keys(waitProfiles ?? {})) {
		const t = token(CAP_WAIT, name);
		if (t) out.add(t);
	}
	return [...out].sort();
}

/** The registry value. Comma-joined, which the charset makes unambiguous. */
export function serializeCaps(tokens) {
	return (tokens ?? []).join(",");
}

/**
 * A peer's tokens, from its registry row. Peer-written, so every element is re-validated here rather than
 * trusted: a row is written by another process and this one decides where money-spending work goes.
 */
export function parseCaps(raw) {
	const out = new Set();
	for (const part of String(raw ?? "").split(",")) {
		const at = part.indexOf(":");
		if (at <= 0) continue;
		const cls = part.slice(0, at);
		const name = part.slice(at + 1);
		if ((cls === CAP_SECRET || cls === CAP_WAIT) && PROFILE_NAME.test(name)) out.add(part);
	}
	return out;
}

/**
 * The implicit profile, `DEFAULT_SECRETS_PROFILE` in `secrets.mjs`, copied rather than imported for the
 * reason the charset above is: that module spawns resolvers and this one is loaded by the receiver. A test
 * holds the two equal.
 */
export const IMPLICIT_SECRET_PROFILE = "default";

/**
 * The profile a job's secrets resolve through, or undefined when it asked for none. `secretsArmed`'s rule
 * (`secrets.mjs`), spelled again here for the same reason as the constant: an explicit profile, or a
 * non-empty `secrets` map, which then resolves through the implicit `default` (issue #704). Before #704 only
 * the explicit field was a need, so a trigger that never wrote `run.secretsProfile` was never routed and took
 * the coin flip this module exists to remove.
 *
 * UPGRADE THE WORKERS BEFORE THE RECEIVER (and the console, whose re-run routes by this rule too). The router
 * only ever picks a host that ADVERTISES every need, so the new need never sends a job to a host that cannot
 * serve it. But an older worker advertises `s:default` only when its ENV declares it: one whose `default`
 * lives in the overlay serves it without saying so. For a job with only this need that costs nothing (no
 * advertiser is abstention 3, the shared queue it used before). For a job with a SECOND need it can regress:
 * `run.secrets` without a profile plus a `w:ci` wait, an older host A declaring `w:ci` and serving `default`
 * from its overlay, host B declaring neither. Before #704 the job needed `[w:ci]` and was routed to A; under
 * a new receiver it needs `[s:default, w:ci]`, no host advertises both, and the shared queue lets B pop it
 * and refuse. Once every worker runs this release, A advertises its overlay `default` and the job is routed
 * to A again. An older receiver computes no such need and routes as before.
 */
// Exported (issue #712) for the run record's `secretsProfile` (run-history.mjs), which must name the profile this rule
// routes by and `resolveSecrets` resolves through, and must not import secrets.mjs, which spawns.
export function secretProfileNeeded(job) {
	const named = job?.secretsProfile;
	if (typeof named === "string" && named !== "") return named;
	const secrets = job?.secrets;
	if (secrets !== null && typeof secrets === "object" && Object.keys(secrets).length > 0) return IMPLICIT_SECRET_PROFILE;
	return undefined;
}

/**
 * What a JOB needs, from the same two fields the worker's own refusals read.
 *
 * `waitProfileNames`-shaped inline rather than imported, because this module is loaded by the RECEIVER and
 * `wait-for.mjs` carries the whole wait engine. The extraction is three lines and the charset check below
 * is the same one that module makes.
 */
export function jobNeeds(job) {
	const needs = new Set();
	const secret = token(CAP_SECRET, secretProfileNeeded(job));
	if (secret) needs.add(secret);
	if (Array.isArray(job?.waitFor)) {
		for (const condition of job.waitFor) {
			const wait = token(CAP_WAIT, condition?.profile);
			if (wait) needs.add(wait);
		}
	}
	return [...needs].sort();
}

/**
 * Which queue this job belongs on: a host queue name, or `null` for the shared queue.
 *
 * FOUR ABSTENTIONS, and each one lands on today's behaviour rather than on something new. That is what
 * makes this safe to put in front of every forge delivery: the rule can only ever move a job that would
 * otherwise have had a coin flip decide whether it ran.
 *
 *   1. The job needs nothing host-specific. The overwhelming majority of deliveries.
 *   2. EVERY live host can serve it. The shared queue is then strictly better than picking one, because it
 *      load-balances, and it is what the docs tell operators to aim for by declaring the same profiles
 *      everywhere. A deployment that follows that advice is byte-identical to before.
 *   3. NO host can serve it. Routing cannot help, and the shared queue produces the existing pre-spend
 *      refusal (`secret-profile-unknown` / `wait-profile-unknown`), which is the honest answer and already
 *      names what to fix. Inventing a new terminal state here would be worse than the one that exists.
 *   4. No CAPABLE host has a queue of its own, or the registry could not be read. Nothing to route to.
 *
 * Otherwise the job goes to a capable host, chosen by hashing its jobId: deterministic, so a redelivery of
 * the same job lands the same way and dedup still works, and spread, so a delivery fanned out into replicas
 * does not pile every replica onto one machine.
 */
export function routeForgeJob({ hosts, needs, jobId, now = () => Date.now(), freshMs = ROUTE_FRESH_MS } = {}) {
	if (!Array.isArray(needs) || needs.length === 0) return null; // (1)
	if (!Array.isArray(hosts) || hosts.length === 0) return null; // (4) unreadable registry, or nobody home

	const live = hosts.filter((h) => {
		// `staleMs` is derived by the reader; a row without one is a row we cannot date, and an undatable
		// row is not evidence of life.
		const stale = Number(h?.staleMs);
		return Number.isFinite(stale) && stale <= freshMs;
	});
	if (live.length === 0) return null;

	const serves = (h) => {
		const caps = parseCaps(h?.caps);
		return needs.every((n) => caps.has(n));
	};
	const capable = live.filter(serves);
	if (capable.length === 0) return null; // (3)
	if (capable.length === live.length) return null; // (2)

	// Only a host that DECLARED a name drains a queue of its own; an undeclared one reads the shared queue
	// only, so routing to it would be routing into a queue nothing drains.
	const routable = capable.filter((h) => h?.routes === true || h?.routes === "true").map((h) => h?.name).filter((n) => typeof n === "string" && n !== "");
	if (routable.length === 0) return null; // (4)

	routable.sort();
	return routable[hashIndex(String(jobId ?? ""), routable.length)];
}

/**
 * A stable index from a string. FNV-1a, inline: this module imports nothing, and a cryptographic hash would
 * be a strange dependency for choosing between two machines.
 */
function hashIndex(text, modulo) {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h % modulo;
}
