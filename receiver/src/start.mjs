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
import { makeForgeRouter } from "./route.mjs";
import { parseConnection } from "@edgehero/pi-dispatch/connection";
import { makeWatchCloser } from "@edgehero/pi-dispatch/watch-closer";
import { retryIdentity } from "./boot-retry.mjs";

/**
 * Boot the receiver. Collaborators are injected (defaulting to the real ones) so the whole wiring is
 * testable offline with no GitHub, no Valkey, and no socket. Returns the listening server.
 */
export async function startReceiver(
	env = process.env,
	{
		// Where the receiver's JSON log lines go. Defaults to the real stdout; a test injects a collector
		// rather than reassigning `process.stdout.write`, which under `node --test` is the same channel the
		// child process reports its own results on (issue #266).
		write = (chunk) => process.stdout.write(chunk),
		makeAuth = makeGitHubAuth,
		makeQueueFn = makeQueue,
		makeForgeRouterFn = makeForgeRouter,
		createServer = http.createServer,
		resolveGitLabSelfId: resolveSelfIdFn = resolveGitLabSelfId,
		makeResolveAuthority: makeResolveAuthorityFn = makeResolveAuthority,
		resolveForgejoSelfId: resolveForgejoSelfIdFn = resolveForgejoSelfId,
		makeResolveForgejoAuthority: makeResolveForgejoAuthorityFn = makeResolveForgejoAuthority,
		resolveAzureSelfId: resolveAzureSelfIdFn = resolveAzureSelfId,
		makeResolveAzureAuthority: makeResolveAzureAuthorityFn = makeResolveAzureAuthority,
		makeResolveGitHubAuthority: makeResolveGitHubAuthorityFn = makeResolveGitHubAuthority,
		// The boot retry's clock and sleep (issue #318). `now` is injected for the reason the worker gives
		// (issue #284): a window read off the default `Date.now` beside a fixed test instant is a fuse that
		// fails in CI on a tree nobody touched. `sleep` is left undefined on the real path so
		// `retryIdentity`'s own default runs; a test injects a recorder and never waits real time.
		now = Date.now,
		sleep,
		// The worker's `extraClosers` shape (issue #301): the triggers watch pushes its stop handle here, the
		// real shutdown below drains it, and a test injects its own array so the watch it armed dies with the
		// boot that armed it instead of leaking an FSWatcher across tests.
		closers = [],
	} = {},
) {
	// Single-object log line: `makeReceiver` calls `log?.({ event, ... })`, so the sink takes ONE object.
	const log = (obj) => write(`${JSON.stringify(obj)}\n`);

	const cfg = loadReceiverConfig(env);

	// One options bag for the four identity arms below (issue #318): the SAME window, clock and sleep for
	// every forge, so the bound the operator configured is the bound every arm obeys.
	const retryOpts = { windowMs: cfg.identityRetryWindowMs, log, now, sleep };

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
		// HARD-FAIL identity resolution -- still NO try/catch here. A DETERMINATE throw (absent/bad github
		// auth, an unresolvable id, anything tagged piDispatchConfig) propagates same-tick and the server
		// below is never created: without selfId the bot-loop guard cannot run, so refusing to boot is the
		// only safe outcome. What changed (issue #318) is the TRANSIENT case: retryIdentity keeps
		// re-resolving inside cfg.identityRetryWindowMs before letting the throw propagate, so a forge that
		// is merely restarting no longer costs the deployment its receiver (the ~25 seconds the systemd
		// unit's start limit used to bound recovery at, and the nothing launchd and nssm bounded it at).
		// The retry wraps EACH arm, never the whole boot: a whole-body retry would rebuild the queue and
		// router below once per attempt and leak their connections, and hoisting the four resolutions above
		// the queue would reorder the first failure an operator sees.
		//
		// The WHOLE auth object is kept, not just selfId: the closer resolver below mints its per-delivery
		// metadata-read token through this same object (issue #231), so identity and mint capability stay
		// one credential decision -- an arm that resolved its identity is exactly the arm that can answer
		// a permission question. This is also why the github handler's missing-resolver 503 is unreachable
		// in a wired receiver: a boot that fails here mounts no `/` at all.
		const auth = await retryIdentity(() => makeAuth(cfg.github), { forge: "github", ...retryOpts });
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

	// Multi-host routing for deliveries that bind a host-local resource (issue #57, `OQ-032`). A trigger
	// naming `run.secretsProfile` or a `run.waitFor` profile can only run where that profile is declared, and
	// which worker pops a shared-queue job is a coin flip -- so the same trigger succeeded or failed by
	// chance, permanently, and read like a configuration error rather than a placement one.
	//
	// Every failure path inside the router returns the shared queue, so a receiver whose Valkey read fails,
	// or whose deployment has no named hosts, behaves exactly as it did before this existed.
	const router = makeForgeRouterFn({ valkeyUrl: cfg.valkeyUrl, shared: queue, log });

	// The GitLab arm, when configured. Its identity resolution is HARD-FAIL for the same reason github's
	// is: without a selfId the bot-loop guard cannot run, and a receiver that listens without it turns the
	// harness's own status comment into another paid job.
	let gitlab = null;
	if (cfg.gitlab) {
		const gitlabSelfId = await retryIdentity(() => resolveSelfIdFn({ apiUrl: cfg.gitlab.apiUrl, token: cfg.gitlab.token }), { forge: "gitlab", ...retryOpts });
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
		const forgejoSelfId = await retryIdentity(() => resolveForgejoSelfIdFn({ apiUrl: cfg.forgejo.apiUrl, token: cfg.forgejo.token, botId: cfg.forgejo.botId }), { forge: "forgejo", ...retryOpts });
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
		const azureSelfId = await retryIdentity(() => resolveAzureSelfIdFn({ orgUrl: cfg.azure.orgUrl, token: cfg.azure.token }), { forge: "azure", ...retryOpts });
		log({ event: "self_identity", forge: "azure", id: azureSelfId.id, hasAccountName: azureSelfId.email !== null, mode: cfg.azure.mode });
		azure = {
			mode: cfg.azure.mode,
			secret: cfg.azure.secret,
			headerName: cfg.azure.headerName,
			selfId: azureSelfId,
			resolveAuthority: makeResolveAzureAuthorityFn({ orgUrl: cfg.azure.orgUrl, token: cfg.azure.token }),
		};
	}

	const handler = makeReceiver({ queue, router, selfId, cfg, log, gitlab, forgejo, azure, resolveAuthority });
	const server = createServer(handler);
	server.listen(cfg.port, cfg.bind, () =>
		log({ event: "receiver_started", port: cfg.port, bind: cfg.bind, valkey: cfg.valkeyUrl }),
	);

	// The watch arms UNCONDITIONALLY now (issue #301). Armed only on the real entry, the lifecycle defect
	// was muted under test rather than closed, and this file had no coverage that the watch arms at all --
	// `DES-WATCHERS-CLOSE-WITH-THE-WORKER` rejected exactly that posture for the worker. The closer rides
	// the injected `closers` array, so a test drains what its boot armed and the real shutdown closes it.
	//
	// LAST FALLIBLE STEP, deliberately, and it must stay last: every refusal this boot can produce -- the
	// config load, each hard-fail identity resolution, the router build, even a throwing `listen` -- sits
	// ABOVE this line, so a refused boot has armed nothing and there is never a closer with no one left to
	// drain it. The worker states the same invariant where its watchers arm. A step added BELOW that can
	// throw reopens issue #301 on the refusal path; the HARD-FAIL test pins the refusals that exist today.
	closers.push(watchTriggers(env, cfg, log));

	// Graceful shutdown only on the real entry (default createServer). Under test injection the fakes are
	// per-test, so a process-wide SIGNAL HANDLER would still leak across tests -- and unlike the watch it
	// has no seam to ride: the closers array cannot un-register a `process.once`. The shutdown's own steps
	// are one call per handle, each covered through its seam.
	if (createServer === http.createServer) {
		const shutdown = async (signal) => {
			log({ event: "receiver_stopping", signal });
			await new Promise((resolve) => server.close(resolve));
			await queue.close();
			await router.close();
			// The watch closer, and whatever joins it later. Per-item try, because a throw here would strand
			// the `process.exit(0)` that the unit's stop depends on -- `index.mjs`'s closer loop states the
			// same rule for the worker.
			for (const c of closers) {
				try {
					c?.close?.();
				} catch {
					// A closer that failed has already stopped mattering.
				}
			}
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
 *
 * Returns the worker's stop handle (issue #301), registered in `closers` so the shutdown -- or the test
 * that injected the array -- closes the FSWatcher and cancels the debounce it armed. A closer is returned
 * even when the watch could not arm: closing a never-armed handle is a no-op by construction, and a
 * caller that has to ask "did I get one" is how a handle goes unregistered.
 */
function watchTriggers(env, cfg, log) {
	const path = triggersFilePath(env);
	const dir = dirname(path) || ".";
	const file = basename(path);
	const handles = { watcher: null, timer: null, closed: false };
	// The worker's closer, reused rather than re-derived (issue #301). Its `log` takes `(event, fields)`
	// where this file's takes one object, so it is handed an adapter here instead of the module growing a
	// second signature. The reload lines go through `closer.reloadLog` -- the reload's VOICE, gated once
	// the handle closes; the arming lines keep the real `log`, because they run before any close exists.
	const closer = makeWatchCloser(handles, (event, fields) => log({ event, ...fields }));
	try {
		handles.watcher = watch(dir, (_event, changed) => {
			if (handles.closed) return; // see makeWatchCloser: by construction, not by a delivery rule
			if (changed && changed !== file) return; // only our file (null changed name -> reload to be safe)
			clearTimeout(handles.timer);
			handles.timer = setTimeout(() => {
				const res = reloadTriggers(env, cfg);
				if (res.ok) closer.reloadLog("triggers_reloaded");
				else closer.reloadLog("triggers_reload_invalid", { reason: res.invalid, kept: true });
			}, 150);
		});
		handles.watcher.unref?.();
		log({ event: "triggers_watching", path });
	} catch (err) {
		log({ event: "triggers_watch_unavailable", reason: err?.message });
	}
	return closer;
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
