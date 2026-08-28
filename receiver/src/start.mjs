/**
 * The receiver entry point: an always-on, public webhook producer that resolves the harness's own
 * identity, then serves `makeReceiver` over `node:http` and enqueues onto the shared queue.
 *
 * DES-TRIGGER-OUTSIDE-PI: the trigger is a separate always-on process, outside the container and the
 * agent. It only produces jobs; it never runs pi.
 *
 * CONST-TRIGGER-AUTHOR-GATE: `selfId` is the bot-loop guard's sole input -- the filter drops any event
 * whose `sender.id` is our own. Resolving it is therefore a HARD-FAIL boot invariant WHEREVER A FORGE
 * ENDPOINT IS LIVE: if identity does not resolve, the rejection propagates and the server is NEVER
 * created. A receiver that listened without `selfId` would run the guard disarmed, and its own completion
 * comments would re-trigger jobs -- an unbounded paid recursion. The worker's auth is best-effort because
 * it can fail a github job per-job; the receiver has no such per-job fallback, so identity resolution is a
 * boot gate. Every arm here is gated on its own forge being configured, github included (`cfg.servesGithub`,
 * issue #99) -- an arm whose endpoint does not exist has no guard to arm, and the invariant that matters is
 * that the two are decided by the SAME property, never separately.
 *
 * The receiver holds no JOB credentials. Minting a job's scoped token is the worker's business, per
 * container, per job (CONST-TOKEN-SCOPED-PER-JOB), and that claim keeps its full force. What the
 * receiver ALSO uses, since issue #231, is a per-close-delivery token for a permission QUESTION --
 * does the account that closed this item hold write access (CONST-TRIGGER-AUTHOR-GATE's close arm).
 * On the App source that token is minted repo-scoped AND narrowed to metadata:read (the mint passes
 * the narrowing through, so a leak of it can write nothing); on pat/gh it is the operator's own
 * standing token, already resident in this process's env, used for one read. Never a job credential
 * on any source: no container ever receives it, and it exists only for the lookup it served.
 *
 * DES-ADMIN-VIA-PI-EXTENSION: this process exposes exactly one surface, the webhook handler. There is no
 * admin, dashboard, or admin-extension route here -- the admin surface is a pi extension in the
 * operator's session and binds no port.
 */

import http from "node:http";
import { watch } from "node:fs";
import { dirname, basename } from "node:path";
import { loadReceiverConfig, triggersFilePath, reloadTriggers } from "./config.mjs";
import { makeReceiver } from "./receiver.mjs";
import { entryExitCode } from "./cli.mjs";
import { makeGitHubAuth } from "@edgehero/pi-dispatch/get-token";
import { resolveGitLabSelfId } from "@edgehero/pi-dispatch/gitlab-identity";
import { resolveForgejoSelfId } from "@edgehero/pi-dispatch/forgejo-identity";
import { resolveAzureSelfId } from "@edgehero/pi-dispatch/azure-identity";
import { makeResolveAuthority } from "./gitlab-members.mjs";
import { makeResolveForgejoAuthority } from "./forgejo-members.mjs";
import { makeResolveAzureAuthority } from "./azure-members.mjs";
import { makeResolveGitHubAuthority } from "./github-members.mjs";
import { makeQueue } from "@edgehero/pi-dispatch/queue";
import { parseConnection } from "@edgehero/pi-dispatch/connection";

/**
 * Boot the receiver. Collaborators are injected (defaulting to the real ones) so the whole wiring is
 * testable offline with no GitHub, no Valkey, and no socket. Returns the listening server.
 */
export async function startReceiver(
	env = process.env,
	{
		makeAuth = makeGitHubAuth,
		makeQueueFn = makeQueue,
		createServer = http.createServer,
		resolveGitLabSelfId: resolveSelfIdFn = resolveGitLabSelfId,
		makeResolveAuthority: makeResolveAuthorityFn = makeResolveAuthority,
		resolveForgejoSelfId: resolveForgejoSelfIdFn = resolveForgejoSelfId,
		makeResolveForgejoAuthority: makeResolveForgejoAuthorityFn = makeResolveForgejoAuthority,
		resolveAzureSelfId: resolveAzureSelfIdFn = resolveAzureSelfId,
		makeResolveAzureAuthority: makeResolveAzureAuthorityFn = makeResolveAzureAuthority,
		makeResolveGitHubAuthority: makeResolveGitHubAuthorityFn = makeResolveGitHubAuthority,
	} = {},
) {
	// Single-object log line: `makeReceiver` calls `log?.({ event, ... })`, so the sink takes ONE object.
	const log = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

	const cfg = loadReceiverConfig(env);

	// The GitHub arm, when the deployment actually serves GitHub -- now conditional, exactly like the three
	// sibling arms below (issue #99). It was unconditional, and since GITHUB_AUTH_SOURCE defaults to `gh` and
	// the gh path shells out to `gh auth token`, a GitLab-only deployment could not boot without installing
	// and logging into the GitHub CLI it has no use for.
	//
	// SKIPPING THIS IS ONLY SAFE BECAUSE THE ROUTE IS ALSO ABSENT. `cfg.servesGithub` gates both: this
	// identity resolution AND whether `makeReceiver` mounts `/` at all. `selfId` is the bot-loop guard's sole
	// input, so the two MUST stay coupled -- if a future change mounts `/` unconditionally again, this
	// resolution has to come back with it, or the github endpoint would run its guard disarmed and the
	// harness's own completion comments would re-trigger jobs forever. Read that as: never make one of these
	// two conditions unconditional without the other.
	let selfId;
	let resolveAuthority;
	if (cfg.servesGithub) {
		// HARD-FAIL identity resolution -- NO try/catch. A throw here (absent/bad github auth, unresolvable
		// id) propagates and the server below is never created: without selfId the bot-loop guard cannot
		// run, so refusing to boot is the only safe outcome.
		//
		// The WHOLE auth object is kept, not just selfId: the closer resolver below mints its per-delivery
		// metadata-read token through this same object (issue #231), so identity and mint capability stay
		// one credential decision -- an arm that resolved its identity is exactly the arm that can answer
		// a permission question. This is also why the github handler's missing-resolver 503 is unreachable
		// in a wired receiver: a boot that fails here mounts no `/` at all.
		const auth = await makeAuth(cfg.github);
		selfId = auth.selfId;
		log({ event: "self_identity", id: selfId, source: cfg.github.source });
		// The lookup token asks the mint to narrow to metadata:read -- the App path honors it GitHub-side,
		// so the token this process holds for the permission question cannot write even if leaked; the
		// pat/gh sources cannot narrow (the operator's standing token is what it is, and it already lives
		// in this process's env), which is why the header above words the claim per source.
		resolveAuthority = makeResolveGitHubAuthorityFn({ mintToken: (job) => auth.mintToken({ ...job, permissions: { metadata: "read" } }) });
	} else {
		// Said out loud, because the alternative is an operator staring at a label trigger that does nothing.
		// The two ways out are the two signals `decideServesGithub` reads, so the line names both.
		log({ event: "github_arm_skipped", reason: "no github triggers and GITHUB_AUTH_SOURCE unset" });
	}

	// Ride-out connection (no failFast): the receiver is long-running and should survive a Valkey
	// restart, not give up on a transient disconnect.
	const queue = makeQueueFn(parseConnection(cfg.valkeyUrl));

	// The GitLab arm, when configured. Its identity resolution is HARD-FAIL for the same reason github's
	// is: without a selfId the bot-loop guard cannot run, and a receiver that listens without it turns the
	// harness's own status comment into another paid job.
	let gitlab = null;
	if (cfg.gitlab) {
		const gitlabSelfId = await resolveSelfIdFn({ apiUrl: cfg.gitlab.apiUrl, token: cfg.gitlab.token });
		log({ event: "self_identity", forge: "gitlab", id: gitlabSelfId, mode: cfg.gitlab.mode });
		gitlab = {
			mode: cfg.gitlab.mode,
			secret: cfg.gitlab.secret,
			selfId: gitlabSelfId,
			resolveAuthority: makeResolveAuthorityFn({ apiUrl: cfg.gitlab.apiUrl, token: cfg.gitlab.token }),
		};
	}

	// The Forgejo arm, when configured. Identity resolution is HARD-FAIL here too, and it is the arm where
	// that matters most: a repo-scoped Forgejo token cannot call GET /user, so an operator who follows the
	// scoping advice without setting FORGEJO_BOT_ID lands exactly here -- and a receiver that shrugged and
	// continued would run with selfId undefined, which never equals a sender id and silently turns the
	// harness's own comments into more paid jobs.
	let forgejo = null;
	if (cfg.forgejo) {
		const forgejoSelfId = await resolveForgejoSelfIdFn({ apiUrl: cfg.forgejo.apiUrl, token: cfg.forgejo.token, botId: cfg.forgejo.botId });
		log({ event: "self_identity", forge: "forgejo", id: forgejoSelfId, source: cfg.forgejo.botId ? "FORGEJO_BOT_ID" : "api" });
		forgejo = {
			secret: cfg.forgejo.secret,
			selfId: forgejoSelfId,
			resolveAuthority: makeResolveForgejoAuthorityFn({ apiUrl: cfg.forgejo.apiUrl, token: cfg.forgejo.token }),
		};
	}

	// The Azure arm, when configured. Identity resolution is HARD-FAIL here too, and it resolves BOTH forms
	// of the harness's identity in one call: a pull-request delivery names an actor by GUID and a work item
	// names them only by email address, so a guard that knew one form would be blind on half the events.
	let azure = null;
	if (cfg.azure) {
		const azureSelfId = await resolveAzureSelfIdFn({ orgUrl: cfg.azure.orgUrl, token: cfg.azure.token });
		log({ event: "self_identity", forge: "azure", id: azureSelfId.id, hasAccountName: azureSelfId.email !== null, mode: cfg.azure.mode });
		azure = {
			mode: cfg.azure.mode,
			secret: cfg.azure.secret,
			headerName: cfg.azure.headerName,
			selfId: azureSelfId,
			resolveAuthority: makeResolveAzureAuthorityFn({ orgUrl: cfg.azure.orgUrl, token: cfg.azure.token }),
		};
	}

	const handler = makeReceiver({ queue, selfId, cfg, log, gitlab, forgejo, azure, resolveAuthority });
	const server = createServer(handler);
	server.listen(cfg.port, cfg.bind, () =>
		log({ event: "receiver_started", port: cfg.port, bind: cfg.bind, valkey: cfg.valkeyUrl }),
	);

	// Graceful shutdown AND the live-trigger watcher only on the real entry (default createServer). Under
	// test injection the fakes are per-test, so a process-wide signal handler or an fs watcher would leak
	// across tests; the reload LOGIC (`reloadTriggers`) is unit-tested directly instead.
	if (createServer === http.createServer) {
		watchTriggers(env, cfg, log);
		const shutdown = async (signal) => {
			log({ event: "receiver_stopping", signal });
			await new Promise((resolve) => server.close(resolve));
			await queue.close();
			process.exit(0);
		};
		process.once("SIGTERM", () => void shutdown("SIGTERM"));
		process.once("SIGINT", () => void shutdown("SIGINT"));
	}

	return server;
}

/**
 * Live-reload watcher: watch the DIRECTORY holding the triggers file (robust to the atomic tmp+rename the
 * admin writes with, which swaps the inode a file-watch would lose), debounce, and re-read on change. A bad
 * edit keeps the running triggers (reloadTriggers never throws) and logs a kept-old notice. Best-effort: a
 * platform without `fs.watch` logs and the receiver simply keeps its boot-time triggers.
 */
function watchTriggers(env, cfg, log) {
	const path = triggersFilePath(env);
	const dir = dirname(path) || ".";
	const file = basename(path);
	let timer = null;
	try {
		watch(dir, (_event, changed) => {
			if (changed && changed !== file) return; // only our file (null changed name -> reload to be safe)
			clearTimeout(timer);
			timer = setTimeout(() => {
				const res = reloadTriggers(env, cfg);
				if (res.ok) log({ event: "triggers_reloaded" });
				else log({ event: "triggers_reload_invalid", reason: res.invalid, kept: true });
			}, 150);
		}).unref?.();
		log({ event: "triggers_watching", path });
	} catch (err) {
		log({ event: "triggers_watch_unavailable", reason: err?.message });
	}
}

// Entry point when run directly (main: src/start.mjs, no bin). Kept out of startReceiver so tests call
// it directly. The error line carries only `err.message` -- never a secret or PII.
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("start.mjs")) {
	startReceiver(process.env).catch((err) => {
		process.stderr.write(`${JSON.stringify({ event: "receiver_start_failed", reason: err?.message })}\n`);
		// entryExitCode, NOT a bare 1. This file is what `receiver.service` execs -- cli.mjs is not on that
		// path -- so the mapping cli.mjs documents ("a supervisor restarting on exit 2 would loop on a config
		// that can never parse") only reaches a real deployment from here. A tagged config refusal exits 2
		// and `RestartPreventExitStatus=2` stops the unit; anything else is infra and stays retryable at 1.
		// IMPORTED rather than restated: two copies of an exit-code rule is one place for it to drift, and
		// the copy that drifts is the one nobody is looking at.
		process.exitCode = entryExitCode(err);
	});
}
