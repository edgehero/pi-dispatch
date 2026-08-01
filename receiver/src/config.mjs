/**
 * Receiver configuration, from the environment. Validated and fail-loud, mirroring the worker:
 * a misconfigured receiver refuses to start with a clear message rather than booting into a state
 * where webhooks silently go unverified or untriggered.
 *
 * The security-sensitive GitHub auth block is single-sourced from `@pi-dispatch/worker/config` --
 * `loadGitHubAuth` is parsed once, in one place, so the receiver and worker cannot drift on it. The
 * trigger schema is likewise single-sourced from `@pi-dispatch/worker/triggers` -- both services validate
 * the WHOLE unified triggers file and each selects the `on.type` it owns (issue #20).
 *
 * - `webhookSecret` is REQUIRED: without it the receiver cannot verify `X-Hub-Signature-256` over the
 *   raw body, and an unverified webhook is a forgeable paid-agent trigger (CONST-HMAC-OVER-RAW-BODY).
 * - `triggers` is the receiver's webhook allowlist, grouped by type: label rules (the label IS the
 *   collaborator approval), the single comment trigger (phrase + default flow), and pull_request rules.
 *   Only collaborators can apply labels, so the label/PR-label allowlist is the human approval gate
 *   (CONST-TRIGGER-AUTHOR-GATE).
 * - `bind` defaults to `0.0.0.0` (public): the receiver is the trigger surface that lives outside pi
 *   (DES-TRIGGER-OUTSIDE-PI). It carries no admin/dashboard config -- the admin surface is a pi extension
 *   in the operator's session and binds no port (DES-ADMIN-VIA-PI-EXTENSION), so there is none here.
 *
 * Errors are tagged `piDispatchConfig` (via the shared `configError`) so the entry can print them
 * cleanly and exit non-zero.
 */

import { existsSync, readFileSync } from "node:fs";
import { configError, loadGitHubAuth, positiveInt } from "@pi-dispatch/worker/config";
import { FORGE_KINDS, parseTriggers } from "@pi-dispatch/worker/triggers";

const DEFAULT_TRIGGERS_PATH = "deploy/triggers.json";

/**
 * Parse the receiver's config from `env` (default process.env). Filesystem access is injected
 * (`readFile`, `fileExists`) so the loader is hermetically testable and never touches disk in tests.
 */
export function loadReceiverConfig(env = process.env, { readFile = readFileSync, fileExists = existsSync } = {}) {
	const webhookSecret = env.WEBHOOK_SECRET;
	if (webhookSecret === undefined || webhookSecret.trim() === "") {
		throw configError("WEBHOOK_SECRET is required; refusing to start a receiver that cannot verify signatures");
	}

	return {
		webhookSecret,
		valkeyUrl: env.VALKEY_URL ?? "redis://127.0.0.1:6379", // mirrors worker config: producer and consumer share one queue
		port: positiveInt(env, "RECEIVER_PORT", 3000),
		bind: env.RECEIVER_BIND ?? "0.0.0.0",
		triggers: loadTriggers(env, readFile, fileExists),
		github: loadGitHubAuth(env, fileExists),
		gitlab: loadGitLabConfig(env),
		forgejo: loadForgejoConfig(env),
		azure: loadAzureConfig(env),
	};
}

/**
 * The GitLab endpoint's configuration, or `null` when the deployment serves no GitLab -- in which case no
 * `/gitlab` route exists at all, rather than one that answers 401. An endpoint that responds is an endpoint
 * an operator can believe is armed.
 *
 * `GITLAB_WEBHOOK_MODE` is REQUIRED once any GitLab variable is set, and is not defaulted. The two modes
 * are not equally strong -- `signature` is an HMAC over the body, `token` is a shared-secret compare that
 * proves nothing about the body's integrity -- so which one a deployment runs must be a thing somebody
 * chose and can be asked about, never a thing it fell into. Defaulting to the weaker one would silently
 * downgrade every operator who did not know the field existed; defaulting to the stronger one would break
 * every instance below GitLab 19.0.
 */
function loadGitLabConfig(env) {
	const mode = env.GITLAB_WEBHOOK_MODE;
	const secret = env.GITLAB_WEBHOOK_SECRET;
	const token = env.GITLAB_TOKEN;
	const apiUrl = env.GITLAB_URL ?? "https://gitlab.com";
	if (!mode && !secret && !token) return null;

	if (mode !== "signature" && mode !== "token") {
		throw configError(`GITLAB_WEBHOOK_MODE must be "signature" (HMAC, GitLab 19.0+) or "token" (X-Gitlab-Token, any version); got ${JSON.stringify(mode)}`);
	}
	if (typeof secret !== "string" || secret.trim() === "") {
		throw configError("GITLAB_WEBHOOK_SECRET is required; refusing to start a gitlab endpoint that cannot verify deliveries");
	}
	// The gate needs this token BEFORE any job runs: the actor's access level is what authorises a GitLab
	// trigger at all (CONST-TRIGGER-AUTHOR-GATE), and without a token every lookup is indeterminate and
	// every delivery 503s. Refusing at boot is the difference between one clear message and a redelivery loop.
	if (typeof token !== "string" || token.trim() === "") {
		throw configError("GITLAB_TOKEN is required for gitlab triggers -- the receiver resolves the actor's project access level before it may enqueue");
	}
	return { mode, secret, token, apiUrl };
}

/**
 * The Forgejo/Gitea block, or `null` when nothing names it -- same presence rule as GitLab's: an endpoint
 * that answers for a forge nobody configured is an endpoint an operator can believe is armed.
 *
 * There is no MODE here, and that absence is the good news. Forgejo signs the raw body with HMAC-SHA256
 * and sends GitHub's three headers verbatim, so there is exactly one verification mechanism and it is the
 * strong one -- no choice to make, and none to get wrong.
 *
 * `FORGEJO_BOT_ID` is optional and exists for one reason: a repository-scoped token cannot call
 * `GET /user` (see worker/src/forgejo-identity.mjs). Without it, following the token-scoping advice would
 * make the receiver unable to identify itself, and identity is not optional here.
 */
function loadForgejoConfig(env) {
	const secret = env.FORGEJO_WEBHOOK_SECRET;
	const token = env.FORGEJO_TOKEN;
	const apiUrl = env.FORGEJO_URL;
	const botId = env.FORGEJO_BOT_ID ?? null;
	if (!secret && !token && !apiUrl) return null;

	// No default instance URL, deliberately: Forgejo is self-hosted by nature and there is no forgejo.com to
	// fall back to. Guessing one would send a token to a host the operator never named.
	if (typeof apiUrl !== "string" || apiUrl.trim() === "") {
		throw configError("FORGEJO_URL is required for forgejo triggers -- there is no default instance to fall back to");
	}
	if (typeof secret !== "string" || secret.trim() === "") {
		throw configError("FORGEJO_WEBHOOK_SECRET is required; refusing to start a forgejo endpoint that cannot verify deliveries");
	}
	// Needed BEFORE any job runs: the actor's repository permission is what authorises a forgejo trigger at
	// all (CONST-TRIGGER-AUTHOR-GATE), and without a token every lookup is indeterminate and every delivery
	// 503s. Refusing at boot is the difference between one clear message and a redelivery loop.
	if (typeof token !== "string" || token.trim() === "") {
		throw configError("FORGEJO_TOKEN is required for forgejo triggers -- the receiver resolves the actor's repository permission before it may enqueue");
	}
	return { secret, token, apiUrl: apiUrl.trim(), botId };
}

/**
 * The Azure DevOps block, or `null` when nothing names it.
 *
 * `AZURE_WEBHOOK_MODE` is REQUIRED once any AZURE_* variable is set and is deliberately not defaulted --
 * the same rule GitLab's mode gets, and for a sharper reason. Azure offers no HMAC at all, so BOTH modes
 * are shared-secret compares that cover no bytes; which header carries the secret is a deployment fact
 * somebody has to have decided, and defaulting it would mean an operator could arm an endpoint without
 * ever noticing that its gate proves only that the sender knew a string.
 */
function loadAzureConfig(env) {
	const mode = env.AZURE_WEBHOOK_MODE;
	const secret = env.AZURE_WEBHOOK_SECRET;
	const token = env.AZURE_TOKEN;
	const orgUrl = env.AZURE_ORG_URL;
	const headerName = env.AZURE_WEBHOOK_HEADER ?? null;
	if (!mode && !secret && !token && !orgUrl) return null;

	if (mode !== "basic" && mode !== "header") {
		throw configError(`AZURE_WEBHOOK_MODE must be "basic" (HTTP Basic on the subscription) or "header" (a custom header); got ${JSON.stringify(mode)}`);
	}
	if (mode === "header" && (typeof headerName !== "string" || headerName.trim() === "")) {
		throw configError("AZURE_WEBHOOK_HEADER is required when AZURE_WEBHOOK_MODE=header -- there is no default header name to guess");
	}
	if (typeof secret !== "string" || secret.trim() === "") {
		throw configError("AZURE_WEBHOOK_SECRET is required; refusing to start an azure endpoint that cannot authenticate deliveries");
	}
	// No default organization URL: guessing one would send an operator's token to an organization they
	// never named.
	if (typeof orgUrl !== "string" || orgUrl.trim() === "") {
		throw configError("AZURE_ORG_URL is required for azure triggers (e.g. https://dev.azure.com/your-org)");
	}
	// Needed BEFORE any job runs: project membership is what authorises an azure trigger at all
	// (CONST-TRIGGER-AUTHOR-GATE), and without a token every lookup is indeterminate and every delivery 503s.
	if (typeof token !== "string" || token.trim() === "") {
		throw configError("AZURE_TOKEN is required for azure triggers -- the receiver resolves the actor's project membership before it may enqueue");
	}
	return { mode, secret, headerName: headerName?.trim() ?? null, token, orgUrl: orgUrl.trim().replace(/\/+$/, "") };
}

/**
 * Load, validate, and group the receiver's webhook triggers from the unified triggers file. The file is
 * the reviewed, committed source of truth for which events trigger which flow; a missing, unparseable, or
 * malformed file fails loud rather than degrading to an empty (silently trigger-nothing) allowlist.
 *
 * The shared `parseTriggers` validates the WHOLE file (including the on x run matrix and cron entries the
 * worker owns); this loader keeps only the webhook types and groups them PER FORGE, so `cfg.triggers` is
 * `{ github: <group>, gitlab: <group>, knownFlows }` where each group is:
 *   - `label`:       ordered `{ index, predicate, flow, packages, image }` rules (first match wins in the filter).
 *   - `comment`:     the single `{ index, phrase, defaultFlow, packages, image }` (or null when no comment trigger is configured).
 *   - `pullRequest`: ordered `{ index, actions:Set, predicate, flow, packages, image }` rules.
 * and `knownFlows` is every webhook `run.flow`, so a comment's `<phrase> <flow>` override cannot summon an
 * unlisted flow.
 *
 * Grouping by forge FIRST is what keeps each forge's gate reading only its own rules: a GitLab delivery
 * can never match a rule an operator wrote for GitHub, even when both name the same label. `knownFlows`
 * stays shared deliberately -- a flow is a skill in a repo, not a property of the forge that asked for it,
 * and the set exists to bound which names a comment may summon, which is the same bound either way.
 *
 * `packages` (load the operator-staged pi packages) and `image` (which container image the job runs in) are
 * the entry's per-trigger execution fields (INT-TRIGGERS-FILE-CONTRACT, REQ-GLOBAL-PI-OVERLAY). Both ride on
 * the RULE, not on the group, because the filter resolves them from the rule that actually matched -- two
 * rules in one file may name different images, and picking the group's would run the wrong toolchain for
 * whichever rule lost. Absent stays undefined so the filter can omit it entirely and leave an unflagged job
 * byte-identical to today's. `replicas` (REQ-REPLICA-RUNS) rides the rule for the same reason and one
 * sharper: it multiplies spend, so reading it off any rule other than the one that matched would bill an
 * operator for a decision they made about a different trigger.
 *
 * Each grouped rule carries `index`: its 0-based position in the RAW `triggers` array, cron entries
 * counted. The raw file index is the rule's identity -- the filter reports it on the job as
 * `trigger.matched.index`, so a run is explainable back to the exact triggers.json entry that fired it.
 */
function loadTriggers(env, readFile, fileExists) {
	const path = env.PI_TRIGGERS_FILE ?? DEFAULT_TRIGGERS_PATH;

	if (!fileExists(path)) {
		throw configError(`triggers file not found: ${path}`);
	}

	const parsed = parseTriggers(readFile(path, "utf8"), path); // fail-loud

	// Every forge gets a group whether or not the file names it, so the filter can read
	// `cfg.triggers[kind].label` without a presence check and an unconfigured forge simply matches nothing.
	//
	// Built FROM the forge table rather than written out, because the failure of forgetting one is unusually
	// quiet: `groups[run.kind]` would be undefined, `group.label.push` would throw, and `reloadTriggers`
	// below catches everything and KEEPS the previously-loaded triggers. The operator would see one
	// "invalid" message and their old rules would go on firing indefinitely. A test asserts this object's
	// keys are exactly FORGE_KINDS, so the two can never drift.
	const groups = Object.fromEntries(FORGE_KINDS.map((kind) => [kind, emptyGroup()]));
	const knownFlows = new Set();

	for (const [index, { on, run }] of parsed.entries()) {
		if (on.type === "cron") continue; // the worker owns cron; the receiver never fires it -- but it keeps its index
		knownFlows.add(run.flow);
		const group = groups[run.kind];
		if (on.type === "label") {
			group.label.push({ index, predicate: { any: on.any, all: on.all, none: on.none }, flow: run.flow, packages: run.packages, image: run.image, resume: run.resume, replicas: run.replicas, repository: run.repository });
		} else if (on.type === "comment") {
			group.comment = { index, phrase: on.phrase, defaultFlow: run.flow, packages: run.packages, image: run.image, resume: run.resume, replicas: run.replicas, repository: run.repository }; // parseTriggers guarantees at most one per forge
		} else if (on.type === "pull_request") {
			group.pullRequest.push({ index, actions: new Set(on.action), predicate: { any: on.any, all: on.all, none: on.none }, flow: run.flow, packages: run.packages, image: run.image, resume: run.resume, replicas: run.replicas });
		}
	}

	return { ...groups, knownFlows };
}

function emptyGroup() {
	return { label: [], comment: null, pullRequest: [] };
}

/** The triggers file path the receiver reads (env override or the committed deploy default). */
export function triggersFilePath(env = process.env) {
	return env.PI_TRIGGERS_FILE ?? DEFAULT_TRIGGERS_PATH;
}

/**
 * Live-reload the receiver's triggers: re-read + re-group the file and swap `cfg.triggers` IN PLACE, so the
 * already-wired handler (which closes over `cfg`) picks up the new triggers on its next request -- no
 * restart, mirroring how the worker re-reads the settings overlay per job. If the new file is
 * missing/unparseable/invalid, the running triggers are KEPT (never crash a live receiver on a bad edit)
 * and the reason is returned. Returns `{ ok: true }` or `{ invalid }`.
 */
export function reloadTriggers(env, cfg, { readFile = readFileSync, fileExists = existsSync } = {}) {
	try {
		cfg.triggers = loadTriggers(env, readFile, fileExists);
		return { ok: true };
	} catch (e) {
		return { invalid: e?.message ?? String(e) };
	}
}
