/**
 * Receiver configuration, from the environment. Validated and fail-loud, mirroring the worker:
 * a misconfigured receiver refuses to start with a clear message rather than booting into a state
 * where webhooks silently go unverified or untriggered.
 *
 * The security-sensitive GitHub auth block is single-sourced from `@edgehero/pi-dispatch/config` --
 * `loadGitHubAuth` is parsed once, in one place, so the receiver and worker cannot drift on it. The
 * trigger schema is likewise single-sourced from `@edgehero/pi-dispatch/triggers` -- both services validate
 * the WHOLE unified triggers file and each selects the `on.type` it owns (issue #20).
 *
 * - `webhookSecret` is REQUIRED WHENEVER THE DEPLOYMENT SERVES GITHUB (`servesGithub`, below): without it
 *   the receiver cannot verify `X-Hub-Signature-256` over the raw body, and an unverified webhook is a
 *   forgeable paid-agent trigger (CONST-HMAC-OVER-RAW-BODY). A GitLab-only / Forgejo-only / Azure-only
 *   deployment has no GitHub endpoint and therefore nothing for that secret to verify, so demanding one
 *   there blocked a deployment the harness fully supports (issue #99).
 * - `servesGithub` is that decision, made HERE and named, because three separate things hang off it and
 *   they must never disagree: the WEBHOOK_SECRET requirement, whether `/` is mounted at all
 *   (receiver.mjs), and whether boot resolves the harness's GitHub identity to arm the bot-loop guard
 *   (start.mjs). Deriving it inline in two places is how a route ends up live with a disarmed guard.
 * - `triggers` is the receiver's webhook allowlist, grouped by type: label rules (the label IS the
 *   collaborator approval), the single comment trigger (phrase + default flow), and pull_request rules.
 *   Only collaborators can apply labels, so the label/PR-label allowlist is the human approval gate
 *   (CONST-TRIGGER-AUTHOR-GATE). It is read from `./triggers.json` in the working directory by
 *   default -- the file `pi-dispatch init` scaffolds -- with PI_TRIGGERS_FILE as the override.
 * - `bind` defaults to `0.0.0.0` (public): the receiver is the trigger surface that lives outside pi
 *   (DES-TRIGGER-OUTSIDE-PI). It carries no admin/dashboard config -- the admin surface is a pi extension
 *   in the operator's session and binds no port (DES-ADMIN-VIA-PI-EXTENSION), so there is none here.
 *
 * Errors are tagged `piDispatchConfig` (via the shared `configError`) so the entry can print them
 * cleanly and exit non-zero.
 */

import { existsSync, readFileSync } from "node:fs";
import { groupTriggers } from "./trigger-groups.mjs";
import { configError, githubIngestFrom, githubServedByServe, loadForgeWebhook, loadGitHubAuth, positiveInt } from "@edgehero/pi-dispatch/config";
import { FORGE_KINDS, parseTriggersDocument } from "@edgehero/pi-dispatch/triggers";
import { watchSecretsMissing } from "@edgehero/pi-dispatch/watch-contract";

// Cwd-relative, matching what `pi-dispatch init` scaffolds (and the admin's default): the receiver's
// default must be the file init just told the operator it created, not a demo buried in the repo.
const DEFAULT_TRIGGERS_PATH = "./triggers.json";

// The transient-boot retry window (issue #318). The FLOOR is load-bearing, not a courtesy: systemd's
// start limit is a fixed window from the first counted start (`ratelimit_below`: elapsed past the
// interval resets the counter), so boots that retry for at least StartLimitIntervalSec (60s in
// deploy/receiver.service) exit at least window + RestartSec apart, every start opens a fresh
// interval, and `StartLimitBurst=5` becomes unreachable for a transient failure by systemd's own
// accounting. A sub-60s window would put fast exit-1s back inside one interval and re-open the ~25s
// bound this setting exists to remove. The default outlasts an ordinary self-hosted forge restart,
// and since an exhausted window exits 1 and the supervisor starts another, it bounds one CYCLE, not
// recovery -- while a misclassified determinate fault resurfaces in the journal every window rather
// than hiding.
export const IDENTITY_RETRY_FLOOR_SECONDS = 60;
export const IDENTITY_RETRY_DEFAULT_SECONDS = 600;

/** The receiver commands `loadReceiverConfig` loads for (issue #1006), each judging only what it reads. */
export const RECEIVER_COMMANDS = Object.freeze(["serve", "poll", "watch"]);

/**
 * The boot identity-retry window in milliseconds, from `RECEIVER_IDENTITY_RETRY_SECONDS`. Parsed in
 * ONE place for both loaders (serve and poll), so the floor cannot drift between them. `positiveInt`
 * refuses 0, negatives, fractions and junk with the config tag (a typo'd window is configuration,
 * exit 2); a positive value below the floor is raised to it, the POLL_INTERVAL_SECONDS house pattern.
 */
export function identityRetryWindowMs(env = process.env) {
	return 1000 * Math.max(IDENTITY_RETRY_FLOOR_SECONDS, positiveInt(env, "RECEIVER_IDENTITY_RETRY_SECONDS", IDENTITY_RETRY_DEFAULT_SECONDS));
}

/**
 * Parse the receiver's config from `env` (default process.env). Filesystem access is injected
 * (`readFile`, `fileExists`) so the loader is hermetically testable and never touches disk in tests.
 *
 * `command` names the receiver command loading it, and each judges only the settings it reads (issues #994, #1006):
 *
 *  - `serve` (the default) reads everything: the triggers file, each watch source's push secret, the GitHub auth block,
 *    `GITHUB_INGEST`, `WEBHOOK_SECRET` where it serves GitHub, `RECEIVER_PORT` and `RECEIVER_BIND`, the identity retry
 *    window, and the GitLab, Forgejo and Azure DevOps webhook blocks (`loadForgeWebhook`).
 *  - `poll` reads the triggers file, the GitHub auth block (it polls and resolves its identity with it), `GITHUB_INGEST`
 *    and the identity retry window, and none of what only a listener reads.
 *  - `watch` reads the triggers file alone: it pulls watch sources, resolves no identity and calls no forge, so the
 *    GitHub auth block and the identity retry window are skipped too. `GITHUB_INGEST` is still judged for it, a stated
 *    residual: the console says a garbled one stops every receiver command, and changing that sentence changes a
 *    rendered page this change does not touch.
 *
 * All three used to judge everything, so a `GITLAB_TOKEN` set for the worker, a malformed `RECEIVER_PORT`, a watch
 * source without its secret or (for `watch`) a PAT source without its token stopped a command that never reads them,
 * exit 2 and not restarted. `serve` is the default so a new caller that forgets it is judged as `serve` is and
 * refuses, rather than arming routes it never parsed. `command` is kept on the returned config, so `reloadTriggers`
 * judges a live edit for `serve` exactly as its start did, from one decision.
 */
export function loadReceiverConfig(env = process.env, { readFile = readFileSync, fileExists = existsSync, command = "serve" } = {}) {
	if (!RECEIVER_COMMANDS.includes(command)) throw new Error(`loadReceiverConfig: unknown receiver command ${JSON.stringify(command)}`);
	const listener = command === "serve";
	// Triggers and the GitHub auth block are parsed FIRST, before the secret check, because the secret is
	// now conditional on what they say. Their own fail-loud errors therefore surface first -- a garbled
	// GITHUB_AUTH_SOURCE is reported as a garbled GITHUB_AUTH_SOURCE, never laundered into a confusing
	// complaint about WEBHOOK_SECRET.
	const triggers = loadTriggers(env, readFile, fileExists, listener);
	const github = command === "watch" ? null : loadGitHubAuth(env, fileExists);
	// Before the secret check for the same reason as the two above: a typo'd GITHUB_INGEST is reported as itself,
	// never as a WEBHOOK_SECRET the deployment may not need (issue #879).
	const githubIngest = githubIngestFrom(env);
	const valkeyUrl = env.VALKEY_URL ?? "redis://127.0.0.1:6379"; // mirrors worker config: producer and consumer share one queue
	// What `poll` and `watch` read, and nothing a listener alone reads (issue #1006): no `servesGithub`, so a reload of
	// this config never reports GitHub rules unserved, and no route block, since neither command arms a route.
	if (command === "watch") return { command, githubIngest, valkeyUrl, triggers };
	if (command === "poll") return { command, githubIngest, valkeyUrl, identityRetryWindowMs: identityRetryWindowMs(env), triggers, github };
	const servesGithub = decideServesGithub(env, triggers.github);

	const webhookSecret = env.WEBHOOK_SECRET;
	if (servesGithub && (webhookSecret === undefined || webhookSecret.trim() === "")) {
		// Same message and same behaviour as before for every deployment that serves GitHub: the secret is
		// the whole trust boundary of the `/` endpoint, so a receiver that would mount it without one must
		// refuse to start rather than answer 401 forever (or, worse, accept forged deliveries).
		throw configError("WEBHOOK_SECRET is required; refusing to start a receiver that cannot verify signatures");
	}

	return {
		// Passed through as the env gave it (possibly undefined) when the deployment serves no GitHub. Nothing
		// reads it in that case -- receiver.mjs builds no github handler at all -- and `servesGithub` beside it
		// is what says so, so an unread absent secret can never be mistaken for an armed endpoint.
		webhookSecret,
		servesGithub,
		// What the operator said about the transport (`null`: unset, so `servesGithub` was inferred). Carried so the boot
		// line that skips the GitHub arm can name which rule decided.
		githubIngest,
		// The command this config was judged for (issue #1006), which `reloadTriggers` reads back for watch secrets.
		command,
		valkeyUrl,
		port: positiveInt(env, "RECEIVER_PORT", 3000),
		bind: env.RECEIVER_BIND ?? "0.0.0.0",
		identityRetryWindowMs: identityRetryWindowMs(env),
		triggers,
		github,
		// Each null when nothing names that forge, and then no route exists for it. The rule is the worker package's
		// (`loadForgeWebhook`), so doctor judges a block by the same code this refuses it with.
		gitlab: loadForgeWebhook("gitlab", env),
		forgejo: loadForgeWebhook("forgejo", env),
		azure: loadForgeWebhook("azure", env),
	};
}

/**
 * The forges this receiver serves, in `FORGE_KINDS` order, for its status record (`INT-RECEIVER-STATUS-KEY`, issue
 * #824): GitHub by `servesGithub` (`cfg.github` is its auth block, present whether GitHub is served or not), and every
 * other forge by its own block, which the loader sets to null when nothing names the forge and which `startReceiver`
 * arms a route for exactly when it is set. A kind with no block at all is a forge added to the table that this loader
 * does not read yet, so nothing arms a route for it, and it is unserved. Throwing instead would cost the receiver its
 * whole record, every forge's counts, at boot, for a gap the operator cannot close. The developer who adds the forge
 * learns it from receiver/test/receiver-status-start.test.mjs, which requires a block for every `FORGE_KINDS` member.
 */
export function servedForges(cfg, kinds = FORGE_KINDS) {
	return kinds.filter((kind) => kind === "github" ? cfg.servesGithub === true : Object.hasOwn(cfg, kind) && Boolean(cfg[kind]));
}

/**
 * Does this deployment actually SERVE GitHub? Three things hang off the answer -- the WEBHOOK_SECRET
 * requirement above, whether `/` is mounted (receiver.mjs), and whether boot resolves the harness's own
 * GitHub id to arm the bot-loop guard (start.mjs) -- so it is decided once, here, from the operator's own
 * files rather than assumed.
 *
 * `GITHUB_INGEST` (issue #879), when set, IS the answer and nothing below is consulted: `poll` is no, because the
 * events come from `pi-dispatch-receiver poll` and a route here would verify deliveries against a secret no App was
 * given; `webhook` and `both` are yes, rules or none, because the operator has said the webhook carries GitHub. The
 * setting exists because the two signals below cannot tell the transports apart: the triggers file and the auth
 * block are shared by `serve` and `poll` on purpose, so a deployment that polls GitHub and takes webhooks for another
 * forge read as a GitHub webhook deployment and refused to start without a `WEBHOOK_SECRET`. A `poll` answer is not
 * the silently dead trigger the #231 note below refuses: the operator named the transport that fires those rules, and
 * the boot line says the arm was skipped and why.
 *
 * Unset, it is inferred, exactly as before the setting existed. Either of two signals is a yes:
 *
 *  - THE TRIGGERS FILE NAMES A GITHUB WEBHOOK RULE. `triggers.github` is the group `loadTriggers` built
 *    from every `run.kind: "github"` webhook entry, and `emptyGroup()` is what a forge the file never
 *    mentions gets. So an empty group -- zero label rules, no comment trigger, zero pull_request rules --
 *    means a signed GitHub delivery could not fire anything even if it arrived: the endpoint would verify
 *    the HMAC, match no rule, and answer 204 forever. That is not a GitHub deployment.
 *
 *  - GITHUB_AUTH_SOURCE IS SET EXPLICITLY. An operator who names an auth source has said "GitHub" out
 *    loud, and they may well be arming the receiver before the first rule exists (or driving it from the
 *    poller, which is GitHub-only). Explicit intent wins over the inferred signal, and it is also what
 *    keeps this change byte-identical to today's behaviour for every deployment that sets the variable.
 *    Read from `env` and NOT from the parsed block: `loadGitHubAuth` defaults `source` to "gh", so
 *    `github.source` cannot tell an explicit choice from a default and would answer yes for everyone.
 *
 * Deliberately NOT a signal: the presence of GITHUB_PAT / GITHUB_APP_* alone. Those are credentials a
 * shared env file may carry for the worker (which mints per-job tokens and is a separate process); a
 * credential lying around is not a statement that this receiver terminates GitHub webhooks.
 */
function decideServesGithub(env, githubGroup) {
	// The rule itself lives in the worker's config (`githubServedByServe`, issue #879), so the console's trigger editor
	// asks the same question of the file and the `.env` and cannot answer apart from this. `loadGitHubAuth` has already
	// refused a garbled GITHUB_AUTH_SOURCE by the time we get here, so a non-empty one is a real choice, never a typo read
	// as consent.
	return githubServedByServe(env, hasGithubRules(githubGroup));
}

/**
 * Does the receiver's github group hold any rule? The close groups count too (issue #231): a deployment whose ONLY
 * github rule is a close trigger must still mount `/`, require WEBHOOK_SECRET and build auth, or the one-shot the
 * operator armed can never fire -- and the receiver would report nothing, the silent no-op this file's header calls the
 * worst outcome. Conversely a deployment whose last github one-shot is SPENT stops counting here at its next boot (the
 * sentinel groups nowhere), which is deliberate: nothing is left to serve, and INT-TRIGGERS-FILE-CONTRACT states it.
 */
function hasGithubRules(group) {
	return group.label.length > 0 || group.comment !== null || group.pullRequest.length > 0 || group.issue.length > 0 || group.prClose.length > 0 || (group.localEvents?.length ?? 0) > 0;
}

/**
 * Load, validate, and group the receiver's webhook triggers from the unified triggers file. The file is
 * the reviewed, committed source of truth for which events trigger which flow; a missing, unparseable, or
 * malformed file fails loud rather than degrading to an empty (silently trigger-nothing) allowlist.
 *
 * The shared `parseTriggers` validates the WHOLE file (including the on x run matrix and cron entries the
 * worker owns); this loader keeps only the webhook types and groups them PER FORGE, so `cfg.triggers` is
 * `{ github: <group>, gitlab: <group>, knownFlows }` where each group is:
 *   - `label`:       ordered `{ index, predicate, flow, command, packages, image }` rules (first match wins in the filter).
 *   - `comment`:     the single `{ index, phrase, defaultFlow, command, packages, image }` (or null when no comment trigger is configured).
 *   - `pullRequest`: ordered `{ index, actions:Set, predicate, flow, command, packages, image }` rules (never a close-only rule).
 *   - `issue`:       ordered `{ index, actions:Set, number?, once?, ... }` close rules (issue #231).
 *   - `prClose`:     ordered close-only pull_request rules, same shape as `issue` -- split from
 *                    `pullRequest` so the closer-gated route and the author-gated route can never read
 *                    each other's rules (the loader's no-mixing refusal makes the split total).
 * and `knownFlows` is every webhook `run.flow`, so a comment's `<phrase> <flow>` override cannot summon an
 * unlisted flow. A rule carries EITHER `flow` or `command` (issue #189; the shared parser enforces the
 * exclusivity): a command rule's match dispatches a registered pi extension command in the container, so
 * it resolves no flow and contributes nothing to the flow vocabulary.
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
function loadTriggers(env, readFile, fileExists, listener) {
	const path = env.PI_TRIGGERS_FILE ?? DEFAULT_TRIGGERS_PATH;

	if (!fileExists(path)) {
		throw configError(`triggers file not found: ${path} -- run \`pi-dispatch init\` in this folder to scaffold one, or set PI_TRIGGERS_FILE to yours`);
	}

	const document = parseTriggersDocument(readFile(path, "utf8"), path);
	const parsed = document.triggers;
	const watchSources = document.watchSources ?? {};
	// Judged for `serve` alone (`command`, issue #994), by the worker's predicate (`watchSecretsMissing`, issue #970),
	// shared with doctor and `pi-dispatch triggers check`, so none of them can call a secret present that this refuses.
	if (listener && watchSecretsMissing(watchSources, env).length > 0) throw configError("watch: a configured source secret is missing");

	return groupTriggers(parsed, { watchSources });
}

/** How many rules the github group holds, for the line that says they are not served. */
function githubRuleCount(group) {
	return group.label.length + (group.comment !== null ? 1 : 0) + group.pullRequest.length + group.issue.length + group.prClose.length + (group.localEvents?.length ?? 0);
}

/** The triggers file path the receiver reads (env override or the cwd default matching what `pi-dispatch init` scaffolds). */
export function triggersFilePath(env = process.env) {
	return env.PI_TRIGGERS_FILE ?? DEFAULT_TRIGGERS_PATH;
}

/**
 * Live-reload the receiver's triggers: re-read + re-group the file and swap `cfg.triggers` IN PLACE, so the
 * already-wired handler (which closes over `cfg`) picks up the new triggers on its next request -- no
 * restart, mirroring how the worker re-reads the settings overlay per job. If the new file is
 * missing/unparseable/invalid, the running triggers are KEPT (never crash a live receiver on a bad edit)
 * and the reason is returned. Returns `{ ok: true }` or `{ invalid }`.
 *
 * `servesGithub` is deliberately NOT recomputed. It is a BOOT decision, because the two other things it
 * governs are boot facts: whether `/` was mounted and whether the harness's GitHub identity was resolved.
 * Recomputing it here would let a live file edit mount a github endpoint whose bot-loop guard was never
 * armed -- the one state this design exists to make unreachable. Removing the last github rule leaves `/`
 * verifying deliveries that now match nothing and answer 204.
 *
 * Adding a github rule to a receiver that started without `/` leaves `/` answering 404 until a restart, and GitHub
 * does not resend. That used to be assumed harmless, "the operator's next step anyway, since the deployment also needs a
 * webhook secret", and issue #879 broke the premise twice: `up` writes a secret into every `.env`, and a new scaffold no
 * longer sets GITHUB_AUTH_SOURCE, so a fresh deployment starts without `/` and its first GitHub rule, added from the
 * console or a tool, reloads here while every delivery for it is refused. So the reload says so: `githubUnserved`
 * counts the github rules this receiver now holds and will not serve until it restarts, and the caller logs it loudly
 * (`github_rules_unserved`, start.mjs). Never under GITHUB_INGEST=poll, where the poller serves them and `/` is meant
 * to be absent. Arming `/` here instead was rejected: it needs the GitHub identity resolved (a call that may retry for
 * minutes or fail outright, and a reload cannot refuse to boot) and a handler built into a server already listening,
 * the boot-only coupling DES-TRIGGER-OUTSIDE-PI exists to keep.
 *
 * Watch source secrets are judged as the start judged them, by `cfg.command` (issues #994, #1006): `serve`'s config
 * keeps a new source without its secret out and runs on, while the poller's (which carries no such field) and the
 * watch collector's take it. Read from `cfg` rather than passed by each caller, so `serve` cannot start strict and
 * reload lax.
 */
export function reloadTriggers(env, cfg, { readFile = readFileSync, fileExists = existsSync } = {}) {
	try {
		cfg.triggers = loadTriggers(env, readFile, fileExists, cfg.command === "serve");
		if (cfg.servesGithub === false && cfg.githubIngest !== "poll" && hasGithubRules(cfg.triggers.github)) return { ok: true, githubUnserved: githubRuleCount(cfg.triggers.github) };
		return { ok: true };
	} catch (e) {
		return { invalid: e?.message ?? String(e) };
	}
}

/**
 * Follow the triggers file from a loop that arms no watch (issue #947): the poller, which used to read the file once at
 * start and judge every later event on that copy, so a label trigger added afterwards dropped its events for good and
 * an edited one was queued from the old copy and refused at pickup. `follow()` reads the file and, ONLY when what it
 * read differs from the last read, hands it to `reloadTriggers` unchanged: one loader, so the poller can never accept a
 * file `serve` refuses or the reverse, and `cfg.triggers` is swapped in place on a good file and kept on a bad one.
 *
 * The gate is what was read, not a modification time: the text itself, or "missing", or the read error's code (each
 * kind prefixed, so no file's text can equal a sentinel). An unchanged file therefore costs one stat and one small read
 * and says nothing, which is what lets the caller follow before every judgement, and a bad edit is judged and logged
 * once however many times it is read again. The lines are `serve`'s (start.mjs's watcher): `triggers_reloaded`, and
 * `triggers_reload_invalid` with the reason and `kept: true`. Going back to a good text, the running one included, is a
 * change and says `triggers_reloaded`.
 *
 * `baseline` is the text the BOOT load parsed, recorded through its read seam (receiver/src/start.mjs's issue #386
 * idiom). Taken from that read rather than from one here, because the window an edit hides in is between the boot load
 * and the first follow, which holds identity resolution that retries for up to RECEIVER_IDENTITY_RETRY_SECONDS: a read
 * here would take such an edit as the baseline and never load it. Without one the first follow reloads, which says so.
 *
 * `state` is what the follower knows, for a status reader and never for a judgement: `triggers` is "current" when the
 * running rules are the file's, "kept" when the file was refused and the last good copy runs; `runningText` is the text
 * the running rules came from; `refusal` names why the file was not taken ("refused" by the loader, "missing",
 * "unreadable"); `rejectedText` is the refused text (null when nothing could be read) and `rejectedAt` when the
 * follower saw it, by the injected `now`. Never throws: every read is caught, and `reloadTriggers` returns.
 *
 * `follow()` returns null when nothing changed, else `reloadTriggers`' own result. Its `githubUnserved` is not logged
 * here: it cannot arise on the poller's cfg, which carries no `servesGithub`, and a caller holding `serve`'s cfg would
 * log it from that result as start.mjs's watcher does.
 */
export function makeTriggersFollower(env, cfg, { readFile = readFileSync, fileExists = existsSync, baseline = null, log = () => {}, now = Date.now } = {}) {
	const path = triggersFilePath(env);
	const recorded = typeof baseline === "string";
	const state = { triggers: "current", runningText: recorded ? baseline : null, refusal: null, rejectedText: null, rejectedAt: null };
	let lastKey = recorded ? `text:${baseline}` : null;
	const follow = () => {
		let text = null;
		let readError = null;
		let key;
		try {
			if (fileExists(path)) {
				text = readFile(path, "utf8");
				key = `text:${text}`;
			} else key = "missing";
		} catch (err) {
			// A file removed between the stat and the read is missing, not unreadable: the same refusal either way.
			if (err?.code === "ENOENT") key = "missing";
			else {
				readError = err;
				key = `error:${err?.code ?? "unknown"}`;
			}
		}
		if (key === lastKey) return null;
		lastKey = key;
		const res = reloadTriggers(env, cfg, {
			fileExists: () => key !== "missing",
			readFile: () => {
				if (readError !== null) throw readError;
				return text;
			},
		});
		if (res.ok) {
			Object.assign(state, { triggers: "current", runningText: text, refusal: null, rejectedText: null, rejectedAt: null });
			log({ event: "triggers_reloaded" });
			return res;
		}
		const refusal = key === "missing" ? "missing" : readError !== null ? "unreadable" : "refused";
		Object.assign(state, { triggers: "kept", refusal, rejectedText: text, rejectedAt: now() });
		log({ event: "triggers_reload_invalid", reason: res.invalid, kept: true });
		return res;
	};
	return { follow, state };
}
