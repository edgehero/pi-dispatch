import { execFile } from "node:child_process";
import { readFileSync, watch } from "node:fs";
import { dirname, basename, join } from "node:path";
import { promisify } from "node:util";
import { configError, loadConfig } from "./config.mjs";
import { makeRedisClient, parseConnection } from "./connection.mjs";
import { reconcileGated, reloadSchedules } from "./cron.mjs";
import { makeGitHubAuth } from "./get-token.mjs";
import { makeGitHubHost } from "./github-host.mjs";
import { makeGitLabAuth } from "./gitlab-auth.mjs";
import { makeGitLabHost } from "./gitlab-host.mjs";
import { makeForgejoAuth } from "./forgejo-auth.mjs";
import { makeForgejoHost } from "./forgejo-host.mjs";
import { makeAzureAuth } from "./azure-auth.mjs";
import { makeAzureHost } from "./azure-host.mjs";
import { makeEgressPreflight } from "./egress.mjs";
import { checkSlotKey, makeFleetLease, makeScopeClaimSweeper, scopeSlotKey } from "./fleet-lease.mjs";
import { cronFingerprint } from "./fingerprint.mjs";
import { makeHostRegistry } from "./host-registry.mjs";
import { makeImagePreflight } from "./image-preflight.mjs";
import { createWorker, JOB_TIMEOUT_MS } from "./index.mjs";
import { makeCollectChain } from "./outbox.mjs";
import { containerPackagePaths, readStageManifest } from "./packages.mjs";
import { makeCleanup, makeForgePreparers, makePrepareWorkspace } from "./prepare.mjs";
import { listRunningSandboxes } from "./sandbox.mjs";
import { makeSandboxReaper } from "./sandbox-store.mjs";
import { makeSessionStore } from "./session-store.mjs";
import { makeCheckOnceSpent, makeCheckWaitSkew, makeDisarmOnce } from "./triggers-file.mjs";
import { loadPauseWindows, pauseUntilMs } from "./pause-windows.mjs";
import { loadScopedLimits, scopeKeyPrefix } from "./scoped-limits.mjs";
import { makeWaitChecker } from "./wait-check.mjs";
import { makeWaitState } from "./wait-state.mjs";
import { hostQueueName, makeQueue } from "./queue.mjs";
import { makeRunContainer } from "./run-container.mjs";
import { makeSecretsResolver } from "./secrets.mjs";
import { buildRecord, makeFindPreviousRun, makeLogReaper, makeLogSink, makeRecordWriter } from "./run-history.mjs";
import { effectiveSettings, readOverlay } from "./runtime-settings.mjs";
import { authoredCron, loadSchedules, servedSchedules } from "./schedules.mjs";
import { makeStallGuard } from "./scheduler-stall-guard.mjs";

const exec = promisify(execFile);

/** How long boot will wait for `docker image inspect` before shipping without a digest. */
const BOOT_IMAGE_TIMEOUT_MS = 5_000;

/**
 * How long a fleet-wide scope claim lives. `JOB_TIMEOUT_MS` plus slack: a container cannot outlive that
 * ceiling, so the claim cannot expire underneath a live job -- which is what makes a refresh unnecessary
 * rather than merely unimplemented. DERIVED from that constant rather than written as a number, so the
 * coupling maintains itself if the timeout ever moves.
 */
const SCOPE_CLAIM_TTL_MS = JOB_TIMEOUT_MS + 5 * 60 * 1000;

/**
 * This worker's own package version, for the registry row (issue #57): a rolling upgrade should be
 * visible as a fact about the fleet rather than as a diff someone has to run. Read once, and never
 * fatal -- an unreadable manifest costs a blank field, not a boot. npm always ships `package.json`
 * whatever `files` says, so this resolves from an installed package as well as from a checkout.
 */
const WORKER_VERSION = (() => {
	try {
		return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version ?? "";
	} catch {
		return "";
	}
})();

/**
 * Boot-time reaper: clear stray `pi-job-*` containers a previous worker crash left behind, before
 * the new worker starts draining. A leaked container keeps spending, so it must go before any new
 * job launches.
 *
 * It runs `docker ps` / `docker rm -f` ONLY. It never inspects a container's exit code, never touches
 * the queue, and never re-enqueues -- queue and retry state belong to Redis, not to docker
 * (INT-RUNNER-EXIT-CODE-PROTOCOL / CONST-RETRY-INFRA-ONLY). It logs container names only (no PII).
 *
 * It assumes ONE worker per docker daemon: a co-located second worker's boot would remove the first's
 * in-flight `pi-job-*` container. That is the accepted v1 shape (DES-CONCURRENCY-3, single worker per
 * host).
 *
 * `reap()` NEVER throws: a missing docker binary or a down daemon is caught, logged as
 * `reaper_skipped`, and boot continues to the worker.
 */
/**
 * Watch the DIRECTORY holding the triggers file (robust to the admin's atomic tmp+rename, which swaps the
 * inode a file-watch would lose), debounce, and re-reconcile the cron schedulers on change via
 * `reloadSchedules`. Best-effort and unref'd so it never blocks shutdown; a platform without `fs.watch`
 * logs and the worker keeps its boot-time schedulers.
 */
function watchTriggersFile(config, queue, log, ref, registry, tz, fleet) {
	const path = config.triggersFile;
	const dir = dirname(path) || ".";
	const file = basename(path);
	let timer = null;
	try {
		watch(dir, (_event, changed) => {
			if (changed && changed !== file) return; // only our file (a null name -> reload to be safe)
			clearTimeout(timer);
			timer = setTimeout(() => void reloadSchedules(config, queue, { log, ref, registry, tz, fleet }), 150);
		}).unref?.();
		log("triggers_watching", { path });
	} catch (err) {
		log("triggers_watch_unavailable", { reason: err?.message });
	}
}

/**
 * Watch the DIRECTORY holding the pause-windows file (same atomic-rename robustness as the triggers watch)
 * and hot-swap the in-memory windows in `ref.current` on change. A bad edit keeps the last-good windows in
 * effect (OQ-008 live-edit safety) — the pause gate never loses its config to a typo. Best-effort + unref'd.
 */
function watchPauseWindowsFile(config, ref, log) {
	const path = config.pauseWindowsFile;
	const dir = dirname(path) || ".";
	const file = basename(path);
	let timer = null;
	const reload = () => {
		try {
			ref.current = loadPauseWindows(config);
			log("pause_windows_reloaded", { count: ref.current.length });
		} catch (err) {
			log("pause_windows_reload_invalid", { reason: err?.message });
		}
	};
	try {
		watch(dir, (_event, changed) => {
			if (changed && changed !== file) return;
			clearTimeout(timer);
			timer = setTimeout(reload, 150);
		}).unref?.();
		log("pause_windows_watching", { path });
	} catch (err) {
		log("pause_windows_watch_unavailable", { reason: err?.message });
	}
}

/**
 * The scoped-limits reload, EXPORTED apart from its watcher so keep-last-good is unit-testable without
 * fs.watch (its two watcher siblings above bind theirs inline; this one is money config, so the
 * last-good property carries its own test). A bad edit keeps `ref.current` untouched and logs
 * `scoped_limits_reload_invalid` -- the pause-windows posture, INT-SCOPED-LIMITS-FILE-CONTRACT.
 */
export function reloadScopedLimits(config, ref, log) {
	try {
		ref.current = loadScopedLimits(config);
		log("scoped_limits_reloaded", { count: ref.current.length });
	} catch (err) {
		log("scoped_limits_reload_invalid", { reason: err?.message });
	}
}

/**
 * Watch the scoped-limits file (issue #242) the way the pause-windows watcher above does: the DIRECTORY,
 * for atomic tmp+rename robustness, filtered to the one basename, debounced. Best-effort + unref'd.
 */
function watchScopedLimitsFile(config, ref, log) {
	const path = config.scopedLimitsFile;
	const dir = dirname(path) || ".";
	const file = basename(path);
	let timer = null;
	try {
		watch(dir, (_event, changed) => {
			if (changed && changed !== file) return;
			clearTimeout(timer);
			timer = setTimeout(() => reloadScopedLimits(config, ref, log), 150);
		}).unref?.();
		log("scoped_limits_watching", { path });
	} catch (err) {
		log("scoped_limits_watch_unavailable", { reason: err?.message });
	}
}

export function makeReaper({ log }) {
	return async function reap() {
		try {
			const { stdout } = await exec("docker", ["ps", "--filter", "name=pi-job-", "--format", "{{.Names}}"]);
			const names = stdout
				.split("\n")
				.map((n) => n.trim())
				.filter(Boolean);
			for (const name of names) {
				await exec("docker", ["rm", "-f", name]);
				log("reaped_container", { name });
			}
			// REQ-EGRESS-ALLOWLIST: the per-job networks those containers were on. Swept AFTER the containers,
			// because a network with a member still attached cannot be removed -- and swept by the SAME
			// `pi-job-` filter, so the namespace rule that keeps an operator's live sandbox safe from the
			// container reaper keeps their sandbox NETWORK safe too, with no second rule to remember.
			//
			// A crashed worker is the case this exists for: `runContainer`'s own finally removes the network
			// on every ordinary path, so anything still here outlived a process that did not get to run it.
			// A network still in use by something else fails to remove and is skipped, which is correct: this
			// is a best-effort sweep and never a reason not to boot.
			const { stdout: nets } = await exec("docker", ["network", "ls", "--filter", "name=pi-job-", "--format", "{{.Name}}"]);
			for (const net of nets.split("\n").map((n) => n.trim()).filter(Boolean)) {
				try {
					await exec("docker", ["network", "rm", net]);
					log("reaped_network", { network: net });
				} catch {} // still in use, or already gone -- either way not this boot's problem
			}
			// Whether the enumeration HAPPENED, which the scope-claim sweep depends on: it may only delete a
			// claim naming this host once this host has actually established that it holds no containers.
			return { reaped: true };
		} catch (err) {
			// The `docker ps` itself is inside this try, so on this path nothing was listed and nothing
			// reaped. Sweeping then would free slots for containers that may STILL BE RUNNING, and another
			// host would start more alongside them -- a money overrun rather than a tidy-up.
			log("reaper_skipped", { reason: err?.message });
			return { reaped: false };
		}
	};
}

/**
 * The runnable worker. Reads config, connects to Valkey, wires every REAL dependency the processor
 * needs, and starts draining the queue. `createWorker` already installs the timeout, the
 * abort->docker-stop, and the SIGTERM/SIGINT graceful shutdown.
 *
 * This is where a job's KIND becomes a pair of collaborators. Each forge is one `forges` entry of
 * `{ auth, host }`, and the four deps that used to be bound to one forge -- `mintToken`, `comment`,
 * `isDefaultBranchProtected`, `prepareWorkspace` -- now look their forge up from the job. The processor
 * therefore never branches on which forge a job belongs to; the only place that knows is here.
 *
 * Forge auth is initialised best-effort, per forge: a local-only deployment must still boot when no
 * working GITHUB_AUTH_SOURCE is present, so an auth failure is logged and that forge's deps fail closed
 * per job (mintToken throws configError) rather than blocking startup. Collaborators are injectable
 * (defaulting to the real ones) so the wiring is testable offline with no Redis and no forge.
 */
export async function startWorker(
	env = process.env,
	{
		makeAuth = makeGitHubAuth,
		makeHost = makeGitHubHost,
		createWorkerFn = createWorker,
		makeReaper: makeReaperFn = makeReaper,
		makeLogSink: makeLogSinkFn = makeLogSink,
		makeRecordWriter: makeRecordWriterFn = makeRecordWriter,
		makeLogReaper: makeLogReaperFn = makeLogReaper,
		makeSandboxReaper: makeSandboxReaperFn = makeSandboxReaper,
		makeRunContainer: makeRunContainerFn = makeRunContainer,
		makeSecretsResolver: makeSecretsResolverFn = makeSecretsResolver,
		makeImagePreflight: makeImagePreflightFn = makeImagePreflight,
		makeScopeClaimSweeper: makeScopeClaimSweeperFn = makeScopeClaimSweeper,
		makeHostRegistry: makeHostRegistryFn = makeHostRegistry,
		makeEgressPreflight: makeEgressPreflightFn = makeEgressPreflight,
		makeGitLabAuth: makeGitLabAuthFn = makeGitLabAuth,
		makeGitLabHost: makeGitLabHostFn = makeGitLabHost,
		makeForgejoAuth: makeForgejoAuthFn = makeForgejoAuth,
		makeForgejoHost: makeForgejoHostFn = makeForgejoHost,
		makeAzureAuth: makeAzureAuthFn = makeAzureAuth,
		makeAzureHost: makeAzureHostFn = makeAzureHost,
	} = {},
) {
	const config = loadConfig(env);
	// `host` sits AFTER the spread, so it is authoritative rather than overridable (issue #57). No call
	// site can know better than this closure which process wrote a line, and one that passed `host` would
	// be lying by construction -- verified: none does. This is also why the stamp lives ONLY here. Every
	// other module takes `log` injected, and two tests pin the KEY SET of the fields object handed to an
	// injected log (`run_record_failed`, `wait_check`); a `host` added at any call site would break them,
	// while one added inside this closure cannot reach them.
	const log = (event, fields = {}) => process.stdout.write(`${JSON.stringify({ event, ...fields, host: config.workerName })}\n`);

	// DES-CRON-VIA-BULLMQ-SCHEDULER: load and validate the triggers file with the operator present and
	// before any Valkey contact, so a misconfigured schedule refuses startup loudly (configError) rather
	// than upserting a broken scheduler. [] means cron disabled (no PI_TRIGGERS_FILE, or no cron triggers).
	// A mutable ref, like its `pauseWindows` and `scopedLimits` siblings and for a reason this one only
	// acquired with issue #57: the heartbeat fingerprints what this host CURRENTLY believes should be
	// scheduled, and a `const` frozen at boot would make it publish the pre-edit set forever -- so two
	// hosts would see each other's fingerprint oscillate on the beat period, refusing or agreeing
	// depending on which half of a beat a reload happened to land in.
	const schedules = { current: loadSchedules(config, { fleet: config.workerNameDeclared }) };

	// REQ-SCOPED-PAUSE-WINDOWS: load + validate the pause-windows file with the operator present and before any
	// Valkey contact, so a malformed file refuses startup (configError) rather than silently disabling scoped
	// pauses. Held in a mutable ref so the live-reload watcher can hot-swap it. [] means no scoped pauses.
	const pauseWindows = { current: loadPauseWindows(config) };

	// Issue #242: same posture for the scoped-limits file -- fail-loud with the operator present, mutable
	// ref for the live-reload watcher, [] when unset (the folder mutex is code and needs no file).
	const scopedLimits = { current: loadScopedLimits(config) };

	// The forge a job belongs to is resolved PER JOB from `job.kind`, not bound once for the process.
	// Each entry is `{ auth, host }`: `auth` is get-token's `{ mintToken, selfId, source }` (null when that
	// forge is unconfigured or unreachable), `host` is the three methods github-host.mjs returns. The map
	// is the seam -- `forgeFor` below is the only place a kind becomes a pair of collaborators, so the
	// processor never learns which forge it is talking to.
	//
	// Auth stays BEST-EFFORT per forge, exactly as it was: a local-only deployment has no GitHub
	// credentials and must still boot and drain cron jobs. The refusal is deferred to the job that needs
	// the missing credential (the mintToken fallback below), not raised at startup.
	const forges = { github: { auth: null, host: makeHost() } };
	try {
		forges.github.auth = await makeAuth(config.github);
		log("self_identity", { kind: "github", id: forges.github.auth.selfId, source: forges.github.auth.source });
	} catch (err) {
		log("github_auth_unavailable", { kind: "github", reason: err?.message });
	}
	// GitLab joins the same map on the same best-effort terms. It appears only when configured: a forge
	// with no entry refuses its jobs at mint time with a message naming what is missing, which is a better
	// answer than an entry that exists and cannot authenticate.
	if (config.gitlab) {
		forges.gitlab = { auth: null, host: makeGitLabHostFn({ apiUrl: config.gitlab.apiUrl }) };
		try {
			forges.gitlab.auth = await makeGitLabAuthFn(config.gitlab);
			log("self_identity", { kind: "gitlab", id: forges.gitlab.auth.selfId, source: forges.gitlab.auth.source });
		} catch (err) {
			log("gitlab_auth_unavailable", { kind: "gitlab", reason: err?.message });
		}
	}
	// Forgejo joins on the same best-effort terms. Its auth can fail for one reason the others cannot: a
	// repository-scoped token cannot call GET /user, so an operator who scoped their token without setting
	// FORGEJO_BOT_ID lands here. The message names the fix (forgejo-identity.mjs) and the forge stays
	// credential-less, which refuses its jobs at mint time rather than running them unattributed.
	if (config.forgejo) {
		forges.forgejo = { auth: null, host: makeForgejoHostFn({ apiUrl: config.forgejo.apiUrl }) };
		try {
			forges.forgejo.auth = await makeForgejoAuthFn(config.forgejo);
			log("self_identity", { kind: "forgejo", id: forges.forgejo.auth.selfId, source: forges.forgejo.auth.source });
		} catch (err) {
			log("forgejo_auth_unavailable", { kind: "forgejo", reason: err?.message });
		}
	}
	// Azure joins on the same terms. Its selfId is an OBJECT (`{ id, email }`) rather than a scalar, because
	// a pull-request delivery names an actor by GUID and a work item names them only by address -- the one
	// place a forge's identity does not reduce to a single value.
	if (config.azure) {
		forges.azure = { auth: null, host: makeAzureHostFn({ orgUrl: config.azure.orgUrl }) };
		try {
			forges.azure.auth = await makeAzureAuthFn(config.azure);
			log("self_identity", { kind: "azure", id: forges.azure.auth.selfId?.id ?? null, source: forges.azure.auth.source });
		} catch (err) {
			log("azure_auth_unavailable", { kind: "azure", reason: err?.message });
		}
	}

	/** The `{ auth, host }` pair a job's kind names, or `undefined` for a local job (which has no forge). */
	const forgeFor = (job) => forges[job?.kind];

	// Clear strays left by a previous crash before the worker starts draining. Best-effort: the reaper
	// swallows its own docker errors; this guard keeps any reaper failure from blocking boot.
	// Whether the container reaper actually ENUMERATED, which the scope-claim sweep below depends on.
	let reaped = false;
	try {
		reaped = (await makeReaperFn({ log })())?.reaped === true;
	} catch (err) {
		log("reaper_skipped", { reason: err?.message });
	}

	// REQ-LOCAL-JOB-VISIBILITY: sweep aged `.log`/`.json` history at boot so the logs directory stays
	// bounded across restarts. Best-effort with the same double-wrap posture as the container reaper: the
	// reaper swallows its own fs errors, and this guard keeps any reaper failure from blocking draining.
	try {
		await makeLogReaperFn({ logsDir: config.logsDir, retentionDays: config.logRetentionDays, log })();
	} catch (err) {
		log("log_reaper_skipped", { reason: err?.message });
	}

	// REQ-RESURRECTABLE-SANDBOX: sweep retained per-job directories past their window, so what `cleanup`
	// kept for re-opening stays bounded. Third in the row and deliberately its own sweep -- a different
	// retention policy, a different PII class, and one thing neither sibling needs: it asks docker which
	// sandboxes are live first, because an operator's shell can outlive a worker restart by design and
	// deleting a bind mount underneath it is a confusing failure with a boring cause. Same double-wrap.
	try {
		await makeSandboxReaperFn({
			sandboxDir: config.sandboxDir,
			retentionHours: config.sandboxRetentionHours,
			listRunning: listRunningSandboxes,
			log,
		})();
	} catch (err) {
		log("sandbox_reaper_skipped", { reason: err?.message });
	}

	// One raw Redis client, shared by the budget (via the worker) and the scheduler stall guard, so it is
	// hoisted out of the createWorkerFn arg object.
	const redis = makeRedisClient(config.valkeyUrl);

	// This host's own stale scope claims, gated on the reaper having having enumerated: the
	// reaper is what establishes that this machine holds no `pi-job-*` containers, so a claim naming this
	// host is a claim for a container that no longer exists. Deleting it is not a second source of truth --
	// it is the SAME source writing down what it just established, which is what answers `OQ-008` here.
	// Best-effort and double-wrapped like every other boot sweep: an OPTIMISATION over the TTL, never the
	// mechanism, so a fault costs one TTL of a stale claim and never a boot.
	try {
		if (config.workerNameDeclared)
			await makeScopeClaimSweeperFn({ redis, workerName: config.workerName, limits: scopedLimits.current.map((r) => ({ concurrent: r.concurrent, hash: scopeKeyPrefix(r.scope).slice("budget:s:".length) })), log })({ reaped });
	} catch (err) {
		log("scope_claims_sweep_skipped", { reason: err?.message });
	}

	// The persistent runtime queue: the stall guard tears schedulers down through it, AND the outbox
	// collector enqueues chained children onto it -- the same pi-jobs queue, so one handle serves both.
	// Non-failFast: a long-lived handle rides out a Valkey blip. Registered as an extraCloser so shutdown
	// drains it after the worker.
	const runtimeQueue = makeQueue(parseConnection(config.valkeyUrl));

	// THE HOST QUEUE (issue #57): work only this machine can do, because the folder lives here.
	//
	// Armed by the operator DECLARING a name, not by a peer appearing. Two reasons, and the first is
	// decisive: which queue a job is enqueued to is a routing decision made by whoever enqueues it, so it
	// cannot be allowed to flip underneath a running deployment when a second host happens to register --
	// a cron scheduler upserted on one queue and pruned from another is exactly the mutual teardown this
	// issue exists to stop. And a second BullMQ Worker is a second blocking connection, which a single-host
	// deployment should not pay for silently. Declaring a name IS the multi-host declaration; `doctor`
	// warns when peers exist and nobody has made it.
	const hostQueue = config.workerNameDeclared ? hostQueueName(config.workerName) : null;
	// The long-lived handle the cron watcher reloads through. Its own when a host queue is armed, so a
	// live triggers-file edit lands on the same queue the boot reconcile used; otherwise the shared
	// runtime queue, exactly as before. Registered as an extraCloser only when it is a NEW handle --
	// closing `runtimeQueue` twice would be closing another owner's connection.
	const cronQueue = hostQueue ? makeQueue(parseConnection(config.valkeyUrl), { name: hostQueue }) : runtimeQueue;

	// REQ-LOCAL-JOB-VISIBILITY durable run history, all host-side. The raw `.log` sink is gated on
	// captureJobLogs (raw container output is user-authored data, opt-in per no-pii-in-logs); the id-only
	// `.json` record via recordRun is ALWAYS on, so every run leaves a stable, non-PII trace regardless.
	// logsDir wires only into these host-side factories and openJobLog into runContainer -- never into the
	// container env allowlist (no-broad-env-into-container).
	const openJobLog = makeLogSinkFn({ logsDir: config.logsDir, enabled: config.captureJobLogs, log });
	const writeRecord = makeRecordWriterFn({ logsDir: config.logsDir, log });
	// REQ-RESUMABLE-SESSION. Wires into prepareWorkspace and the processor's completed branch only --
	// never into the container env allowlist, exactly as logsDir does not. The one difference from logsDir
	// is that a PER-JOB COPY of one key's transcript IS mounted; the store itself never is.
	const sessionStore = makeSessionStore({
		sessionsDir: config.sessionsDir,
		ttlDays: config.sessionsTtlDays,
		maxBytes: config.sessionMaxBytes,
		maxAgeDays: config.sessionMaxAgeDays,
		maxResumeChain: config.sessionMaxResumeChain,
		maxContextPct: config.sessionMaxContextPct,
		log,
	});
	// Boot sweep, beside the log reaper and for the same reason it is beside rather than inside it: these
	// files have a different retention policy and a different PII class. The gate that actually matters is
	// the age check at OPEN -- a worker that never restarts would otherwise resume forever (OQ-007).
	try {
		sessionStore.reapSessions();
	} catch (err) {
		log("session_reaper_skipped", { reason: err?.message });
	}
	// The one-shot file path (issue #231): PI_TRIGGERS_FILE, else ./triggers.json against this process's
	// cwd -- doctor's own fallback, chosen for doctor's own reason ("the two must read the same file"),
	// and deliberately NOT config.triggersFile, whose null means "cron disabled" and must keep meaning
	// that: under that knob the DEFAULT single-host deployment would have a firing receiver and a worker
	// that can neither disarm nor pre-spend-check.
	const onceTriggersFile = env.PI_TRIGGERS_FILE ?? join(process.cwd(), "triggers.json");
	const disarmOnce = makeDisarmOnce({ triggersPath: onceTriggersFile, log });
	const recordRun = ({ job, result, error, startedAt, endedAt }) => {
		// The `host` is stamped HERE rather than inside the processor, which is what keeps every one of its
		// four `recordRun` call sites byte-unchanged and `buildRecord` a pure function of its arguments.
		writeRecord(buildRecord({ job, result, error, startedAt, endedAt, host: config.workerName }));
		// Strictly AFTER the durable record: "fired" means "produced a run record", and the crash
		// direction this ordering buys is the chosen one -- an armed one-shot with a record, never a
		// disarm before writeRecord RETURNED. Returned, not succeeded: the record writer swallows fs
		// errors by contract (run_record_failed), so a full disk still spends the one-shot -- the
		// alternative, skipping the disarm on a failed record write, would re-fire it unbounded. Fire-and-forget: the hook never rejects, and the record path must not
		// wait on a lock retry. An uncontended disarm completes synchronously inside this call; the
		// one loss window is a drain's process.exit landing mid-lock-retry sleep, which loses only
		// the disarm -- the same chosen direction, met at shutdown instead of a crash.
		void disarmOnce({ job, endedAt });
	};

	// INT-CONFIG-OVERLAY-CONTRACT: the worker reads the runtime-settings overlay at EACH job start, so this
	// closure -- not a value frozen at boot -- is what the processor calls per job. It resolves the eight
	// effective settings from the overlay over env; an invalid overlay returns `{ invalid }` (logged loudly,
	// key-name-only per no-pii-in-logs) so the processor RETURNS a settings-overlay-invalid refusal instead
	// of the run.
	const settingsFile = config.settingsFile;
	const getSettings = () => {
		const res = readOverlay(settingsFile, { log });
		if (res.invalid) {
			log("settings_overlay_invalid", { reason: res.invalid, settingsFile });
			return { invalid: res.invalid };
		}
		// REQ-TRIGGER-SECRETS rides ALONGSIDE the ten tunables rather than inside them. `effectiveSettings`
		// resolves `overlay > env` over a fixed ten-key literal, and its own tests pin that key set and
		// assert an empty overlay returns the config verbatim -- so an eleventh key there would break both,
		// and would also claim a precedence this key deliberately does not have (a name declared in both
		// sources is refused per delivery, not silently won by either).
		return { ...effectiveSettings(config, res.overlay), secretProfiles: res.overlay?.secretProfiles ?? {} };
	};

	// Resolve the Worker constructor's slot count once from the overlay: a present overlay may raise or lower
	// boot concurrency. An invalid overlay must NOT dead-end the worker -- fall back to the env/default and let
	// the per-job path enforce the refusal (getSettings already logged the invalid reason).
	const bootSettings = getSettings();
	const bootConcurrency = bootSettings.invalid ? config.concurrency : bootSettings.concurrency;

	// INT-OUTBOX-CONTRACT chain collector: the host-side reader of a completed local parent's /outbox. It
	// enqueues chained children onto the CRON queue via enqueueLocalJob -- this host's own when one is
	// armed, since a chained child continues the working tree this machine just used. Never throws, so a chain fault cannot flip a completed parent
	// (CONST-RETRY-INFRA-ONLY). The processor calls it as the sole COMPLETED-path chain step.
	// Onto the HOST queue when one is armed. A chained child is same-folder and local-parent-only
	// (`OQ-009`), so the working tree it needs is the one this machine just used: routing it anywhere
	// else would enqueue a job only this host can run onto a queue every host drains.
	const collectChain = makeCollectChain({ queue: cronQueue, config, log });

	// REQ-GLOBAL-PI-OVERLAY staged packages: read the operator's stage manifest at EACH job start, like
	// getSettings above and the pause-window ref below.
	//
	// This was a boot-time read until issue #102, and the argument for that was sound while it held: the
	// staged set was deploy-time state under a :ro mount, identical for every job, so a per-job read bought
	// nothing. What changed is that `import-pi --with-packages` now discovers what the operator installed in
	// pi, which makes `pi install X` then re-stage a ROUTINE act rather than a rare one. Under the boot read
	// the jobs after such a re-stage keep the old set until someone restarts the worker, and when the re-stage
	// DROPS a package the symptom is worse than staleness: the runner refuses a missing staged dir at
	// container start (exit 2), and budget is reserved before the container, so every job burns a daily-cap
	// slot until the restart. A free filesystem read that prevents a reserved-and-wasted slot is exactly what
	// CONST-BUDGET-BEFORE-TOKENS asks for.
	//
	// Last-known-good on a failed read, never []: an empty set emits no PI_PACKAGES at all, so the runner's
	// assertPackagePathsExist has nothing to refuse and the job would run WITHOUT its tools and still exit 0.
	// That is the silent no-op this project refuses. And never a throw: a transient overlay fault must not
	// become a queue retry (CONST-RETRY-INFRA-ONLY).
	let lastGoodPackagePaths = [];
	let lastPackageKey = null;
	// Logged once per CHANGE, not once per job: a line every job would drown the log it is meant to serve.
	// EVERY resolved read records its key, including the empty one, so "nothing staged" becoming "one package
	// staged" is the change it obviously is rather than a first read that logs nothing.
	const notePackageKey = (key) => {
		if (lastPackageKey !== null && key !== lastPackageKey) log("packages_stage_changed", { count: key === "" ? 0 : key.split(":").length });
		lastPackageKey = key;
	};
	const getPackagePaths = () => {
		if (!config.globalPiDir) return [];
		const staged = readStageManifest({ globalPiDir: config.globalPiDir });
		if (!staged) {
			if (lastGoodPackagePaths.length > 0) {
				log("packages_manifest_unreadable", { overlay: config.globalPiDir, keeping: lastGoodPackagePaths.length });
				return lastGoodPackagePaths;
			}
			notePackageKey("");
			return [];
		}
		const paths = containerPackagePaths(staged);
		notePackageKey(paths.join(":"));
		lastGoodPackagePaths = paths;
		return paths;
	};
	// One read at boot, for the same log line the boot read always emitted, and to seed last-known-good.
	if (config.globalPiDir && !readStageManifest({ globalPiDir: config.globalPiDir })) log("packages_manifest_absent", { overlay: config.globalPiDir });
	getPackagePaths();

	// Issue #57. Published before the worker starts draining, so a peer that boots a moment later sees this
	// host rather than an empty fleet. The image identity rides the SAME preflight the job path uses -- one
	// inspect implementation, one format string -- called once here with an empty job, which resolves the
	// deployment default and trips none of the per-job label gates.
	//
	// The boot line and the registry may cache this where the GATE may not, and the distinction is the whole
	// argument: a gate that caches gives a WRONG DECISION when an operator builds or removes an image
	// mid-day, which is why `imagePreflight` is deliberately not memoised below. A heartbeat that caches
	// gives a STALE ROW, and nothing reads a row to decide anything.
	// ONE preflight instance, constructed once and shared: `start-wiring.test.mjs` pins that, and the
	// reason is the module's own -- the tag the preflight checked has to be the tag `docker run` is
	// handed, and two constructions are two chances for that to stop being true.
	const imagePreflight = makeImagePreflightFn({ image: config.jobImage });
	// BOUNDED, because `.catch()` cannot rescue a promise that never settles: `runDocker` resolves only on
	// the child's `close` or `error` and has no timeout of its own, so a wedged daemon would hang boot
	// here. This read is a nicety -- a digest for the boot line and the registry -- and a nicety may
	// never be able to stop a worker starting. The per-JOB preflight keeps its unbounded wait, where a
	// wedged daemon is the job's problem and the 30-minute job timeout already covers it.
	const bootImage = await Promise.race([
		imagePreflight({}).catch(() => ({})),
		new Promise((resolve) => setTimeout(() => resolve({}), BOOT_IMAGE_TIMEOUT_MS).unref?.()),
	]);
	// Resolved once: `Intl` is not free, and this value cannot change without a restart.
	const hostTz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
	const registry = makeHostRegistryFn({ redis, name: config.workerName, log });
	// NOT awaited, and that is load-bearing rather than an optimisation. `makeRedisClient` sets
	// `maxRetriesPerRequest: null` -- required for BullMQ's blocking connections -- which means a command
	// issued against an unreachable server QUEUES FOREVER instead of rejecting. Awaiting the first beat
	// would therefore hang boot indefinitely on a deployment whose Valkey is down, turning a telemetry
	// keyspace into a boot dependency. The registry is never on a decision path, so a worker that comes
	// up before its own row does is correct: the row appears when Valkey does.
	void registry.start({
		version: WORKER_VERSION,
		image: config.jobImage,
		imageDigest: bootImage.imageDigest ?? "",
		piVersion: bootImage.piVersion ?? "",
		// A thunk, because the spec says this row carries the LIVE slot count and the overlay can lower it
		// mid-run through `dispatch_set`. A literal here would publish the boot value forever.
		concurrency: () => worker?.concurrency ?? bootConcurrency,
		pid: process.pid,
		// Whether this host DRAINS a queue of its own. Every worker publishes a row; only a host that declared
		// a name has somewhere for routed work to go, and a reader must not invent a queue for one that has not.
		routes: config.workerNameDeclared,
		// The host's IANA zone, because a cron PATTERN carries none: `triggers.json` has no `tz` field and
		// BullMQ hands the pattern to cron-parser with no zone, so it resolves in each worker's LOCAL time.
		// On one host that is exactly what an operator means; on two in different zones the same pattern is
		// two different instants, and nothing anywhere says so. Published now so a later slice can refuse.
		tz: hostTz,
		// The cron fingerprint rides every beat from the LIVE ref, so a peer always compares against what
		// this host believes now rather than what it believed at boot. `null` means abstain: cron disabled
		// here is no opinion at all, and such a host must never be able to disagree with one that has one.
		fpCron: () => cronFingerprint(authoredCron(config), { tz: hostTz }) ?? "",
		cronCount: () => schedules.current.length,
	});


	const worker = createWorkerFn({
		connection: parseConnection(config.valkeyUrl),
		hostQueue,
		// Names the BullMQ Worker, which makes `getWorkers()` rows tell hosts apart -- bullmq appends
		// `:w:<name>` to the client name and `moveToActive` stamps `processedBy` onto each active job's
		// hash, so per-job host attribution arrives for free. A NICETY on top of the registry and never the
		// source of truth: that call rests on CLIENT SETNAME, which bullmq's own doc-comment says some
		// providers do not support, and a host list that silently empties cannot be what a decision reads.
		name: config.workerName,
		concurrency: bootConcurrency,
		getSettings,
		redis,
		recordRun,
		extraClosers: [runtimeQueue, registry, ...(cronQueue === runtimeQueue ? [] : [cronQueue])],
		// REQ-SCOPED-PAUSE-WINDOWS: the processor defers a job whose folder/repo is inside an active window.
		// Reads the live-reloaded ref, so an operator edit takes effect on the next job without a restart.
		pauseUntil: (job, now) => pauseUntilMs(pauseWindows.current, job, now),
		// Issue #242: the scoped-limits snapshot the pickup gate and the scoped budget read, once per
		// pickup, from the live-reloaded ref -- same next-job grain as pauseUntil above.
		scopedLimits: () => scopedLimits.current,
		// Issue #230. The `after` ceiling is read per pickup from config rather than frozen into the
		// processor, so it is one value with one home; the wait state shares the budget's redis client
		// because it describes the same delayed jobs that client already reasons about.
		afterMaxMs: () => config.waitAfterMaxMs,
		waitState: makeWaitState({ redis }),
		// The polled tier's bounds, read per pickup from config so they are one value with one home. The
		// slot count is a CEILING the gate clamps against the live concurrency, never the final number.
		// The fleet-wide half of the wait-check bound (issue #57), armed on the same predicate as the host
		// queue: declaring a name is declaring a fleet. Its TTL is DERIVED rather than guessed -- the gate
		// holds the lease across every profile in turn, each bounded by the check timeout, so one timeout
		// per profile plus one for the overhead between them.
		// The fleet-wide half of a scoped `concurrent` ceiling. Its TTL is DERIVED rather than guessed, and
		// derived is what makes a heartbeat unnecessary: `JOB_TIMEOUT_MS` is a hard 30-minute ceiling on how
		// long any container can run, so a TTL above it cannot expire underneath a live job -- which is the
		// failure that would matter, because it would let another host start a second container on a scope
		// the operator limited to one. Nothing refreshes this claim, deliberately: a refresher would be a
		// second thing to get wrong for a window that cannot be reached.
		scopeLease: hostQueue ? makeFleetLease({ redis, holderPrefix: config.workerName, keyFor: scopeSlotKey, ttlMs: SCOPE_CLAIM_TTL_MS, log }) : null,
		checkLease: hostQueue
			? makeFleetLease({
					redis,
					holderPrefix: config.workerName,
					keyFor: checkSlotKey,
					ttlMs: config.waitCheckTimeoutMs, // a floor; the gate passes the real one, derived from the profile count
					log,
				})
			: null,
		checkSlotCount: () => config.waitCheckSlots,
		checkTimeoutMs: () => config.waitCheckTimeoutMs,
		intervalMs: () => config.waitIntervalMs,
		maxWaitMs: () => config.waitMaxMs,
		maxChecks: () => config.waitMaxChecks,
		maxFaults: () => config.waitMaxFaults,
		deps: {
			collectChain,
			// The one-shot pre-spend check (issue #231): reads the same file the disarm writes, refuses
			// only on a FOREIGN positive mark (index.mjs binds the real queue jobId so a retry of the
			// spending delivery is excused). In the compose topology this check is the once-enforcement
			// layer, because the receiver's single-file :ro mount pins a dead inode until restart.
			checkOnceSpent: makeCheckOnceSpent({ triggersPath: onceTriggersFile }),
			// Issue #230. The same file and the same fail-open posture, but its own mtime-cached read: this one
			// asks whether the AUTHORED entry declares wait conditions the job arrived without, which is how a
			// service below the version floor turns a wait into a paid run nothing can tell from a correct
			// one. In the compose topology the worker's read is the live inode while the receiver's is dead
			// until restart, which is exactly the deployment where the skew happens.
			checkWaitSkew: makeCheckWaitSkew({ triggersPath: onceTriggersFile }),
			// Issue #230. Whether a job the supersede lease names is still in the queue. Without it a holder
			// that vanished by any route except the clean one leaves a key that refuses every later delivery
			// for that target until it expires -- and a refused forge delivery is gone, since no webhook
			// resends it. `getJob` answers from the queue rather than from our own bookkeeping, so the two
			// cannot agree with each other while both being wrong.
			// REQ-WAIT-FOR's polled tier. Built here for the image and egress preflights' reason: one
			// deployment value, one place, so the gate that refuses an undeclared profile and the spawn that
			// runs it cannot disagree about which checks exist. The env-declared table is parsed once at boot
			// (it is env, not overlay -- the gate reads its config above the per-job settings read).
			// The free half of the profile check: whether this deployment declares the name at all. A table
			// lookup, so it belongs with the gate's other free refusals rather than inside the subprocess.
			waitProfileDeclared: (name) => typeof config.waitProfiles[name] === "string",
			checkWait: makeWaitChecker({ profiles: config.waitProfiles, timeoutMs: config.waitCheckTimeoutMs, log }),
			isJobLive: async (id) => {
				const held = await runtimeQueue.getJob(id);
				if (!held) return false;
				// EXISTENCE IS NOT LIVENESS, and the difference decides whether a target stays deafened:
				// `removeOnComplete`/`removeOnFail` keep a finished job's hash for 31 days, so a holder that
				// can never wake again would answer "still waiting" for a month. Only a state it can still be
				// picked up from counts.
				const state = await held.getState();
				return state === "delayed" || state === "waiting" || state === "active" || state === "prioritized" || state === "waiting-children";
			},
			// One deployment default, two consumers, adjacent by construction: the preflight that refuses a missing
			// image BEFORE the budget slot, and the factory that puts it in the argv. Both resolve a trigger's own
			// `run.image` through the same resolveJobImage, so the image that was checked is the image that runs.
			// Nothing is memoised: `docker image inspect` costs ~tens of ms against a container run of minutes, and a
			// cache would be wrong in both directions -- an operator who builds the image mid-day would stay refused,
			// one who removes it would stay admitted. Contrast the staged-package manifest, correctly read once at
			// boot because it is deploy-time state under a :ro mount; the host's image set is not.
			imagePreflight,
			// REQ-EGRESS-ALLOWLIST, and built here for the same reason the image preflight is: one deployment
			// value, one place, so the gate that checks the proxy and the runner that attaches to its network
			// cannot disagree about which proxy is meant. Nothing is memoised here either -- an operator who
			// starts the proxy mid-day must not stay refused, and one who stops it must not stay admitted.
			// Unarmed it spawns nothing at all, so a deployment without a policy pays for none of this.
			egressPreflight: makeEgressPreflightFn({ proxy: config.egressProxy, armed: config.egress }),
			// Completed-only, so a policy or infra exit leaves the canonical transcript byte-identical and a
			// retry starts from what the first attempt did (CONST-RETRY-INFRA-ONLY).
			promoteSession: sessionStore.promoteSession,
			// The same value the store above was built from, passed explicitly so the processor's fail-closed
			// `run.resume` gate answers from THIS config rather than from its own env default. Identical on the
			// real path; the difference shows under an injected env, where the store would be built from the
			// synthetic value while the gate read the process one.
			sessionsDir: config.sessionsDir,
			// REQ-TRIGGER-SECRETS. Built here for the image and egress preflights' reason: one deployment
			// value, one place, so the gate that refuses an unknown profile and the spawn that runs it cannot
			// disagree about which resolvers exist. The env-declared table is parsed once at boot (it is env,
			// and a change to it is a restart), while the OVERLAY half arrives per job through index.mjs,
			// because the settings file is read at each job start and an operator who declares a profile in
			// the panel should not have to restart the worker to use it. A deployment that declares nothing
			// spawns nothing at all: the gate only calls this when a trigger is armed.
			resolveSecrets: makeSecretsResolverFn({ envProfiles: config.secretProfiles, roots: config.secretResolverRoots, timeoutMs: config.secretResolveTimeoutMs, forwardEnv: config.forwardEnv, log }),
			runContainer: makeRunContainerFn({
				image: config.jobImage,
				hostEnv: env,
				egress: config.egress, // REQ-EGRESS-ALLOWLIST: the per-job network and the proxy variables
				egressProxy: config.egressProxy,
				openJobLog,
				globalPiDir: config.globalPiDir, // REQ-GLOBAL-PI-OVERLAY: :ro overlay mount when configured
				allowGlobalExtensions: config.allowGlobalExtensions,
				// REQ-GLOBAL-PI-OVERLAY: staged package paths; every job receives them unless its trigger set
				// packages:false. A RESOLVER, not the array: the factory is still constructed exactly once, only
				// the value it reads became a call, so a re-stage takes effect on the next job without a restart.
				packagePaths: getPackagePaths,
				forwardEnv: config.forwardEnv,
				authFromPi: config.authFromPi, // source the provider key from ~/.pi/agent/auth.json when env has none
				// Self-hosted instance URLs, keyed by forge. A MAP rather than one scalar per forge: the table says
				// which variable each lands in, so a forge with no self-hosted concept simply has no entry, and
				// adding one does not widen this signature again.
				forgeHosts: { gitlab: config.gitlab?.apiUrl ?? null, forgejo: config.forgejo?.apiUrl ?? null, azure: config.azure?.orgUrl ?? null },
			}),
			prepareWorkspace: makePrepareWorkspace({
				jobsDir: config.jobsDir,
				forgeFor,
				// REQ-RESURRECTABLE-SANDBOX: the deployment default, resolved per job against run.image so a
				// retained directory records the image that actually ran and a sandbox re-opens that one.
				jobImage: config.jobImage,
				preparers: makeForgePreparers({ gitlabApiUrl: config.gitlab?.apiUrl ?? null, forgejoApiUrl: config.forgejo?.apiUrl ?? null, azureOrgUrl: config.azure?.orgUrl ?? null }),
				// The cron event.json's previousRunAt (INT-CONTAINER-JOB-INPUTS): read back from the same
				// per-job run-history sidecars recordRun writes above -- no new store, no new query surface.
				findPreviousRun: makeFindPreviousRun({ logsDir: config.logsDir }),
				// Which transcript, if any, a job continues (REQ-RESUMABLE-SESSION). Returns null for every
				// job whose trigger did not arm run.resume, whose key does not resolve, or when
				// PI_SESSIONS_DIR is unset -- and a null means no mount and nothing written.
				resolveSession: sessionStore.resolveSession,
			}),
			// REQ-RESURRECTABLE-SANDBOX. With the window at 0 this IS the old bare `cleanup`, by the same
			// `rm` on the same path -- a deployment that wants no retention keeps today's behaviour exactly.
			cleanup: makeCleanup({ sandboxDir: config.sandboxDir, retentionHours: config.sandboxRetentionHours, log }),
			comment: async (job, text) => {
				// Best-effort: the processor awaits comment() inside its try, so a rejection here would
				// corrupt the job outcome and could drive a wrong retry / second PR (CONST-RETRY-INFRA-ONLY).
				// This adapter NEVER throws.
				const forge = forgeFor(job);
				if (forge?.auth) {
					try {
						const token = await forge.auth.mintToken(job);
						await forge.host.postStatusComment(job, job.target, text, token);
					} catch (err) {
						log("comment_failed", { jobId: job?.id, reason: err?.message });
					}
					return;
				}
				// A local job, or a forge-backed one whose auth never came up. Either way there is nowhere to
				// post, so the line on stdout IS the completion signal (REQ-LOCAL-JOB-VISIBILITY).
				log("comment", { jobId: job?.id, text });
			},
			log,
			// Resolved per job so the credential always comes from the job's OWN forge. A job whose forge has
			// no working auth refuses here, at mint time, rather than running anonymously -- and the refusal
			// names the kind, because with more than one forge configured "auth is broken" is not diagnostic.
			//
			// A LOCAL job reaches this only via the `run.github: true` cron opt-in
			// (INT-TRIGGERS-FILE-CONTRACT), and that flag names github explicitly -- so it mints from the
			// github forge and not from a "default" one. There is deliberately no default: which forge a
			// token comes from must always be something the trigger said.
			mintToken: async (job) => {
				const kind = job?.kind === "local" ? "github" : job?.kind;
				const auth = forges[kind]?.auth;
				if (auth) return await auth.mintToken(job);
				if (kind === "github") {
					throw configError("github jobs and cron triggers with run.github require a working GITHUB_AUTH_SOURCE (gh/pat/app)");
				}
				throw configError(`no forge credentials are configured for job kind ${JSON.stringify(job?.kind)} -- see .env.example`);
			},
			isDefaultBranchProtected: async (job, token) => {
				const host = forgeFor(job)?.host;
				if (!host) throw configError(`no forge host is configured for job kind ${JSON.stringify(job?.kind)}`);
				return await host.isDefaultBranchProtected(job, token);
			},
		},
	});

	// REQ-LOCAL-JOB-VISIBILITY: exactly one terminal line per job, carrying the job id and outcome,
	// where the operator is already looking. This is the local counterpart of the GitHub issue
	// comment and the signal for CONST-PI-VERSION-PINNED's silent-no-op mode -- a missing line is
	// what tells a human a run did nothing. The container's own output already streams via
	// runContainer's onOutput during the run.
	// `reason` is a fixed enum (worker-abort | over-budget | unprotected-branch | runner-policy |
	// job-image-missing), never
	// user content. Included only when present so success lines stay clean; a shutdown-aborted job logs
	// { outcome: "policy", reason: "worker-abort" }, making a restart-dropped job visible.
	// BOTH workers, or a cron job on the host queue produces no `job_completed` line at all -- and
	// REQ-LOCAL-JOB-VISIBILITY's whole point is that a missing line is what tells a human a run did nothing.
	const allWorkers = [worker, ...(worker.hostWorker ? [worker.hostWorker] : [])];
	for (const w of allWorkers) w.on("completed", (job, result) =>
		log("job_completed", { jobId: job?.id, outcome: result?.outcome, ...(result?.reason ? { reason: result.reason } : {}) }),
	);
	for (const w of allWorkers) w.on("failed", (job, err) =>
		log("job_failed", { jobId: job?.id, attempt: job?.attemptsMade, reason: String(err?.message ?? err).slice(0, 120) }),
	);

	// CONST-RETRY-INFRA-ONLY money backstop: BullMQ's maxStalledCount does not bound scheduler jobs, so a
	// wedged scheduled run is re-paid on every stall. The guard counts stalls per scheduler and tears the
	// scheduler down past the threshold. Keyed on "stalled", not "failed" -- only a stall is the unbounded re-run.
	const guard = makeStallGuard({
		redis,
		threshold: config.schedulerStallMax,
		// The queue the schedulers were actually INSTALLED on. Torn down from `runtimeQueue` on a named
		// host, this money backstop -- a wedged scheduled run is re-paid on every stall -- silently no-ops.
		removeJobScheduler: (id) => cronQueue.removeJobScheduler(id),
		log,
	});
	for (const w of allWorkers) w.on("stalled", (jobId) => void guard.onStalled(jobId));

	// DES-CRON-VIA-BULLMQ-SCHEDULER: install the schedule set (and prune orphans) before announcing the
	// worker is up, so schedules_installed always precedes worker_started. An empty set skips the reconcile
	// queue entirely -- no getJobSchedulers Redis hit -- but still logs {0,0} so the operator sees cron is off.
	// What this host will NOT be running, said once at boot and per trigger. A folder that belongs to
	// another machine is ordinary on a fleet; a folder that belongs to NO machine is a trigger that will
	// silently never fire, which is the silent no-op this project refuses -- and which `doctor` is the
	// right place to catch, because it can ask the registry and this cannot.
	const { served, unserved } = servedSchedules(schedules.current);
	for (const s of unserved) log("schedule_unserved", { schedulerId: s.schedulerId, reason: s.unserved });

	if (served.length > 0) {
		// Onto the HOST queue when one is armed. That makes Gap 1 structural rather than merely gated: a
		// host queue's resident schedulers are only ever that host's, so `reconcile`'s "resident minus my
		// config" is correct again by construction and two hosts can no longer prune each other at all. The
		// fingerprint gate stays, because it still catches the divergence itself -- including a timezone
		// disagreement, which no queue split can detect.
		const rq = makeQueue(parseConnection(config.valkeyUrl, { failFast: true }), { ...(hostQueue ? { name: hostQueue } : {}) });
		try {
			const r = await reconcileGated(rq, served, { registry, log, tz: hostTz, authored: authoredCron(config) });
			log("schedules_installed", { installed: r.installed, removed: r.removed, ...(unserved.length > 0 && { unserved: unserved.length }) });
		} finally {
			await rq.close().catch(() => {});
		}
	} else {
		log("schedules_installed", { installed: 0, removed: 0, ...(unserved.length > 0 && { unserved: unserved.length }) });
	}

	// DES-CRON-VIA-BULLMQ-SCHEDULER live edit (OQ-008): watch the triggers file and re-reconcile schedulers
	// on change, so an operator's add/edit/delete of a cron trigger takes effect without a worker restart.
	// Only when a triggers file is configured; best-effort + unref'd; a bad edit keeps the running schedulers.
	if (config.triggersFile) {
		watchTriggersFile(config, cronQueue, log, schedules, registry, hostTz, config.workerNameDeclared);
	}

	// REQ-SCOPED-PAUSE-WINDOWS live edit: watch the pause-windows file and hot-swap the in-memory windows, so
	// an operator's add/delete of a pause window takes effect without a worker restart. A bad edit is kept out.
	if (config.pauseWindowsFile) {
		watchPauseWindowsFile(config, pauseWindows, log);
	}

	// Issue #242 live edit: hot-swap the scoped limits on file change, keeping last-good on a bad edit.
	if (config.scopedLimitsFile) {
		watchScopedLimitsFile(config, scopedLimits, log);
	}

	log("worker_started", {
		queue: "pi-jobs",
		host: config.workerName, // issue #57; `log` stamps it on every line, and the boot line names it where an operator looks first
		imageDigest: bootImage.imageDigest ?? null, // two hosts on two builds of one tag used to emit byte-identical boot lines
		concurrency: bootConcurrency, // the slot count the Worker is actually constructed with (overlay may raise/lower it)
		dailyCap: config.dailyCap,
		weeklyCap: config.weeklyCap, // null when the weekly window is disabled
		monthlyCap: config.monthlyCap, // null when the monthly window is disabled
		softHoldPct: config.softHoldPct, // null when the soft-hold band is disabled
		scopedLimitsFile: config.scopedLimitsFile, // null = no scoped caps/concurrency (the folder mutex holds regardless)
		scopedLimits: scopedLimits.current.length, // row count -- money config deserves boot visibility; the watcher logs only changes
		image: config.jobImage,
		valkey: config.valkeyUrl,
		logsDir: config.logsDir,
		settingsFile: config.settingsFile,
		captureJobLogs: config.captureJobLogs,
		logRetentionDays: config.logRetentionDays,
		sandboxRetentionHours: config.sandboxRetentionHours, // 0 = retention off; a run's directory is deleted as before
	});
	return worker;
}
