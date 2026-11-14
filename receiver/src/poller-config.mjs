/**
 * Poller configuration (issue #81, polling producer). The polling producer shares almost everything
 * with the webhook receiver -- the triggers file, the GitHub auth block, the queue URL -- and differs
 * on exactly one requirement: WEBHOOK_SECRET.
 *
 * The receiver HARD-REQUIRES that secret because an inbound delivery is a forgeable paid-agent
 * trigger until the HMAC over the raw body proves otherwise (CONST-HMAC-OVER-RAW-BODY). The poller
 * has no inbound anything: it originates every request itself, over TLS, to api.github.com, carrying
 * the operator's own credential -- the authentication runs in the OTHER direction, so there is
 * nothing for a webhook secret to verify and demanding one would block exactly the deployment this
 * mode exists for (no public URL, no DNS, no tunnel).
 *
 * REUSE, NEVER RE-DERIVE: this loader does not fork `loadTriggers`/`loadGitHubAuth`. It calls the
 * receiver's own `loadReceiverConfig` -- the single place the trigger file is grouped for the filter
 * and the auth block is validated -- satisfying its WEBHOOK_SECRET precondition with an inert
 * placeholder when the env has none, and then DROPS the field from the returned object so nothing
 * downstream can ever read the placeholder and believe it is armed. A forked grouping loader would be
 * the classic drift: two parsers of one file, one of them quietly behind on the next rule field.
 *
 * Poller-specific env:
 *   - POLL_REPOS: comma-separated `owner/name` list -- the explicit answer to "which repos". When
 *     unset AND GITHUB_AUTH_SOURCE=app, the poller instead lists the App installation's repositories
 *     at boot (and refreshes at low frequency). Unset with any other auth source is a config error:
 *     a PAT/gh credential names no repo set, and a poller that watched nothing would look exactly
 *     like a poller that was working.
 *   - POLL_INTERVAL_SECONDS: the cycle delay, default 60, floored at 30. The floor is a courtesy to
 *     GitHub's polling guidance (the API asks pollers to respect `X-Poll-Interval`, typically 60s);
 *     a typo'd `1` must not turn the harness into a hammer.
 *   - POLL_CATCHUP_MINUTES: the catch-up horizon (issue #880), default 60. A repository whose next poll has
 *     been due for longer than this when a starting poller first polls it is re-armed from now instead of
 *     resumed (see the poller's header). 0 is a sentinel, never catch up, which is why this is the
 *     non-negative parse and not the interval's positive one. No floor ties it to POLL_INTERVAL_SECONDS:
 *     the age counts from when the next poll was DUE, so the interval (and GitHub's x-poll-interval, and a
 *     rate-limit sleep) never adds to it, and a one-minute horizon means one minute past the planned wait,
 *     not a refusal to catch up at all. There is no refusal above the cursor TTL: a horizon at or past the TTL
 *     means exactly what the operator asked, catch up as far as the stored cursors reach, so the poller
 *     clamps it there (`CATCH_UP_CAP_MINUTES`) rather than this loader refusing a value that is not wrong.
 *     The cap lives in poller.mjs beside the TTL it is made of; importing it here would make a cycle.
 *
 * Errors are tagged `piDispatchConfig` (shared `configError`), so the receiver bin's entryExitCode
 * maps them to EXIT_POLICY (2) and a supervisor never restart-loops a config that cannot parse.
 */

import { existsSync, readFileSync } from "node:fs";
import { configError, nonNegativeInt, positiveInt } from "@edgehero/pi-dispatch/config";
import { loadReceiverConfig } from "./config.mjs";

// Never a real secret and never returned: it exists only to satisfy loadReceiverConfig's fail-loud
// precondition when the deployment is pure-polling and legitimately has no WEBHOOK_SECRET at all.
const PLACEHOLDER_SECRET = "poller-has-no-webhook-to-verify";

const POLL_INTERVAL_FLOOR_SECONDS = 30;
const POLL_INTERVAL_DEFAULT_SECONDS = 60;
// An hour (issue #880): long enough for a host restart, an upgrade or a supervisor's restart loop to catch up
// on what it missed, short of the days after which a label is no longer an approval for that moment.
const POLL_CATCHUP_DEFAULT_MINUTES = 60;

/**
 * Parse the poller's config from `env`. Filesystem access is injected (`readFile`, `fileExists`) and
 * forwarded to the receiver loader, so the whole thing is hermetically testable.
 *
 * Returns `{ valkeyUrl, triggers, github, repos, intervalSeconds, catchUpMinutes, identityRetryWindowMs }` --
 * and deliberately nothing else.
 * `webhookSecret`, `port`, `bind` and the other-forge blocks are receiver-only concerns: the poller
 * binds no port and speaks only GitHub (the other forges' producers stay webhook-armed).
 * `repos === null` means "discover from the App installation each boot" and is only reachable when
 * the auth source is `app`.
 */
export function loadPollerConfig(env = process.env, { readFile = readFileSync, fileExists = existsSync } = {}) {
	// A present WEBHOOK_SECRET is passed through untouched (a deployment may run serve AND poll from
	// one env file); only its ABSENCE is papered over, and only for the duration of this call.
	const base = loadReceiverConfig(
		env.WEBHOOK_SECRET ? env : { ...env, WEBHOOK_SECRET: PLACEHOLDER_SECRET },
		{ readFile, fileExists },
	);

	const repos = parsePollRepos(env.POLL_REPOS);
	if (repos === null && base.github.source !== "app") {
		// Fail-loud at boot naming BOTH mechanisms: a poller with an empty repo set would cycle forever,
		// log healthy summaries, and trigger nothing -- indistinguishable from working until someone
		// labels an issue and waits.
		throw configError(
			"nothing to poll: set POLL_REPOS=owner/name[,owner/name...] or use GITHUB_AUTH_SOURCE=app so the poller can list the App installation's repositories",
		);
	}

	return {
		valkeyUrl: base.valkeyUrl, // mirrors the receiver: producer and consumer share one queue
		triggers: base.triggers, // the SAME grouped rules the webhook filter reads -- one gate, two feeds
		github: base.github, // validated by the shared loadGitHubAuth, exactly as serve validates it
		repos,
		intervalSeconds: Math.max(POLL_INTERVAL_FLOOR_SECONDS, positiveInt(env, "POLL_INTERVAL_SECONDS", POLL_INTERVAL_DEFAULT_SECONDS)),
		// Unclamped here; startPoller caps it at the cursor TTL (see the header's POLL_CATCHUP_MINUTES note).
		catchUpMinutes: nonNegativeInt(env, "POLL_CATCHUP_MINUTES", POLL_CATCHUP_DEFAULT_MINUTES),
		// Passed THROUGH the receiver loader rather than re-parsed: one parse, one floor (issue #318).
		// The poller's boot identity gate is the same hard-fail gate serve has, so it retries under the
		// same window -- a pure-polling deployment loses deliveries to a stopped process just as surely.
		identityRetryWindowMs: base.identityRetryWindowMs,
	};
}

/**
 * `POLL_REPOS` -> `["owner/name", ...]`, `null` when unset/empty (falsy-is-unset, matching the
 * receiver's forge blocks). Set-but-garbled fails loud: a silently dropped entry is a repo the
 * operator believes is watched. Duplicates are collapsed so a repeated entry cannot double-poll
 * (and double-enqueue-attempt) one repo.
 */
function parsePollRepos(raw) {
	if (raw === undefined || raw.trim() === "") return null;
	const entries = [...new Set(raw.split(",").map((s) => s.trim()).filter((s) => s !== ""))];
	if (entries.length === 0) {
		throw configError(`POLL_REPOS is set but names no repositories: ${JSON.stringify(raw)}`);
	}
	for (const entry of entries) {
		if (!/^[^\s/]+\/[^\s/]+$/.test(entry)) {
			throw configError(`POLL_REPOS entries must be owner/name, got ${JSON.stringify(entry)}`);
		}
	}
	return entries;
}
